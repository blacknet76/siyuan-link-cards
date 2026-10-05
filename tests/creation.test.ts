import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Dialog, Plugin, Protyle } from "siyuan";
import { CreationController } from "../src/creation/controller.ts";
import type { CreationView } from "../src/creation/controller.ts";
import { openCardDialog } from "../src/creation/dialog.ts";
import { captureTarget } from "../src/creation/editor.ts";
import {
  blockCandidate,
  caretCandidate,
  immediateCandidate,
  selectionCandidate,
} from "../src/creation/prefill.ts";
import { metadataSnapshot, simpleSnapshot } from "../src/creation/snapshot.ts";
import { CreationError } from "../src/creation/types.ts";
import type { BookmarkResolver, EmbedOptions, InsertionTarget } from "../src/creation/types.ts";
import { nativeYoutubeSource } from "../src/creation/youtube.ts";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import type { BookmarkMetadata, ResolutionResult } from "../src/metadata/types.ts";
import { normalizeOembed } from "../src/oembed/normalize.ts";
import { parseOembedSnapshot } from "../src/oembed/schema.ts";
import type { OembedResult } from "../src/oembed/types.ts";
import { customBlockMarkdown, parseSnapshot, serializeSnapshot } from "../src/schema.ts";
import { localizedStrings } from "../src/strings.ts";

