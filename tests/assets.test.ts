import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dataRaster, decodeBase64, inspectRaster, MAX_ASSET_BYTES } from "../src/assets/raster.ts";
import { isAssetReference, mediaAttributes, mediaIAL } from "../src/assets/reference.ts";
import { assetFilename, assetImporter, localizeMedia } from "../src/assets/service.ts";
import english from "../src/i18n/en.json" with { type: "json" };
import { renderLinkCard } from "../src/renderer.ts";
import { customBlockMarkdown, parseSnapshot, serializeSnapshot } from "../src/schema.ts";
import { JPEG, PNG, WEBP } from "./asset-fixtures.ts";
import { syntheticSnapshot } from "./fixtures.ts";
const id = "20261003000000-aaaaaaa";
export const LOCAL_IMAGE = "assets/slc-test-20261003000000-aaaaaaa.png";
const data = "data:image/png;base64," + PNG;
const noNetwork = async () => assert.fail("data URI must not contact network");
const noDecode = async () => {};
function successfulUpload(form: FormData) {
  const name = (form.get("file[]") as File).name;
  assert.equal(form.get("id"), id);
  assert.equal(form.get("assetsDirPath"), "/assets/");
  return Promise.resolve({
    code: 0,
    data: {
      errFiles: [],
      succMap: { [name]: "assets/" + name.replace(/\.(png|jpg|webp)$/, "-20261003000000-aaaaaaa.$1") },
    },
  });
}
test("official successful upload accepts null errFiles from the live kernel", async () => {
  const importer = assetImporter(noNetwork, async form => {
    const response = await successfulUpload(form);
    return { ...response, data: { ...response.data, errFiles: null } };
  }, noDecode);
  assert.ok(isAssetReference(await importer(data, id)));
});
for (
  const [encoded, mime, extension] of [[PNG, "image/png", "png"], [JPEG, "image/jpeg", "jpg"], [
    WEBP,
    "image/webp",
    "webp",
  ]] as const
) {
  test("valid " + mime + " data URI/signature/dimensions and official single-file multipart", async () => {
    const raster = dataRaster("data:" + mime + ";base64," + encoded);
    assert.deepEqual([raster.width, raster.height, raster.extension], [3, 2, extension]);
    const importer = assetImporter(noNetwork, successfulUpload, noDecode);
    const result = await importer("data:" + mime + ";base64," + encoded, id);
    assert.ok(isAssetReference(result));
    assert.equal(result, await importer("data:" + mime + ";base64," + encoded, id));
  });
  test("remote " + mime + " shares validation/upload and bounded binary transport", async () => {
    let calls = 0;
    const importer = assetImporter(
      async (req) => {
        calls++;
        assert.equal(req.method, "GET");
        assert.equal(req.responseEncoding, "base64-std");
        assert.equal(req.redirect, false);
        assert.equal(req.timeout, 7000);
        assert.ok(!JSON.stringify(req).includes("Cookie"));
        return {
          code: 0,
          data: { status: 200, contentType: mime, body: encoded, bodyEncoding: "base64-std" },
        };
      },
      successfulUpload,
      noDecode,
    );
    assert.ok(isAssetReference(await importer("https://example.com/preview", id)));
    assert.equal(calls, 1);
  });
}
for (
  const value of [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/gif;base64,R0lGODlh",
    "data:text/plain;base64,QQ==",
    "data:image/png,abc",
    "data:image/png;base64,A===",
    "data:image/png;base64,AB==",
    "data:image/jpeg;base64," + PNG,
  ]
) {
  test("unusable data media is rejected by asset validator", () => assert.throws(() => dataRaster(value)));
}
test("encoded size, binary size, dimensions and signature fail before decoder/upload", async () => {
  assert.throws(() => decodeBase64("A".repeat(MAX_ASSET_BYTES + 4)));
  assert.throws(() => inspectRaster(new Uint8Array(MAX_ASSET_BYTES + 1), "image/png"));
  assert.throws(() => inspectRaster(new Uint8Array(50), "image/png"));
  const bytes = decodeBase64(PNG);
  new DataView(bytes.buffer).setUint32(16, 16000001);
  assert.throws(() => inspectRaster(bytes, "image/png"));
  let uploads = 0;
  const importer = assetImporter(noNetwork, async () => {
    uploads++;
    return {};
  }, noDecode);
  await assert.rejects(importer("data:image/png;base64," + btoa(String.fromCharCode(...bytes)), id));
  assert.equal(uploads, 0);
});
test("decoder integrity failure, invalid context and cancellation never upload", async () => {
  let uploads = 0;
  const importer = assetImporter(noNetwork, async () => {
    uploads++;
    return {};
  }, async () => {
    throw new Error("corrupt image");
  });
  await assert.rejects(importer(data, id));
  await assert.rejects(importer(data, "not-a-block"));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(importer(data, id, abort.signal));
  assert.equal(uploads, 0);
});
test("filename is deterministic content SHA256, independent of private URLs and names", async () => {
  const name = await assetFilename(dataRaster(data));
  assert.match(name, /^slc-[a-f0-9]{64}\.png$/);
  assert.equal(name, await assetFilename(dataRaster(data)));
});
for (
  const response of [{ code: -1 }, { code: 0, data: { errFiles: ["failed"], succMap: {} } }, {
    code: 0,
    data: { errFiles: [], succMap: { wrong: LOCAL_IMAGE } },
  }, { code: 0, data: { errFiles: [], succMap: {} } }]
) {
  test("upload errors and incomplete success cannot persist a reference", async () => {
    await assert.rejects(assetImporter(noNetwork, async () => response, noDecode)(data, id));
  });
}
test("kernel-returned pseudo asset path rejected and optional failure omitted", async () => {
  const importer = assetImporter(
    noNetwork,
    async form => ({
      code: 0,
      data: { errFiles: [], succMap: { [(form.get("file[]") as File).name]: "assets/fake.png" } },
    }),
    noDecode,
  );
  const snapshot = syntheticSnapshot();
  snapshot.card.image = "https://example.com/preview.png";
  const result = await localizeMedia(
    snapshot,
    { image: data, favicon: "data:image/svg+xml;base64,PHN2Zy8+" },
    id,
    importer,
  );
  assert.deepEqual(result.media, { imported: 0, omitted: 2 });
  assert.ok(!result.snapshot.card.image && !result.snapshot.card.favicon);
  assert.equal(result.snapshot.card.title, snapshot.card.title);
});
test("redirect media uses existing public policy and never follows a private target", async () => {
  let calls = 0;
  const importer = assetImporter(
    async () => {
      calls++;
      return { code: 0, data: { status: 302, headers: { Location: ["http://127.0.0.1/image.png"] } } };
    },
    successfulUpload,
    noDecode,
  );
  await assert.rejects(importer("https://example.com/preview", id));
  assert.equal(calls, 1);
});
test("existing remote snapshot serialization and HTTP-only navigation remain unchanged", () => {
  const snapshot = syntheticSnapshot();
  snapshot.card.image = "https://example.com/image.png";
  snapshot.card.favicon = "http://example.com/icon.png";
  assert.equal(serializeSnapshot(parseSnapshot(serializeSnapshot(snapshot))), serializeSnapshot(snapshot));
  assert.ok(!customBlockMarkdown(snapshot).includes("custom-data-assets"));
  for (const field of ["url", "resolvedUrl"]) {
    assert.throws(() => serializeSnapshot({ ...snapshot, card: { ...snapshot.card, [field]: LOCAL_IMAGE } }));
  }
});
for (
  const invalid of [
    "relative.png",
    "assets/fake.png",
    "/assets/a-20261003000000-aaaaaaa.png",
    "assets/../a-20261003000000-aaaaaaa.png",
    "assets/a-20261003000000-aaaaaaa.png?x=1",
    "assets/a-20261003000000-aaaaaaa.svg",
    data,
    "blob:foo",
    "file:///a.png",
    "javascript:alert(1)",
  ]
) {
  test("native media refuses pseudo/unsafe reference", () =>
    assert.throws(() =>
      serializeSnapshot({ card: { ...syntheticSnapshot().card, image: invalid }, unknown: {} })
    ));
}
test("two canonical local media fields generate exact own host attributes; update removes stale refs", () => {
  assert.throws(() => mediaIAL({}, "{: custom-data-assets-slc-image='stale'}"));
  const card = { ...syntheticSnapshot().card, image: LOCAL_IMAGE, favicon: LOCAL_IMAGE };
  assert.equal(parseSnapshot(serializeSnapshot({ card, unknown: {} })).card.image, LOCAL_IMAGE);
  const attrs = mediaAttributes(card);
  assert.equal(Object.keys(attrs).length, 2);
  const ial = mediaIAL(card, `{: id="${id}" custom-user="keep" custom-data-assets-other="assets/other.png"}`);
  for (const [key, value] of Object.entries(attrs)) assert.ok(ial.includes(`${key}="${value}"`));
  const next = mediaIAL(syntheticSnapshot().card, ial);
  assert.ok(!next.includes("custom-data-assets-slc-"));
  assert.ok(next.includes("custom-data-assets-other=\"assets/other.png\""));
  assert.ok(next.includes("custom-user=\"keep\""));
});
test("renderer uses root local asset URL without imports or writes; footer survives missing/failed media", () => {
  const document = new JSDOM("", { url: "http://localhost/stage/build/desktop/" }).window.document;
  const snapshot = syntheticSnapshot();
  snapshot.card.image = LOCAL_IMAGE;
  snapshot.card.favicon = LOCAL_IMAGE;
  snapshot.card.siteName = "long".repeat(64);
  const mount = document.createElement("div");
  const close = renderLinkCard({
    element: mount,
    content: serializeSnapshot(snapshot),
    setContent: () => assert.fail("render writes forbidden"),
  }, { strings: english, navigate: () => {} });
  const identity = mount.querySelector(".slc-card__identity")!;
  assert.equal(identity.children.length, 2);
  const icon = identity.querySelector("img")!;
  assert.equal(icon.getAttribute("src"), "/" + LOCAL_IMAGE);
  assert.equal(icon.hasAttribute("tabindex"), false);
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  icon.dispatchEvent(new document.defaultView!.Event("error"));
  assert.equal(identity.children.length, 2);
  assert.ok(identity.querySelector("svg.slc-card__globe use[href=\"#iconGlobe\"]"));
  assert.equal(identity.textContent, snapshot.card.siteName);
  close();
  assert.ok(!readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8").includes("assets/service"));
});

test("optional favicon import tries bounded declared candidates before globe, without persisting candidates", async () => {
  const snapshot = syntheticSnapshot(), calls: string[] = [];
  const result = await localizeMedia(
    snapshot,
    {
      favicon: "https://example.com/first.ico",
      faviconCandidates: [
        "https://example.com/first.ico",
        "https://example.com/site.png",
        "https://example.com/later.png",
      ],
    },
    id,
    async source => {
      calls.push(source);
      if (source.endsWith(".ico")) throw new Error("unsupported raster");
      return LOCAL_IMAGE;
    },
  );
  assert.deepEqual(calls, ["https://example.com/first.ico", "https://example.com/site.png"]);
  assert.equal(result.snapshot.card.favicon, LOCAL_IMAGE);
  assert.deepEqual(result.media, { imported: 1, omitted: 0 });
  assert.ok(!serializeSnapshot(result.snapshot).includes("faviconCandidates"));
});
test("all failed favicon candidates count as one optional omission; cancellation stops candidates", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}.png`),
    calls: string[] = [];
  const result = await localizeMedia(
    syntheticSnapshot(),
    { faviconCandidates: candidates },
    id,
    async source => {
      calls.push(source);
      throw new Error("unavailable");
    },
  );
  assert.equal(calls.length, 8);
  assert.equal(result.snapshot.card.favicon, undefined);
  assert.deepEqual(result.media, { imported: 0, omitted: 1 });
  const controller = new AbortController();
  let imports = 0;
  await assert.rejects(localizeMedia(syntheticSnapshot(), { faviconCandidates: candidates }, id, async () => {
    imports++;
    controller.abort();
    throw new Error("cancelled");
  }, controller.signal));
  assert.equal(imports, 1);
});
