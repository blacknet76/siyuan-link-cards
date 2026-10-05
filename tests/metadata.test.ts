import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMetadata } from "../src/metadata/extract.ts";
import { kernelTransport, MAX_HTML_BYTES, retrieveHtml } from "../src/metadata/http.ts";
import type { ProxyRequest, ProxyTransport } from "../src/metadata/http.ts";
import { resolveBookmark } from "../src/metadata/resolver.ts";
import { ResolutionError } from "../src/metadata/types.ts";
import type { ResolutionResult } from "../src/metadata/types.ts";
import { publicHttpUrl } from "../src/metadata/url-policy.ts";
import { parseSnapshot, serializeSnapshot } from "../src/schema.ts";

const document = new JSDOM("<!doctype html><p>Host unchanged</p>").window.document;
const url = "https://example.com/articles/page";
const html = "<!doctype html><html><head><title>Title</title></head><body>Public page</body></html>";
const now = () => new Date("2026-10-02T12:00:00.000Z");
function response(
  body = html,
  status = 200,
  headers: Record<string, string[]> = {},
  contentType = "text/html",
): unknown {
  return {
    code: 0,
    msg: "",
    data: { body, bodyEncoding: "text", status, headers, contentType, url: "https://untrusted.example/echo" },
  };
}
function sequence(replies: unknown[]) {
  const requests: ProxyRequest[] = [];
  const transport: ProxyTransport = async request => {
    requests.push(request);
    assert.ok(replies.length, "unexpected extra request / retry");
    return replies.shift();
  };
  return { transport, requests };
}
async function run(replies: unknown[], target = url) {
  const h = sequence(replies);
  const result = await resolveBookmark(target, { transport: h.transport, document, now });
  return { ...h, result };
}
function success(result: ResolutionResult) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected success");
  return result.metadata;
}
function failure(result: ResolutionResult, kind: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.error.kind, kind);
  assert.ok(!("metadata" in result));
  return result.error;
}
function extract(head: string, base = url) {
  return extractMetadata(`<!doctype html><html><head>${head}</head><body></body></html>`, base, document);
}
function meta(key: string, content: string) {
  return `<meta property="${key}" content="${content}">`;
}

test("public HTTPS accepted", () => assert.equal(publicHttpUrl(url).href, url));
test("public HTTP accepted", () => assert.equal(publicHttpUrl("http://example.com/").protocol, "http:"));
test("malformed absolute targets rejected before any request", async () => {
  for (
    const target of [
      "bad",
      "/relative",
      "https:example.com",
      "https://",
      "https://example.com\\path",
      "https://example.com/a b",
      "https://example.com/" + "ä".repeat(1000),
    ]
  ) {
    const h = await run([], target);
    failure(h.result, "invalid-url");
    assert.equal(h.requests.length, 0);
  }
});
test("credentials rejected", () => {
  for (const target of ["https://u:p@example.com/", "https://@example.com/", "http://user@example.com/"]) {
    assert.throws(() => publicHttpUrl(target), ResolutionError);
  }
});
for (
  const [name, targets] of Object.entries({
    localhost: [
      "http://localhost",
      "http://LOCALHOST.",
      "http://a.localhost",
      "http://localhost.localdomain",
    ],
    "IPv4 loopback spellings": [
      "http://127.0.0.1",
      "http://127.1",
      "http://2130706433",
      "http://0x7f000001",
      "http://0177.0.0.1",
    ],
    "IPv6 loopback": ["http://[::1]", "http://[0:0:0:0:0:0:0:1]", "http://[::ffff:127.0.0.1]"],
    "private IPv4": [
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://100.64.1.1",
    ],
    "link-local literals": ["http://169.254.1.1", "http://[fe80::1]"],
    "unspecified and local-only targets": [
      "http://0.0.0.0",
      "http://[::]",
      "http://[fc00::1]",
      "http://router",
      "http://printer.local",
      "http://service.internal",
      "http://router.home.arpa",
      "http://example.test",
    ],
    "special-use literals": [
      "http://224.1.1.1",
      "http://192.0.2.1",
      "http://[2001:db8::1]",
      "http://[2002:7f00:1::1]",
      "http://[2001::1]",
      "http://[64:ff9b::a00:1]",
    ],
  })
) {
  test(`${name} rejected without requests`, async () => {
    for (const target of targets) {
      const h = await run([], target);
      failure(h.result, "blocked-target");
      assert.equal(h.requests.length, 0);
    }
  });
}
test("unsupported schemes rejected", () => {
  for (
    const target of [
      "file:///a",
      "data:text/html,a",
      "javascript:alert(1)",
      "blob:https://example.com/a",
      "ftp://example.com",
    ]
  ) {
    assert.throws(() => publicHttpUrl(target), ResolutionError);
  }
});
test("ordinary public IP literals and IDN accepted", () => {
  for (const target of ["https://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://bücher.de/"]) {
    assert.ok(publicHttpUrl(target));
  }
});

