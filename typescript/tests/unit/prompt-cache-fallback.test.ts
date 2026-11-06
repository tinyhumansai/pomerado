import { Usage, type ModelProvider, type ModelRequest, type ModelResponse } from "@openai/agents";
import OpenAI from "openai";
import { expect, it } from "vitest";
import { promptCacheFallback } from "../../src/models/prompt-cache.js";

/** A 400 that names no parameter, as OpenRouter answers a prompt-cache setting it doesn't take. */
const unnamedRefusal = () =>
  new OpenAI.BadRequestError(
    400,
    { code: "invalid_prompt", message: "Invalid Responses API request" },
    undefined,
    new Headers(),
  );

const answered = (): ModelResponse => ({ usage: new Usage(), output: [] });

const request = (providerData?: Record<string, unknown>): ModelRequest =>
  ({
    input: "Synthetic input.",
    modelSettings: providerData === undefined ? {} : { providerData },
  }) as unknown as ModelRequest;

const withSettings = { prompt_cache_options: { mode: "implicit" }, prompt_cache_key: "synthetic" };

/** A provider whose model answers each request as `answer` says, keeping every request it got. */
const scripted = (answer: (sent: ModelRequest) => ModelResponse | Error) => {
  const sent: ModelRequest[] = [];
  const provider = {
    getModel: () =>
      Promise.resolve({
        getResponse: (made: ModelRequest) => {
          sent.push(made);
          const result = answer(made);
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
        getStreamedResponse: () => {
          throw new Error("Unused");
        },
      }),
  } as unknown as ModelProvider;
  return { sent, provider };
};

const settingsOf = (sent: ModelRequest | undefined) => sent?.modelSettings.providerData?.["prompt_cache_options"];

it("throws a 400 that names no setting once, when the request carried no prompt-cache settings", async () => {
  const { sent, provider } = scripted(unnamedRefusal);
  const model = await promptCacheFallback()(provider).getModel();
  await expect(model.getResponse(request())).rejects.toThrow("Invalid Responses API request");
  expect(sent).toHaveLength(1);
});

it("throws any other 400 that names no setting once, though the request carried prompt-cache settings", async () => {
  const { sent, provider } = scripted(
    () => new OpenAI.BadRequestError(400, { message: "Synthetic refusal" }, undefined, new Headers()),
  );
  const model = await promptCacheFallback()(provider).getModel();
  await expect(model.getResponse(request(withSettings))).rejects.toThrow("Synthetic refusal");
  expect(sent).toHaveLength(1);
});

it("throws the second refusal when the request without its settings is refused too, and keeps them for the next request", async () => {
  const { sent, provider } = scripted(unnamedRefusal);
  const model = await promptCacheFallback()(provider).getModel();
  await expect(model.getResponse(request(withSettings))).rejects.toThrow("Invalid Responses API request");
  expect(sent).toHaveLength(2);
  expect(settingsOf(sent[1])).toBeUndefined();
  // The settings weren't shown to be the cause, so the next request carries them again.
  await expect(model.getResponse(request(withSettings))).rejects.toThrow();
  expect(settingsOf(sent[2])).toEqual({ mode: "implicit" });
});

it("resolves a prewarm refused without a named setting as one that cached nothing, and sends the rest without the settings", async () => {
  const { sent, provider } = scripted((made) => (settingsOf(made) === undefined ? answered() : unnamedRefusal()));
  const model = await promptCacheFallback()(provider).getModel();
  const prewarm = await model.getResponse(
    request({ prompt_cache_options: { mode: "implicit", prewarm: true } }),
  );
  expect(prewarm.output).toEqual([]);
  expect(prewarm.usage.inputTokens).toBe(0);
  expect(sent).toHaveLength(1);
  await model.getResponse(request(withSettings));
  expect(sent).toHaveLength(2);
  expect(settingsOf(sent[1])).toBeUndefined();
  expect(sent[1]?.modelSettings.providerData?.["prompt_cache_key"]).toBe("synthetic");
});
