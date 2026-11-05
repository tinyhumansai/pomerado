import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hostProtocolFindings } from "../../../tools/check-host-protocol.js";

// A host refuses a package whose host protocol it doesn't support, so removing a `./core/*`
// export without raising the protocol would let a host load a package it can't compose.

const target = { import: "./dist/x.js" };
const previous = {
  version: "1.0.0-canary.1",
  exports: { "./runtime": target, "./core/a": target, "./core/b": target },
};

describe("the host protocol check", () => {
  it("fails a removed ./core export without a higher host protocol", () => {
    const current = { exports: { "./runtime": target, "./core/a": target } };
    expect(hostProtocolFindings(current, previous)).toEqual([
      expect.stringContaining("./core/b is exported by pomerado@1.0.0-canary.1 and not here"),
    ]);
    expect(
      hostProtocolFindings({ ...current, pomerado: { hostProtocol: 1 } }, previous),
    ).toHaveLength(1);
  });

  it("passes a removed ./core export once the host protocol rises", () => {
    const current = { exports: { "./core/a": target }, pomerado: { hostProtocol: 2 } };
    expect(hostProtocolFindings(current, previous)).toEqual([]);
    expect(
      hostProtocolFindings(current, { ...previous, pomerado: { hostProtocol: 2 } }),
    ).toHaveLength(1);
  });

  it("passes added exports and changes outside ./core", () => {
    const current = { exports: { "./core/a": target, "./core/b": target, "./core/c": target } };
    expect(hostProtocolFindings(current, previous)).toEqual([]);
  });

  it("fails a host protocol lower than the published one", () => {
    const current = { exports: previous.exports, pomerado: { hostProtocol: 1 } };
    expect(
      hostProtocolFindings(current, { ...previous, pomerado: { hostProtocol: 2 } }),
    ).toEqual([expect.stringContaining("hostProtocol 1 is lower than 2")]);
  });

  // The check sees removed exports only: an export that changed incompatibly raises it by hand.
  it("stands at 2, for the object `reviewPublication` returns in place of a review's ID", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly pomerado: { readonly hostProtocol: number };
    };
    expect(manifest.pomerado.hostProtocol).toBe(2);
  });
});
