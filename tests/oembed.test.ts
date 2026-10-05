import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import english from "../src/i18n/en.json" with { type: "json" };
import { MAX_JSON_BYTES, retrieveJson } from "../src/metadata/http.ts";
import type { ProxyRequest, ProxyTransport } from "../src/metadata/http.ts";
import { discoverOembed } from "../src/oembed/discovery.ts";
import { normalizeOembed } from "../src/oembed/normalize.ts";
import { renderOembed } from "../src/oembed/renderer.ts";
import { resolveOembed } from "../src/oembed/resolver.ts";
import {
  InvalidOembedError,
  oembedMarkdown,
  parseOembedSnapshot,
  serializeOembedSnapshot,
} from "../src/oembed/schema.ts";
import { OembedResolutionError } from "../src/oembed/types.ts";

const document = new JSDOM("<!doctype html><p>Unchanged host</p>").window.document;
const original = "HTTPS://Example.com/source?a=%2F#original";
const final = "https://example.com/final/path";
const endpoint = "https://provider.example/api?url=https%3A%2F%2Fexample.com%2Fsource&format=json";
const alternate = (href = endpoint, type = "application/json+oembed") =>
  `<link rel='alternate' type='${type}' href='${href}'>`;
const discover = (head: string, base = final) =>
  discoverOembed(`<!doctype html><head>${head}</head>`, base, document);
const link = {
  version: "1.0",
  type: "link",
  title: "Link title",
  provider_name: "Provider",
  provider_url: "https://provider.example/",
};
const photo = { ...link, type: "photo", url: "https://images.example/photo.jpg", width: 1200, height: 800 };
const normalize = (value: unknown) => normalizeOembed(JSON.stringify(value), original);
function reply(
  body: string,
  status = 200,
  headers: Record<string, string[]> = {},
  contentType = "application/json",
): unknown {
  return {
    code: 0,
    data: { status, body, headers, bodyEncoding: "text", contentType, url: "https://ignored.example/echo" },
  };
}
function network(replies: unknown[]) {
  const requests: ProxyRequest[] = [];
  const transport: ProxyTransport = async request => {
    requests.push(request);
    assert.ok(replies.length, "unexpected retry");
    return replies.shift();
  };
  return { requests, transport };
}
function rejected(callback: () => unknown, kind: string) {
  assert.throws(callback, error => error instanceof OembedResolutionError && error.failure.kind === kind);
}
test("JSON alternate discovered; exact complete endpoint query retained", () =>
  assert.equal(discover(alternate()), endpoint));
test("relative discovery uses verified final path, not request echo or original URL", () =>
  assert.equal(discover(alternate("../api?url=x")), "https://example.com/api?url=x"));
test("verified first base resolves discovery; invalid first base ignores later bases", () => {
  assert.equal(
    discover("<base href='https://cdn.example/sub/'>" + alternate("api")),
    "https://cdn.example/sub/api",
  );
  assert.equal(
    discover("<base href='http://localhost/'><base href='https://ignored.example/'>" + alternate("api")),
    "https://example.com/final/api",
  );
});
test("first valid document-order JSON candidate; rejected candidates skipped", () =>
  assert.equal(
    discover(
      alternate("javascript:bad") + alternate("http://127.0.0.1/") + alternate(endpoint)
        + alternate("https://later.example/"),
    ),
    endpoint,
  ));
test("rel token matching is case-insensitive; MIME is precise", () =>
  assert.equal(
    discover(`<link rel='other ALTERNATE' type='APPLICATION/JSON+OEMBED' href='${endpoint}'>`),
    endpoint,
  ));