const url = "https://example.com/";
const metadata: BookmarkMetadata = {
  originalUrl: url,
  resolvedUrl: url,
  title: "Example",
  siteName: "example.com",
  resolvedAt: "2026-10-03T00:00:00.000Z",
};
const success: ResolutionResult = { ok: true, metadata };
const failure: ResolutionResult = { ok: false, error: { kind: "network-error" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
function editor(markup = "/bookmark", source = markup) {
  const dom = new JSDOM(
    "<!doctype html><div id='editor'><div data-node-id='20261003000000-aaaaaaa'><div contenteditable='true'></div></div></div>",
  );
  const document = dom.window.document;
  const root = document.getElementById("editor")!;
  const block = root.firstElementChild as HTMLElement;
  const editable = block.firstElementChild!;
  editable.innerHTML = markup;
  const range = document.createRange();
  range.selectNodeContents(editable);
  const handles = new Map<string, Range>();
  const inserted: { html: string; range: string; }[] = [];
  const reads: string[] = [];
  let released = 0, sequence = 0, invalid = false, skipInsert = false, throwInsert = false;
  const protyle = {
    protyle: {
      disabled: false,
      block: { rootID: "20261003000000-rootaaa" },
      wysiwyg: { element: root },
      toolbar: { range },
      lute: {
        Md2BlockDOM(markdown: string) {
          const node = document.createElement("div");
          node.dataset.type = markdown.startsWith("<iframe ") ? "NodeIFrame" : "NodeCustomBlock";
          node.dataset.nodeId = "20261003000000-" + String(++sequence).padStart(7, "0");
          if (node.dataset.type === "NodeIFrame") {
            const parsed = new dom.window.DOMParser().parseFromString(markdown, "text/html");
            const frame = parsed.querySelector("iframe")!;
            node.setAttribute("style", frame.getAttribute("style")!);
            frame.removeAttribute("style");
            node.append(frame);
          } else node.dataset.content = markdown;
          return node.outerHTML;
        },
      },
    },
    getRange: () => range,
    hasClosestBlock: (node: Node) =>
      (node.nodeType === 1 ? node as Element : node.parentElement)?.closest("[data-node-id]") ?? false,
    trackRange(value: Range) {
      const id = "h" + (++sequence);
      handles.set(id, value.cloneRange());
      return { id };
    },
    resolveTrackedRange(handle: { id: string; }) {
      const found = handles.get(handle.id);
      return found && !invalid ? { status: "resolved", range: found.cloneRange() } : { status: "invalid" };
    },
    releaseTrackedRange(handle: { id: string; }) {
      if (handles.delete(handle.id)) released++;
    },
    insert(html: string, isBlock: boolean, useProtyleRange: boolean) {
      if (throwInsert) throw new Error("private host detail");
      assert.equal(isBlock, true);
      assert.equal(useProtyleRange, true);
      if (skipInsert) return;
      const selected = protyle.protyle.toolbar.range;
      inserted.push({ html, range: selected.toString() });
      selected.deleteContents();
      const template = document.createElement("template");
      template.innerHTML = html;
      block.after(template.content);
    },
  };
  const target = () =>
    captureTarget(protyle as unknown as Protyle, block, {} as Plugin, async id => {
      reads.push(id);
      return source;
    });
  return {
    dom,
    document,
    root,
    block,
    editable,
    range,
    protyle,
    target,
    handles,
    inserted,
    reads,
    released: () => released,
    invalidate: () => {
      invalid = true;
    },
    skipInsert: () => {
      skipInsert = true;
    },
    throwInsert: () => {
      throwInsert = true;
    },
  };
}
function view(initial = url) {
  const state = { value: initial, busy: false, status: "", fallback: false, closed: false, terminal: false };
  const adapter: CreationView = {
    value: () => state.value,
    prefill: value => {
      if (!state.value) state.value = value;
    },
    busy: value => {
      state.busy = value;
    },
    status: value => {
      state.status = value;
    },
    fallback: value => {
      state.fallback = value;
    },
    terminal: () => {
      state.terminal = true;
    },
    close: () => {
      state.closed = true;
    },
  };
  return { state, adapter };
}
function operation(resolve: BookmarkResolver = async () => success, initial = url) {
  const h = editor();
  const t = h.target();
  const v = view(initial);
  const controller = new CreationController(t, v.adapter, resolve, english);
  return { ...h, ...v, controller, t };
}
function stored(h: ReturnType<typeof operation>) {
  const node = h.root.querySelector<HTMLElement>("[data-type=\"NodeCustomBlock\"]")!;
  const markdown = node.dataset.content!;
  return parseSnapshot(markdown.slice(markdown.indexOf("\n") + 1, -4));
}

test("selected public URL prefills, preserving original spelling", () => {
  const h = editor("HTTPS://Example.com/a?x=%2F#part");
  assert.equal(selectionCandidate(h.range, h.block), "HTTPS://Example.com/a?x=%2F#part");
});
test("selection of named native inline link uses its target", () => {
  const h = editor("<span data-type=\"a\" data-href=\"https://example.com/path\">Named link</span>");
  assert.equal(selectionCandidate(h.range, h.block), "https://example.com/path");
});
test("caret inside URL and immediately after URL", () => {
  const h = editor("Read https://example.com/path next");
  const text = h.editable.firstChild!;
  for (const offset of [14, 29, 30]) {
    h.range.setStart(text, offset);
    h.range.collapse(true);
    assert.equal(caretCandidate(h.range, h.block), "https://example.com/path");
  }
});
test("caret inside a native named link", () => {
  const h = editor("<span data-type=\"a\" data-href=\"https://example.net/\">Named</span>");
  h.range.setStart(h.editable.firstChild!.firstChild!, 2);
  h.range.collapse(true);
  assert.equal(caretCandidate(h.range, h.block), "https://example.net/");
});
test("SiYuan zero-width paragraph boundary is excluded from selection/caret URL prefill", () => {
  const h = editor("https://example.com/\u200b");
  assert.equal(selectionCandidate(h.range, h.block), "https://example.com/");
  const text = h.editable.firstChild!;
  for (const offset of [10, 19, 20]) {
    h.range.setStart(text, offset);
    h.range.collapse(true);
    assert.equal(caretCandidate(h.range, h.block), "https://example.com/");
  }
});
test("all five selected slash aliases preserve the adjacent caret URL despite other block URLs", () => {
  for (const alias of ["bookmark", "linkcard", "card", "embed", "oembed"]) {
    const h = editor(`https://example.com/ /${alias} https://example.net/`);
    const text = h.editable.firstChild!;
    const start = "https://example.com/ ".length;
    h.range.setStart(text, start);
    h.range.setEnd(text, start + alias.length + 1);
    assert.equal(blockCandidate(h.block.textContent!), undefined);
    assert.equal(immediateCandidate(h.range, h.block), url);
  }
});
test("exactly one unique current-block URL; duplicate spellings do not add a target", () => {
  assert.equal(blockCandidate("https://example.com/a and https://example.com/a"), "https://example.com/a");
});
test("Markdown link target including balanced URL parentheses and angle form", () => {
  assert.equal(blockCandidate("[Label](https://example.com/a_(b))"), "https://example.com/a_(b)");
  assert.equal(blockCandidate("[Label](<https://example.com/a> \"Title\")"), "https://example.com/a");
});
test("multiple different URLs never produce a block or selection guess", () => {
  const source = "https://example.com/a https://example.net/b";
  const h = editor(source);
  assert.equal(blockCandidate(source), undefined);
  assert.equal(selectionCandidate(h.range, h.block), undefined);
});
test("prefill priority: selection before caret; caret before block source", async () => {
  const h = editor("https://example.com/", "https://example.net/");
  const t = h.target();
  assert.equal(await t.prefill, url);
  assert.equal(h.reads.length, 0);
  t.release();
  h.range.setStart(h.editable.firstChild!, 10);
  h.range.collapse(true);
  assert.equal(immediateCandidate(h.range, h.block), url);
  const caret = h.target();
  assert.equal(await caret.prefill, url);
  assert.equal(h.reads.length, 0);
  caret.release();
});
test("block fallback reads only the supplied official block ID", async () => {
  const h = editor("/bookmark", "Named [link](https://example.net/a)");
  const t = h.target();
  assert.equal(await t.prefill, "https://example.net/a");
  assert.deepEqual(h.reads, [h.block.dataset.nodeId]);
  t.release();
});
test("invalid/blocked candidates ignored; no usable value yields empty prefill", async () => {
  for (
    const source of [
      "http://localhost/a",
      "http://10.0.0.1/",
      "https://u:p@example.com/",
      "https://",
      "no URL",
    ]
  ) {
    assert.equal(blockCandidate(source), undefined);
    const h = editor("/card", source);
    const t = h.target();
    assert.equal(await t.prefill, "");
    t.release();
  }
});
test("prefill never crosses the supplied editor/block boundary", () => {
  const a = editor();
  const b = editor(url);
  assert.equal(selectionCandidate(b.range, a.block), undefined);
  assert.equal(caretCandidate(b.range, a.block), undefined);
  assert.throws(
    () => captureTarget(a.protyle as unknown as Protyle, a.block, {} as Plugin, async () => "", b.range),
    CreationError,
  );
});
test("unavailable official block read leaves empty field", async () => {
  const h = editor();
  const t = captureTarget(h.protyle as unknown as Protyle, h.block, {} as Plugin, async () => {
    throw new Error("raw API error");
  });
  assert.equal(await t.prefill, "");
  t.release();
});

test("original target survives async work and another editor selection", async () => {
  const wait = deferred<ResolutionResult>();
  const a = operation(() => wait.promise);
  const b = editor("Other editor");
  const pending = a.controller.submit();
  b.document.getSelection()!.addRange(b.range);
  wait.resolve(success);
  await pending;
  assert.equal(a.inserted.length, 1);
  assert.equal(b.inserted.length, 0);
  assert.equal(a.inserted[0]!.range, "/bookmark");
  assert.equal(a.handles.size, 0);
  assert.equal(a.released(), 1);
});
test("deleted original block causes no insertion anywhere", async () => {
  const wait = deferred<ResolutionResult>();
  const h = operation(() => wait.promise);
  const pending = h.controller.submit();
  h.block.remove();
  wait.resolve(success);
  await pending;
  assert.equal(h.inserted.length, 0);
  assert.equal(h.handles.size, 0);
  assert.equal(h.state.status, english.bookmarkStaleTarget);
  assert.equal(h.state.terminal, true);
});
test("invalid tracked range, changed document, disabled editor and replaced root fail safely", async () => {
  for (
    const change of [
      (h: ReturnType<typeof operation>) => h.invalidate(),
      (h: ReturnType<typeof operation>) => {
        h.protyle.protyle.block.rootID = "other-doc";
      },
      (h: ReturnType<typeof operation>) => {
        h.protyle.protyle.disabled = true;
      },
      (h: ReturnType<typeof operation>) => {
        h.root.remove();
      },
    ]
  ) {
    const wait = deferred<ResolutionResult>();
    const h = operation(() => wait.promise);
    const pending = h.controller.submit();
    change(h);
    wait.resolve(success);
    await pending;
    assert.equal(h.inserted.length, 0);
    assert.equal(h.handles.size, 0);
    assert.equal(h.state.status, english.bookmarkStaleTarget);
  }
});
test("failure releases attempt tracking; explicit fallback obtains new tracking at same checkpoint", async () => {
  const h = operation(async () => failure);
  await h.controller.submit();
  assert.equal(h.handles.size, 0);
  assert.equal(h.released(), 1);
  assert.equal(h.inserted.length, 0);
  h.controller.simple();
  assert.equal(h.inserted.length, 1);
  assert.equal(h.handles.size, 0);
  assert.equal(h.released(), 2);
});
test("editing the checkpoint block after metadata failure makes later fallback stale", async () => {
  const h = operation(async () => failure);
  await h.controller.submit();
  h.editable.textContent = "Changed";
  h.controller.simple();
  assert.equal(h.inserted.length, 0);
  assert.equal(h.state.status, english.bookmarkStaleTarget);
});
test("cancel releases tracking and ignores late resolver success", async () => {
  const wait = deferred<ResolutionResult>();
  let signal!: AbortSignal;
  const h = operation((_url, current) => {
    signal = current;
    return wait.promise;
  });
  const pending = h.controller.submit();
  h.controller.cancel();
  h.controller.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(h.handles.size, 0);
  assert.equal(h.released(), 1);
  wait.resolve(success);
  await pending;
  assert.equal(h.inserted.length, 0);
  assert.equal(h.state.closed, false);
});
test("invalid URL stays open, makes no resolver request and releases current attempt", async () => {
  let calls = 0;
  const h = operation(async () => {
    calls++;
    return success;
  }, "javascript:alert(1)");
  await h.controller.submit();
  assert.equal(calls, 0);
  assert.equal(h.state.closed, false);
  assert.equal(h.state.status, english.resolverInvalidUrl);
  assert.equal(h.handles.size, 0);
  assert.equal(h.state.fallback, false);
});
test("blocked URL is localized, cannot resolve or use fallback", async () => {
  let calls = 0;
  const h = operation(async () => {
    calls++;
    return success;
  }, "http://localhost/");
  await h.controller.submit();
  h.controller.simple();
  assert.equal(calls, 0);
  assert.equal(h.state.status, english.resolverBlockedTarget);
  assert.equal(h.inserted.length, 0);
});
test("duplicate submission creates one request and one native block", async () => {
  const wait = deferred<ResolutionResult>();
  let calls = 0;
  const h = operation(() => {
    calls++;
    return wait.promise;
  });
  const pending = h.controller.submit();
  await h.controller.submit();
  h.controller.simple();
  assert.equal(calls, 1);
  assert.equal(h.state.busy, true);
  wait.resolve(success);
  await pending;
  await h.controller.submit();
  assert.equal(h.inserted.length, 1);
  assert.equal(h.root.querySelectorAll("[data-type=\"NodeCustomBlock\"]").length, 1);
});
test("metadata error offers explicit fallback and never inserts automatically", async () => {
  let calls = 0;
  const h = operation(async () => {
    calls++;
    return failure;
  });
  await h.controller.submit();
  assert.equal(h.state.fallback, true);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.closed, false);
  assert.equal(h.inserted.length, 0);
  assert.ok(h.state.status.includes(english.resolverNetworkError));
  h.controller.simple();
  assert.equal(calls, 1);
  assert.deepEqual(stored(h), simpleSnapshot(url));
});
test("unexpected resolver rejection is a localized metadata failure with explicit fallback", async () => {
  const h = operation(async () => {
    throw new Error("secret response body");
  });
  await h.controller.submit();
  assert.equal(h.state.fallback, true);
  assert.ok(!h.state.status.includes("secret"));
  assert.equal(h.inserted.length, 0);
});
test("changing failed URL revokes fallback; editing alone never retries", async () => {
  let calls = 0;
  const h = operation(async () => {
    calls++;
    return failure;
  });
  await h.controller.submit();
  h.state.value = "https://example.net/";
  h.controller.inputChanged();
  h.controller.simple();
  assert.equal(h.state.fallback, false);
  assert.equal(h.inserted.length, 0);
  assert.equal(calls, 1);
});
test("native insertion rejection/exception fails once and releases tracking", async () => {
  for (const mode of ["skip", "throw"] as const) {
    const h = operation();
    if (mode === "skip") h.skipInsert();
    else h.throwInsert();
    await h.controller.submit();
    await h.controller.submit();
    assert.equal(h.state.status, english.bookmarkInsertionFailure);
    assert.equal(h.inserted.length, 0);
    assert.equal(h.handles.size, 0);
  }
});
test("full mapping whitelists fields, preserves original URL across redirects and serializes deterministically", () => {
  const m = {
    ...metadata,
    originalUrl: "HTTPS://Example.com/start#part",
    resolvedUrl: "https://example.net/final",
    description: "Description",
    image: "https://example.net/a.jpg",
    favicon: "https://example.net/a.ico",
    html: "<script>raw()</script>",
    diagnostics: "secret",
    redirectHistory: ["other"],
  };
  const snapshot = metadataSnapshot(m);
  const source = serializeSnapshot(snapshot);
  assert.equal(snapshot.card.url, m.originalUrl);
  assert.equal(snapshot.card.resolvedUrl, m.resolvedUrl);
  assert.ok(!source.includes("raw()"));
  assert.ok(!source.includes("diagnostics"));
  assert.deepEqual(snapshot.unknown, {});
  assert.equal(source, serializeSnapshot(parseSnapshot(source)));
  assert.equal(customBlockMarkdown(snapshot).split("\n")[0], ";;;siyuan-link-cards/link-card");
});
test("sparse metadata mapping and minimal fallback omit unavailable fields and fallback timestamp", () => {
  const sparse = metadataSnapshot(metadata);
  assert.equal(sparse.card.description, undefined);
  assert.equal(sparse.card.image, undefined);
  const simple = simpleSnapshot("HTTPS://Example.com/start#part");
  assert.equal(simple.card.url, "HTTPS://Example.com/start#part");
  assert.equal(simple.card.title, "example.com");
  assert.equal(simple.card.siteName, "example.com");
  assert.equal(simple.card.description, undefined);
  assert.equal(simple.card.image, undefined);
  assert.equal(simple.card.favicon, undefined);
  assert.equal(simple.card.resolvedAt, undefined);
});
test("two simultaneous dialogs/operations do not share URL, range or result", async () => {
  const one = deferred<ResolutionResult>(), two = deferred<ResolutionResult>();
  const a = operation(() => one.promise);
  const b = operation(() => two.promise, "https://example.net/");
  const pa = a.controller.submit(), pb = b.controller.submit();
  two.resolve({
    ok: true,
    metadata: {
      ...metadata,
      originalUrl: "https://example.net/",
      resolvedUrl: "https://example.net/",
      title: "Two",
    },
  });
  await pb;
  one.resolve(success);
  await pa;
  assert.equal(stored(a).card.url, url);
  assert.equal(stored(b).card.url, "https://example.net/");
  assert.equal(stored(b).card.title, "Two");
});

function dialogHarness(
  t: InsertionTarget,
  resolve: BookmarkResolver = async () => success,
  strings = english,
  embedOptions: EmbedOptions = {},
) {
  const dom = new JSDOM("<!doctype html><main></main>");
  let dialog!: Dialog;
  let destroyed = 0, closed = 0;
  const close = openCardDialog(
    t,
    options => {
      const element = dom.window.document.createElement("div");
      element.innerHTML = options.content;
      dom.window.document.body.append(element);
      const fake = {
        element,
        destroy() {
          destroyed++;
          element.remove(); /* destroyCallback deliberately deferred */
        },
        bindInput(input: HTMLInputElement, enter?: () => void) {
          input.focus();
          input.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.repeat) {
              event.preventDefault();
              enter?.();
            }
          });
        },
      };
      dialog = fake as unknown as Dialog;
      return dialog;
    },
    resolve,
    localizedStrings(strings),
    () => {
      closed++;
    },
    embedOptions,
  );
  const input = dialog.element.querySelector("input")!;
  const form = dialog.element.querySelector("form")!;
  const buttons = [...dialog.element.querySelectorAll("button")];
  const fallback = buttons[0]!, cancel = buttons[1]!, insert = buttons[2]!;
  return {
    dom,
    dialog,
    input,
    form,
    fallback,
    cancel,
    insert,
    close,
    destroyed: () => destroyed,
    closed: () => closed,
    submit: () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
    status: () => dialog.element.querySelector("[role=\"status\"]")!.textContent,
  };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("hidden fallback stays invisible despite SiYuan button display styles", async () => {
  const h = dialogHarness(editor().target());
  const style = h.dom.window.document.createElement("style");
  style.textContent = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
    + "\n.b3-button { display: inline-flex; }";
  h.dom.window.document.head.append(style);
  assert.equal(h.dom.window.getComputedStyle(h.fallback).display, "none");
  h.close();
});