test("no redirect: fixed GET, timeout, independent original URL and final URL", async () => {
  const original = "HTTPS://Example.com/articles/page#section";
  const h = await run([response()], original);
  const m = success(h.result);
  assert.equal(m.originalUrl, original);
  assert.equal(m.resolvedUrl, url);
  assert.equal(m.resolvedAt, now().toISOString());
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], {
    url,
    method: "GET",
    timeout: 7000,
    redirect: false,
    contentType: "text/html",
    responseEncoding: "text",
    headers: [{
      Accept: "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5",
      "User-Agent": "SiYuan-Link-Cards/0.1.0",
    }],
  });
});
test("one absolute redirect records the final URL rather than API echo or og:url", async () => {
  const final = "https://example.net/final";
  const h = await run([
    response("", 301, { Location: [final] }),
    response(meta("og:url", "https://wrong.example/") + html),
  ]);
  assert.equal(success(h.result).originalUrl, url);
  assert.equal(success(h.result).resolvedUrl, final);
});
test("relative redirect resolves against the current document path", async () => {
  const h = await run([response("", 302, { lOcAtIoN: ["../new?x=1"] }), response()]);
  assert.equal(success(h.result).resolvedUrl, "https://example.com/new?x=1");
});
test("three allowed redirects and all standard GET redirect statuses", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const h = await run([
      response("", status, { Location: ["/one"] }),
      response("", 307, { Location: ["/two"] }),
      response("", 308, { Location: ["/three"] }),
      response(),
    ]);
    assert.equal(success(h.result).resolvedUrl, "https://example.com/three");
    assert.equal(h.requests.length, 4);
  }
});
test("fourth redirect rejected before requesting its destination", async () => {
  const h = await run([1, 2, 3, 4].map(i => response("", 302, { Location: [`/${i}`] })));
  assert.equal(failure(h.result, "redirect-error").reason, "limit");
  assert.equal(h.requests.length, 4);
});
test("redirect loops include canonical and fragment-only spellings", async () => {
  for (const location of [url, "HTTPS://EXAMPLE.COM:443/articles/page", "#fragment"]) {
    const h = await run([response("", 302, { Location: [location] })]);
    assert.equal(failure(h.result, "redirect-error").reason, "loop");
    assert.equal(h.requests.length, 1);
  }
});
test("blocked redirect destinations are never requested", async () => {
  for (const target of ["http://localhost", "http://10.0.0.1", "http://[::1]"]) {
    const h = await run([response("", 302, { Location: [target] })]);
    assert.equal(failure(h.result, "redirect-error").reason, "blocked-target");
    assert.equal(h.requests.length, 1);
  }
});
test("missing/ambiguous/invalid Location fails safely", async () => {
  for (
    const headers of [{}, { Location: [] }, { Location: ["/a", "/b"] }, { Location: [""] }, {
      Location: ["/a\r\nX: value"],
    }]
  ) {
    const h = await run([response("", 302, headers)]);
    failure(h.result, "redirect-error");
    assert.equal(h.requests.length, 1);
  }
  for (const target of ["javascript:alert(1)", "https://u:p@example.com", "https://", "data:text/html,x"]) {
    const h = await run([response("", 302, { Location: [target] })]);
    assert.equal(failure(h.result, "redirect-error").reason, "invalid-url");
  }
});
test("SDK wrapper uses only fixed local endpoint, disables raw messages, forwards cancellation", async () => {
  const controller = new AbortController();
  const h = sequence([response()]);
  await retrieveHtml(url, h.transport);
  const calls: unknown[][] = [];
  const transport = kernelTransport(async (...args) => {
    calls.push(args);
    return response();
  });
  await transport(h.requests[0]!, controller.signal);
  assert.equal(calls[0]![0], "/api/network/forwardProxy");
  assert.deepEqual(calls[0]![2], { "Content-Type": "application/json" });
  assert.equal(calls[0]![3], false);
  assert.equal(calls[0]![4], controller.signal);
});
test("SiYuan API failure is distinct from target HTTP failure and hides raw errors", async () => {
  const h = await run([{ code: 8, msg: "secret kernel detail", data: null }]);
  assert.deepEqual(failure(h.result, "network-error"), { kind: "network-error" });
  const big = await run([{ code: 10, msg: "too large", data: null }]);
  failure(big.result, "response-too-large");
});
test("target HTTP failures do not parse or retry", async () => {
  for (const status of [304, 403, 404, 500]) {
    const h = await run([response("not HTML", status)]);
    assert.equal(failure(h.result, "http-error").httpStatus, status);
    assert.equal(h.requests.length, 1);
  }
});
test("transport rejection and malformed kernel responses are network failures", async () => {
  const rejected = await resolveBookmark(url, {
    document,
    transport: async () => {
      throw new Error("private error");
    },
  });
  assert.deepEqual(failure(rejected, "network-error"), { kind: "network-error" });
  for (
    const reply of [null, "HTML", { code: 0, data: {} }, {
      code: 0,
      data: { status: 200, body: html, bodyEncoding: "base64" },
    }]
  ) {
    failure((await run([reply])).result, "network-error");
  }
});
test("2 MiB UTF-8 HTML bound is inclusive and checked before parsing", async () => {
  const padded = html + " ".repeat(MAX_HTML_BYTES - html.length);
  success((await run([response(padded)])).result);
  failure((await run([response(padded + " ")])).result, "response-too-large");
  failure((await run([response(html + "界".repeat(750_000))])).result, "response-too-large");
});
test("obvious binary/non HTML rejected despite misleading headers", async () => {
  for (
    const [body, mime] of [
      ["%PDF-1.7", "text/html"],
      ["GIF89a", "text/html"],
      [html, "image/png"],
      [html, "application/octet-stream"],
      ["{\"title\":1}", "application/json"],
      ["PK\u0003\u0004", "text/plain"],
    ]
  ) {
    failure((await run([response(body, 200, {}, mime)])).result, "unsupported-content");
  }
});
test("usable HTML with missing or imperfect type; normal XHTML", async () => {
  for (
    const mime of [
      "",
      "text/plain",
      "application/unknown",
      "Text/HTML; charset=utf-8",
      "application/xhtml+xml",
    ]
  ) {
    success((await run([response(html, 200, {}, mime)])).result);
  }
  failure((await run([response("just untyped text", 200, {}, "")])).result, "unsupported-content");
  failure((await run([response("", 204)])).result, "unsupported-content");
});

