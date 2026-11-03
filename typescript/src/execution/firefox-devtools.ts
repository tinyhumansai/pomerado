import { randomUUID } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  JSHandle,
  Page,
  Request,
  Route,
} from "playwright";
import { Schema } from "effect";

/**
 * Firefox answers no DevTools commands, so the Firefox engine answers the few the native host sends
 * itself, with Playwright calls in their place and in the shapes the host reads. A session refuses
 * every other command. Tabs and contexts get ids of their own, stable for the worker's connection.
 */

/**
 * The attributes the host marks a node with before it looks the node up in the DevTools document:
 * a file input it places a file into, and a credential field's one-use binding.
 */
const fileMarker = "data-placing-file";
const bindingPrefix = "__pomerado_autofill_";

/** Why a frame gets no session of its own: the worker then covers it with its tab's session. */
export const frameSessionRefusal = "This frame does not have a separate CDP session";

const ids = new WeakMap<object, string>();
const idOf = (value: object) => {
  const known = ids.get(value);
  if (known !== undefined) return known;
  const id = randomUUID().replaceAll("-", "").toUpperCase();
  ids.set(value, id);
  return id;
};

interface Visit {
  readonly url: string;
  readonly transitionType: "form_submit" | "other";
}
/** A main-frame navigation on its way: its request, and the method its redirect chain began with. */
interface Navigation {
  readonly request: Request;
  readonly method: string;
  /** When its response came: its document commits soon after, if it commits one. */
  respondedAt?: number;
  /** Its response commits no document: it holds no content, or is an attachment. */
  noDocument?: boolean;
}
/** A main-frame load that failed, whose error page Firefox commits a moment later. */
interface FailedLoad {
  readonly url: string;
  readonly method: string;
  readonly at: number;
}
/** The most top-level navigations a tab keeps, newest last. */
const visitsKept = 50;
const visits = new WeakMap<Page, Visit[]>();
const pending = new WeakMap<Page, Navigation>();
const errorPageDue = new WeakMap<Page, FailedLoad>();
/** The longest a failed load's error page is waited for. */
const errorPageMs = 2_000;
/** The longest a navigation whose response came holds reads before its document commits. */
const commitMs = 5_000;
/** The longest a stop waits for the page to run it. */
const stopMs = 2_000;
/** The failures that show no error page: a load stopped, or overtaken by another. */
const abortedLoads = new Set(["NS_BINDING_ABORTED", "NS_ERROR_ABORT"]);

const withoutFragment = (url: string) => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

/**
 * The worker global under which the engine says whether a tab's main-frame navigation is on its
 * way. Chromium holds a tab's reads while one is, so its old document reads as absent; Firefox
 * reads the old document, so the readiness wait asks this instead (`readyWaitCode`).
 */
export const navigationPendingKey = "__pomeradoNavigationPending";

/**
 * Whether a navigation of `page`'s main frame is on its way: requested, and its document not yet
 * committed, or a failed load's error page not yet committed. A response that commits no
 * document, such as a download's, ends it, and so does a closed tab. A response whose document
 * never says it committed holds for at most `commitMs`, and an error page for `errorPageMs`.
 */
export const navigationPending = (page: Page) => {
  if (page.isClosed()) return false;
  const navigation = pending.get(page);
  if (
    navigation !== undefined &&
    (navigation.respondedAt === undefined || Date.now() - navigation.respondedAt < commitMs)
  )
    return true;
  const failed = errorPageDue.get(page);
  return failed !== undefined && Date.now() - failed.at < errorPageMs;
};

/**
 * Records `page`'s top-level navigations, each a `form_submit` when a POST started it, redirects
 * included, as DevTools' history types a form's answer. One a GET started is `other`; a GET
 * form's answer is too, where Chromium types it `form_submit`, which is safe to open again. A
 * same-document navigation, which Playwright reports as a navigation too, moves the current
 * entry's address and keeps its type, as `replaceState` does in Chromium.
 */