test("native dialog prefills through value only; no network before explicit submission", async () => {
  const h = editor();
  const t = h.target();
  t.prefill = Promise.resolve(url + "?x=%22%3E%3Cscript%3E");
  let calls = 0;
  const d = dialogHarness(t, async () => {
    calls++;
    return success;
  });
  await settle();
  assert.equal(d.input.value, url + "?x=%22%3E%3Cscript%3E");
  assert.equal(calls, 0);
  assert.equal(d.dialog.element.querySelector("script"), null);
  assert.equal(d.fallback.hidden, true);
  d.close();
});
test("empty state and late block prefill cannot overwrite edited input", async () => {
  const h = editor();
  const t = h.target();
  const prefill = deferred<string>();
  t.prefill = prefill.promise;
  const d = dialogHarness(t);
  assert.equal(d.input.value, "");
  d.input.value = "https://example.net/";
  d.input.dispatchEvent(new d.dom.window.Event("input"));
  prefill.resolve(url);
  await settle();
  assert.equal(d.input.value, "https://example.net/");
  d.close();
});
test("dialog invalid URL stays open with localized error", async () => {
  const h = editor();
  const d = dialogHarness(h.target());
  d.input.value = "bad";
  d.submit();
  await settle();
  assert.equal(d.destroyed(), 0);
  assert.equal(d.status(), english.resolverInvalidUrl);
  assert.equal(d.fallback.hidden, true);
  d.close();
});
test("busy dialog disables input/submission but leaves Cancel available; duplicate Enter creates one card", async () => {
  const h = editor();
  const wait = deferred<ResolutionResult>();
  let calls = 0;
  const d = dialogHarness(h.target(), () => {
    calls++;
    return wait.promise;
  });
  d.input.value = url;
  d.input.dispatchEvent(
    new d.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  d.submit();
  assert.equal(calls, 1);
  assert.equal(d.input.disabled, true);
  assert.equal(d.insert.disabled, true);
  assert.equal(d.cancel.disabled, false);
  assert.equal(d.status(), english.bookmarkBusy);
  wait.resolve(success);
  await settle();
  assert.equal(h.inserted.length, 1);
  assert.equal(d.destroyed(), 1);
});
for (const method of ["cancel", "escape", "native-close", "unload"] as const) {
  test(`${method} cancels immediately before delayed native destroy callback; late result ignored`, async () => {
    const h = editor();
    const wait = deferred<ResolutionResult>();
    const d = dialogHarness(h.target(), () => wait.promise);
    d.input.value = url;
    d.submit();
    if (method === "cancel") d.cancel.click();
    else if (method === "escape") {
      d.input.dispatchEvent(
        new d.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    } else if (method === "native-close") d.dialog.destroy();
    else d.close();
    assert.equal(h.handles.size, 0);
    assert.equal(d.closed(), 0);
    wait.resolve(success);
    await settle();
    assert.equal(h.inserted.length, 0);
    assert.equal(d.destroyed(), 1);
  });
}
test("German error and explicit simple-card action; fallback never follows Enter automatically", async () => {
  const h = editor();
  const d = dialogHarness(h.target(), async () => failure, german);
  d.input.value = url;
  d.submit();
  await settle();
  assert.ok(d.status()!.includes(german.bookmarkMetadataFailure));
  assert.equal(d.fallback.textContent, german.bookmarkSimple);
  assert.equal(d.fallback.hidden, false);
  assert.equal(h.inserted.length, 0);
  d.fallback.click();
  assert.equal(h.inserted.length, 1);
  assert.equal(d.destroyed(), 1);
});

const embedSuccess: OembedResult = {
  ok: true,
  snapshot: normalizeOembed("{\"version\":\"1.0\",\"type\":\"link\",\"title\":\"Embed\"}", url),
};
const embedFailure: OembedResult = { ok: false, error: { kind: "no-discovery" } };
test("YouTube Bookmark selection remains passive; Embed selection inserts native iframe, not video-v1", async () => {
  const source = "https://www.youtube.com/watch?v=M7lc1UVf-VE";
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(source)}`;
  const video = normalizeOembed(
    JSON.stringify({
      version: "1.0",
      type: "video",
      title: "Public video",
      provider_name: "YouTube",
      provider_url: "https://www.youtube.com/",
      html: "<script>ignored</script>",
    }),
    source,
    { resolvedUrl: source, endpoint },
  );
  for (const kind of ["bookmark", "embed"] as const) {
    const h = editor();
    let bookmarks = 0, embeds = 0;
    const d = dialogHarness(
      h.target(),
      async () => {
        bookmarks++;
        return { ok: true, metadata: { ...metadata, originalUrl: source, resolvedUrl: source } };
      },
      english,
      {
        kind,
        resolveEmbed: async () => {
          embeds++;
          return { ok: true, snapshot: video };
        },
      },
    );
    d.input.value = source;
    d.submit();
    await settle();
    assert.equal(bookmarks, kind === "bookmark" ? 1 : 0);
    assert.equal(embeds, kind === "embed" ? 1 : 0);
    assert.equal(h.inserted.length, 1);
    if (kind === "embed") {
      assert.ok(h.inserted[0]!.html.includes("NodeIFrame"));
      assert.equal(h.root.querySelectorAll("[data-type=NodeCustomBlock]").length, 0);
      assert.equal(
        h.root.querySelector("iframe")!.getAttribute("src"),
        "https://www.youtube.com/embed/M7lc1UVf-VE",
      );
      assert.ok(!h.inserted[0]!.html.includes("siyuan-link-cards/oembed"));
    } else {
      assert.ok(h.inserted[0]!.html.includes("siyuan-link-cards/link-card"));
      assert.equal(h.root.querySelectorAll("iframe").length, 0);
    }
  }
});
test("invalid-video offers only the existing explicit Bookmark fallback", async () => {
  const h = editor();
  let bookmarks = 0;
  const d = dialogHarness(
    h.target(),
    async () => {
      bookmarks++;
      return success;
    },
    german,
    {
      kind: "embed",
      resolveEmbed: async () => ({ ok: false, error: { kind: "invalid-video" } }),
    },
  );
  d.input.value = url;
  d.submit();
  await settle();
  assert.equal(h.inserted.length, 0);
  assert.equal(bookmarks, 0);
  assert.ok(d.status()!.includes(german.embedInvalidVideo));
  d.fallback.click();
  await settle();
  assert.equal(bookmarks, 1);
  assert.equal(h.inserted.length, 1);
});
function changeType(d: ReturnType<typeof dialogHarness>, kind: "embed" | "bookmark") {
  const type = d.dialog.element.querySelector("select")!;
  type.value = kind;
  type.dispatchEvent(new d.dom.window.Event("change"));
  return type;
}
for (const kind of ["bookmark", "embed"] as const) {
  test(`shared native dialog preselects ${kind}; switching preserves URL and original tracked handle`, async () => {
    const h = editor();
    const target = h.target();
    const d = dialogHarness(target, async () => success, german, {
      kind,
      resolveEmbed: async () => embedSuccess,
    });
    await settle();
    const type = d.dialog.element.querySelector("select")!;
    assert.equal(type.value, kind);
    assert.equal(type.options.length, 2);
    d.input.value = url;
    const handles = [...h.handles.keys()];
    changeType(d, kind === "bookmark" ? "embed" : "bookmark");
    assert.equal(d.input.value, url);
    assert.deepEqual([...h.handles.keys()], handles);
    changeType(d, "embed");
    d.submit();
    await settle();
    assert.equal(h.inserted.length, 1);
    assert.ok(h.inserted[0]!.html.includes("siyuan-link-cards/oembed"));
  });
}
test("Embed failure stays open; only explicit Bookmark action runs original metadata workflow", async () => {
  const h = editor();
  let calls = 0, embedCalls = 0;
  const d = dialogHarness(
    h.target(),
    async () => {
      calls++;
      return success;
    },
    german,
    {
      kind: "embed",
      resolveEmbed: async () => {
        embedCalls++;
        return embedFailure;
      },
    },
  );
  d.input.value = url;
  d.submit();
  await settle();
  assert.equal(calls, 0);
  assert.equal(h.inserted.length, 0);
  assert.equal(d.destroyed(), 0);
  assert.ok(d.status()!.includes(german.embedFailure));
  assert.equal(d.fallback.textContent, german.embedBookmarkFallback);
  d.fallback.click();
  await settle();
  assert.equal(calls, 1);
  assert.equal(embedCalls, 1);
  assert.equal(h.inserted.length, 1);
  assert.ok(h.inserted[0]!.html.includes("siyuan-link-cards/link-card"));
});
test("Bookmark fallback failure still requires explicit simple-card action", async () => {
  const h = editor();
  const d = dialogHarness(h.target(), async () => failure, english, {
    kind: "embed",
    resolveEmbed: async () => embedFailure,
  });
  d.input.value = url;
  d.submit();
  await settle();
  d.fallback.click();
  await settle();
  assert.equal(h.inserted.length, 0);
  assert.equal(d.fallback.textContent, english.bookmarkSimple);
  assert.equal(d.dialog.element.querySelector("select")!.value, "bookmark");
  d.fallback.click();
  assert.equal(h.inserted.length, 1);
});
for (
  const kind of ["invalid-url", "blocked-target", "invalid-photo", "unsupported-type", "xml-only"] as const
) {
  test(`Embed ${kind} offers deliberate Bookmark fallback after valid source confirmation`, async () => {
    const h = editor();
    const d = dialogHarness(h.target(), async () => success, english, {
      kind: "embed",
      resolveEmbed: async () => ({ ok: false, error: { kind } }),
    });
    d.input.value = url;
    d.submit();
    await settle();
    assert.equal(d.fallback.hidden, false);
    assert.equal(h.inserted.length, 0);
    d.close();
  });
}
for (const close of ["cancel", "native", "escape", "unload"] as const) {
  test(`Embed ${close} prevents late insertion and releases original range`, async () => {
    const h = editor();
    const wait = deferred<OembedResult>();
    let signal: AbortSignal | undefined;
    const d = dialogHarness(h.target(), async () => success, english, {
      kind: "embed",
      resolveEmbed: (_url, s) => {
        signal = s;
        return wait.promise;
      },
    });
    d.input.value = url;
    d.submit();
    assert.equal(d.dialog.element.querySelector("select")!.disabled, true);
    if (close === "cancel") d.cancel.click();
    else if (close === "escape") {
      d.input.dispatchEvent(new d.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else if (close === "native") d.dialog.destroy();
    else d.close();
    assert.equal(signal!.aborted, true);
    assert.equal(h.handles.size, 0);
    wait.resolve(embedSuccess);
    await settle();
    assert.equal(h.inserted.length, 0);
  });
}
test("stale Embed result never inserts in a different editor", async () => {
  const h = editor(), other = editor();
  const wait = deferred<OembedResult>();
  const d = dialogHarness(h.target(), async () => success, english, {
    kind: "embed",
    resolveEmbed: () => wait.promise,
  });
  d.input.value = url;
  d.submit();
  h.invalidate();
  wait.resolve(embedSuccess);
  await settle();
  assert.equal(h.inserted.length, 0);
  assert.equal(other.inserted.length, 0);
  assert.equal(d.insert.disabled, true);
  d.close();
});
test("simultaneous Bookmark/Embed dialogs keep independent URL/type/targets and results", async () => {
  const a = editor(), b = editor();
  const bookWait = deferred<ResolutionResult>(), embedWait = deferred<OembedResult>();
  const da = dialogHarness(a.target(), () => bookWait.promise);
  const db = dialogHarness(b.target(), async () => assert.fail("must not resolve Bookmark"), english, {
    kind: "embed",
    resolveEmbed: () => embedWait.promise,
  });
  da.input.value = url;
  db.input.value = url;
  da.submit();
  db.submit();
  embedWait.resolve(embedSuccess);
  await settle();
  assert.equal(a.inserted.length, 0);
  assert.equal(b.inserted.length, 1);
  bookWait.resolve(success);
  await settle();
  assert.equal(a.inserted.length, 1);
  assert.ok(a.inserted[0]!.html.includes("link-card"));
  assert.ok(b.inserted[0]!.html.includes("/oembed"));
});
test("editing URL/type clears failed Embed fallback and never starts a request", async () => {
  const h = editor();
  let calls = 0;
  const d = dialogHarness(h.target(), async () => success, english, {
    kind: "embed",
    resolveEmbed: async () => {
      calls++;
      return embedFailure;
    },
  });
  d.input.value = url;
  d.submit();
  await settle();
  changeType(d, "bookmark");
  assert.equal(d.fallback.hidden, true);
  assert.equal(calls, 1);
  changeType(d, "embed");
  d.input.value = "https://example.net/";
  d.input.dispatchEvent(new d.dom.window.Event("input"));
  assert.equal(calls, 1);
  d.close();
});

test("Bookmark metadata is localized after resolution, persisted with host refs and original insertion target", async () => {
  const h = editor(), target = h.target(), v = view();
  const calls: string[] = [];
  const controller = new CreationController(
    target,
    v.adapter,
    async () => {
      calls.push("metadata");
      return {
        ok: true,
        metadata: {
          ...metadata,
          image: "https://example.com/preview.png",
          favicon: "https://example.com/favicon.png",
        },
      };
    },
    english,
    {
      importAsset: async (source, id) => {
        calls.push(source);
        assert.equal(id, h.block.dataset.nodeId);
        return "assets/slc-test-20261003000000-aaaaaaa.png";
      },
    },
  );
  await controller.submit();
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "metadata");
  assert.equal(h.inserted.length, 1);
  const markdown = h.document.querySelector<HTMLElement>("[data-type=\"NodeCustomBlock\"]")!.dataset.content!;
  assert.ok(markdown.includes("\"image\": \"assets/"));
  assert.ok(markdown.includes("custom-data-assets-slc-image="));
  assert.ok(markdown.includes("custom-data-assets-slc-favicon="));
  assert.equal(h.handles.size, 0);
  assert.equal(v.state.closed, true);
});
test("optional creation import failure omits remote media and reports degradation without failing card", async () => {
  const h = editor(), v = view();
  let notices = 0;
  const controller = new CreationController(
    h.target(),
    v.adapter,
    async () => ({
      ok: true,
      metadata: {
        ...metadata,
        image: "https://example.com/image.png",
        favicon: "https://example.com/favicon.ico",
      },
    }),
    english,
    {
      importAsset: async () => {
        throw new Error("unusable optional media");
      },
      notifyMediaOmitted: () => {
        notices++;
      },
    },
  );
  await controller.submit();
  assert.equal(h.inserted.length, 1);
  assert.equal(notices, 1);
  assert.equal(v.state.closed, true);
  const markdown = h.document.querySelector<HTMLElement>("[data-type=\"NodeCustomBlock\"]")!.dataset.content!;
  assert.ok(!markdown.includes("\"image\"") && !markdown.includes("\"favicon\""));
});
test("cancel during optional creation import leaves no late card and releases original range", async () => {
  const h = editor(), v = view();
  const pending = deferred<string>();
  let started: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const controller = new CreationController(
    h.target(),
    v.adapter,
    async () => ({ ok: true, metadata: { ...metadata, image: "https://example.com/preview.png" } }),
    english,
    {
      importAsset: async () => {
        started!();
        return pending.promise;
      },
    },
  );
  const submitting = controller.submit();
  await ready;
  controller.cancel();
  pending.resolve("assets/slc-test-20261003000000-aaaaaaa.png");
  await submitting;
  assert.equal(h.inserted.length, 0);
  assert.equal(h.handles.size, 0);
});

const nativeSource = "https://www.youtube.com/watch?v=M7lc1UVf-VE";
const nativeId = "M7lc1UVf-VE";
function nativeVideoResult(): OembedResult {
  return {
    ok: true,
    snapshot: normalizeOembed(
      JSON.stringify({
        version: "1.0",
        type: "video",
        title: "Video",
        provider_name: "YouTube",
        provider_url: "https://www.youtube.com/",
        html: "<iframe src='https://evil.example/'></iframe>",
      }),
      nativeSource,
      {
        resolvedUrl: nativeSource,
        endpoint: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(nativeSource)}`,
      },
    ),
  };
}
for (const state of ["switched", "deleted", "invalid", "cancelled"] as const) {
  test(`native YouTube async ${state} retains original target or inserts nothing`, async () => {
    const h = editor("/embed"), other = editor("Other editor"), wait = deferred<OembedResult>();
    const d = dialogHarness(h.target(), async () => assert.fail("not Bookmark"), english, {
      kind: "embed",
      resolveEmbed: () => wait.promise,
    });
    d.input.value = nativeSource;
    d.submit();
    if (state === "switched") other.document.getSelection()!.addRange(other.range);
    if (state === "deleted") h.block.remove();
    if (state === "invalid") h.invalidate();
    if (state === "cancelled") d.cancel.click();
    wait.resolve(nativeVideoResult());
    await settle();
    assert.equal(other.inserted.length, 0);
    assert.equal(h.inserted.length, state === "switched" ? 1 : 0);
    if (state === "switched") {
      assert.equal(h.inserted[0]!.range, "/embed");
      assert.equal(h.root.querySelectorAll("[data-type=NodeIFrame]").length, 1);
    }
    assert.equal(h.handles.size, 0);
    d.close();
  });
}
test("unavailable native frontend offers explicit Bookmark fallback without old video creation", async () => {
  const h = editor("/embed"),
    d = dialogHarness(h.target(), async () => success, english, {
      kind: "embed",
      resolveEmbed: async () => nativeVideoResult(),
      nativeYoutubeAvailable: false,
    });
  d.input.value = nativeSource;
  d.submit();
  await settle();
  assert.equal(h.inserted.length, 0);
  assert.equal(d.fallback.hidden, false);
  assert.ok(d.status()!.includes(english.embedNativeUnavailable));
  assert.equal(d.destroyed(), 0);
  d.close();
});
for (const mutate of ["custom", "host", "attribute", "script", "extra-block", "geometry"] as const) {
  test(`native conversion ${mutate} fails before public insert`, () => {
    const h = editor("/embed"), convert = h.protyle.protyle.lute.Md2BlockDOM;
    h.protyle.protyle.lute.Md2BlockDOM = source => {
      const parsed = new h.dom.window.DOMParser().parseFromString(convert(source), "text/html");
      const node = parsed.body.firstElementChild as HTMLElement, frame = node.querySelector("iframe")!;
      if (mutate === "custom") node.dataset.type = "NodeCustomBlock";
      if (mutate === "host") frame.src = "https://evil.example/embed/";
      if (mutate === "attribute") frame.setAttribute("srcdoc", "<script>bad</script>");
      if (mutate === "script") node.append(parsed.createElement("script"));
      if (mutate === "extra-block") parsed.body.append(parsed.createElement("div"));
      if (mutate === "geometry") node.style.height = "9999px";
      return parsed.body.innerHTML;
    };
    const t = h.target();
    assert.throws(() => t.insertYoutube(nativeSource, nativeId), CreationError);
    assert.equal(h.inserted.length, 0);
    t.release();
  });
}
test("native adapter rejects raw markup and embed-host URLs before conversion", () => {
  const h = editor();
  const t = h.target();
  for (
    const source of [
      nativeYoutubeSource(nativeSource, nativeId),
      "https://www.youtube.com/embed/M7lc1UVf-VE",
      "https://evil.example/watch?v=M7lc1UVf-VE",
    ]
  ) {
    assert.throws(() => t.insertYoutube(source, nativeId), CreationError);
  }
  assert.equal(h.inserted.length, 0);
  t.release();
});
test("shared dialog exposes native privacy only for Embed, preserves URL through type changes", () => {
  for (const strings of [english, german]) {
    const h = editor();
    const d = dialogHarness(h.target(), async () => success, strings);
    const privacy = d.dialog.element.querySelector<HTMLElement>(".slc-dialog__privacy")!;
    assert.equal(privacy.hidden, true);
    d.input.value = nativeSource;
    changeType(d, "embed");
    assert.equal(privacy.hidden, false);
    assert.equal(privacy.textContent, strings.embedNativePrivacy);
    changeType(d, "bookmark");
    assert.equal(privacy.hidden, true);
    assert.equal(d.input.value, nativeSource);
    d.close();
  }
});

