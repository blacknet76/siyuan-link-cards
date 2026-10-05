import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import { navigateExternal } from "../src/navigation.ts";
import { renderOembed } from "../src/oembed/renderer.ts";
import { renderLinkCard } from "../src/renderer.ts";
import { serializeSnapshot } from "../src/schema.ts";
import { localizedStrings } from "../src/strings.ts";
import { syntheticSnapshot } from "./fixtures.ts";

const base = {
  version: 1,
  type: "link-card",
  url: "https://example.com/card",
  title: "Title",
  siteName: "Example",
};
function harness(
  data: unknown = base,
  options: { source?: string; language?: typeof english; } = {},
) {
  // JSDOM does not enable external resource loading. No external URLs are fetched.
  const dom = new JSDOM("<!doctype html><div id='mount'></div>");
  const mount = dom.window.document.getElementById("mount")!;
  const navigations: string[] = [];
  const writes: string[] = [];
  const source = options.source ?? JSON.stringify(data);
  const dispose = renderLinkCard({
    element: mount,
    content: source,
    setContent: value => {
      writes.push(value);
      return true;
    },
  }, {
    strings: localizedStrings(options.language ?? english),
    navigate: (url, event) => {
      navigations.push(url);
      event.preventDefault();
    },
  });
  return { dom, mount, navigations, writes, dispose, source };
}