export const recordNavigations = (page: Page) => {
  if (visits.has(page)) return;
  const entries: Visit[] = [];
  visits.set(page, entries);
  const visit = (url: string, method: string) => {
    entries.push({ url, transitionType: method === "POST" ? "form_submit" : "other" });
    if (entries.length > visitsKept) entries.splice(0, entries.length - visitsKept);
  };
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    let main = false;
    try {
      main = request.frame() === page.mainFrame();
    } catch {
      return;
    }
    if (!main) return;
    let first = request;
    for (let from = request.redirectedFrom(); from !== null; from = from.redirectedFrom())
      first = from;
    pending.set(page, { request, method: first.method() });
  });
  page.on("response", (response) => {
    const navigation = pending.get(page);
    if (navigation?.request !== response.request()) return;
    navigation.respondedAt = Date.now();
    const disposition = response.headers()["content-disposition"] ?? "";
    navigation.noDocument =
      response.status() === 204 || response.status() === 205 || /^\s*attachment/iu.test(disposition);
  });
  // Firefox may say a request finished before its document says it committed, so only a response
  // that commits none ends the navigation here.
  page.on("requestfinished", (request) => {
    const navigation = pending.get(page);
    if (navigation?.request === request && navigation.noDocument === true) pending.delete(page);
  });
  page.on("requestfailed", (request) => {
    const navigation = pending.get(page);
    if (navigation?.request !== request) return;
    pending.delete(page);
    const reason = request.failure()?.errorText ?? "";
    if (!abortedLoads.has(reason))
      errorPageDue.set(page, {
        url: withoutFragment(request.url()),
        method: navigation.method,
        at: Date.now(),
      });
  });
  page.on("download", (download) => {
    const navigation = pending.get(page);
    if (withoutFragment(download.url()) === withoutFragment(navigation?.request.url() ?? ""))
      pending.delete(page);
  });
  page.on("close", () => {
    pending.delete(page);
    errorPageDue.delete(page);
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = withoutFragment(frame.url());
    const navigation = pending.get(page);
    const failed = errorPageDue.get(page);
    // A new document is the pending navigation's, at its address or once its response came; a
    // redirect Playwright fulfilled starts no request of its own for where it leads.
    if (
      navigation !== undefined &&
      (withoutFragment(navigation.request.url()) === url || navigation.respondedAt !== undefined)
    ) {
      pending.delete(page);
      errorPageDue.delete(page);
      visit(frame.url(), navigation.method);
    } else if (failed?.url === url) {
      errorPageDue.delete(page);
      visit(frame.url(), failed.method);
    } else {
      const current = entries.at(-1);
      if (current === undefined) visit(frame.url(), "GET");
      else entries[entries.length - 1] = { ...current, url: frame.url() };
    }
  });
};

const Origin = Schema.Struct({ origin: Schema.String });
const Bypass = Schema.Struct({ bypass: Schema.Boolean });
const FileInput = Schema.Struct({
  files: Schema.Array(Schema.String),
  backendNodeId: Schema.Number,
});
const NodeId = Schema.Struct({ backendNodeId: Schema.Number });
const ObjectId = Schema.Struct({ objectId: Schema.String });
const FunctionCall = Schema.Struct({
  objectId: Schema.String,
  functionDeclaration: Schema.String,
  arguments: Schema.optionalWith(
    Schema.Array(
      Schema.Union(
        Schema.Struct({ objectId: Schema.String }),
        Schema.Struct({ value: Schema.Unknown }),
      ),
    ),
    { exact: true },
  ),
  returnByValue: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
const KeyEvent = Schema.Struct({
  type: Schema.Literal("keyDown", "keyUp"),
  key: Schema.String,
  text: Schema.optionalWith(Schema.String, { exact: true }),
});

/** Every element of `frame`'s document and its open shadow roots that carries a marker. */
const markedElements = async (frame: Frame) => {
  const list = await frame.evaluateHandle(
    ([marker, prefix]) => {
      const found: Element[] = [];
      const visit = (root: Document | ShadowRoot) => {
        for (const element of root.querySelectorAll("*")) {
          const names = element.getAttributeNames();
          if (names.some((name) => name === marker || name.startsWith(prefix))) found.push(element);
          if (element.shadowRoot !== null) visit(element.shadowRoot);
        }
      };
      visit(document);
      return found;
    },
    [fileMarker, bindingPrefix] as const,
  );
  const elements: ElementHandle<Element>[] = [];
  try {
    for (const property of (await list.getProperties()).values()) {
      const element = property.asElement();
      if (element === null) await property.dispose();
      // The page function returned only elements.
      else elements.push(element as ElementHandle<Element>);
    }
    return elements;
  } catch (error) {
    await Promise.all(elements.map((element) => element.dispose().catch(() => undefined)));
    throw error;
  } finally {
    await list.dispose().catch(() => undefined);
  }
};

/** An inert same-origin document, so a tab reaches an origin's storage without loading the site. */
const blank = (route: Route) => route.fulfill({ contentType: "text/html", body: "<html></html>" });

/**
 * Clears what `Storage.clearDataForOrigin` clears: the origin's cookies, local storage, IndexedDB,
 * cache storage and service workers. The tab opens an inert document on the origin to reach them;
 * a database another connection holds open is deleted once that connection closes. Where a site's
 * worker runs, as on Camoufox (`firefoxEngine`), it may answer that load in place of the routes.
 */
const clearOrigin = async (context: BrowserContext, page: Page, origin: string) => {
  const pattern = `${origin}/**`;
  await page.route(pattern, blank);
  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.evaluate(async () => {
      localStorage.clear();
      for (const { name } of await indexedDB.databases()) {
        if (name === undefined) continue;
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
        });
      }
      if ("caches" in globalThis) for (const key of await caches.keys()) await caches.delete(key);
      if (navigator.serviceWorker !== undefined)
        for (const registration of await navigator.serviceWorker.getRegistrations())
          await registration.unregister();
    });
  } finally {
    await page.unroute(pattern, blank);
  }
  await context.clearCookies({ domain: new URL(origin).hostname });
};

