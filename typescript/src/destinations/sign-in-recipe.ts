import { Effect, Either, Option, Schema } from "effect";
import type {
  AutofillApproval,
  AutofillPopup,
  RejectedMarker,
  SubmitKey,
} from "./autofill-contracts.js";
import {
  autofillRecipe,
  autofillRecipePath,
  CallingCodeAutofillRecipe,
  DismissAutofillRecipe,
  KeyboardSubmitAutofillRecipe,
  KeySubmitAutofillRecipe,
  LegacyAutofillRecipe,
  NationalPhoneAutofillRecipe,
  PopupAutofillRecipe,
  PrivateIdentifierAutofillRecipe,
  publishedAutofillRecipe,
  ResendAutofillRecipe,
  WildcardAutofillRecipe,
  WorkspaceAutofillRecipe,
  type AutofillRecipeOrigins,
  type AutofillRecipeStep,
} from "./autofill-recipe.js";
import { refused } from "./autofill-refusal.js";
import {
  isCallingCode,
  type AutofillField,
  type AutofillInspection,
  type AutofillRefusal,
  type AutofillScreens,
  type AutofillSignedIn,
  type AutofillSignedInCheck,
  type AutofillStep,
  type AutofillStepReport,
} from "./autofill-step.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { recordedScreenPage } from "../runtime/workspace-origin.js";

/**
 * Version 3, which this host wrote for a private answer's question selector before it wrote that
 * selector in version 1 or 2 as other hosts do. It is read as this host wrote it, so those tools
 * still run, and never written.
 */
export const SignInRecipeV3 = Schema.Struct({
  ...PopupAutofillRecipe.fields,
  version: Schema.Literal(3),
}).pipe(
  Schema.filter(
    (recipe) =>
      recipe.steps.every((step) =>
        step.fields.every((field) => !("questionSelector" in field) || field.slot === "private_answer"),
      ),
    { message: () => "only a private answer names a question selector" },
  ),
);
/**
 * A recipe this host reads: version 1, 2, 4, 5, 6, 7, 8, 9, 10, 11 or 12 as every host writes it,
 * or this host's version 3.
 */
export const SignInRecipe = Schema.Union(
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  SignInRecipeV3,
  WorkspaceAutofillRecipe,
  KeySubmitAutofillRecipe,
  DismissAutofillRecipe,
  WildcardAutofillRecipe,
  KeyboardSubmitAutofillRecipe,
  PrivateIdentifierAutofillRecipe,
  NationalPhoneAutofillRecipe,
  CallingCodeAutofillRecipe,
  ResendAutofillRecipe,
);
export type SignInRecipe = typeof SignInRecipe.Type;
export type SignInRecipeStep = AutofillRecipeStep;

/** A recorded step's page on the given workspace origin, or as recorded. */
export const resolvedPage = (step: SignInRecipeStep, workspace: string | undefined) =>
  step.origin === "workspace" && workspace === undefined
    ? undefined
    : recordedScreenPage(step, workspace);

const knownVersions: readonly unknown[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * A published recipe file read back: the recipe, `unknown_version` for a version this host does
 * not know, else `invalid`. Version 1, 2, 4, 5, 6, 7, 8, 9, 10, 11 and 12 decode as every host
 * reads them; version 3 is read only here.
 */
export const decodeSignInRecipe = (text: string): SignInRecipe | "invalid" | "unknown_version" => {
  const shared = publishedAutofillRecipe(new Map([[autofillRecipePath, text]]));
  if (shared !== undefined) return shared;
  const parsed = Schema.decodeUnknownEither(Schema.parseJson())(text);
  if (Either.isLeft(parsed) || typeof parsed.right !== "object" || parsed.right === null)
    return "invalid";
  const version: unknown = Reflect.get(parsed.right, "version");
  if (typeof version === "number" && !knownVersions.includes(version)) return "unknown_version";
  if (version !== 3) return "invalid";
  return Option.getOrElse(
    Schema.decodeUnknownOption(SignInRecipeV3)(parsed.right),
    () => "invalid" as const,
  );
};

/**
 * One screen of a sign-in as the host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
export interface RecordedSignInStep {
  /** `workspace` for a screen on the login's workspace host, whose `page` is then a path. */
  readonly origin?: "workspace" | undefined;
  readonly popup?: AutofillPopup | undefined;
  readonly approval?: AutofillApproval | undefined;
  /** A device approval's element that shows the number the owner picks on their device. */
  readonly matchSelector?: string | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  /** The key pressed in the last field to submit its form, on a form with no submit control. */
  readonly submitKey?: SubmitKey | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** `keyboard` when the host pressed the step's covered submit from the keyboard. */
  readonly submitVia?: "keyboard" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillStep["methods"];
  /** The secrets an earlier screen took that this one asks for again with a second factor. */
  readonly refills?: SignInRecipeStep["refills"];
  /** The covering notice's own control the host clicked on this screen. */
  readonly dismiss?: string | undefined;
  /** A code screen's own control that asks the site to send a new code. */
  readonly resend?: string | undefined;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
  /** The segments of `page`'s path written as `*`, which any one segment matches. */
  readonly anySegments?: readonly number[] | undefined;
}