test("full horizontal card has all optional components", () => {
  const h = harness({
    ...base,
    description: "Description",
    image: "https://example.com/image.jpg",
    favicon: "https://example.com/favicon.ico",
  });
  assert.equal(h.mount.querySelector(".slc-card__title")!.textContent, "Title");
  assert.equal(h.mount.querySelector(".slc-card__description")!.textContent, "Description");
  assert.equal(h.mount.querySelectorAll("img").length, 2);
  assert.ok(h.mount.querySelector(".slc-card__image"));
  assert.equal(h.mount.querySelector("a")!.getAttribute("href"), base.url);
});
test("title and site only; missing image creates no empty image region", () => {
  const h = harness();
  assert.equal(h.mount.querySelectorAll("img").length, 0);
  assert.equal(h.mount.querySelector(".slc-card__image"), null);
  assert.equal(h.mount.querySelector(".slc-card__description"), null);
  assert.equal(h.mount.querySelector(".slc-card__identity")!.textContent, "Example");
});
test("no description cleanly collapses while media remains", () => {
  const h = harness({ ...base, description: "  ", image: "https://example.com/a.jpg" });
  assert.equal(h.mount.querySelector(".slc-card__description"), null);
  assert.ok(h.mount.querySelector(".slc-card__image"));
});
test("no favicon preserves site identity and missing siteName uses hostname", () => {
  const h = harness({ version: 1, type: "link-card", url: base.url, title: base.title });
  assert.ok(h.mount.querySelector("svg.slc-card__globe use[href=\"#iconGlobe\"]"));
  assert.equal(h.mount.querySelector(".slc-card__identity")!.textContent, "example.com");
});
test("invalid snapshots all use safe localized fallback without rewriting", () => {
  for (
    const source of [
      "broken",
      JSON.stringify({ ...base, version: 2 }),
      JSON.stringify({ ...base, url: "javascript:alert(1)" }),
      JSON.stringify({ ...base, image: "data:text/html,x" }),
    ]
  ) {
    const h = harness(null, { source, language: german });
    assert.equal(h.mount.textContent, german.unavailable);
    assert.equal(h.mount.querySelector("a"), null);
    assert.deepEqual(h.writes, []);
  }
});
test("document text is inert; scripts, event attrs, styles are not injected", () => {
  const hostile = "<img src=x onerror=\"alert(1)\"><script>alert(1)</script>";
  const h = harness({
    ...base,
    title: hostile,
    description: hostile,
    siteName: hostile,
    style: "position:fixed",
    onclick: "alert(1)",
  });
  assert.equal(h.mount.querySelector(".slc-card__title")!.textContent, hostile);
  assert.equal(h.mount.querySelectorAll("img, script, [onerror], [onclick], [style]").length, 0);
});
test("accessible labels preserve replacement-like title and URL characters", () => {
  const h = harness({ ...base, title: "$& $` $'", url: "https://example.com/$&" });
  assert.equal(
    h.mount.querySelector("a")!.getAttribute("aria-label"),
    "Open $& $` $' — https://example.com/$&",
  );
});
test("preview error removes only media, with no write or retry", () => {
  const h = harness({ ...base, image: "https://example.com/missing.jpg", description: "Keep me" });
  const image = h.mount.querySelector(".slc-card__preview")!;
  image.dispatchEvent(new h.dom.window.Event("error"));
  assert.equal(h.mount.querySelector(".slc-card__image"), null);
  assert.equal(h.mount.querySelector(".slc-card__description")!.textContent, "Keep me");
  assert.ok(h.mount.querySelector("a"));
  assert.deepEqual(h.writes, []);
});
test("favicon error preserves site identity", () => {
  const h = harness({ ...base, favicon: "https://example.com/missing.ico" });
  h.mount.querySelector(".slc-card__favicon")!.dispatchEvent(new h.dom.window.Event("error"));
  assert.ok(h.mount.querySelector("svg.slc-card__globe use[href=\"#iconGlobe\"]"));
  assert.equal(h.mount.querySelector(".slc-card__identity")!.textContent, "Example");
});
test("native keyboard-link semantics and keyboard-generated click reach exact validated URL", () => {
  const h = harness({
    ...base,
    url: "https://Example.com/card?q=%2F#part",
    image: "https://example.com/a.jpg",
  });
  const link = h.mount.querySelector("a")!;
  link.focus();
  assert.equal(h.dom.window.document.activeElement, link);
  assert.ok(link.getAttribute("aria-label")!.includes("https://Example.com/card?q=%2F#part"));
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(h.mount.querySelector("img")!.tabIndex, -1);
  // JSDOM has no native Enter default action. Detail=0 models the browser's
  // keyboard-generated click; real Enter is separately verified in SiYuan.
  link.dispatchEvent(new h.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  assert.deepEqual(h.navigations, ["https://Example.com/card?q=%2F#part"]);
});
test("external navigation adapter allows only matching safe href", () => {
  const h = harness();
  const link = h.mount.querySelector("a")!;
  const checked: boolean[] = [];
  link.addEventListener("click", event => {
    navigateExternal(base.url, event);
    checked.push(event.defaultPrevented);
    event.preventDefault();
  });
  // A fresh anchor avoids the harness spy that intentionally prevents navigation.
  const clean = h.dom.window.document.createElement("a");
  clean.setAttribute("href", base.url);
  clean.addEventListener("click", event => {
    navigateExternal(base.url, event);
    checked.push(event.defaultPrevented);
    event.preventDefault();
  });
  clean.click();
  assert.deepEqual(checked, [false]);
  clean.href = "https://example.net/changed";
  clean.click();
  assert.equal(checked.at(-1), true);
  clean.setAttribute("href", "javascript:alert(1)");
  clean.addEventListener("click", event => navigateExternal("javascript:alert(1)", event));
  clean.click();
  assert.equal(checked.at(-1), true);
});
test("cleanup removes owned activation and media handlers", () => {
  const h = harness({ ...syntheticSnapshot().card, image: "https://example.com/a.jpg" });
  const link = h.mount.querySelector("a")!;
  const image = h.mount.querySelector("img")!;
  link.addEventListener("click", event => event.preventDefault());
  h.dispose();
  h.dispose();
  link.click();
  image.dispatchEvent(new h.dom.window.Event("error"));
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.mount.childElementCount, 0);
});
test("multiple cards and source snapshots remain independent", () => {
  const one = harness(syntheticSnapshot().card);
  const two = harness(syntheticSnapshot().card);
  assert.equal(one.mount.querySelector("button"), null);
  assert.deepEqual(one.writes, []);
  assert.deepEqual(two.writes, []);
  assert.equal(
    two.mount.querySelector(".slc-card__description")!.textContent,
    syntheticSnapshot().card.description,
  );
});
test("render and cleanup never call setContent for valid content", () => {
  const h = harness(syntheticSnapshot().card, { source: JSON.stringify(syntheticSnapshot().card) + "\n\n" });
  assert.deepEqual(h.writes, []);
  h.dispose();
  assert.deepEqual(h.writes, []);
});
test("re-render after reload gives the same snapshot content", () => {
  const source = serializeSnapshot(syntheticSnapshot());
  const first = harness(null, { source });
  const expected = first.mount.innerHTML;
  first.dispose();
  const second = harness(null, { source });
  assert.equal(second.mount.innerHTML, expected);
  assert.deepEqual(second.writes, []);
});
test("i18n key parity and fallback never exposes raw keys", () => {
  assert.deepEqual(Object.keys(german).sort(), Object.keys(english).sort());
  assert.deepEqual(localizedStrings({ unavailable: "" }), english);
});

