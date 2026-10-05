import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import { normalizeOembed } from "../src/oembed/normalize.ts";
import { renderOembed } from "../src/oembed/renderer.ts";
import { resolveOembed } from "../src/oembed/resolver.ts";
import { parseOembedSnapshot, serializeOembedSnapshot } from "../src/oembed/schema.ts";
import { OembedResolutionError } from "../src/oembed/types.ts";
import { youtubeEmbedUrl, youtubePlaybackAllowed, youtubeSourceId } from "../src/oembed/youtube.ts";

const id = "M7lc1UVf-VE";
const original = `https://www.youtube.com/watch?v=${id}`;
const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(original)}`;
const context = { resolvedUrl: original, endpoint };
const data = {
  version: "1.0",
  type: "video",
  title: "YouTube Developers Live",
  provider_name: "YouTube",
  provider_url: "https://www.youtube.com/",
  width: 200,
  height: 113,
  thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  thumbnail_width: 480,
  thumbnail_height: 360,
  html: "<iframe src='https://evil.example/' srcdoc='<script>bad()</script>' allow='autoplay'></iframe>",
};
const normalize = (patch = {}, source = original, verification = context) =>
  normalizeOembed(JSON.stringify({ ...data, ...patch }), source, verification);
function invalid(callback: () => unknown, kind = "invalid-video") {
  assert.throws(callback, error => error instanceof OembedResolutionError && error.failure.kind === kind);
}
for (
  const source of [
    original,
    `https://youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `${original}&t=42&si=Public_share`,
    `${original}&feature=youtu.be`,
    `https://youtu.be/${id}?si=Public_share&t=1m2s`,
  ]
) {
  test(`supported source identity ${source}`, () => {
    assert.equal(youtubeSourceId(source), id);
    assert.equal(normalize({}, source).card.url, source);
  });
}
for (
  const source of [
    "https://youtube.com/",
    `https://www.youtube.com/x/../watch?v=${id}`,
    `https://www.youtube.com/%2e/watch?v=${id}`,
    "https://www.youtube.com/watch",
    `${original}&v=${id}`,
    `${original}&v=other`,
    `https://www.youtube.com/watch?v=${id}%2F`,
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${id}x`,
    `https://www.youtube.com/watch?v=${id.slice(0, 10)}!`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/live/${id}`,
    `${original}&list=PL123`,
    `${original}&index=2`,
    `${original}&autoplay=1`,
    `${original}#t=1`,
    `${original}&t=oops`,
    `${original}&t=1&t=2`,
    `${original}&si=`,
    `${original}&feature=evil`,
    `https://youtu.be/${id}/extra`,
    `https://youtu.be/${id}/`,
    `https://youtu.be/${id}?v=${id}`,
    `http://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com:444/watch?v=${id}`,
    `https://u:p@www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com.evil.example/watch?v=${id}`,
    `https://youtube.example/watch?v=${id}`,
    `https://youtube.com@evil.example/watch?v=${id}`,
    `https://www.yоutube.com/watch?v=${id}`,
    `https://www.youtube.com./watch?v=${id}`,
  ]
) {
  test(`unsupported or ambiguous source ${source}`, () => {
    assert.equal(youtubeSourceId(source), undefined);
    assert.throws(() => normalize({}, source)); // Shared URL policy may reject before video classification.
  });
}
test("video whitelist discards provider HTML, policy, autoplay, author and useless video dimensions", () => {
  const snapshot = normalize({ embed_url: "https://evil.example/", autoplay: true, sandbox: "allow-popups" });
  assert.deepEqual(snapshot.card, {
    version: 1,
    type: "oembed",
    url: original,
    title: data.title,
    provider: { name: "YouTube", url: "https://www.youtube.com/" },
    resource: {
      kind: "video",
      provider: "youtube",
      videoId: id,
      thumbnail: { url: data.thumbnail_url, width: 480, height: 360 },
    },
  });
  assert.deepEqual(snapshot.unknown, {});
  assert.ok(!serializeOembedSnapshot(snapshot).includes("iframe"));
});
for (
  const patch of [
    { provider_name: "Vimeo" },
    { provider_name: "youtube" },
    { provider_name: "YouTube " },
    { provider_url: "https://youtube.com.evil.example/" },
    { provider_url: "http://www.youtube.com/" },
    { provider_url: "https://www.youtube.com/channel/a" },
    { provider_url: null },
  ]
) test(`spoofed provider data rejected ${JSON.stringify(patch)}`, () => invalid(() => normalize(patch)));
for (
  const verification of [
    { ...context, endpoint: "https://evil.example/oembed" },
    { ...context, endpoint: endpoint.replace("www.youtube.com/oembed", "youtube.com/oembed") },
    { ...context, endpoint: endpoint + "&format=json" },
    { ...context, endpoint: endpoint.replace(id, "aaaaaaaaaaa") },
    { ...context, resolvedUrl: "https://evil.example/" },
    { ...context, resolvedUrl: original.replace(id, "aaaaaaaaaaa") },
  ]
) {
  test(`verified discovery/final identity required ${JSON.stringify(verification)}`, () =>
    invalid(() => normalize({}, original, verification)));
}
test("direct video normalization without verified pipeline context fails safely", () =>
  invalid(() => normalizeOembed(JSON.stringify(data), original)));