/**
 * A verified sign-in's recipe, as `autofillRecipe` writes it, with only the signed-in indicator's
 * parts that are set, and version 4's workspace relation when given.
 */
export const signInRecipe = (
  steps: readonly RecordedSignInStep[],
  signedIn: AutofillSignedIn,
  origins: AutofillRecipeOrigins = {},
): SignInRecipe =>
  autofillRecipe(
    steps,
    {
      ...(signedIn.selector === undefined ? {} : { selector: signedIn.selector }),
      ...(signedIn.urlPath === undefined ? {} : { urlPath: signedIn.urlPath }),
      ...(signedIn.openPath === undefined ? {} : { openPath: signedIn.openPath }),
    },
    origins,
  );

/** A recipe screen in `recipeStep`'s key order, whatever order it was read in. */
const inStepOrder = (step: SignInRecipeStep): SignInRecipeStep => ({
  ...(step.origin === undefined ? {} : { origin: step.origin }),
  page: step.page,
  ...(step.anySegments === undefined ? {} : { anySegments: step.anySegments }),
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.matchSelector === undefined ? {} : { matchSelector: step.matchSelector }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    "accepts" in field
      ? {
          selector: field.selector,
          accepts: field.accepts,
          ...("label" in field && field.label !== undefined ? { label: field.label } : {}),
          ...("format" in field && field.format !== undefined ? { format: field.format } : {}),
        }
      : {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          ...(field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        },
  ),
  ...(step.refills === undefined ? {} : { refills: step.refills }),
  ...(step.submit === undefined ? {} : { submit: step.submit }),
  ...(step.submitKey === undefined ? {} : { submitKey: step.submitKey }),
  ...(step.submittedBy === undefined ? {} : { submittedBy: step.submittedBy }),
  ...(step.submitVia === undefined ? {} : { submitVia: step.submitVia }),
  ...(step.methods === undefined ? {} : { methods: step.methods }),
  ...(step.dismiss === undefined ? {} : { dismiss: step.dismiss }),
  ...(step.resend === undefined ? {} : { resend: step.resend }),
});

/**
 * A recipe as `auth-fill.json` holds it: `version`, then version 4's to 12's `workspace`, then each
 * screen in `recipeStep`'s key order (a workspace screen's `origin` first), indented two spaces,
 * with no final newline. The same recipe is the same bytes from any
 * host that writes it this way.
 */
export const signInRecipeText = (recipe: SignInRecipe) =>
  JSON.stringify(
    {
      version: recipe.version,
      ...(recipe.version === 1 ||
      recipe.version === 2 ||
      recipe.version === 3 ||
      recipe.workspace === undefined
        ? {}
        : { workspace: { parent: recipe.workspace.parent } }),
      steps: recipe.steps.map(inStepOrder),
      signedIn: {
        ...(recipe.signedIn.selector === undefined ? {} : { selector: recipe.signedIn.selector }),
        ...(recipe.signedIn.urlPath === undefined ? {} : { urlPath: recipe.signedIn.urlPath }),
        ...(recipe.signedIn.openPath === undefined ? {} : { openPath: recipe.signedIn.openPath }),
      },
    },
    null,
    2,
  );

