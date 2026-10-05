import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DialogFactory } from "../src/creation/dialog.ts";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import { FaviconRepairController, openFaviconRepairDialog } from "../src/maintenance/favicon-dialog.ts";
import type { FaviconRepairResult } from "../src/maintenance/favicon-dialog.ts";
import { FaviconRepairKernel } from "../src/maintenance/favicon-kernel.ts";
import { recognizeFavicon } from "../src/maintenance/favicon.ts";
import type { Request } from "../src/migration/kernel.ts";

const id = "20261005000000-test000", root = "20261005000000-test001", box = "20261005000000-test002";
const asset = "assets/favicon-20261005000000-test003.png";
const image = "assets/preview-20261005000000-test004.png";
const raw = (type = "link-card") => ({
  version: 1,
  type,
  url: "https://example.com/article?kept=true#fragment",
  title: " Title  unchanged ",
  ...(type === "link-card"
    ? {
      description: "Two  spaces",
      image,
      siteName: " Site ",
      resolvedUrl: "https://example.com/old",
      resolvedAt: "2020-01-01T00:00:00Z",
    }
    : { provider: { name: " Site ", extra: { nested: true } }, resource: { kind: "link", extra: 7 } }),
  extension: { array: ["kept", 3], nested: { ok: true } },
  "2": "numeric unknown key",
});
const source = (value: Record<string, unknown> = raw(), blockId = id) =>
  `;;;siyuan-link-cards/${value.type}\n${JSON.stringify(value, null, 2)}\n;;;\n`
  + `{: id="${blockId}" updated="20261005000000" custom-data-assets-slc-image="${image}" custom-test="keep &amp; intact"}\n`;
