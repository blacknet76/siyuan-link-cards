import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DialogFactory } from "../src/creation/dialog.ts";
import { NATIVE_YOUTUBE_STYLE, nativeYoutubeSource } from "../src/creation/youtube.ts";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import type { Request } from "../src/migration/kernel.ts";
import { openYoutubeMigrationDialog, YoutubeMigrationController } from "../src/migration/youtube-dialog.ts";
import type { YoutubeMigrationResult } from "../src/migration/youtube-dialog.ts";
import { YoutubeMigrationKernel } from "../src/migration/youtube-kernel.ts";
import { recognizeHistoricalYoutube } from "../src/migration/youtube-legacy.ts";

const id = "20260514000000-audit00", root = "20260514000000-audit01", box = "20260514000000-audit02";
const video = "M7lc1UVf-VE", url = `https://www.youtube.com/watch?v=${video}`;
const iframe =
  `<iframe width="200" height="113" src="https://www.youtube.com/embed/${video}?feature=oembed" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen="" title="Synthetic video"></iframe>`;
const legacy = (blockId = id) =>
  `<div>${iframe}</div>\n{: id="${blockId}" updated="20260514000000" custom-oembed-link="${url}" custom-test="keep &amp; intact"}\n`;
const document = new JSDOM().window.document;
function recognize(source = legacy(), type = "NodeHTMLBlock") {
  return recognizeHistoricalYoutube(type, id, source, document);
}
test("exact historical signature extracts matching identity and delegates all target policy to canonical builder", () => {
  const r = recognize();
  assert.equal(r.kind, "confirmed");
  if (r.kind !== "confirmed") return;
  assert.equal(r.videoId, video);
  assert.equal(r.sourceUrl, url);
  assert.equal(r.markdown, nativeYoutubeSource(url, video) + legacy().split("\n")[1] + "\n");
  assert.equal(r.attributes["custom-test"], "keep & intact");
  assert.ok(!r.markdown.includes("feature=oembed"));
});
const invalid: [string, (s: string) => string][] = [
  ["missing marker", s => s.replace(` custom-oembed-link="${url}"`, "")],
  ["wrong ID", s => s.replace(`id="${id}"`, `id="${root}"`)],
  ["duplicate IAL", s => s.replace("{: id=", "{: id=\"" + id + "\" id=")],
  ["style override", s => s.replace("{: id=", "{: style=\"height:1px\" id=")],
  ["missing wrapper", s => s.replace("<div>", "").replace("</div>", "")],
  ["outer executable attribute", s => s.replace("<div>", "<div onclick=\"alert(1)\">")],
  ["script", s => s.replace("</div>", "<script>alert(1)</script></div>")],
  ["second frame", s => s.replace("</div>", iframe + "</div>")],
  ["text composition", s => s.replace("</div>", "ambiguous</div>")],
  ["comment", s => s.replace("<div>", "<div><!-- extra -->")],
  ["malformed nesting", s => s.replace("</iframe>", "")],
  [
    "self closing",
    s => s.replace("</iframe>", "").replace("title=\"Synthetic video\">", "title=\"Synthetic video\"/>"),
  ],
  ["duplicate src", s => s.replace("width=\"200\"", "src=\"" + url + "\" width=\"200\"")],
  ["unquoted attribute", s => s.replace("width=\"200\"", "width=200")],
  ["srcdoc", s => s.replace("width=\"200\"", "srcdoc=\"text\" width=\"200\"")],
  ["event", s => s.replace("width=\"200\"", "onload=\"alert(1)\" width=\"200\"")],
  ["non YouTube", s => s.replace("www.youtube.com/embed/", "player.vimeo.com/video/")],
  ["spoofed host", s => s.replace("www.youtube.com/embed/", "www.youtube.com.evil.example/embed/")],
  ["HTTP", s => s.replace("https://www.youtube.com/embed/", "http://www.youtube.com/embed/")],
  ["credentials", s => s.replace("https://www.youtube.com/embed/", "https://user@www.youtube.com/embed/")],
  ["dot segments", s => s.replace("/embed/", "/other/../embed/")],
  ["encoded ID", s => s.replace("/embed/M7", "/embed/%4D7")],
  ["invalid ID", s => s.replace(`/embed/${video}`, "/embed/short")],
  ["mismatched marker", s => s.replace("watch?v=" + video, "watch?v=abcdefghijk")],
  ["arbitrary query", s => s.replace("?feature=oembed", "?autoplay=1")],
  ["duplicate query", s => s.replace("?feature=oembed", "?feature=oembed&feature=oembed")],
  ["fragment", s => s.replace("?feature=oembed", "#fragment")],
  ["unexpected capability", s => s.replace("allow=\"accelerometer;", "allow=\"camera; accelerometer;")],
];
for (const [name, transform] of invalid) {
  test(`historical false positive/malformed rejection: ${name}`, () =>
    assert.notEqual(recognize(transform(legacy())).kind, "confirmed"));
}
for (const type of ["NodeIFrame", "NodeCustomBlock", "NodeCodeBlock", "NodeWidget", "NodeVideo"]) {
  test(`existing ${type} excluded even with a copied historical marker`, () =>
    assert.equal(recognize(legacy(), type).kind, "ignored"));
}
test("bookmark HTML, migrated Link Card and recent video-v1 are excluded", () => {
  assert.equal(
    recognize(legacy().replace(`<div>${iframe}</div>`, "<div class=\"kg-bookmark-card\">passive</div>")).kind,
    "ignored",
  );
  for (const info of ["siyuan-link-cards/link-card", "siyuan-link-cards/oembed"]) {
    assert.equal(recognize(`;;;${info}\n{}\n;;;\n`, "NodeCustomBlock").kind, "ignored");
  }
});