/** The browser a sign-in runs on, as the recorder uses it. */
export interface SignInBrowser<E> {
  /** Finds the step's controls and judges where they submit, before anything is typed. */
  readonly inspect: (step: AutofillStep) => Effect.Effect<AutofillRefusal | AutofillInspection, E>;
  /**
   * Fills the step's values into the inspected controls and clicks its submit. `revealedFor`, by
   * field, is the origin a host revealed each value for, when it did: the fill types that value
   * only into a field in a document of that origin.
   */
  readonly fill: (input: {
    readonly step: AutofillStep;
    readonly values: readonly string[];
    readonly inspection: AutofillInspection;
    readonly revealedFor?: readonly (string | undefined)[];
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Clicks again the submit of a screen whose fill reported `blocked`, typing nothing, after the
   * step's `dismiss` when it names one. A browser without it has the screen filled again.
   */
  readonly resubmit?: (input: {
    readonly step: AutofillStep;
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Presses a code screen's resend control, typing nothing (`resendAutofillCode`): the step's code
   * fields, emptied first, and the control as its submit, waited on for up to `waitMs` while the
   * site keeps it disabled, never one of the elements `apartFrom` names (the screen's own submit,
   * methods and dismiss). A browser without it never offers a resend.
   */
  readonly resend?: (input: {
    readonly step: AutofillStep;
    readonly inspection: AutofillInspection;
    readonly waitMs: number;
    readonly apartFrom: readonly string[];
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Checks the minter's signed-in indicator on the page: `screens` are every screen the build
   * filled, `challengeScreens` the current sign-in's, whose recorded challenges count.
   * `openOrigin`, a same-site origin such as the login's workspace origin, is where the
   * indicator's `openPath` opens; the site origin when absent.
   */
  readonly confirm: (
    indicator: AutofillSignedIn,
    screens: AutofillScreens,
    challengeScreens: AutofillScreens,
    openOrigin?: string,
  ) => Effect.Effect<AutofillSignedInCheck, E>;
  /** The configured sign-in origins off the site. */
  readonly authenticationOrigins: readonly string[];
  /**
   * Whether `fill` picks a phone's calling code in a step's calling-code picker
   * (`format: "calling_code"`) with the authoring library's own chooser, as core's fill does. A
   * browser without it has such a step refused at its inspection (`callingCodesGated`).
   */
  readonly picksCallingCodes?: true;
}

/**
 * `browser`, or a replay's hooks, with its inspection refusing a step that names a calling-code
 * picker, as not editable at the picker, when its fill can't pick a calling code
 * (`SignInBrowser.picksCallingCodes`, `AutofillHooks.picksCallingCodes`), as a host before version
 * 11 refuses such a picker: nothing is picked or typed, and a fill of its own never gets the
 * picker's code to type. A build's recorder and every replay apply it.
 */
export const callingCodesGated = <B extends Pick<SignInBrowser<unknown>, "inspect" | "picksCallingCodes">>(
  browser: B,
): B => {
  if (browser.picksCallingCodes === true) return browser;
  return {
    ...browser,
    inspect: (step: AutofillStep) => {
      const picker = step.fields.findIndex(isCallingCode);
      return picker === -1 ? browser.inspect(step) : Effect.succeed(refused("not_editable", picker));
    },
  };
};

/** The identifier kinds a login question offers, as `CurrentLoginStep` names them. */
const loginIdentifierKinds = ["username", "email", "phone", "account_number"] as const;

/** A login question's `currentStep` for a login with no password. */
export const PasswordlessLoginStep = Schema.Struct({
  identifierKinds: Schema.Array(Schema.Literal(...loginIdentifierKinds)).pipe(
    Schema.minItems(1),
    Schema.maxItems(loginIdentifierKinds.length),
    Schema.filter((kinds) => new Set(kinds).size === kinds.length),
  ),
  password: Schema.Literal(false),
});
export type PasswordlessLoginStep = typeof PasswordlessLoginStep.Type;

/**
 * What a run's login needs from the owner when its recipe types no password, as a login question's
 * `currentStep`: the identifier kinds its screens accept, and no password, as a sign-in by a phone
 * number and the code the site sends. A private identifier is asked apart, like a password. A
 * recipe that types a password, or accepts no offered identifier kind, needs the whole login, and
 * this is undefined.
 */
export const recipeLoginStep = (recipe: SignInRecipe): PasswordlessLoginStep | undefined => {
  const fields = recipe.steps.flatMap((step) => step.fields);
  if (fields.some((field) => "slot" in field && field.slot === "password")) return undefined;
  const accepted = new Set(fields.flatMap((field) => ("accepts" in field ? field.accepts : [])));
  const identifierKinds = loginIdentifierKinds.filter((kind) => accepted.has(kind));
  return identifierKinds.length === 0 ? undefined : { identifierKinds, password: false };
};

/** Where a sign-in's login comes from. */
export interface SignInLogin<E> {
  /** The login already given, if any. */
  readonly held: () => WebsiteCredentials | undefined;
  /** The login, asked for once when none is held. */
  readonly values: Effect.Effect<WebsiteCredentials, E>;
  /**
   * A corrected login after the site rejected `field` of `held`; `triesLeft`, this one included,
   * when the sign-in bounds its corrections.
   */
  readonly correct: (
    field: CredentialRejectedField,
    held: WebsiteCredentials,
    triesLeft?: number,
  ) => Effect.Effect<WebsiteCredentials, E>;
}