test("former synthetic fixtures render without development update controls or source writes", () => {
  const h = harness(syntheticSnapshot().card);
  assert.equal(h.mount.querySelector("button"), null);
  assert.deepEqual(h.writes, []);
});

const passiveCases = [
  {
    name: "bookmark",
    render: renderLinkCard,
    card: {
      ...base,
      description: "Keep description",
      image: "assets/preview-20261003000000-aaaaaaa.png",
      favicon: "assets/icon-20261003000000-bbbbbbb.png",
    },
  },
  {
    name: "oembed link",
    render: renderOembed,
    card: {
      version: 1,
      type: "oembed",
      url: base.url,
      title: base.title,
      provider: { name: "Provider" },
      resource: { kind: "link" },
    },
  },
  {
    name: "oembed photo",
    render: renderOembed,
    card: {
      version: 1,
      type: "oembed",
      url: base.url,
      title: base.title,
      provider: { name: "Provider" },
      resource: { kind: "photo", url: "https://example.com/photo.jpg", width: 24, height: 2000 },
    },
  },
  {
    name: "unloaded youtube",
    render: renderOembed,
    card: {
      version: 1,
      type: "oembed",
      url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      title: base.title,
      provider: { name: "YouTube", url: "https://www.youtube.com/" },
      resource: {
        kind: "video",
        provider: "youtube",
        videoId: "M7lc1UVf-VE",
        thumbnail: { url: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg", width: 480, height: 360 },
      },
    },
  },
];
for (const sample of passiveCases) {
  test(`${sample.name}: common shell, identity, safe navigation, optional media and immutable snapshot`, () => {
    const dom = new JSDOM("<main></main>", { url: "http://127.0.0.1:18167/" });
    const element = dom.window.document.querySelector("main")!;
    const calls: string[] = [];
    const services = {
      strings: english,
      frontend: "browser-desktop",
      navigate: (url: string, event: MouseEvent) => {
        event.preventDefault();
        calls.push(url);
      },
    };
    const source = JSON.stringify(sample.card);
    const dispose = sample.render({
      element,
      content: source,
      setContent: () => assert.fail("passive rendering must not persist"),
    }, services);
    const shell = element.querySelector(".slc-root > .slc-card")!;
    assert.equal(shell.firstElementChild!.className, "slc-card__body");
    assert.equal(shell.querySelector(".slc-card__title")!.textContent, base.title);
    assert.ok(shell.querySelector(".slc-card__body > .slc-card__identity > .slc-card__site"));
    assert.equal(element.querySelector("iframe"), null);
    assert.ok(shell.querySelector(".slc-card__identity .slc-card__favicon"));
    assert.equal(element.querySelector("a button"), null);
    const region = shell.querySelector(":scope > .slc-card__image");
    if (sample.name === "oembed link") {
      assert.equal(region, null);
      assert.equal(shell.querySelector(".slc-card__description"), null);
    } else {
      assert.ok(region);
      const img = region.querySelector("img")!;
      assert.equal(img.className, "slc-card__preview");
      assert.equal(img.alt, "");
      assert.equal(img.tabIndex, -1);
      assert.equal(img.getAttribute("style"), null);
      if (sample.name === "bookmark") {
        assert.equal(img.getAttribute("src"), "/assets/preview-20261003000000-aaaaaaa.png");
      }
      img.dispatchEvent(new dom.window.Event("error"));
      assert.equal(shell.querySelector(".slc-card__image"), null);
      assert.equal(shell.querySelector(".slc-card__title")!.textContent, base.title);
      assert.ok(shell.querySelector(".slc-card__site"));
      if (sample.name === "unloaded youtube") assert.ok(shell.querySelector("button"));
    }
    element.querySelector("a")!.click();
    assert.deepEqual(calls, [sample.card.url]);
    dispose();
    dispose();
    assert.equal(element.childElementCount, 0);
  });
}
test("common media geometry is owned by shell rather than intrinsic photo/thumbnail width", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.slc-card__image\s*\{[^}]*position: relative;[^}]*flex: 0 0 30%;/);
  assert.match(
    css,
    /\.slc-root \.slc-card__preview\s*\{[^}]*position: absolute;[^}]*width: 100%;[^}]*height: 100%;[^}]*max-width: none;[^}]*object-fit: cover;/,
  );
  assert.match(css, /@container \(max-width: 380px\)[\s\S]*?\.slc-card \{\s*flex-direction: column;/);
  assert.doesNotMatch(css, /slc-embed--photo|slc-video__thumbnail|slc-embed__photo/);
});