function harness(sources: [string, string][] = [[id, legacy()]], writable = () => true) {
  const doc = new JSDOM().window.document;
  const stored = new Map(sources);
  const locations = new Map(
    sources.map(([id]) => [id, { id, root_id: root, parent_id: root, box, path: `/${root}.sy`, sort: 10 }]),
  );
  const calls: string[] = [], writes: string[] = [];
  const backups = new Map<string, string>();
  const history: {
    doOperations: { action: string; id: string; data: string; }[];
    undoOperations: { action: string; id: string; data: string; }[];
  }[] = [];
  const referenceTargets = [{ kind: "static", id }, { kind: "dynamic", id }];
  let fail = "", beforeRead: (() => void) | undefined;
  const dom = (source: string, blockId: string) => {
    const node = doc.createElement("div");
    node.dataset.nodeId = blockId;
    const ial = /\n\{:([^\n]*)\}/.exec(source)?.[1] ?? "";
    const attr = doc.createElement("template");
    attr.innerHTML = "<div" + ial + "></div>";
    for (const a of attr.content.firstElementChild!.attributes) {
      if (a.name !== "id") node.setAttribute(a.name, a.value);
    }
    node.dataset.type = source.startsWith("<iframe") ? "NodeIFrame" : "NodeHTMLBlock";
    const payload = source.slice(0, source.indexOf("\n{:")).trim();
    if (node.dataset.type === "NodeHTMLBlock") {
      const html = doc.createElement("protyle-html");
      html.setAttribute("data-content", payload);
      node.append(html);
    } else {
      const t = doc.createElement("template");
      t.innerHTML = payload;
      const frame = t.content.firstElementChild!;
      node.setAttribute("style", frame.getAttribute("style")!);
      frame.removeAttribute("style");
      node.append(frame);
    }
    backups.set(node.outerHTML, source);
    return node.outerHTML;
  };
  const convert = (source: string) => dom(source, /\{: id="([^"]+)"/.exec(source)![1]!);
  const request: Request = async (path, body) => {
    calls.push(path);
    if (path === "/api/query/sql") {
      const stmt = body.stmt as string;
      assert.ok(stmt.startsWith("SELECT "));
      const cursor = /id > '([^']*)'/.exec(stmt)?.[1];
      const exact = /WHERE id = '([^']*)'/.exec(stmt)?.[1];
      return {
        code: 0,
        data: [...stored].filter(([_key, s]) => s.startsWith("<div>") || s.startsWith("<div ")).filter((
          [key],
        ) => exact ? key === exact : key > (cursor ?? ""))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, 128).map(([key]) => locations.get(key)),
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
      return stored.has(body.id as string)
        ? { code: 0, data: { id: body.id, dom: dom(stored.get(body.id as string)!, body.id as string) } }
        : { code: -1 };
    }
    assert.equal(path, "/api/transactions", "no provider/metadata/upload endpoint permitted");
    const tx = (body.transactions as typeof history)[0]!;
    assert.equal(tx.doOperations.length, 1);
    assert.equal(tx.undoOperations.length, 1);
    assert.equal(tx.doOperations[0]!.action, "update");
    assert.equal(tx.undoOperations[0]!.action, "update");
    assert.equal(tx.doOperations[0]!.id, tx.undoOperations[0]!.id);
    writes.push(tx.doOperations[0]!.id);
    if (fail === tx.doOperations[0]!.id) return { code: -1 };
    history.push(tx);
    stored.set(tx.doOperations[0]!.id, backups.get(tx.doOperations[0]!.data)!);
    return { code: 0 };
  };
  return {
    kernel: new YoutubeMigrationKernel(request, doc, convert, writable),
    request,
    doc,
    convert,
    stored,
    locations,
    calls,
    writes,
    history,
    referenceTargets,
    beforeRead: (f: () => void) => {
      beforeRead = f;
    },
    fail: (value: string) => {
      fail = value;
    },
    undo: () => {
      const tx = history.at(-1)!;
      stored.set(tx.undoOperations[0]!.id, backups.get(tx.undoOperations[0]!.data)!);
    },
    redo: () => {
      const tx = history.at(-1)!;
      stored.set(tx.doOperations[0]!.id, backups.get(tx.doOperations[0]!.data)!);
    },
  };
}
test("read-only scan + canonical update preserves identity, IAL, reference targets; exact Undo/Redo and idempotency", async () => {
  const h = harness();
  const original = legacy(),
    refs = structuredClone(h.referenceTargets),
    location = structuredClone(h.locations.get(id));
  const preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.unsupported, 0);
  assert.equal(preview.changed, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(await h.kernel.migrate(preview.candidates[0]!, () => true), "migrated");
  assert.equal(h.stored.get(id), nativeYoutubeSource(url, video) + legacy().split("\n")[1] + "\n");
  assert.deepEqual(h.locations.get(id), location);
  assert.deepEqual(h.referenceTargets, refs);
  assert.equal((await h.kernel.scan(() => true)).candidates.length, 0);
  h.undo();
  assert.equal(h.stored.get(id), original);
  assert.equal((await h.kernel.scan(() => true)).candidates.length, 1);
  h.redo();
  assert.ok(h.stored.get(id)?.startsWith("<iframe"));
  assert.deepEqual(h.referenceTargets, refs);
});
for (
  const [name, change] of [
    ["source", (s: string) => s.replace("Synthetic video", "Edited")],
    ["IAL", (s: string) => s.replace("keep &amp; intact", "edited")],
    ["video ID", (s: string) => s.replaceAll(video, "abcdefghijk")],
  ] as const
) {
  test(`changed ${name} since scan skips without write`, async () => {
    const h = harness(), candidate = (await h.kernel.scan(() => true)).candidates[0]!;
    h.beforeRead(() => h.stored.set(id, change(legacy())));
    assert.equal(await h.kernel.migrate(candidate, () => true), "changed");
    assert.equal(h.writes.length, 0);
  });
}
test("document move since scan skips; altered/deleted identity and readonly cannot write", async () => {
  for (const mode of ["move", "position", "delete", "identity", "readonly"]) {
    let writable = true;
    const h = harness(undefined, () => writable),
      candidate = (await h.kernel.scan(() => true)).candidates[0]!;
    if (mode === "move") h.locations.get(id)!.root_id = box;
    if (mode === "position") h.locations.get(id)!.sort++;
    if (mode === "delete") h.stored.delete(id);
    if (mode === "identity") candidate.id = "invalid";
    if (mode === "readonly") writable = false;
    assert.notEqual(await h.kernel.migrate(candidate, () => true), "migrated");
    assert.equal(h.writes.length, 0);
  }
});
test("unsupported marker HTML counted, unrelated/native content excluded; source changing during scan counted", async () => {
  const second = "20260514000000-audit03";
  const h = harness([[id, legacy().replace("www.youtube.com/embed/", "player.vimeo.com/video/")], [
    second,
    legacy(second),
  ]]);
  const p = await h.kernel.scan(() => true);
  assert.equal(p.unsupported, 1);
  assert.equal(p.candidates.length, 1);
  const only = harness();
  let step = 0;
  const changing = new YoutubeMigrationKernel(
    async (path, body) => {
      if (path === "/api/block/getBlockKramdown" && ++step === 2) {
        only.stored.set(
          id,
          legacy().replace("Synthetic video", "changed"),
        );
      }
      return only.request(path, body);
    },
    only.doc,
    only.convert,
  );
  assert.equal((await changing.scan(() => true)).changed, 1);
  assert.equal(h.writes.length, 0);
});
test("sequential explicit confirm isolates a failure, has no retry and cannot be double-confirmed", async () => {
  const second = "20260514000000-audit03";
  const h = harness([[id, legacy()], [second, legacy(second)]]);
  h.fail(id);
  let result: YoutubeMigrationResult | undefined;
  const c = new YoutubeMigrationController(h.kernel, {
    preview: () => {},
    progress: () => {},
    result: r => {
      result = r;
    },
    error: () => assert.fail("isolated failure must not abort"),
  });
  await c.confirm();
  assert.equal(h.writes.length, 0);
  await c.scan();
  assert.equal(h.writes.length, 0);
  await Promise.all([c.confirm(), c.confirm()]);
  assert.deepEqual(h.writes, [id, second]);
  assert.deepEqual(result, { migrated: 1, changed: 0, failed: 1, unsupported: 0 });
});
test("closed preview and unload/close during scanning never start writes", async () => {
  const h = harness();
  let preview = 0;
  const c = new YoutubeMigrationController(h.kernel, {
    preview: () => {
      preview++;
    },
    progress: () => {},
    result: () => {},
    error: () => {},
  });
  const scan = c.scan();
  c.cancel();
  await scan;
  await c.confirm();
  assert.equal(preview, 0);
  assert.equal(h.writes.length, 0);
});
test("cancel after a submitted update completes it but stops subsequent candidates", async () => {
  const second = "20260514000000-audit03";
  const h = harness([[id, legacy()], [second, legacy(second)]]);
  let c: YoutubeMigrationController;
  const k = new YoutubeMigrationKernel(
    async (path, body) => {
      if (path === "/api/transactions") c.cancel();
      return h.request(path, body);
    },
    h.doc,
    h.convert,
  );
  c = new YoutubeMigrationController(k, {
    preview: () => {},
    progress: () => {},
    result: () => assert.fail("closed"),
    error: () => {},
  });
  await c.scan();
  await c.confirm();
  assert.deepEqual(h.writes, [id]);
});
test("malformed conversion with wrong ID, attrs or geometry fails before writing", async () => {
  for (
    const mutate of [
      (s: string) => s.replace(id, root),
      (s: string) => s.replace("NodeIFrame", "NodeHTMLBlock"),
      (s: string) => s.replace("sandbox=", "srcdoc="),
      (s: string) => s.replace(NATIVE_YOUTUBE_STYLE, "height:1px;"),
    ]
  ) {
    const h = harness(), candidate = (await h.kernel.scan(() => true)).candidates[0]!;
    const k = new YoutubeMigrationKernel(h.request, h.doc, md => mutate(h.convert(md)));
    assert.equal(await k.migrate(candidate, () => true), "failed");
    assert.equal(h.writes.length, 0);
  }
});
test("localized preview exposes only counts, requires explicit click, closes safely", async () => {
  for (const strings of [english, german]) {
    const h = harness();
    let options: { destroyCallback?: () => void; } | undefined;
    const element = h.doc.createElement("div");
    element.innerHTML = "<div class=\"slc-youtube-migration\"></div>";
    h.doc.body.append(element);
    const close = openYoutubeMigrationDialog(
      h.kernel,
      o => {
        options = o;
        return {
          element,
          destroy: () => {
            options?.destroyCallback?.();
            element.remove();
          },
        } as unknown as ReturnType<DialogFactory>;
      },
      strings,
      () => {},
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(element.querySelector("dl")!.textContent!, /1/);
    assert.ok(!element.textContent!.includes(url));
    assert.ok(!element.textContent!.includes("Synthetic video"));
    assert.equal(h.writes.length, 0);
    assert.equal(element.querySelectorAll("button")[1]!.disabled, false);
    assert.equal(element.querySelectorAll("button")[1]!.textContent, strings.youtubeMigrationConfirmOne);
    close();
    element.querySelectorAll("button")[1]?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.writes.length, 0);
  }
});

