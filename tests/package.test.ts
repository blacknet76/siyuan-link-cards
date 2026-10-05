import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import type { Configuration, Stats } from "webpack";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const webpack = require("webpack") as typeof import("webpack");
const screenshots = [
  "link-cards-light.png",
  "link-cards-dark.png",
  "insert-dialog.png",
  "youtube-preview.png",
];
const inventory = [
  "LICENSE",
  "README.md",
  "README.de-DE.md",
  "README.siyuan.md",
  "README.siyuan.de-DE.md",
  "THIRD_PARTY_NOTICES.md",
  "icon.png",
  "index.css",
  "index.js",
  "plugin.json",
  "i18n/en.json",
  "i18n/de-DE.json",
  "i18n/de.json",
  ...screenshots.map(name => `docs/screenshots/${name}`),
].sort();

// Read the generated ZIP's central directory and validate its payloads and CRCs.
function zipFiles(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26)
      + bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(start, start + compressedSize);
    assert.ok(method === 0 || method === 8);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(data.length, size);
    assert.equal(crc32(data), checksum);
    assert.ok(!files.has(name), `duplicate ZIP entry: ${name}`);
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function fixture(t: TestContext, layout: "DEV" | "PUBLIC") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slc-package-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  for (
    const name of [
      "webpack.config.cjs",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "icon.png",
      "plugin.json",
      "README.md",
      "README.de-DE.md",
      "README.siyuan.md",
      "README.siyuan.de-DE.md",
      "src/i18n/en.json",
      "src/i18n/de-DE.json",
    ]
  ) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.copyFile(path.join(root, name), path.join(directory, name));
  }
  await fs.writeFile(
    path.join(directory, "src/index.ts"),
    "import \"./index.css\"; export default class Plugin {}\n",
  );
  await fs.writeFile(path.join(directory, "src/index.css"), ".fixture { color: inherit; }\n");
  const screenshotDirectory = layout === "DEV" ? "public-assets/screenshots" : "docs/screenshots";
  const sourceDirectory = await fs.stat(path.join(root, "public-assets/screenshots")).then(
    () => "public-assets/screenshots",
    () => "docs/screenshots",
  );
  await fs.mkdir(path.join(directory, screenshotDirectory), { recursive: true });
  for (const name of screenshots) {
    await fs.copyFile(
      path.join(root, sourceDirectory, name),
      path.join(directory, screenshotDirectory, name),
    );
  }
  await fs.writeFile(path.join(directory, screenshotDirectory, "unapproved.png"), "not approved");
  await fs.mkdir(path.join(directory, "docs/assets"), { recursive: true });
  await fs.writeFile(path.join(directory, "docs/assets/evidence.png"), "private evidence");
  await fs.writeFile(path.join(directory, "docs/PROJECT_STATE.md"), "internal documentation");
  return { directory, screenshotDirectory };
}

async function build(directory: string): Promise<Stats> {
  const configure = require(path.join(directory, "webpack.config.cjs")) as (
    env: unknown,
    argv: { mode: string; },
  ) => Configuration;
  const compiler = webpack({ ...configure({}, { mode: "production" }), context: directory });
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else if (!stats) reject(new Error("missing webpack result"));
        else resolve(stats);
      });
    });
  });
}

for (const layout of ["DEV", "PUBLIC"] as const) {
  test(`${layout} production package: exact 17 files, approved screenshots, bytes and EN/DE README links`, async t => {
    const { directory, screenshotDirectory } = await fixture(t, layout);
    const stats = await build(directory);
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    const files = zipFiles(await fs.readFile(path.join(directory, "package.zip")));
    assert.equal(files.size, 17);
    assert.deepEqual([...files.keys()].sort(), inventory);
    assert.deepEqual(
      [...files.keys()].filter(name => name.endsWith(".png")).sort(),
      ["icon.png", ...screenshots.map(name => `docs/screenshots/${name}`)].sort(),
    );
    const dist = path.join(directory, "dist");
    assert.deepEqual(
      (await fs.readdir(dist, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
        .sort(),
      inventory,
    );
    for (const [name, bytes] of files) assert.deepEqual(bytes, await fs.readFile(path.join(dist, name)));
    for (const name of screenshots) {
      assert.deepEqual(
        files.get(`docs/screenshots/${name}`),
        await fs.readFile(path.join(directory, screenshotDirectory, name)),
      );
    }
    const manifest = JSON.parse(files.get("plugin.json")!.toString());
    assert.deepEqual(manifest.readme, {
      default: "README.siyuan.md",
      de: "README.siyuan.de-DE.md",
      "de-DE": "README.siyuan.de-DE.md",
    });
    for (const name of ["README.siyuan.md", "README.siyuan.de-DE.md"]) {
      const readme = files.get(name)!;
      assert.deepEqual(readme, await fs.readFile(path.join(root, name)));
      const text = readme.toString();
      const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]!);
      assert.deepEqual(images, ["docs/screenshots/link-cards-light.png"]);
      assert.ok(files.has(images[0]!));
      assert.match(text, /https:\/\/github\.com\/blacknet76\/siyuan-link-cards#readme/);
      assert.match(text, /SiYuan 3\.8\.3\+/);
      assert.doesNotMatch(text, /npm |video-v1|schema|Undo|package\.zip/);
    }
    for (const name of ["README.md", "README.de-DE.md"]) {
      const readme = files.get(name)!;
      assert.deepEqual(readme, await fs.readFile(path.join(root, name)));
      const targets = [...readme.toString().matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]!);
      assert.deepEqual(targets.sort(), screenshots.map(image => `docs/screenshots/${image}`).sort());
      for (const target of targets) assert.ok(files.has(target), `missing packaged README image: ${target}`);
    }
  });
}

test("missing approved screenshot fails the production build instead of silently weakening the inventory", async t => {
  const { directory, screenshotDirectory } = await fixture(t, "DEV");
  await fs.unlink(path.join(directory, screenshotDirectory, screenshots[0]!));
  const stats = await build(directory);
  assert.equal(stats.hasErrors(), true);
  assert.match(stats.toString({ all: false, errors: true }), /link-cards-light\.png/);
});

// CI/release opts in after building the real source; reuse the exact ZIP contract above.
if (process.env.SLC_VALIDATE_PACKAGE === "1") {
  test("built source package: ZIP integrity, exact runtime inventory, dist bytes and release version", async () => {
    const files = zipFiles(await fs.readFile(path.join(root, "package.zip")));
    assert.equal(files.size, 17);
    assert.deepEqual([...files.keys()].sort(), inventory);
    for (const [name, bytes] of files) {
      assert.deepEqual(bytes, await fs.readFile(path.join(root, "dist", name)), name);
    }
    const source = await fs.readFile(path.join(root, "plugin.json"));
    assert.deepEqual(files.get("plugin.json"), source);
    const plugin = JSON.parse(source.toString());
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    assert.equal(plugin.version, pkg.version);
    if (process.env.SLC_RELEASE_TAG !== undefined) {
      assert.match(process.env.SLC_RELEASE_TAG, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      assert.equal(process.env.SLC_RELEASE_TAG, process.env.SLC_RELEASE_TAG.trim());
      assert.equal(plugin.version, process.env.SLC_RELEASE_TAG.slice(1));
    }
  });
}