test("shared navigation preserves the literal validated source href for the production adapter", () => {
  for (const sample of passiveCases.slice(0, 2)) {
    const dom = new JSDOM("<main></main>");
    const element = dom.window.document.querySelector("main")!;
    const url = "https://Example.com/Card?q=%2F#part";
    const dispose = sample.render({
      element,
      content: JSON.stringify({ ...sample.card, url }),
      setContent: () => assert.fail("immutable"),
    }, { strings: english, navigate: navigateExternal });
    const anchor = element.querySelector("a")!;
    assert.equal(anchor.getAttribute("href"), url);
    let prevented = true;
    anchor.addEventListener("click", event => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    });
    anchor.click();
    assert.equal(prevented, false);
    dispose();
  }
});

for (const sample of passiveCases) {
  test(`${sample.name}: actual favicon preferred, error switches same slot to native globe without writes`, () => {
    for (const favicon of ["https://example.com/icon.png", "assets/site-20261003000000-aaaaaaa.png"]) {
      const dom = new JSDOM("<main></main>"), element = dom.window.document.querySelector("main")!;
      const source = JSON.stringify({ ...sample.card, favicon });
      const dispose = sample.render({
        element,
        content: source,
        setContent: () => assert.fail("no write/refresh"),
      }, { strings: english, frontend: "browser-desktop", navigate: () => {} });
      const identity = element.querySelector(".slc-card__identity")!, label = identity.textContent;
      const image = identity.querySelector("img")!;
      assert.ok(image);
      assert.equal(image.getAttribute("src"), favicon.startsWith("assets/") ? "/" + favicon : favicon);
      assert.equal(identity.querySelector("svg"), null);
      image.dispatchEvent(new dom.window.Event("error"));
      assert.equal(identity.querySelector("img"), null);
      const globe = identity.querySelector("svg")!;
      assert.equal(globe.getAttribute("focusable"), "false");
      assert.equal(globe.getAttribute("aria-hidden"), "true");
      assert.equal(globe.querySelector("use")!.getAttribute("href"), "#iconGlobe");
      assert.equal(identity.children.length, 2);
      assert.equal(identity.textContent, label);
      assert.ok(label);
      assert.equal(source, JSON.stringify({ ...sample.card, favicon }));
      dispose();
    }
  });
}