test("OG title wins over Twitter and HTML", () =>
  assert.equal(
    extract(meta("og:title", "OG") + meta("twitter:title", "Twitter") + "<title>HTML</title>").title,
    "OG",
  ));
test("Twitter title fallback", () =>
  assert.equal(
    extract(meta("og:title", " ") + meta("twitter:title", "Twitter") + "<title>HTML</title>").title,
    "Twitter",
  ));
test("HTML title fallback", () => assert.equal(extract("<title>HTML</title>").title, "HTML"));
test("hostname title fallback", () => assert.equal(extract("").title, "example.com"));
test("OG description wins", () =>
  assert.equal(
    extract(
      meta("og:description", "OG") + meta("twitter:description", "Twitter") + meta("description", "HTML"),
    ).description,
    "OG",
  ));
test("Twitter description fallback", () =>
  assert.equal(
    extract(meta("twitter:description", "Twitter") + meta("description", "HTML")).description,
    "Twitter",
  ));
test("standard meta description fallback", () =>
  assert.equal(extract("<meta name=\"description\" content=\"HTML\">").description, "HTML"));
test("missing description omitted", () => assert.ok(!("description" in extract(""))));
test("secure OG image preferred", () =>
  assert.equal(
    extract(
      meta("og:image", "/normal.jpg") + meta("og:image:secure_url", "https://cdn.example.com/secure.jpg"),
    ).image,
    "https://cdn.example.com/secure.jpg",
  ));
test("invalid secure image falls back to OG image", () =>
  assert.equal(
    extract(meta("og:image:secure_url", "javascript:alert(1)") + meta("og:image", "/og.jpg")).image,
    "https://example.com/og.jpg",
  ));
test("Twitter image fallback", () =>
  assert.equal(
    extract(meta("twitter:image", "//cdn.example.com/twitter.jpg")).image,
    "https://cdn.example.com/twitter.jpg",
  ));