for (const type of ["link", "photo"] as const) {
  for (const importFails of [false, true]) {
    test(`passive ${type} favicon uses common optional import/IAL pipeline (fails=${importFails})`, async () => {
      const h = editor(), v = view();
      const snapshot = normalizeOembed(
        JSON.stringify({
          version: "1.0",
          type,
          title: "Public page",
          ...(type === "photo" ? { url: "https://example.com/photo.jpg", width: 100, height: 100 } : {}),
        }),
        url,
      );
      snapshot.card.favicon = "https://example.com/declared.png";
      const calls: string[] = [], asset = "assets/site-20261003000000-aaaaaaa.png";
      let omitted = 0;
      const controller = new CreationController(
        h.target(),
        v.adapter,
        async () => assert.fail("no second page resolver"),
        english,
        {
          kind: "embed",
          resolveEmbed: async () => ({ ok: true, snapshot }),
          importAsset: async (source, blockId) => {
            calls.push(source);
            assert.equal(blockId, "20261003000000-aaaaaaa");
            if (importFails) throw new Error("optional unavailable");
            return asset;
          },
          notifyMediaOmitted: () => omitted++,
        },
      );
      await controller.submit();
      assert.equal(h.inserted.length, 1);
      const md = h.root.querySelector<HTMLElement>("[data-type=NodeCustomBlock]")!.dataset.content!;
      const stored = parseOembedSnapshot(md.split("\n").slice(1).join("\n").split(";;;")[0]!);
      assert.equal(stored.card.favicon, importFails ? undefined : asset);
      assert.equal(md.includes("custom-data-assets-slc-favicon="), !importFails);
      assert.deepEqual(calls, [snapshot.card.favicon]);
      assert.equal(omitted, importFails ? 1 : 0);
      assert.equal(v.state.closed, true);
      assert.equal(snapshot.card.favicon, "https://example.com/declared.png");
    });
  }
}
test("cancel during optional oembed favicon import never inserts a late result", async () => {
  const h = editor(), v = view(), wait = deferred<string>();
  const snapshot = normalizeOembed("{\"version\":\"1.0\",\"type\":\"link\"}", url);
  snapshot.card.favicon = "https://example.com/icon.png";
  const controller = new CreationController(h.target(), v.adapter, async () => success, english, {
    kind: "embed",
    resolveEmbed: async () => ({ ok: true, snapshot }),
    importAsset: () => wait.promise,
  });
  const pending = controller.submit();
  await settle();
  controller.cancel();
  wait.resolve("assets/site-20261003000000-aaaaaaa.png");
  await pending;
  assert.equal(h.inserted.length, 0);
});