for (
  const [name, href, kind] of [
    ["invalid", "javascript:bad", "invalid-url"],
    ["blocked", "http://127.0.0.1/", "blocked-target"],
    ["credential", "https://u:p@provider.example/", "invalid-url"],
    ["missing", "", "invalid-url"],
  ]
) {
  test(`${name} endpoint rejected by existing public policy`, () =>
    assert.throws(
      () => discover(alternate(href)),
      error =>
        typeof error === "object" && error !== null && "failure" in error
        && (error.failure as { kind: string; }).kind === kind,
    ));
}
test("no discovery does not guess a registry endpoint", () =>
  rejected(() => discover("<title>Nothing</title>"), "no-discovery"));
test("XML-only is recognized, never parsed or fetched", () =>
  rejected(() => discover(alternate("https://provider.example/xml", "text/xml+oembed")), "xml-only"));
test("wrong rel or MIME is not JSON discovery", () =>
  rejected(
    () =>
      discover(
        `<link rel='icon' type='application/json+oembed' href='${endpoint}'>`
          + alternate(endpoint, "application/json"),
      ),
    "no-discovery",
  ));
test("inert discovery does not execute scripts or load source images/frames/styles", () => {
  let loads = 0;
  const dom = new JSDOM("<!doctype html><p>Host</p>", {
    runScripts: "dangerously",
    resources: {
      interceptors: [() => () => {
        loads++;
        throw new Error("unexpected resource");
      }],
    },
  });
  assert.equal(
    discoverOembed(
      `<script>window.pwned=true</script><img src='https://images.example/x'><iframe src='https://provider.example/'></iframe><link rel='stylesheet' href='https://provider.example/x.css'>`
        + alternate(),
      final,
      dom.window.document,
    ),
    endpoint,
  );
  assert.equal(dom.window.eval("window.pwned"), undefined);
  assert.equal(loads, 0);
  assert.equal(dom.window.document.body.textContent, "Host");
  dom.window.close();
});
test("link normalization is a whitelist with original destination and provider only", () => {
  const result = normalize({
    ...link,
    url: "https://untrusted.example/replacement",
    html: "<script>bad()</script>",
    css: "bad",
    onclick: "bad",
    author_name: "Ignored",
    thumbnail_url: "https://ignored.example/",
    cache_age: 0,
    unexpected: { deep: "ignored" },
  });
  assert.deepEqual(result.card, {
    version: 1,
    type: "oembed",
    url: original,
    title: "Link title",
    provider: { name: "Provider", url: "https://provider.example/" },
    resource: { kind: "link" },
  });
  assert.deepEqual(result.unknown, {});
  assert.ok(!serializeOembedSnapshot(result).includes("<script>"));
});
test("photo normalizes safe public image URL and finite positive numeric dimensions", () => {
  const result = normalize(photo);
  assert.deepEqual(result.card.resource, { kind: "photo", url: photo.url, width: 1200, height: 800 });
  assert.deepEqual(normalize({ ...photo, width: 0.5, height: 1.5 }).card.resource, {
    kind: "photo",
    url: photo.url,
    width: 0.5,
    height: 1.5,
  });
});
test("title fallback, whitespace/control bounds, literal provider markup and invalid optional provider URL", () => {
  assert.equal(normalize({ version: 1, type: "link" }).card.title, "example.com");
  const result = normalize({
    ...link,
    title: " \n <img onerror=bad()> \u0000 ",
    provider_name: "é".repeat(300),
    provider_url: "http://localhost/",
  });
  assert.equal(result.card.title, "<img onerror=bad()>");
  assert.equal(result.card.provider!.name!.length, 256);
  assert.equal(result.card.provider!.url, undefined);
  assert.equal(normalize({ ...link, title: "x".repeat(511) + "😀" }).card.title.length, 511);
});
for (const source of ["{", "null", "[]", "\"text\"", "4", "true", "\ufeff{}"]) {
  test(`malformed/nonobject JSON rejected (${source})`, () =>
    rejected(() => normalizeOembed(source, original), "invalid-response"));
}
test("256-KiB UTF-8 bound checked before parse; exact boundary accepted", () => {
  const valid = JSON.stringify({ version: "1.0", type: "link", ignored: "" });
  assert.equal(
    normalizeOembed(
      valid.replace("\"ignored\":\"\"", "\"ignored\":\"" + " ".repeat(MAX_JSON_BYTES - valid.length) + "\""),
      original,
    ).card.resource.kind,
    "link",
  );
  assert.throws(() => normalizeOembed(" ".repeat(MAX_JSON_BYTES + 1), original));
  assert.throws(() => normalize({ ...link, ignored: "é".repeat(MAX_JSON_BYTES / 2) }));
});
for (const version of [undefined, "1", "1.1", 2, null]) {
  test(`invalid protocol version ${version}`, () =>
    rejected(() => normalize({ ...link, version }), "invalid-version"));
}
test("protocol numeric 1 and string 1.0 both normalize to own integer version 1", () => {
  assert.equal(normalize({ ...link, version: 1 }).card.version, 1);
  assert.equal(normalize(link).card.version, 1);
});
for (const type of ["rich", "video", "PHOTO", "unknown", null]) {
  test(`unsupported type ${type} fails explicitly`, () =>
    rejected(
      () => normalize({ ...link, type, html: "<iframe src='https://example.com/'>" }),
      "unsupported-type",
    ));
}
for (
  const url of [
    undefined,
    "/relative",
    "data:image/png,x",
    "javascript:bad",
    "http://localhost/",
    "http://192.168.1.1/",
    "https://u:p@images.example/",
  ]
) {
  test(`invalid required photo URL ${url}`, () =>
    rejected(() => normalize({ ...photo, url }), "invalid-photo"));
}
for (const value of [undefined, 0, -1, "1200", null, Infinity, NaN]) {
  test(`invalid photo dimensions ${value}`, () => {
    rejected(() => normalize({ ...photo, width: value }), "invalid-photo");
    rejected(() => normalize({ ...photo, height: value }), "invalid-photo");
  });
}
test("bounded endpoint uses same redirect loop, GET/header policy and verified locations", async () => {
  const h = network([reply("", 302, { Location: ["/json"] }), reply(JSON.stringify(link))]);
  assert.equal(await retrieveJson(endpoint, h.transport), JSON.stringify(link));
  assert.equal(h.requests[1]!.url, "https://provider.example/json");
  for (const request of h.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, false);
    assert.equal(request.timeout, 7000);
    assert.equal(request.contentType, "application/json");
    assert.deepEqual(Object.keys(request.headers[0]!).sort(), ["Accept", "User-Agent"]);
  }
});
test("page and endpoint redirects independently revalidate targets and preserve original URL", async () => {
  const h = network([
    reply("", 302, { Location: [final] }),
    reply("<html><head>" + alternate("/oembed") + "</head></html>", 200, {}, "text/html"),
    reply("", 307, { Location: [endpoint] }),
    reply(JSON.stringify(photo)),
  ]);
  const result = await resolveOembed(original, { ...h, document });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.snapshot.card.url, original);
  assert.deepEqual(h.requests.map(x => x.url), [
    "https://example.com/source?a=%2F",
    final,
    "https://example.com/oembed",
    endpoint,
  ]);
});
for (
  const [name, replies, kind] of [
    ["blocked redirect", [reply("", 302, { Location: ["http://localhost/"] })], "redirect-error"],
    ["redirect loop", [reply("", 302, { Location: [endpoint] })], "redirect-error"],
    ["HTTP error", [reply("", 404)], "http-error"],
    ["kernel error", [{ code: 1, msg: "secret" }], "network-error"],
    ["kernel oversized", [{ code: 10 }], "response-too-large"],
    ["HTML MIME", [reply(JSON.stringify(link), 200, {}, "text/html")], "unsupported-content"],
    [
      "binary MIME",
      [reply(JSON.stringify(link), 200, {}, "application/octet-stream")],
      "unsupported-content",
    ],
    ["UTF8 oversized", [reply("é".repeat(MAX_JSON_BYTES / 2 + 1))], "response-too-large"],
  ] as const
) {
  test(`JSON transport rejects ${name}`, async () => {
    const h = network([...replies]);
    await assert.rejects(
      () => retrieveJson(endpoint, h.transport),
      error =>
        typeof error === "object" && error !== null && "failure" in error
        && (error.failure as { kind: string; }).kind === kind,
    );
  });
}
for (
  const mime of [
    "",
    "text/plain",
    "application/json; charset=utf-8",
    "application/json+oembed",
    "application/problem+json",
  ]
) {
  test(`JSON endpoint MIME policy permits ${mime || "missing"} only with subsequent strict JSON parse`, async () => {
    const h = network([reply(JSON.stringify(link), 200, {}, mime)]);
    assert.equal(await retrieveJson(endpoint, h.transport), JSON.stringify(link));
  });
}
test("no discovery means exactly one HTML request; no fallback or persistence in resolver", async () => {
  const h = network([reply("<html><title>No discovery</title></html>", 200, {}, "text/html")]);
  const result = await resolveOembed(original, { ...h, document });
  assert.deepEqual(result, { ok: false, error: { kind: "no-discovery" } });
  assert.equal(h.requests.length, 1);
});
test("cancellation after page/JSON request prevents a late normalized result", async () => {
  for (const stage of [0, 1]) {
    const abort = new AbortController();
    let calls = 0;
    const transport: ProxyTransport = async () => {
      const current = calls++;
      if (current === stage) abort.abort();
      return current === 0
        ? reply("<html>" + alternate() + "</html>", 200, {}, "text/html")
        : reply(JSON.stringify(link));
    };
    assert.deepEqual(await resolveOembed(original, { transport, document }, abort.signal), {
      ok: false,
      error: { kind: "cancelled" },
    });
    assert.equal(calls, stage + 1);
  }
});
test("deterministic snapshot roundtrip, fixed known keys, sorted unknown extensions, native namespace", () => {
  const snapshot = normalize(photo);
  snapshot.unknown = { z: { b: 1, a: 2 }, "2": true, a: "inert" };
  const source = serializeOembedSnapshot(snapshot);
  assert.equal(serializeOembedSnapshot(parseOembedSnapshot(source)), source);
  assert.ok(source.startsWith("{\n  \"version\": 1,\n  \"type\": \"oembed\",\n  \"url\":"));
  assert.ok(source.indexOf("\"resource\"") < source.indexOf("\"2\""));
  assert.ok(source.indexOf("\"2\"") < source.indexOf("\"a\": \"inert\""));
  assert.ok(source.endsWith("\n") && !source.endsWith("\n\n"));
  assert.ok(oembedMarkdown(snapshot).startsWith(";;;siyuan-link-cards/oembed\n"));
});
for (
  const patch of [
    { version: 2 },
    { type: "link-card" },
    { url: "http://localhost/" },
    { title: "" },
    { resource: { kind: "video" } },
    { resource: { kind: "photo", url: "https://images.example/x", width: 0, height: 1 } },
    { resource: { kind: "photo", url: "javascript:bad", width: 1, height: 1 } },
    { provider: { url: "http://127.0.0.1/" } },
  ]
) {
  test(`persisted snapshot revalidation ${JSON.stringify(patch)}`, () =>
    assert.throws(
      () => parseOembedSnapshot(JSON.stringify({ ...normalize(photo).card, ...patch })),
      InvalidOembedError,
    ));
}
test("snapshot limits cover UTF8, unknown depth/nonfinite and key collisions", () => {
  const snapshot = normalize(link);
  snapshot.unknown = { title: "override" };
  assert.throws(() => serializeOembedSnapshot(snapshot));
  snapshot.unknown = { deep: "é".repeat(33000) };
  assert.throws(() => serializeOembedSnapshot(snapshot));
  snapshot.unknown = { infinite: Infinity };
  assert.throws(() => serializeOembedSnapshot(snapshot));
  let deep: unknown = {};
  for (let i = 0; i < 34; i++) deep = { a: deep };
  assert.throws(() => parseOembedSnapshot(JSON.stringify({ ...snapshot.card, deep })));
});
function rendering(value: unknown = photo) {
  const dom = new JSDOM("<!doctype html><main></main>");
  const element = dom.window.document.querySelector("main")!;
  const calls: string[] = [];
  const content = serializeOembedSnapshot(normalize(value));
  let writes = 0;
  const dispose = renderOembed({
    element,
    content,
    setContent: () => {
      writes++;
      return true;
    },
  }, {
    strings: english,
    navigate: (url, event) => {
      event.preventDefault();
      calls.push(url);
    },
  });
  return { dom, element, content, dispose, calls, writes: () => writes };
}
test("link renderer own UI, protected navigation to original source, no image or provider endpoint", () => {
  const h = rendering(link);
  const anchor = h.element.querySelector("a")!;
  assert.equal(anchor.getAttribute("href"), original);
  assert.equal(anchor.target, "_blank");
  assert.equal(anchor.rel, "noopener noreferrer");
  assert.equal(anchor.referrerPolicy, "no-referrer");
  assert.equal(h.element.querySelector("img"), null);
  anchor.click();
  assert.deepEqual(h.calls, [original]);
  assert.equal(h.writes(), 0);
  h.dispose();
});
test("photo renderer normal image only; failure retains title/provider/source and never retries", () => {
  const h = rendering();
  const image = h.element.querySelector("img")!;
  assert.equal(image.src, photo.url);
  assert.equal(image.loading, "lazy");
  assert.equal(image.referrerPolicy, "no-referrer");
  image.dispatchEvent(new h.dom.window.Event("error"));
  assert.equal(h.element.querySelector("img"), null);
  assert.ok(h.element.textContent!.includes("Link title"));
  assert.ok(h.element.textContent!.includes("Provider"));
  h.element.querySelector("a")!.click();
  assert.deepEqual(h.calls, [original]);
  assert.equal(h.writes(), 0);
  h.dispose();
  h.dispose();
  assert.equal(h.element.childNodes.length, 0);
});
test("provider and persisted HTML stay text or ignored JSON; never DOM/iframes/scripts/styles/handlers", () => {
  const h = rendering({
    ...link,
    title: "<img src=x onerror=bad()>",
    provider_name: "<script>bad()</script>",
    html: "<iframe srcdoc=bad>",
  });
  assert.ok(h.element.textContent!.includes("<img src=x onerror=bad()>"));
  assert.equal(h.element.querySelector("img,script,iframe,style,[onclick],[onerror]"), null);
  const snapshot = normalize(link);
  snapshot.unknown = { html: "<script>bad()</script>" };
  renderOembed({
    element: h.element,
    content: serializeOembedSnapshot(snapshot),
    setContent: () => assert.fail("no source mutation"),
  }, { strings: english, navigate: () => {} });
  assert.equal(h.element.querySelector("script"), null);
  h.dispose();
});
test("invalid persisted media/source degrades safely without reads/writes/metadata requests", () => {
  const h = rendering();
  let fetches = 0;
  h.dom.window.fetch = async () => {
    fetches++;
    throw new Error("renderer must not fetch");
  };
  for (const url of ["http://localhost/", "javascript:bad"]) {
    renderOembed({
      element: h.element,
      content: JSON.stringify({ ...normalize(photo).card, url }),
      setContent: () => assert.fail("immutable"),
    }, { strings: english, navigate: () => assert.fail("unavailable has no destination") });
    assert.equal(h.element.querySelector("a,img"), null);
    assert.equal(h.element.textContent, english.embedUnavailable);
  }
  assert.equal(fetches, 0);
  h.dispose();
});
test("independent renderer cleanup cannot remove a later mount", () => {
  const h = rendering();
  const second = renderOembed({ element: h.element, content: h.content, setContent: () => false }, {
    strings: english,
    navigate: () => {},
  });
  h.dispose();
  assert.equal(h.element.querySelectorAll("a").length, 1);
  second();
  assert.equal(h.element.childNodes.length, 0);
});