test("relative image resolves against final document directory", () =>
  assert.equal(
    extract(meta("og:image", "images/a.jpg"), "https://example.net/path/page").image,
    "https://example.net/path/images/a.jpg",
  ));
test("invalid/local resource addresses are dropped", () => {
  for (
    const value of [
      "javascript:alert(1)",
      "data:image/png,x",
      "file:///a",
      "blob:https://example.com/a",
      "https://u:p@example.com/a",
      "http://localhost/a",
      "http://10.0.0.1/a",
      "https://",
      "\u0001https://example.com/image.jpg",
    ]
  ) {
    assert.equal(extract(meta("og:image", value)).image, undefined);
  }
});
test("OG site name", () => assert.equal(extract(meta("og:site_name", "My Site")).siteName, "My Site"));
test("hostname site fallback uses final host", () =>
  assert.equal(extract("", "https://example.net/final").siteName, "example.net"));
test("declared standard icon in document order, ahead of Apple fallback", () => {
  assert.equal(
    extract(
      "<link rel=\"apple-touch-icon\" href=\"/apple.png\"><link rel=\"shortcut icon\" href=\"https://cdn.example.com/icon.ico\"><link rel=\"icon\" href=\"/later.ico\">",
    ).favicon,
    "https://cdn.example.com/icon.ico",
  );
});
test("relative favicon and invalid first icon", () =>
  assert.equal(
    extract("<link rel=\"icon\" href=\"data:x\"><link rel=\"ICON\" href=\"../icon.ico\">").favicon,
    "https://example.com/icon.ico",
  ));
test("Apple icon fallback before favicon.ico candidate", () =>
  assert.equal(
    extract("<link rel=\"apple-touch-icon\" href=\"/apple.png\">").favicon,
    "https://example.com/apple.png",
  ));
test("favicon.ico fallback uses final origin", () =>
  assert.equal(extract("", "https://example.net/path").favicon, "https://example.net/favicon.ico"));