const doc = new JSDOM().window.document;
function recognize(value: Record<string, unknown>, type = "NodeCustomBlock") {
  return recognizeFavicon(type, id, source(value), doc);
}
test("missing and only structurally unusable favicon eligible; existing local/remote excludes runtime failures", () => {
  for (const type of ["link-card", "oembed"]) {
    assert.equal(recognize(raw(type)).kind, "eligible");
    for (
      const favicon of ["", "assets/a.png", "data:image/png;base64,AAA=", "javascript:alert(1)", null, 7]
    ) {
      assert.equal(recognize({ ...raw(type), favicon }).kind, "eligible");
    }
    for (const favicon of [asset, "https://example.com/missing.png"]) {
      assert.equal(recognize({ ...raw(type), favicon }).kind, "usable");
    }
  }
});
test("unsupported public source, invalid/future schema and native/historical/active node exclusions", () => {
  assert.equal(recognize({ ...raw(), url: "http://127.0.0.1/private" }).kind, "unrepairable");
  for (
    const patch of [{ version: 2 }, { url: "javascript:alert(1)" }, { title: "" }, { image: "assets/a.png" }]
  ) {
    assert.equal(recognize({ ...raw(), ...patch }).kind, "invalid");
  }
  for (const type of ["NodeIFrame", "NodeHTMLBlock", "NodeVideo", "NodeAudio", "NodeCodeBlock"]) {
    assert.equal(recognize(raw(), type).kind, "ignored");
  }
  assert.equal(
    recognizeFavicon("NodeCustomBlock", id, source().replace("siyuan-link-cards", "other"), doc).kind,
    "ignored",
  );
  for (
    const bad of [
      source().replace(id, root),
      source().replace("{: id=", `{: id="${id}" id=`),
      source().replace("custom-test=\"keep &amp; intact\"", "custom-test=unquoted"),
    ]
  ) {
    assert.equal(recognizeFavicon("NodeCustomBlock", id, bad, doc).kind, "invalid");
  }
});
function harness(sources: [string, string][] = [[id, source()]]) {
  const document = new JSDOM().window.document;
  const stored = new Map(sources), backups = new Map<string, string>();
  const locations = new Map(
    sources.map(([id]) => [id, { id, root_id: root, parent_id: root, box, path: `/${root}.sy`, sort: 10 }]),
  );
  const calls: string[] = [], network: string[] = [], imports: string[] = [], writes: string[] = [];
  const history: {
    doOperations: { action: string; id: string; data: string; }[];
    undoOperations: { action: string; id: string; data: string; }[];
  }[] = [];
  let mode = "", writable = true, activeId = "", afterImport: (() => void) | undefined;
  const dom = (s: string, blockId: string) => {
    const node = document.createElement("div");
    const parts = /^;;;([^\n]+)\n([\s\S]*\n);;;\n\{:([^\n]*)\}/.exec(s)!;
    node.dataset.nodeId = blockId;
    node.dataset.type = "NodeCustomBlock";
    node.dataset.info = parts[1]!;
    node.dataset.content = parts[2]!;
    const t = document.createElement("template");
    t.innerHTML = "<div" + parts[3] + "></div>";
    for (const a of t.content.firstElementChild!.attributes) {
      if (a.name !== "id") node.setAttribute(a.name, a.value);
    }
    backups.set(node.outerHTML, s);
    return node.outerHTML;
  };
  const convert = (s: string) => dom(s, /\{: id="([^"]+)"/.exec(s)![1]!);
  const request: Request = async (path, body) => {
    calls.push(path);
    if (path === "/api/query/sql") {
      const stmt = body.stmt as string;
      assert.match(stmt, /type = 'custom'/);
      const cursor = /id > '([^']*)'/.exec(stmt)?.[1], exact = /WHERE id = '([^']*)'/.exec(stmt)?.[1];
      return {
        code: 0,
        data: [...stored.keys()].filter(key => exact ? key === exact : key > (cursor ?? "")).sort().slice(
          0,
          128,
        ).map(key => locations.get(key)),
      };
    }
    if (path === "/api/block/getBlockKramdown") {
      return stored.has(body.id as string)
        ? { code: 0, data: { id: body.id, kramdown: stored.get(body.id as string) } }
        : { code: -1 };
    }
    if (path === "/api/block/getBlockDOM") {
      return stored.has(body.id as string)
        ? { code: 0, data: { id: body.id, dom: dom(stored.get(body.id as string)!, body.id as string) } }
        : { code: -1 };
    }
    assert.equal(path, "/api/transactions", "scan permits no network/asset/write endpoints");
    const tx = (body.transactions as typeof history)[0]!;
    assert.equal(tx.doOperations.length, 1);
    assert.equal(tx.undoOperations.length, 1);
    assert.equal(tx.doOperations[0]!.action, "update");
    assert.equal(tx.undoOperations[0]!.action, "update");
    assert.equal(tx.doOperations[0]!.id, tx.undoOperations[0]!.id);
    writes.push(tx.doOperations[0]!.id);
    if (mode === "write-failure") return { code: -1 };
    history.push(tx);
    stored.set(tx.doOperations[0]!.id, backups.get(tx.doOperations[0]!.data)!);
    return { code: 0 };
  };
  const resolve = async (url: string, signal: AbortSignal) => {
    network.push(url);
    assert.equal(signal.aborted, false);
    if (mode === "discovery-failure") {
      return { ok: false as const, error: { kind: "network-error" as const } };
    }
    return {
      ok: true as const,
      metadata: {
        originalUrl: url,
        resolvedUrl: "https://example.com/NEW",
        title: "NEW title",
        description: "NEW description",
        image: "https://example.com/NEW.png",
        siteName: "NEW site",
        resolvedAt: "2030-01-01T00:00:00Z",
        favicon: "https://example.com/icon.ico",
        faviconCandidates: ["https://example.com/usable.png"],
      },
    };
  };
  const importer = async (url: string, blockId: string, signal?: AbortSignal) => {
    imports.push(url);
    assert.equal(blockId, id);
    assert.equal(signal?.aborted, false);
    if (mode === "import-failure" || url.endsWith(".ico")) throw new Error("unsupported");
    afterImport?.();
    return asset;
  };
  const kernel = new FaviconRepairKernel(
    request,
    document,
    convert,
    resolve,
    importer,
    () => writable,
    id => id === activeId,
  );
  return {
    kernel,
    request,
    document,
    convert,
    stored,
    locations,
    calls,
    network,
    imports,
    writes,
    history,
    backups,
    mode: (v: string) => {
      mode = v;
    },
    writable: (v: boolean) => {
      writable = v;
    },
    active: (v: string) => {
      activeId = v;
    },
    afterImport: (f: () => void) => {
      afterImport = f;
    },
    undo: () => {
      const op = history.at(-1)!.undoOperations[0]!;
      stored.set(op.id, backups.get(op.data)!);
    },
    redo: () => {
      const op = history.at(-1)!.doOperations[0]!;
      stored.set(op.id, backups.get(op.data)!);
    },
  };
}
for (const type of ["link-card", "oembed"]) {
  test(`${type} repair changes ONLY favicon, raw display strings and all unknown fields/IAL preserved; exact Undo/Redo`, async () => {
    const original = source(raw(type)), h = harness([[id, original]]);
    const location = structuredClone(h.locations.get(id));
    const p = await h.kernel.scan(() => true);
    assert.equal(p.candidates.length, 1);
    assert.equal(h.network.length, 0);
    assert.equal(h.imports.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(await h.kernel.repair(p.candidates[0]!, () => true), "repaired");
    const repaired = h.stored.get(id)!;
    const next = JSON.parse(repaired.split("\n").slice(1).join("\n").split("\n;;;")[0]!);
    assert.deepEqual(next, { ...raw(type), favicon: asset });
    assert.equal(
      repaired.split("\n;;;")[1],
      original.split("\n;;;")[1]!.replace("}\n", ` custom-data-assets-slc-favicon="${asset}"}\n`),
    );
    assert.deepEqual(h.locations.get(id), location);
    assert.deepEqual(h.network, [raw(type).url]);
    assert.deepEqual(h.imports, ["https://example.com/icon.ico", "https://example.com/usable.png"]);
    h.undo();
    assert.equal(h.stored.get(id), original);
    h.redo();
    assert.equal(h.stored.get(id), repaired);
    assert.equal((await h.kernel.scan(() => true)).usable, 1);
  });
}
test("aggregate preview excludes usable references, private sources, invalid schemas, other plugins and active view; no network", async () => {
  const values = [raw(), { ...raw(), favicon: asset }, { ...raw(), url: "http://127.0.0.1/" }, {
    ...raw(),
    version: 2,
  }, raw()];
  const sources: [string, string][] = values.map((r, i) => {
    const k = `20261005000000-test0${String(i).padStart(2, "0")}`;
    return [k, source(r, k)];
  });
  sources.push([
    "20261005000000-test005",
    source(raw(), "20261005000000-test005").replace("siyuan-link-cards", "other"),
  ]);
  const h = harness(sources);
  h.active(sources[4]![0]);
  const p = await h.kernel.scan(() => true);
  assert.deepEqual({ ...p, candidates: p.candidates.length }, {
    candidates: 1,
    usable: 1,
    unrepairable: 1,
    invalid: 1,
    active: 1,
    changed: 0,
  });
  assert.equal(h.network.length + h.imports.length + h.writes.length, 0);
});
for (const mode of ["discovery-failure", "import-failure", "write-failure"]) {
  test(`${mode} leaves exact original source unchanged; no retry or asset deletion`, async () => {
    const h = harness();
    h.mode(mode);
    const p = await h.kernel.scan(() => true);
    assert.equal(
      await h.kernel.repair(p.candidates[0]!, () => true),
      mode === "write-failure" ? "failed" : "unchanged",
    );
    assert.equal(h.stored.get(id), source());
    assert.equal(h.writes.length, mode === "write-failure" ? 1 : 0);
    assert.ok(!h.calls.some(p => /delete|insert|append|remove/.test(p)));
  });
}
for (const mode of ["source", "IAL", "favicon", "position", "document", "active", "readonly"]) {
  test(`changed ${mode} during import skips final write and keeps uploaded asset`, async () => {
    const h = harness();
    const p = await h.kernel.scan(() => true);
    h.afterImport(() => {
      if (mode === "source") h.stored.set(id, source({ ...raw(), title: "Edited" }));
      if (mode === "IAL") h.stored.set(id, source().replace("keep &amp; intact", "Edited"));
      if (mode === "favicon") h.stored.set(id, source({ ...raw(), favicon: asset }));
      if (mode === "position") h.locations.get(id)!.sort++;
      if (mode === "document") h.locations.get(id)!.root_id = box;
      if (mode === "active") h.active(id);
      if (mode === "readonly") h.writable(false);
    });
    assert.equal(
      await h.kernel.repair(p.candidates[0]!, () => true),
      mode === "readonly" ? "cancelled" : "changed",
    );
    assert.equal(h.writes.length, 0);
  });
}
test("changed-since-scan and existing/active snapshots cannot start discovery; invalid ID excluded", async () => {
  for (const mode of ["source", "active", "id"]) {
    const h = harness(), p = await h.kernel.scan(() => true), candidate = p.candidates[0]!;
    if (mode === "source") h.stored.set(id, source({ ...raw(), favicon: asset }));
    if (mode === "active") h.active(id);
    if (mode === "id") candidate.id = "invalid";
    assert.equal(await h.kernel.repair(candidate, () => true), "changed");
    assert.equal(h.network.length + h.imports.length + h.writes.length, 0);
  }
});
test("explicit confirm only, sequential isolation, no double confirm, cancellation stops next candidate", async () => {
  const second = "20261005000000-test005";
  const h = harness([[id, source()], [second, source(raw(), second)]]);
  let count = 0, simultaneous = 0, maximum = 0, result: FaviconRepairResult | undefined;
  const c = new FaviconRepairController({
    scan: a => h.kernel.scan(a),
    cancel: () => h.kernel.cancel(),
    repair: async () => {
      maximum = Math.max(maximum, ++simultaneous);
      await Promise.resolve();
      simultaneous--;
      return ++count === 1 ? "failed" : "repaired";
    },
  }, {
    preview: () => {},
    progress: () => {},
    result: r => {
      result = r;
    },
    error: () => assert.fail("failure isolation"),
  });
  await c.confirm();
  assert.equal(count, 0);
  await c.scan();
  assert.equal(count, 0);
  await Promise.all([c.confirm(), c.confirm()]);
  assert.equal(count, 2);
  assert.equal(maximum, 1);
  assert.equal(result?.failed, 1);
  assert.equal(result?.repaired, 1);
  const closed = harness(),
    controller = new FaviconRepairController(closed.kernel, {
      preview: () => {},
      progress: () => {},
      result: () => {},
      error: () => {},
    });
  await controller.scan();
  controller.cancel();
  await controller.confirm();
  assert.equal(closed.network.length, 0);
});
test("cancel during discovery aborts importer and writes", async () => {
  const h = harness(), p = await h.kernel.scan(() => true);
  const kernel = new FaviconRepairKernel(h.request, h.document, h.convert, async (_url, signal) => {
    kernel.cancel();
    assert.equal(signal.aborted, true);
    return { ok: false, error: { kind: "cancelled" } };
  }, async () => assert.fail("cancelled"));
  assert.equal(await kernel.repair(p.candidates[0]!, () => true), "cancelled");
  assert.equal(h.writes.length, 0);
});
test("129-row keyset preview scans entire scope without network", async () => {
  const sources: [string, string][] = Array.from({ length: 129 }, (_, i) => {
    const k = `20261005000000-t${String(i).padStart(6, "0")}`;
    return [k, source(raw(), k)];
  });
  const h = harness(sources);
  assert.equal((await h.kernel.scan(() => true)).candidates.length, 129);
  assert.equal(h.calls.filter(p => p === "/api/query/sql").length, 2);
  assert.equal(h.network.length, 0);
});
test("localized native dialog shows aggregate-only preview and explicit network warning; close aborts without writes", async () => {
  for (const strings of [english, german]) {
    const h = harness(), element = h.document.createElement("div");
    element.innerHTML = "<div class=\"slc-favicon-repair\"></div>";
    let options: { destroyCallback?: () => void; } | undefined;
    const close = openFaviconRepairDialog(
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
    await new Promise(r => setTimeout(r, 0));
    assert.equal(element.querySelectorAll("dd").length, 6);
    assert.equal(element.querySelectorAll("dd")[0]!.textContent, "1");
    assert.equal(element.querySelector("p")!.textContent, strings.faviconRepairNotice);
    assert.ok(!element.textContent!.includes(raw().url));
    assert.ok(!element.textContent!.includes(raw().title));
    const confirm = element.querySelectorAll("button")[1]!;
    assert.equal(confirm.disabled, false);
    assert.equal(confirm.textContent, strings.faviconRepairConfirmOne);
    assert.equal(h.network.length, 0);
    close();
    confirm.click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(h.network.length, 0);
  }
});

test("structurally unusable favicon and stale own reference replaced; unrelated asset reference intact", async () => {
  const original = source({ ...raw(), favicon: "assets/bad.png" }).replace(
    " custom-test=",
    " custom-data-assets-slc-favicon=\"assets/bad.png\" custom-test=",
  );
  const h = harness([[id, original]]), p = await h.kernel.scan(() => true);
  assert.equal(await h.kernel.repair(p.candidates[0]!, () => true), "repaired");
  const repaired = h.stored.get(id)!;
  assert.equal((repaired.match(/custom-data-assets-slc-favicon=/g) ?? []).length, 1);
  assert.ok(repaired.includes(`custom-data-assets-slc-image="${image}"`));
  assert.ok(!repaired.includes("assets/bad.png"));
  h.undo();
  assert.equal(h.stored.get(id), original);
});
test("inconsistent DOM/source or malformed converted identity cannot write", async () => {
  for (const mode of ["original", "converted"]) {
    const h = harness(), p = await h.kernel.scan(() => true);
    const request: Request = async (path, body) => {
      const result = await h.request(path, body);
      if (mode === "original" && path === "/api/block/getBlockDOM") {
        const data = result.data as { dom: string; };
        data.dom = data.dom.replace("data-content=", "data-wrong=");
      }
      return result;
    };
    const kernel = new FaviconRepairKernel(
      request,
      h.document,
      md => h.convert(md).replace(id, root),
      async () => ({
        ok: true,
        metadata: {
          originalUrl: raw().url,
          resolvedUrl: raw().url,
          title: "ignored",
          siteName: "ignored",
          resolvedAt: "2020-01-01T00:00:00Z",
          favicon: "https://example.com/icon.png",
        },
      }),
      async () => asset,
    );
    assert.equal(
      await kernel.repair(p.candidates[0]!, () => true),
      mode === "original" ? "changed" : "failed",
    );
    assert.equal(h.writes.length, 0);
  }
});
test("closing while a submitted update finishes prevents the next sequential repair", async () => {
  const second = "20261005000000-test005", h = harness([[id, source()], [second, source(raw(), second)]]);
  let controller: FaviconRepairController;
  controller = new FaviconRepairController({
    scan: a => h.kernel.scan(a),
    cancel: () => h.kernel.cancel(),
    repair: async (candidate, a) => {
      const outcome = await h.kernel.repair(candidate, a);
      controller.cancel();
      return outcome;
    },
  }, { preview: () => {}, progress: () => {}, result: () => assert.fail("closed"), error: () => {} });
  await controller.scan();
  await controller.confirm();
  assert.deepEqual(h.writes, [id]);
  assert.equal(h.network.length, 1);
});

test("repair preserves unrelated original JSON bytes, nested favicon fields and unusual numeric spelling", async () => {
  const base = source({
    ...raw(),
    extension: { number: 0, favicon: "nested stays", punctuation: "} , \\\" favicon \\\" : [" },
  });
  for (
    const original of [
      base.replace("\"number\": 0", "\"number\": -0"),
      base.replace("\"number\": 0", "\"number\": 1e-07").replace(
        "\"type\": \"link-card\",",
        "\"type\": \"link-card\",\n  \"favicon\": {\"unusable\": [1,{\"nested\":true}]},",
      ),
    ]
  ) {
    const h = harness([[id, original]]), p = await h.kernel.scan(() => true);
    assert.equal(await h.kernel.repair(p.candidates[0]!, () => true), "repaired");
    const repaired = h.stored.get(id)!;
    assert.ok(repaired.includes("\"favicon\": \"nested stays\""));
    assert.ok(
      repaired.includes(original.includes("\"number\": -0") ? "\"number\": -0" : "\"number\": 1e-07"),
    );
    assert.ok(repaired.includes("\"punctuation\": \"} , \\\\\\\" favicon \\\\\\\" : [\""));
    h.undo();
    assert.equal(h.stored.get(id), original);
  }
});
