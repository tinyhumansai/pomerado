// Failure modes covered: a run that asks for a password its recorded sign-in never types, such as
// one by a phone number and a code, and one that skips the password a recipe does type, or offers
// a private identifier as a login's own kind.
import { describe, expect, it } from "vitest";
import { recipeLoginStep, type SignInRecipe } from "../../src/destinations/sign-in-recipe.js";

const origin = "https://shop.example";
/** A recipe of one screen with `fields`, then a code screen. */
const recipe = (fields: readonly object[]) =>
  ({
    version: 1,
    steps: [
      { page: `${origin}/login`, fields, submit: "button", submittedBy: "host" },
      {
        page: `${origin}/verify`,
        fields: [{ selector: "input[name=code]", slot: "code" }],
        submit: "button",
        submittedBy: "host",
      },
    ],
    signedIn: { selector: "#account" },
  }) as unknown as SignInRecipe;

describe("a run's login for its recorded sign-in", () => {
  it("asks for the identifier alone when no screen types a password", () => {
    expect(recipeLoginStep(recipe([{ selector: "#phone", accepts: ["phone"] }]))).toEqual({
      identifierKinds: ["phone"],
      password: false,
    });
    expect(
      recipeLoginStep(recipe([{ selector: "#login", accepts: ["phone", "email"] }])),
    ).toEqual({ identifierKinds: ["email", "phone"], password: false });
  });

  it("asks for the whole login when a screen types a password", () => {
    expect(
      recipeLoginStep(
        recipe([
          { selector: "#phone", accepts: ["phone"] },
          { selector: "#password", slot: "password" },
        ]),
      ),
    ).toBeUndefined();
  });

  it("offers no private identifier as the login's own kind", () => {
    expect(
      recipeLoginStep(
        recipe([{ selector: "#pin", accepts: ["private_identifier"], label: "PIN" }]),
      ),
    ).toBeUndefined();
  });
});