test("link without provider/media retains the common hostname identity and keyboard source", () => {
  const withoutProvider = Object.fromEntries(
    Object.entries(link).filter(([key]) => !key.startsWith("provider_")),
  );
  const h = rendering(withoutProvider);
  const anchor = h.element.querySelector("a")!;
  assert.equal(h.element.querySelector(".slc-card__site")!.textContent, new URL(original).hostname);
  assert.equal(h.element.querySelector(".slc-card__image,.slc-card__description"), null);
  anchor.focus();
  assert.equal(h.dom.window.document.activeElement, anchor);
  anchor.dispatchEvent(new h.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  assert.deepEqual(h.calls, [original]);
  h.dispose();
});

const faviconAsset = "assets/site-20261003000000-aaaaaaa.png";
test("additive oembed-v1 favicon keeps old snapshot bytes and unknown-field roundtrip", () => {
  const old = normalize(link);
  const bytes = serializeOembedSnapshot(old);
  assert.equal(serializeOembedSnapshot(parseOembedSnapshot(bytes)), bytes);
  assert.equal(parseOembedSnapshot(bytes).card.favicon, undefined);
  const snapshot = { card: { ...old.card, favicon: faviconAsset }, unknown: { extension: { kept: true } } };
  const next = serializeOembedSnapshot(snapshot);
  assert.equal(serializeOembedSnapshot(parseOembedSnapshot(next)), next);
  assert.deepEqual(parseOembedSnapshot(next).unknown, snapshot.unknown);
  assert.equal(parseOembedSnapshot(next).card.version, 1);
  assert.equal(parseOembedSnapshot(next).card.favicon, faviconAsset);
  assert.ok(oembedMarkdown(snapshot).includes(`custom-data-assets-slc-favicon="${faviconAsset}"`));
  assert.ok(!oembedMarkdown(old).includes("custom-data-assets"));
});
for (
  const favicon of [
    "javascript:bad",
    "data:image/png;base64,x",
    "/assets/icon.png",
    "assets/../bad.png",
    null,
  ]
) {
  test(`invalid optional oembed favicon rejected ${favicon}`, () => {
    assert.throws(
      () => parseOembedSnapshot(JSON.stringify({ ...normalize(link).card, favicon })),
      InvalidOembedError,
    );
  });
}
test("older remote oembed favicon remains supported without localization during rendering", () => {
  const snapshot = {
    card: { ...normalize(link).card, favicon: "https://example.com/icon.png" },
    unknown: {},
  };
  assert.equal(parseOembedSnapshot(serializeOembedSnapshot(snapshot)).card.favicon, snapshot.card.favicon);
});
for (const response of [link, photo]) {
  test(`${response.type}: uses Bookmark metadata candidate on already fetched target page, no provider logo`, async () => {
    const head =
      `<base href="https://cdn.example/icons/"><link rel="icon" href="javascript:bad"><link rel="apple-touch-icon" href="apple.png"><link rel="icon" href="declared.png">`;
    const h = network([
      reply("<html><head>" + head + alternate() + "</head></html>", 200, {}, "text/html"),
      reply(JSON.stringify({ ...response, favicon: "https://provider.example/logo.png" })),
    ]);
    const result = await resolveOembed(original, { ...h, document });
    assert.ok(result.ok);
    assert.equal(result.snapshot.card.favicon, "https://cdn.example/icons/declared.png");
    assert.deepEqual(result.faviconCandidates, [
      "https://cdn.example/icons/declared.png",
      "https://cdn.example/icons/apple.png",
      "https://example.com/favicon.ico",
    ]);
    assert.ok(!serializeOembedSnapshot(result.snapshot).includes("faviconCandidates"));
    assert.equal(h.requests.length, 2);
  });
}