/**
 * Runs `declaration`, a function's source, on `target` with `args`, as `Runtime.callFunctionOn`
 * does: `this` is the target. Playwright compiles the wrapper's source in the page, so a page's
 * content security policy does not apply to it.
 */
const callOn = (
  target: JSHandle,
  declaration: string,
  args: readonly unknown[],
  byValue: boolean,
) => {
  const call = new Function("target", "args", `return (${declaration}).apply(target, args);`) as (
    target: unknown,
    args: readonly unknown[],
  ) => unknown;
  return byValue ? target.evaluate(call, args) : target.evaluateHandle(call, args);
};

const session = (context: BrowserContext, page: Page): CDPSession => {
  const nodes = new Map<number, ElementHandle<Element>>();
  const objects = new Map<string, JSHandle>();
  const pressed = new Map<string, string>();
  let nextNode = 1;
  let detached = false;
  const keep = (handle: JSHandle) => {
    const objectId = randomUUID();
    objects.set(objectId, handle);
    return objectId;
  };
  const object = (objectId: string) => {
    const handle = objects.get(objectId);
    if (handle === undefined) throw new Error("Could not find object with given id");
    return handle;
  };
  const release = async () => {
    const handles = [...nodes.values(), ...objects.values()];
    nodes.clear();
    objects.clear();
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  };
  const commands: Record<string, (params: unknown) => Promise<unknown>> = {
    "Target.getTargetInfo": async () => ({
      targetInfo: {
        targetId: idOf(page),
        browserContextId: idOf(context),
        type: "page",
        url: page.url(),
      },
    }),
    "Page.stopLoading": async () => {
      // The page runs the stop, where Chromium's browser does, so a page that holds its thread
      // past the wait skips it rather than stopping a load started after it.
      const until = Date.now() + stopMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        page
          .evaluate((deadline) => {
            if (Date.now() < deadline) window.stop();
          }, until)
          .catch(() => undefined),
        new Promise((resolve) => (timer = setTimeout(resolve, stopMs))),
      ]);
      clearTimeout(timer);
      // A failed load's error page commits after the failure, and a load started before it would
      // be cut off by it, so a stop after one waits for it.
      const failed = errorPageDue.get(page);
      const left = failed === undefined ? 0 : errorPageMs - (Date.now() - failed.at);
      if (left > 0)
        await page
          .waitForEvent("framenavigated", {
            predicate: (frame) => frame === page.mainFrame() && !errorPageDue.has(page),
            timeout: left,
          })
          .catch(() => undefined);
      return {};
    },
    "Page.getNavigationHistory": async () => {
      const entries = visits.get(page) ?? [];
      return {
        currentIndex: entries.length - 1,
        entries: entries.map((entry, id) => ({ id, ...entry })),
      };
    },
    "Network.setBypassServiceWorker": async (params) => {
      Schema.decodeUnknownSync(Bypass)(params);
      return {};
    },
    "Storage.clearDataForOrigin": async (params) => {
      await clearOrigin(context, page, Schema.decodeUnknownSync(Origin)(params).origin);
      return {};
    },
    "DOM.getDocument": async () => {
      for (const handle of nodes.values()) await handle.dispose().catch(() => undefined);
      nodes.clear();
      const children: unknown[] = [];
      for (const frame of page.frames()) {
        const elements = await markedElements(frame).catch(() => []);
        for (const element of elements) {
          const attributes = await element
            .evaluate(
              (node, [marker, prefix]) =>
                node
                  .getAttributeNames()
                  .filter((name) => name === marker || name.startsWith(prefix))
                  .flatMap((name) => [name, node.getAttribute(name) ?? ""]),
              [fileMarker, bindingPrefix] as const,
            )
            .catch(() => undefined);
          if (attributes === undefined) {
            await element.dispose();
            continue;
          }
          const backendNodeId = nextNode++;
          nodes.set(backendNodeId, element);
          children.push({ nodeId: backendNodeId, backendNodeId, nodeName: "ELEMENT", attributes });
        }
      }
      return { root: { nodeId: 0, backendNodeId: 0, nodeName: "#document", children } };
    },
    "DOM.setFileInputFiles": async (params) => {
      const { files, backendNodeId } = Schema.decodeUnknownSync(FileInput)(params);
      const element = nodes.get(backendNodeId);
      if (element === undefined) throw new Error("No node with given id found");
      await element.setInputFiles([...files]);
      return {};
    },
    "DOM.resolveNode": async (params) => {
      const element = nodes.get(Schema.decodeUnknownSync(NodeId)(params).backendNodeId);
      if (element === undefined) throw new Error("No node with given id found");
      // Its own handle, so releasing the object leaves the node resolvable again.
      const handle = await element.evaluateHandle((node) => node);
      return { object: { type: "object", subtype: "node", objectId: keep(handle) } };
    },
    "Runtime.callFunctionOn": async (params) => {
      const call = Schema.decodeUnknownSync(FunctionCall)(params);
      const target = object(call.objectId);
      const args = (call.arguments ?? []).map((argument) =>
        "objectId" in argument ? object(argument.objectId) : argument.value,
      );
      let handle: JSHandle | undefined;
      try {
        if (call.returnByValue === true)
          return { result: { value: await callOn(target, call.functionDeclaration, args, true) } };
        handle = (await callOn(target, call.functionDeclaration, args, false)) as JSHandle;
        const kind = await handle.evaluate((value) => (value === null ? "null" : typeof value));
        if (kind === "object" || kind === "function") {
          const objectId = keep(handle);
          handle = undefined;
          return { result: { type: kind, objectId } };
        }
        const value: unknown = await handle.jsonValue();
        return { result: { type: kind, value } };
      } catch (error) {
        const text = error instanceof Error ? error.message : "Function call failed";
        return { result: { type: "undefined" }, exceptionDetails: { text } };
      } finally {
        // A handle the session keeps is released with its object; any other goes now.
        await handle?.dispose().catch(() => undefined);
      }
    },
    "Runtime.releaseObject": async (params) => {
      const { objectId } = Schema.decodeUnknownSync(ObjectId)(params);
      const handle = objects.get(objectId);
      objects.delete(objectId);
      await handle?.dispose();
      return {};
    },
    "Input.dispatchKeyEvent": async (params) => {
      const event = Schema.decodeUnknownSync(KeyEvent)(params);
      if (event.type === "keyUp") {
        const name = pressed.get(event.key);
        pressed.delete(event.key);
        if (name !== "") await page.keyboard.up(name ?? event.key);
        return {};
      }
      const name = event.text?.length === 1 ? event.text : event.key;
      try {
        await page.keyboard.down(name);
        pressed.set(event.key, name);
      } catch (error) {
        // A character off Playwright's keyboard layout goes in as text, as its own typing does.
        const offLayout = error instanceof Error && error.message.includes("Unknown key");
        if (event.text === undefined || !offLayout) throw error;
        await page.keyboard.insertText(event.text);
        pressed.set(event.key, "");
      }
      return {};
    },
  };
  const stand = {
    send: async (method: string, params?: unknown) => {
      if (detached) throw new Error("Target page, context or browser has been closed");
      const command = commands[method];
      if (command === undefined) throw new Error(`Firefox engine does not answer ${method}`);
      return command(params ?? {});
    },
    detach: async () => {
      detached = true;
      await release();
    },
  };
  // The host reads only `send` and `detach` from its sessions.
  return stand as unknown as CDPSession;
};

/**
 * A session on a tab, also when named by its main frame as Chromium allows, or a refusal for a
 * child frame, which never has a separate session in Firefox.
 */
export const firefoxSession = async (context: BrowserContext, target: Page | Frame) => {
  if ("mainFrame" in target) return session(context, target);
  if (target.parentFrame() === null) return session(context, target.page());
  throw new Error(frameSessionRefusal);
};

/** A session on the browser, answering only which contexts this connection made. */
export const firefoxBrowserSession = async (browser: Browser): Promise<CDPSession> => {
  let detached = false;
  const stand = {
    send: async (method: string) => {
      if (detached) throw new Error("Target page, context or browser has been closed");
      if (method !== "Target.getBrowserContexts")
        throw new Error(`Firefox engine does not answer ${method}`);
      return { browserContextIds: browser.contexts().map(idOf) };
    },
    detach: async () => {
      detached = true;
    },
  };
  // The host reads only `send` and `detach` from its sessions.
  return stand as unknown as CDPSession;
};