test("base href affects relative resources but not final network URL or icon fallback", () => {
  const m = extract(
    "<base href=\"https://cdn.example.com/assets/\"><link rel=\"icon\" href=\"icons/a.ico\">"
      + meta("og:image", "image.jpg"),
  );
  assert.equal(m.image, "https://cdn.example.com/assets/image.jpg");
  assert.equal(m.favicon, "https://cdn.example.com/assets/icons/a.ico");
  assert.equal(
    extract("<base href=\"https://cdn.example.com/assets/\">").favicon,
    "https://example.com/favicon.ico",
  );
});
test("relative base and invalid first base ignored safely", () => {
  assert.equal(
    extract("<base href=\"../assets/\">" + meta("og:image", "a.jpg")).image,
    "https://example.com/assets/a.jpg",
  );
  for (const value of ["javascript:alert(1)", "http://localhost/", "https://u:p@example.com/", "https://"]) {
    assert.equal(
      extract(`<base href="${value}"><base href="https://cdn.example.com/">` + meta("og:image", "a.jpg"))
        .image,
      "https://example.com/articles/a.jpg",
    );
  }
});
test("entities decoded naturally without repeated plain-text decoding", () => {
  assert.equal(extract(meta("og:title", "Fish &amp; Chips &#x1F41F;")).title, "Fish & Chips 🐟");
  assert.equal(extract(meta("og:title", "&amp;lt;literal&amp;gt;")).title, "&lt;literal&gt;");
});
test("whitespace and empty duplicate metadata normalized", () => {
  assert.equal(extract(meta("og:title", " ") + meta("OG:TITLE", "  A&#10; B&#9; C  ")).title, "A B C");
});
test("metadata markup stripped to plain strings; host DOM unchanged", () => {
  const before = document.documentElement.outerHTML;
  const m = extract(
    meta("og:title", "&lt;b&gt;Title&lt;/b&gt;&lt;script&gt;bad()&lt;/script&gt;")
      + meta("og:description", "&lt;img src=x onerror=bad()&gt;Description"),
  );
  assert.equal(m.title, "Title");
  assert.equal(m.description, "Description");
  assert.equal(document.documentElement.outerHTML, before);
});
test("native inert template parses scripts/images/frames without executing or loading", () => {
  let requests = 0;
  const host = new JSDOM("<!doctype html><p>Host</p>", {
    resources: {
      interceptors: [() => () => {
        requests++;
        throw new Error("Unexpected resource request");
      }],
    },
    runScripts: "dangerously",
  });
  const before = host.window.document.documentElement.outerHTML;
  const m = extractMetadata(
    "<title>Safe</title><script>document.body.textContent=\"changed\"</script><img src=\"https://example.com/a\"><iframe src=\"https://example.com/b\"></iframe><link rel=\"stylesheet\" href=\"https://example.com/c\">",
    url,
    host.window.document,
  );
  assert.equal(m.title, "Safe");
  assert.equal(requests, 0);
  assert.equal(host.window.document.documentElement.outerHTML, before);
  host.window.close();
});
test("normalization bounds match existing snapshot schema without splitting surrogate pairs", () => {
  const m = extract(
    meta("og:title", "x".repeat(511) + "🐟tail") + meta("og:description", "x".repeat(5000))
      + meta("og:site_name", "x".repeat(300)),
  );
  assert.equal(m.title.length, 511);
  assert.equal(m.description!.length, 4096);
  assert.equal(m.siteName.length, 256);
  parseSnapshot(serializeSnapshot({ card: { version: 1, type: "link-card", url, ...m }, unknown: {} }));
});
test("sparse metadata produces a schema-compatible fallback", async () => {
  const m = success((await run([response("<html><body>Small page</body></html>")])).result);
  assert.equal(m.title, "example.com");
  assert.equal(m.siteName, "example.com");
  const { originalUrl, ...fields } = m;
  parseSnapshot(
    serializeSnapshot({ card: { version: 1, type: "link-card", url: originalUrl, ...fields }, unknown: {} }),
  );
});
test("clock used only after successful HTML extraction; failures have no persistence capability", async () => {
  let clockCalls = 0;
  const h = sequence([{ code: 8, msg: "error" }]);
  const result = await resolveBookmark(url, {
    document,
    transport: h.transport,
    now: () => {
      clockCalls++;
      return now();
    },
  });
  failure(result, "network-error");
  assert.equal(clockCalls, 0);
  // Services contain no block/editor write callback; failed result is data only.
  assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
});
test("HTML parser failure returns structured parse-error", async () => {
  const result = await resolveBookmark(url, {
    transport: async () => response(),
    document: {
      implementation: {
        createHTMLDocument() {
          throw new Error("internal");
        },
      },
    } as never,
  });
  assert.deepEqual(failure(result, "parse-error"), { kind: "parse-error" });
});
test("parallel operations have independent redirect state", async () => {
  const first = sequence([response("", 302, { Location: ["/one"] }), response()]);
  const second = sequence([response("", 302, { Location: ["/two"] }), response()]);
  const [a, b] = await Promise.all([
    resolveBookmark(url, { transport: first.transport, document, now }),
    resolveBookmark(url, { transport: second.transport, document, now }),
  ]);
  assert.equal(success(a).resolvedUrl, "https://example.com/one");
  assert.equal(success(b).resolvedUrl, "https://example.com/two");
});
test("cancellation before request and while awaiting cannot return late success", async () => {
  const before = new AbortController();
  before.abort();
  const h = sequence([]);
  failure(await resolveBookmark(url, { document, transport: h.transport, now }, before.signal), "cancelled");
  assert.equal(h.requests.length, 0);
  const during = new AbortController();
  let complete!: (value: unknown) => void;
  const pending = resolveBookmark(url, {
    document,
    transport: () =>
      new Promise(resolve => {
        complete = resolve;
      }),
    now,
  }, during.signal);
  during.abort();
  complete(response());
  failure(await pending, "cancelled");
});

test("favicon candidates preserve existing priority, include declared raster alternatives, deduplicate and bound", () => {
  const metadata = extract(
    "<link rel=\"apple-touch-icon\" href=\"/apple.png\"><link rel=\"icon\" href=\"/primary.svg\"><link rel=\"icon\" href=\"/next.png\"><link rel=\"icon\" href=\"/next.png\"><link rel=\"icon\" href=\"http://localhost/bad.png\">",
  );
  assert.equal(metadata.favicon, "https://example.com/primary.svg");
  assert.deepEqual(metadata.faviconCandidates, [
    "https://example.com/primary.svg",
    "https://example.com/next.png",
    "https://example.com/apple.png",
    "https://example.com/favicon.ico",
  ]);
  assert.equal(
    extract(Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/${i}.png">`).join(""))
      .faviconCandidates!.length,
    8,
  );
});
