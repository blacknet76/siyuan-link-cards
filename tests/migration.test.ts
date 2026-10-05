import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Dialog } from "siyuan";
import type { AssetImporter } from "../src/assets/service.ts";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import { MigrationController } from "../src/migration/controller.ts";
import { openMigrationDialog } from "../src/migration/dialog.ts";
import { MigrationKernel } from "../src/migration/kernel.ts";
import type { Preview, Request } from "../src/migration/kernel.ts";
import { recognizeLegacy } from "../src/migration/legacy.ts";
import { BLOCK_INFO, serializeSnapshot } from "../src/schema.ts";
import { PNG } from "./asset-fixtures.ts";

const id = "20261003000000-aaaaaaa";
const legacy = (patch: Record<string, unknown> = {}, blockId = id) =>
  "```embed\n" + Object.entries({
    title: "Titel: Unicode ä \\\"",
    image: "https://example.com/image.png",
    description: "Beschreibung",
    url: "https://example.com/article?a=b#c",
    favicon: "https://example.com/favicon.ico",
    aspectRatio: "75.5",
    ...patch,
  }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")
  + `\n\x60\x60\x60\n{: id="${blockId}" updated="20261003000000" custom-test="keep"}\n`;

for (
  const [variant, patch] of [
    ["imageDescription", {}],
    ["descriptionOnly", { image: "" }],
    ["imageOnly", { description: "" }],
    ["titleOnly", { image: "", description: "" }],
  ] as const
) {
  test(`recognizes and maps ${variant}`, () => {
    const result = recognizeLegacy("NodeCodeBlock", legacy(patch));
    assert.equal(result.kind, "confirmed");
    if (result.kind !== "confirmed") return;
    assert.equal(result.variant, variant);
    assert.equal(result.snapshot.card.url, "https://example.com/article?a=b#c");
    assert.equal(result.snapshot.card.siteName, "example.com");
    assert.equal(result.snapshot.card.title, "Titel: Unicode ä \\\"");
    assert.equal(Boolean(result.snapshot.card.image), !Object.hasOwn(patch, "image"));
    assert.equal(Boolean(result.snapshot.card.description), !Object.hasOwn(patch, "description"));
    assert.equal(result.snapshot.card.favicon, "https://example.com/favicon.ico");
    for (const key of ["aspectRatio", "resolvedUrl", "resolvedAt"]) assert.ok(!(key in result.snapshot.card));
    assert.deepEqual(result.snapshot.unknown, {});
    assert.equal(recognizeLegacy("NodeCodeBlock", legacy(patch)).kind, "confirmed");
    assert.equal(result.markdown, recognizeConfirmed(legacy(patch)).markdown);
    assert.ok(result.markdown.endsWith(`{: id="${id}" updated="20261003000000" custom-test="keep"}\n`));
  });
}
function recognizeConfirmed(source: string) {
  const result = recognizeLegacy("NodeCodeBlock", source);
  assert.equal(result.kind, "confirmed");
  if (result.kind !== "confirmed") throw new Error("fixture");
  return result;
}
test("five fields, empty optional strings, order independence and deterministic serialization", () => {
  const source = legacy({ image: "", description: "", favicon: "" }).replace("aspectRatio: \"75.5\"\n", "");
  const result = recognizeConfirmed(source);
  assert.deepEqual(Object.keys(result.snapshot.card), ["version", "type", "url", "title", "siteName"]);
  const lines = source.split("\n");
  const reordered = [lines[0], ...lines.slice(1, 6).reverse(), ...lines.slice(6)].join("\n");
  assert.equal(recognizeConfirmed(reordered).markdown, result.markdown);
});
for (
  const [label, source] of [
    ["malformed YAML", legacy().replace("title: \"", "title: ")],
    ["duplicate field", legacy().replace("image:", "title:")],
    ["missing URL", legacy().replace(/^url:.*\n/m, "")],
    ["missing required empty field", legacy().replace(/^image:.*\n/m, "")],
    ["invalid URL", legacy({ url: "file:///etc/passwd" })],
    ["private URL", legacy({ url: "http://127.0.0.1/" })],
    ["unrelated mapping", "```embed\nfoo: \"bar\"\n```\n"],
    ["null", legacy({ description: null })],
    ["number", legacy({ aspectRatio: 75 })],
    ["invalid ratio", legacy({ aspectRatio: "Infinity" })],
    ["native validator title limit", legacy({ title: "a".repeat(513) })],
    ["native validator description limit", legacy({ description: "a".repeat(4097) })],
    ["nested YAML", legacy().replace("title:", " title:")],
    ["tags and anchors", legacy().replace("title: \"", "title: &anchor \"")],
    ["oversized UTF8", legacy({ description: "ä".repeat(33000) })],
    ["trailing block", legacy() + "other block\n"],
  ] as const
) {
  test(`rejects ${label} safely`, () =>
    assert.equal(recognizeLegacy("NodeCodeBlock", source).kind, "rejected"));
}
test("exact language and block type; native blocks are ignored", () => {
  for (const language of ["Embed", "embed yaml", "yaml", "embed "]) {
    assert.equal(
      recognizeLegacy("NodeCodeBlock", legacy().replace("```embed", "```" + language)).kind,
      "ignored",
    );
  }
  assert.equal(recognizeLegacy("NodeParagraph", legacy()).kind, "ignored");
  assert.equal(recognizeLegacy("NodeCustomBlock", recognizeConfirmed(legacy()).markdown).kind, "ignored");
});
test("unknown scalar fields are classified separately without persisting them; prototype keys inert", () => {
  for (const field of ["extra", "__proto__", "constructor"]) {
    const result = recognizeLegacy("NodeCodeBlock", legacy({ [field]: "preserve for review" }));
    assert.deepEqual(result, { kind: "unknown", fields: [field] });
  }
});

function harness(sources = [legacy()], writable: () => boolean = () => true, importer?: AssetImporter) {
  const document = new JSDOM().window.document;
  const stored = new Map(sources.map(source => [/{: id="([^"]+)"/.exec(source)![1]!, source]));
  const calls: string[] = [], writes: string[] = [];
  let fail = "", beforeRead: (() => void) | undefined;
  const convert = (markdown: string) => {
    const block = document.createElement("div");
    block.dataset.nodeId = /{: id="([^"]+)"/.exec(markdown)![1]!;
    block.dataset.type = "NodeCustomBlock";
    block.dataset.info = BLOCK_INFO;
    for (
      const match of (markdown.match(/^\{:[^\n]*\}/m)?.[0] ?? "").matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)
    ) block.setAttribute(match[1]!, match[2]!);
    block.dataset.content = /^;;;[^\n]+\n([\s\S]*?)\n;;;/.exec(markdown)![1]! + "\n";
    return block.outerHTML;
  };
  const request: Request = async (path, body) => {
    calls.push(path);
    if (path === "/api/query/sql") {
      const cursor = /id > '([^']*)'/.exec(body.stmt as string)![1]!;
      return {
        code: 0,
        data: [...stored].filter(([key, source]) => key > cursor && source.startsWith("```"))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, 128).map(([id]) => ({ id })),
      };
    }
    if (path === "/api/block/getBlockKramdown") {
      beforeRead?.();
      beforeRead = undefined;
      return stored.has(body.id as string)
        ? { code: 0, data: { id: body.id, kramdown: stored.get(body.id as string) } }
        : { code: -1 };
    }
    if (path === "/api/block/getBlockDOM") {
      const source = stored.get(body.id as string);
      if (!source) return { code: -1 };
      return {
        code: 0,
        data: {
          id: body.id,
          dom: source.startsWith(";;;")
            ? convert(source)
            : `<div data-node-id="${body.id}" data-type="NodeCodeBlock" custom-test="keep"></div>`,
        },
      };
    }
    assert.equal(path, "/api/transactions", "migration must use no resolver/remote endpoint");
    const tx =
      (body.transactions as { doOperations: { id: string; data: string; }[]; undoOperations: unknown[]; }[])[
        0
      ]!;
    const op = tx.doOperations[0]!;
    writes.push(op.id);
    assert.equal(tx.undoOperations.length, 1);
    if (op.id === fail) return { code: -1 };
    const template = document.createElement("template");
    template.innerHTML = op.data;
    const block = template.content.firstElementChild as HTMLElement;
    assert.equal(block.dataset.nodeId, op.id);
    const attrs = Array.from(block.attributes).filter(attr => !attr.name.startsWith("data-"))
      .map(attr => `${attr.name}="${attr.value}"`).join(" ");
    stored.set(op.id, `;;;${BLOCK_INFO}\n${block.dataset.content};;;\n{: id="${op.id}" ${attrs}}\n`);
    return { code: 0, data: [tx] };
  };
  const kernel = new MigrationKernel(request, document, convert, writable, importer);
  return {
    kernel,
    request,
    document,
    stored,
    writes,
    calls,
    fail: (id: string) => {
      fail = id;
    },
    beforeRead: (callback: () => void) => {
      beforeRead = callback;
    },
  };
}
test("scan is read-only; same source eligible, official update+undo supplied, second scan idempotent", async () => {
  const h = harness();
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(preview.candidates[0]!.source, legacy());
  assert.equal(preview.candidates[0]!.content, serializeSnapshot(recognizeConfirmed(legacy()).snapshot));
  assert.equal(await h.kernel.migrate(preview.candidates[0]!, () => true), "migrated");
  assert.equal(h.writes.length, 1);
  assert.equal((await h.kernel.scan(() => true)).candidates.length, 0);
  assert.ok(h.calls.every(path => !/forwardProxy|oembed|network/i.test(path)));
});
test("changed text or IAL since scan skipped immediately before submission", async () => {
  for (
    const transform of [
      (s: string) => s.replace("Beschreibung", "Edited"),
      (s: string) => s.replace("keep", "edited"),
    ]
  ) {
    const h = harness();
    const candidate = (await h.kernel.scan(() => true)).candidates[0]!;
    h.beforeRead(() => h.stored.set(id, transform(legacy())));
    assert.equal(await h.kernel.migrate(candidate, () => true), "changed");
    assert.equal(h.writes.length, 0);
  }
});
test("deleted block fails safely without writing", async () => {
  const h = harness();
  const candidate = (await h.kernel.scan(() => true)).candidates[0]!;
  h.stored.delete(id);
  assert.equal(await h.kernel.migrate(candidate, () => true), "failed");
  assert.equal(h.writes.length, 0);
});
test("all counts are actual; unrelated and unknown fields stay untouched", async () => {
  const ids = [id, "20261003000000-bbbbbbb", "20261003000000-ccccccc"];
  const unknown = legacy({ extra: "review" }, ids[1]);
  const unrelated = legacy({}, ids[2]).replace(/^title:.*\n/m, "");
  const h = harness([legacy(), unknown, unrelated]);
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.unknown, 1);
  assert.equal(preview.rejected, 1);
  await h.kernel.migrate(preview.candidates[0]!, () => true);
  assert.equal(h.stored.get(ids[1]!), unknown);
  assert.equal(h.stored.get(ids[2]!), unrelated);
});
test("scan pages beyond the kernel default and a full page", async () => {
  const h = harness(
    Array.from({ length: 129 }, (_, i) => legacy({}, `20261003000000-${i.toString(36).padStart(7, "0")}`)),
  );
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 129);
  assert.equal(h.calls.filter(path => path === "/api/query/sql").length, 2);
});
test("identity mismatch from official converter prevents writes", async () => {
  const h = harness();
  const bad = new MigrationKernel(h.request, h.document, () => "<div></div>");
  await assert.rejects(bad.scan(() => true));
  assert.equal(h.writes.length, 0);
});
const view = () => {
  const previews: Preview[] = [], results: unknown[] = [];
  return {
    previews,
    results,
    preview: (p: Preview) => {
      previews.push(p);
    },
    progress: () => {},
    result: (r: unknown) => {
      results.push(r);
    },
    error: () => {
      results.push("error");
    },
  };
};
test("cancel before confirmation means zero writes, late confirmation inert", async () => {
  const h = harness(), v = view(), c = new MigrationController(h.kernel, v);
  await c.scan();
  c.cancel();
  await c.confirm();
  assert.equal(h.writes.length, 0);
});
test("duplicate confirm guarded; failure isolated; no automatic retry", async () => {
  const second = "20261003000000-bbbbbbb";
  const h = harness([legacy(), legacy({}, second)]), v = view(), c = new MigrationController(h.kernel, v);
  h.fail(id);
  await c.scan();
  await Promise.all([c.confirm(), c.confirm()]);
  assert.deepEqual(h.writes, [id, second]);
  assert.deepEqual(v.results, [{
    migrated: 1,
    changed: 0,
    failed: 1,
    skipped: 0,
    fully: 0,
    localMedia: 0,
    omittedMedia: 1,
    titleFallback: 0,
  }]);
});
test("close during reread stops current and all subsequent writes", async () => {
  const h = harness([legacy(), legacy({}, "20261003000000-bbbbbbb")]);
  const c = new MigrationController(h.kernel, view());
  await c.scan();
  h.beforeRead(() => c.cancel());
  await c.confirm();
  assert.equal(h.writes.length, 0);
});
test("readonly transition stops submission", async () => {
  let writable = true;
  const h = harness([legacy()], () => writable);
  const candidate = (await h.kernel.scan(() => true)).candidates[0]!;
  h.beforeRead(() => {
    writable = false;
  });
  assert.equal(await h.kernel.migrate(candidate, () => true), "cancelled");
  assert.equal(h.writes.length, 0);
});
test("API acceptance without a persisted conversion is never reported as success", async () => {
  const h = harness();
  const candidate = (await h.kernel.scan(() => true)).candidates[0]!;
  const checked = new MigrationKernel(
    (path, body) => path === "/api/transactions" ? Promise.resolve({ code: 0 }) : h.request(path, body),
    h.document,
    () => {
      const block = h.document.createElement("div");
      block.dataset.nodeId = id;
      block.dataset.type = "NodeCustomBlock";
      block.dataset.info = BLOCK_INFO;
      block.dataset.content = candidate.content;
      return block.outerHTML;
    },
  );
  assert.equal(await checked.migrate(candidate, () => true), "failed");
  assert.equal(h.stored.get(id), legacy());
});
test("closed operation starts no next write after a submitted transaction finishes", async () => {
  const h = harness([legacy(), legacy({}, "20261003000000-bbbbbbb")]);
  let c: MigrationController;
  const service = {
    cancel: () => h.kernel.cancel(),
    scan: (active: () => boolean) => h.kernel.scan(active),
    migrate: async (candidate: Parameters<MigrationKernel["migrate"]>[0], active: () => boolean) => {
      const outcome = await h.kernel.migrate(candidate, active);
      c.cancel();
      return outcome;
    },
  } as MigrationKernel;
  const v = view();
  c = new MigrationController(service, v);
  await c.scan();
  await c.confirm();
  assert.equal(h.writes.length, 1);
  assert.equal(v.results.length, 0);
});
test("no candidates disables confirmation and performs zero writes", async () => {
  const h = harness([]), v = view(), c = new MigrationController(h.kernel, v);
  await c.scan();
  await c.confirm();
  assert.equal(v.previews[0]!.candidates.length, 0);
  assert.equal(h.writes.length, 0);
});
test("native dialog EN/DE preview, private source absent, every destroy path cancels synchronously", async () => {
  for (const strings of [english, german]) {
    const h = harness();
    let dialog: Dialog;
    const close = openMigrationDialog(
      h.kernel,
      options => {
        const element = h.document.createElement("div");
        element.innerHTML = options.content!;
        h.document.body.append(element);
        dialog = {
          element,
          destroy: () => {
            element.remove();
            options.destroyCallback?.();
          },
        } as unknown as Dialog;
        return dialog;
      },
      strings,
      () => {},
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.document.body.textContent!.includes(strings.migrationFound));
    assert.ok(!h.document.body.textContent!.includes("https://example.com"));
    assert.ok(!h.document.body.textContent!.includes("Titel: Unicode"));
    const confirm = dialog!.element.querySelectorAll("button")[1]!;
    assert.equal(confirm.disabled, false);
    close();
    confirm.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.writes.length, 0);
  }
});

