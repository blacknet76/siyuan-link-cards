import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NATIVE_YOUTUBE_STYLE,
  nativeYoutubeAvailable,
  nativeYoutubeSource,
} from "../src/creation/youtube.ts";

const id = "M7lc1UVf-VE";
for (
  const source of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/watch?v=${id}&si=abc&t=30&feature=shared`,
  ]
) {
  test(`native URL/attribute mapping ${source}`, () => {
    const markup = nativeYoutubeSource(source, id);
    const document = new JSDOM().window.document;
    const frame = new document.defaultView!.DOMParser().parseFromString(markup, "text/html").querySelector(
      "iframe",
    )!;
    assert.equal(frame.getAttribute("src"), `https://www.youtube.com/embed/${id}`);
    assert.deepEqual(
      frame.getAttributeNames().sort(),
      ["src", "title", "sandbox", "allow", "referrerpolicy", "allowfullscreen", "style"].sort(),
    );
    assert.equal(frame.getAttribute("style"), NATIVE_YOUTUBE_STYLE);
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-presentation");
    assert.equal(frame.getAttribute("allow"), "fullscreen");
    assert.equal(frame.getAttribute("referrerpolicy"), "strict-origin");
    assert.equal(frame.getAttribute("title"), "YouTube video player");
    assert.ok(!markup.includes("siyuan-link-cards") && !markup.includes("autoplay"));
  });
}
for (
  const source of [
    `https://www.youtube.com/embed/${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123`,
    `https://youtube.com/watch?v=${id}&v=${id}`,
    `https://youtube.com/watch?v=${id}&autoplay=1`,
    `https://evil.example/watch?v=${id}`,
    `http://youtube.com/watch?v=${id}`,
    `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`,
  ]
) {
  test(`native rejects unsupported/raw input ${source}`, () =>
    assert.throws(() => nativeYoutubeSource(source, id)));
}
test("native rejects mismatched and injected video IDs", () => {
  for (const value of ["abcdefghijk", "../bad", "\" onload=\"bad"]) {
    assert.throws(() => nativeYoutubeSource(`https://youtu.be/${id}`, value));
  }
});
test("native frontend policy keeps unsupported/remote hosts passive", () => {
  for (const frontend of ["desktop", "desktop-window", "browser-desktop"]) {
    assert.equal(nativeYoutubeAvailable(frontend, "http://127.0.0.1:18173/stage/build/desktop/"), true);
    assert.equal(nativeYoutubeAvailable(frontend, "http://127.0.0.1:18173/?remote=1"), false);
  }
  for (const frontend of ["mobile", "browser-mobile", "unknown"]) {
    assert.equal(nativeYoutubeAvailable(frontend, "https://notes.example/"), false);
  }
  assert.equal(nativeYoutubeAvailable("desktop", "https://notes.example/"), false);
  assert.equal(nativeYoutubeAvailable("browser-desktop", "https://notes.example/"), true);
  assert.equal(nativeYoutubeAvailable("browser-desktop", "https://www.youtube.com/"), false);
  assert.equal(nativeYoutubeAvailable("browser-desktop", "file:///notes"), false);
});