test("non-YouTube video remains unsupported even with YouTube branding or arbitrary HTML", () => {
  invalid(() => normalize({}, "https://vimeo.com/123"), "unsupported-type");
});
for (
  const patch of [
    { thumbnail_url: "https://evil.example/thumb.jpg" },
    { thumbnail_url: data.thumbnail_url.replace(id, "aaaaaaaaaaa") },
    { thumbnail_url: "http://127.0.0.1/image" },
    { thumbnail_url: data.thumbnail_url + "?token=x" },
    { thumbnail_width: 0 },
    { thumbnail_width: "480" },
    { thumbnail_height: null },
  ]
) {
  test(`invalid optional thumbnail omitted ${JSON.stringify(patch)}`, () => {
    assert.ok(!("thumbnail" in normalize(patch).card.resource));
  });
}
test("video v1 roundtrip deterministic; unknown safe extensions retained but inert", () => {
  const snapshot = normalize();
  snapshot.unknown = { z: 1, a: { b: 2, a: 1 } };
  const source = serializeOembedSnapshot(snapshot);
  assert.equal(serializeOembedSnapshot(parseOembedSnapshot(source)), source);
  assert.ok(source.includes("\"kind\": \"video\""));
  assert.ok(source.indexOf("\"provider\": \"youtube\"") < source.indexOf("\"videoId\""));
  assert.ok(source.endsWith("\n") && !source.endsWith("\n\n"));
});
for (const kind of ["link", "photo"] as const) {
  test(`accepted Slice4 ${kind} snapshot keeps exact canonical bytes`, () => {
    const resource = kind === "link"
      ? "{\n    \"kind\": \"link\"\n  }"
      : "{\n    \"height\": 360,\n    \"kind\": \"photo\",\n    \"url\": \"https://images.example/photo.jpg\",\n    \"width\": 480\n  }";
    const source =
      "{\n  \"version\": 1,\n  \"type\": \"oembed\",\n  \"url\": \"https://example.com/\",\n  \"title\": \"Existing card\",\n  \"provider\": {\n    \"name\": \"Provider\",\n    \"url\": \"https://provider.example/\"\n  },\n  \"resource\": "
      + resource + "\n}\n";
    assert.equal(serializeOembedSnapshot(parseOembedSnapshot(source)), source);
  });
}
for (
  const patch of [
    { kind: "unknown" },
    { kind: "rich" },
    { kind: "VIDEO" },
    { videoId: "../bad" },
    { videoId: "aaaaaaaaaaa" },
    { videoId: null },
    { provider: "vimeo" },
    { thumbnail: { url: "https://evil.example/", width: 1, height: 1 } },
    { thumbnail: { url: data.thumbnail_url, width: 0, height: 1 } },
  ]
) {
  test(`persisted video revalidated ${JSON.stringify(patch)}`, () => {
    const card = normalize().card;
    assert.throws(() =>
      parseOembedSnapshot(JSON.stringify({ ...card, resource: { ...card.resource, ...patch } }))
    );
  });
}
test("persisted video source and optional provider cannot contradict the validated resource", () => {
  const card = normalize().card;
  assert.throws(() => parseOembedSnapshot(JSON.stringify({ ...card, url: "https://evil.example/" })));
  assert.throws(() => parseOembedSnapshot(JSON.stringify({ ...card, provider: { name: "Vimeo" } })));
});
function reply(body: string, contentType: string, status = 200, headers = {}) {
  return { code: 0, data: { body, contentType, status, headers, bodyEncoding: "text", url: original } };
}
test("existing discovery pipeline verifies real endpoint, source and video; no HTML adoption", async () => {
  const requests: string[] = [];
  const replies = [
    reply(
      `<html><link rel='alternate' type='application/json+oembed' href='${endpoint}'></html>`,
      "text/html",
    ),
    reply(JSON.stringify(data), "application/json"),
  ];
  const result = await resolveOembed(original, {
    document: new JSDOM().window.document,
    transport: async request => {
      requests.push(request.url);
      return replies.shift();
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [original, endpoint]);
});
test("oEmbed redirect to spoof endpoint rejected despite YouTube source/provider labels", async () => {
  const replies = [
    reply(
      `<html><link rel='alternate' type='application/json+oembed' href='${endpoint}'></html>`,
      "text/html",
    ),
    reply("", "", 302, { Location: ["https://evil.example/response"] }),
    reply(JSON.stringify(data), "application/json"),
  ];
  assert.deepEqual(
    await resolveOembed(original, {
      document: new JSDOM().window.document,
      transport: async () => replies.shift(),
    }),
    { ok: false, error: { kind: "invalid-video" } },
  );
});
function render(strings = english, frontend: string | undefined = "browser-desktop") {
  const dom = new JSDOM("<!doctype html><main></main>", { url: "http://127.0.0.1:18167/" });
  const element = dom.window.document.querySelector("main")!;
  const calls: string[] = [];
  let fetches = 0;
  dom.window.fetch = async () => {
    fetches++;
    throw new Error("no resolver in renderer");
  };
  const content = serializeOembedSnapshot(normalize());
  const mount = () => {
    const dispose = renderOembed({ element, content, setContent: () => assert.fail("immutable") }, {
      strings,
      frontend,
      navigate: (url, event) => {
        event.preventDefault();
        calls.push(url);
      },
    });
    Object.defineProperty(element.querySelector(".slc-card"), "clientWidth", {
      value: 480,
      configurable: true,
    });
    return dispose;
  };
  const dispose = mount();
  return { dom, element, calls, dispose, mount, fetches: () => fetches };
}
test("initial native preview has title/provider/decorative thumbnail/source/button, no iframe or scripts", () => {
  const h = render();
  assert.equal(h.element.querySelector("iframe,script,style"), null);
  h.element.querySelector(".slc-card__preview")!.dispatchEvent(
    new h.dom.window.MouseEvent("click", { bubbles: true }),
  );
  assert.equal(h.element.querySelector("iframe"), null);
  assert.deepEqual(h.calls, []);
  const button = h.element.querySelector("button")!;
  assert.equal(button.type, "button");
  assert.equal(button.textContent, "Load video");
  assert.equal(button.getAttribute("aria-label"), `Load video: ${data.title}`);
  button.focus();
  assert.equal(h.dom.window.document.activeElement, button);
  assert.equal(h.element.querySelector("img")!.getAttribute("tabindex"), null);
  assert.equal(h.element.querySelector("img")!.alt, "");
  const shell = h.element.querySelector(".slc-root > .slc-card")!;
  assert.equal(shell.firstElementChild!.className, "slc-card__body");
  assert.ok(shell.querySelector(":scope > .slc-card__image > .slc-card__preview"));
  assert.ok(shell.querySelector(".slc-card__body .slc-video__actions"));
  assert.equal(shell.querySelector("a button"), null);
  assert.equal(button.getAttribute("aria-describedby"), h.element.querySelector(".slc-video__hint")!.id);
  assert.equal(h.element.querySelector(".slc-video__hint")!.textContent, english.videoHint);
  assert.equal(h.fetches(), 0);
  h.dispose();
});
test("explicit activation derives one iframe from validated ID, exact minimal policy, no autoplay", () => {
  const h = render(german);
  const button = h.element.querySelector("button")!;
  assert.equal(button.textContent, "Video laden");
  button.click();
  button.click();
  const frame = h.element.querySelector("iframe")!;
  assert.equal(h.element.querySelectorAll("iframe").length, 1);
  assert.equal(frame.src, youtubeEmbedUrl(id));
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.equal(frame.getAttribute("allow"), "fullscreen https://www.youtube.com");
  assert.equal(frame.referrerPolicy, "strict-origin");
  assert.equal(frame.getAttribute("srcdoc"), null);
  assert.equal(frame.getAttribute("allowfullscreen"), null);
  assert.equal(frame.title, `YouTube: ${data.title}`);
  assert.equal(new URL(frame.src).searchParams.get("autoplay"), "0");
  assert.equal(button.disabled, true);
  assert.ok(h.element.querySelector(".slc-card--active > iframe"));
  assert.equal(h.element.querySelector(".slc-card__image"), null);
  h.element.querySelector("a")!.click();
  assert.deepEqual(h.calls, [original]);
  assert.equal(h.fetches(), 0);
  h.dispose();
});
test("thumbnail and frame errors keep title/source and hint; no retries or fabricated load success", () => {
  const h = render();
  h.element.querySelector("img")!.dispatchEvent(new h.dom.window.Event("error"));
  assert.equal(h.element.querySelector("img"), null);
  const button = h.element.querySelector("button")!;
  button.click();
  const frame = h.element.querySelector("iframe")!;
  frame.dispatchEvent(new h.dom.window.Event("error"));
  frame.dispatchEvent(new h.dom.window.Event("load"));
  button.dispatchEvent(new h.dom.window.MouseEvent("click"));
  assert.equal(h.element.querySelectorAll("iframe").length, 1);
  assert.ok(h.element.textContent!.includes("If playback is blocked"));
  h.element.querySelector("a")!.click();
  assert.deepEqual(h.calls, [original]);
  h.dispose();
});
test("rerender starts unloaded; removed/replaced/disposed mounts cannot create frames", () => {
  const h = render();
  const stale = h.element.querySelector("button")!;
  stale.click();
  const disposeSecond = h.mount();
  assert.equal(h.element.querySelector("iframe"), null);
  assert.equal(h.element.querySelector(".slc-card--active"), null);
  assert.ok(h.element.querySelector(".slc-card__image > img"));
  stale.disabled = false;
  stale.click();
  assert.equal(h.element.querySelector("iframe"), null);
  const current = h.element.querySelector("button")!;
  disposeSecond();
  current.click();
  assert.equal(h.element.querySelector("iframe"), null);
  h.dispose();
  h.dispose();
});
test("disconnected preview cannot activate; sub-200px card offers source instead of undersized player", () => {
  const h = render();
  const button = h.element.querySelector("button")!;
  h.element.remove();
  button.click();
  assert.equal(h.element.querySelector("iframe"), null);
  h.dom.window.document.body.append(h.element);
  Object.defineProperty(h.element.querySelector(".slc-card"), "clientWidth", { value: 180 });
  button.click();
  assert.equal(h.element.querySelector("iframe"), null);
  assert.ok(h.element.textContent!.includes("200 px"));
  h.dispose();
});
test("native button keyboard semantics are preserved; visible focus rule exists", () => {
  // JSDOM does not synthesize native Enter/Space clicks; actual key activation is covered live.
  const h = render();
  assert.equal(h.element.querySelector("button")!.tabIndex, 0);
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.slc-video__load:focus-visible\s*\{/);
  assert.match(css, /outline: 2px solid var\(--b3-theme-primary\)/);
  h.dispose();
});
for (const frontend of ["desktop", "desktop-window", "mobile", "browser-mobile", "unknown"]) {
  test(`unreviewed or insecure host ${frontend} remains preview/source only`, () => {
    const h = render(english, frontend);
    const button = h.element.querySelector("button")!;
    assert.equal(button.disabled, true);
    button.dispatchEvent(new h.dom.window.MouseEvent("click"));
    assert.equal(h.element.querySelector("iframe"), null);
    assert.ok(h.element.textContent!.includes("does not support safe video playback"));
    h.element.querySelector("a")!.click();
    assert.deepEqual(h.calls, [original]);
    h.dispose();
  });
}
test("unknown frontend, opaque parent or same YouTube parent cannot opt into broadened sandbox", () => {
  assert.equal(youtubePlaybackAllowed(undefined, "http://127.0.0.1:18167/"), false);
  assert.equal(youtubePlaybackAllowed("browser-desktop", "about:blank"), false);
  assert.equal(youtubePlaybackAllowed("browser-desktop", "https://www.youtube.com/watch"), false);
  assert.equal(youtubePlaybackAllowed("browser-desktop", "file:///tmp/app.html"), false);
});

test("video without thumbnail collapses media while retaining source, action and privacy text", () => {
  const dom = new JSDOM("<main></main>", { url: "http://127.0.0.1:18167/" });
  const element = dom.window.document.querySelector("main")!;
  const snapshot = normalize();
  delete (snapshot.card.resource as { thumbnail?: unknown; }).thumbnail;
  const dispose = renderOembed({
    element,
    content: serializeOembedSnapshot(snapshot),
    setContent: () => assert.fail("immutable"),
  }, { strings: german, frontend: "browser-desktop", navigate: () => {} });
  assert.equal(element.querySelector(".slc-card__image"), null);
  assert.ok(element.querySelector("a"));
  assert.equal(element.querySelector("button")!.textContent, german.videoLoad);
  assert.equal(element.querySelector(".slc-video__hint")!.textContent, german.videoHint);
  dispose();
});