test("keyset scan includes every matching block beyond the SQL default/page limit", async () => {
  const sources: [string, string][] = Array.from({ length: 129 }, (_, i) => {
    const id = `20260514000000-a${String(i).padStart(6, "0")}`;
    return [id, legacy(id)];
  });
  const h = harness(sources), preview = await h.kernel.scan(() => true);
  assert.equal(preview.candidates.length, 129);
  assert.equal(new Set(preview.candidates.map(c => c.id)).size, 129);
  assert.equal(h.calls.filter(p => p === "/api/query/sql").length, 2);
  assert.equal(h.writes.length, 0);
});
test("inconsistent original DOM payload cannot become an eligible migration or undo backup", async () => {
  const h = harness(), candidate = (await h.kernel.scan(() => true)).candidates[0]!;
  const request: Request = async (path, body) => {
    const result = await h.request(path, body);
    if (path === "/api/block/getBlockDOM") {
      const data = result.data as { id: string; dom: string; };
      data.dom = data.dom.replace("protyle-html", "wrong-html");
    }
    return result;
  };
  const k = new YoutubeMigrationKernel(request, h.doc, h.convert);
  assert.equal((await k.scan(() => true)).unsupported, 1);
  assert.equal(await k.migrate(candidate, () => true), "changed");
  assert.equal(h.writes.length, 0);
});