test("literal TAB is an unambiguous flat string, other controls/ambiguous syntax stay rejected", () => {
  const source = legacy().replace("Beschreibung", "literal\tTAB");
  assert.equal(recognizeConfirmed(source).snapshot.card.description, "literal TAB");
  for (const bad of ["\u0001", "\n", "\r"]) {
    assert.equal(recognizeLegacy("NodeCodeBlock", legacy().replace("Beschreibung", bad)).kind, "rejected");
  }
});
test("empty title falls back only to validated hostname with no metadata request", () => {
  const result = recognizeConfirmed(legacy({ title: " " }));
  assert.equal(result.snapshot.card.title, "example.com");
  assert.equal(result.titleFallback, true);
});
test("optional malformed/unsafe/SVG media degrades the card instead of rejecting it", () => {
  for (
    const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AA==",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "file:///image.png",
    ]
  ) {
    const result = recognizeConfirmed(legacy({ image: value, favicon: value }));
    assert.equal(result.omittedMedia, 2);
    assert.ok(!result.snapshot.card.image && !result.snapshot.card.favicon);
  }
});
test("four PNG favicon fixtures plan imports without scan writes; real outcome uses local refs", async () => {
  let imports = 0;
  const h = harness(
    Array.from(
      { length: 4 },
      (_, index) =>
        legacy({ image: "", favicon: "data:image/png;base64," + PNG }, `20261003000000-aaaaaa${index}`),
    ),
    () => true,
    async () => {
      imports++;
      return "assets/slc-synthetic-20261003000000-aaaaaaa.png";
    },
  );
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 4);
  assert.equal(preview.categories.localMedia, 4);
  assert.equal(imports, 0);
  for (const candidate of preview.candidates) {
    assert.equal(await h.kernel.migrate(candidate, () => true), "migrated");
    assert.equal(h.kernel.mediaResults.get(candidate.id)?.imported, 1);
    assert.ok(h.stored.get(candidate.id)!.includes("custom-data-assets-slc-favicon=\"assets/"));
  }
  assert.equal(imports, 4);
  assert.ok(h.calls.every(p => !p.includes("network")));
});
test("validated PNG data image retains the planned image variant without downloading during scan", async () => {
  const h = harness([legacy({ image: "data:image/png;base64," + PNG })]);
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.variants.imageDescription, 1);
  assert.equal(preview.categories.localMedia, 1);
  assert.ok(h.calls.every(p => !p.includes("network") && !p.includes("upload")));
});
test("SVG omission, title fallback and optional upload failure are separate actual summary flags", async () => {
  const h = harness(
    [legacy({
      image: "data:image/svg+xml;base64,PHN2Zy8+",
      favicon: "data:image/png;base64," + PNG,
      title: "",
    })],
    () => true,
    async () => {
      throw new Error("upload failed");
    },
  );
  const v = view(), controller = new MigrationController(h.kernel, v);
  await controller.scan();
  await controller.confirm();
  assert.deepEqual(v.results, [{
    migrated: 1,
    fully: 0,
    localMedia: 0,
    omittedMedia: 1,
    titleFallback: 1,
    changed: 0,
    failed: 0,
    skipped: 0,
  }]);
  assert.ok(h.stored.get(id)!.includes("\"title\": \"example.com\""));
  assert.ok(!h.stored.get(id)!.includes("data:image"));
});
test("changed source stops asset import before it starts; close aborts an in-progress import", async () => {
  let imported = 0;
  const h = harness([legacy({ favicon: "data:image/png;base64," + PNG })], () => true, async () => {
    imported++;
    return "assets/slc-test-20261003000000-aaaaaaa.png";
  });
  const preview = await h.kernel.scan(() => true);
  h.stored.set(id, legacy({ title: "Changed" }));
  assert.equal(await h.kernel.migrate(preview.candidates[0]!, () => true), "changed");
  assert.equal(imported, 0);
  let started: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const other = harness(
    [legacy({ image: "", favicon: "data:image/png;base64," + PNG })],
    () => true,
    async (_source, _id, signal) => {
      started!();
      return new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      );
    },
  );
  const candidate = (await other.kernel.scan(() => true)).candidates[0]!;
  const pending = other.kernel.migrate(candidate, () => true);
  await ready;
  other.kernel.cancel();
  await pending;
  assert.equal(other.writes.length, 0);
});