for (const kind of ["bookmark", "embed"] as const) {
  test(`${kind}: passes transient declared favicon alternatives to shared importer, only successful asset persists`, async () => {
    const h = editor(), v = view(), asset = "assets/site-20261003000000-aaaaaaa.png";
    const candidates = ["https://example.com/first.svg", "https://example.com/second.png"],
      calls: string[] = [];
    const snapshot = normalizeOembed("{\"version\":\"1.0\",\"type\":\"link\"}", url);
    snapshot.card.favicon = candidates[0]!;
    const controller = new CreationController(
      h.target(),
      v.adapter,
      async () => ({
        ok: true,
        metadata: { ...metadata, favicon: candidates[0]!, faviconCandidates: candidates },
      }),
      english,
      {
        kind,
        resolveEmbed: async () => ({ ok: true, snapshot, faviconCandidates: candidates }),
        importAsset: async source => {
          calls.push(source);
          if (source.endsWith(".svg")) throw new Error("unsupported raster");
          return asset;
        },
      },
    );
    await controller.submit();
    assert.deepEqual(calls, candidates);
    const markdown = h.root.querySelector<HTMLElement>("[data-type=NodeCustomBlock]")!.dataset.content!;
    const content = markdown.split("\n").slice(1).join("\n").split(";;;")[0]!;
    assert.equal(
      (kind === "bookmark" ? parseSnapshot(content) : parseOembedSnapshot(content)).card.favicon,
      asset,
    );
    assert.ok(markdown.includes(`custom-data-assets-slc-favicon="${asset}"`));
    assert.ok(!markdown.includes("faviconCandidates"));
    assert.ok(!markdown.includes("second.png"));
  });
}
