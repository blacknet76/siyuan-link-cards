import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCK_INFO,
  customBlockMarkdown,
  InvalidCardError,
  KEY_ORDER,
  MAX_PAYLOAD_BYTES,
  parseSnapshot,
  serializeSnapshot,
  updateSnapshot,
  validateHttpUrl,
} from "../src/schema.ts";
import type { LinkCard } from "../src/schema.ts";
import { syntheticSnapshot } from "./fixtures.ts";

const minimal: LinkCard = {
  version: 1,
  type: "link-card",
  url: "https://example.com/a?x=1#part",
  title: "Title",
};
const full: LinkCard = {
  ...minimal,
  description: "Description",
  image: "https://example.com/image.jpg",
  favicon: "https://example.com/favicon.ico",
  siteName: "Example",
  resolvedUrl: "https://example.net/resolved",
  resolvedAt: "2026-10-02T12:30:00Z",
};
const parse = (value: unknown) => parseSnapshot(JSON.stringify(value));
const invalid = (value: unknown) => assert.throws(() => parse(value), InvalidCardError);

test("valid minimal snapshot", () => assert.deepEqual(parse(minimal).card, minimal));
test("valid full snapshot keeps the confirmed URL", () => {
  const card = parse(full).card;
  assert.equal(card.url, minimal.url);
  assert.equal(card.resolvedUrl, full.resolvedUrl);
  assert.equal(card.resolvedAt, "2026-10-02T12:30:00.000Z");
});
test("malformed JSON", () => assert.throws(() => parseSnapshot("{broken"), InvalidCardError));
test("unsupported version", () => invalid({ ...minimal, version: 2 }));
test("wrong type", () => invalid({ ...minimal, type: "oembed" }));
test("missing URL", () => invalid({ version: 1, type: "link-card", title: "Title" }));
test("non HTTP(S) and ambiguous URL spellings", () => {
  for (
    const url of [
      "javascript:alert(1)",
      "data:text/plain,a",
      "blob:https://example.com/a",
      "file:///tmp/a",
      "/relative",
      "https:example.com",
      "https://example.com/a\nb",
      "https://example.com\\a",
    ]
  ) invalid({ ...minimal, url });
});
test("credentials including empty userinfo", () => {
  for (const url of ["https://user:pass@example.com", "https://user@example.com", "https://@example.com"]) {
    invalid({ ...minimal, url });
  }
});
test("missing and empty title", () => {
  invalid({ version: 1, type: "link-card", url: minimal.url });
  invalid({ ...minimal, title: " \n\t " });
});
test("invalid optional image, favicon, resolved URL", () => {
  for (const key of ["image", "favicon", "resolvedUrl"]) {
    for (const value of ["javascript:alert(1)", "", null, 1, "https://u:p@example.com"]) {
      invalid({ ...minimal, [key]: value });
    }
  }
});
test("unknown fields are ignored when reading and preserved on update", () => {
  const snapshot = parse({ ...minimal, future: { z: [1, true, null], a: "kept" }, other: false });
  assert.deepEqual(snapshot.card, minimal);
  const next = parseSnapshot(updateSnapshot(snapshot, { description: "new" }));
  assert.deepEqual(next.unknown, snapshot.unknown);
  assert.equal(next.card.description, "new");
});
test("deterministic key order, indentation, LF and one final newline", () => {
  const snapshot = parse({ zz: { z: 2, a: 1 }, aa: "future", ...full });
  const source = serializeSnapshot(snapshot);
  assert.deepEqual(Object.keys(JSON.parse(source)), [...KEY_ORDER, "aa", "zz"]);
  assert.ok(source.startsWith("{\n  \"version\": 1,\n  \"type\": \"link-card\",\n"));
  assert.ok(source.endsWith("}\n"));
  assert.ok(!source.endsWith("\n\n"));
  assert.ok(!source.includes("\r"));
  assert.equal(source, serializeSnapshot(parseSnapshot(source)));
  assert.deepEqual(Object.keys(JSON.parse(source).zz), ["a", "z"]);
});
test("parse -> serialize -> parse roundtrip", () => {
  const initial = parse({ ...full, title: "A \"quote\" — Unicode", description: "x\ny" });
  assert.deepEqual(parseSnapshot(serializeSnapshot(initial)), initial);
});
test("integer-looking extension keys follow known keys and sort lexically at every level", () => {
  const snapshot = parse({ ...minimal, "0": { "2": [1, { z: 2, a: 1 }], "10": null } });
  const source = serializeSnapshot(snapshot);
  assert.ok(source.indexOf("\"version\"") < source.indexOf("\"0\""));
  assert.ok(source.indexOf("\"10\"") < source.indexOf("\"2\""));
  assert.deepEqual(parseSnapshot(source), snapshot);
  assert.equal(serializeSnapshot(parseSnapshot(source)), source);
});
test("64 KiB limit counts UTF-8 bytes, inclusive at boundary", () => {
  const prefix = JSON.stringify(minimal);
  const padded = prefix + " ".repeat(MAX_PAYLOAD_BYTES - prefix.length);
  assert.deepEqual(parseSnapshot(padded).card, minimal);
  assert.throws(() => parseSnapshot(padded + " "), InvalidCardError);
  const largeUnicode = JSON.stringify({ ...minimal, future: "界".repeat(23_000) });
  assert.ok(largeUnicode.length < MAX_PAYLOAD_BYTES);
  assert.throws(() => parseSnapshot(largeUnicode), InvalidCardError);
  assert.throws(
    () => serializeSnapshot({ card: minimal, unknown: { big: "x".repeat(MAX_PAYLOAD_BYTES) } }),
    InvalidCardError,
  );
});
test("normalize display whitespace and omit empty optional text", () => {
  const card = parse({ ...minimal, title: "  A\tB\nC  ", description: " \t ", siteName: "  A   B " }).card;
  assert.equal(card.title, "A B C");
  assert.equal(card.siteName, "A B");
  assert.ok(!("description" in card));
});
test("bounds and rejects incorrect text types and control characters", () => {
  for (
    const patch of [
      { title: "x".repeat(513) },
      { description: "x".repeat(4097) },
      { siteName: "x".repeat(257) },
      { title: 1 },
      { description: null },
      { title: "a\u0000b" },
    ]
  ) invalid({ ...minimal, ...patch });
});
test("timestamps validate real UTC calendar dates", () => {
  for (
    const resolvedAt of [
      "2026-02-30T10:00:00Z",
      "2026-10-02T12:00:00+02:00",
      "yesterday",
      "2026-10-02T24:00:00Z",
    ]
  ) invalid({ ...minimal, resolvedAt });
  assert.equal(
    parse({ ...minimal, resolvedAt: "2024-02-29T10:00:00.123Z" }).card.resolvedAt,
    "2024-02-29T10:00:00.123Z",
  );
});
test("reject numeric overflow and non JSON extension values before serializing", () => {
  assert.throws(
    () => parseSnapshot(JSON.stringify(minimal).replace("\"version\":1", "\"version\":1e999")),
    InvalidCardError,
  );
  assert.throws(
    () =>
      parseSnapshot(
        "{\"version\":1,\"type\":\"link-card\",\"url\":\"https://example.com\",\"title\":\"t\",\"future\":1e999}",
      ),
    InvalidCardError,
  );
  for (const bad of [NaN, Infinity, undefined, new Date(), () => 1]) {
    assert.throws(() => serializeSnapshot({ card: minimal, unknown: { bad } } as never), InvalidCardError);
  }
});
test("prototype-looking extension keys remain inert and recoverable", () => {
  const snapshot = parseSnapshot(
    "{\"version\":1,\"type\":\"link-card\",\"url\":\"https://example.com\",\"title\":\"t\",\"__proto__\":{\"polluted\":true},\"constructor\":\"kept\"}",
  );
  const next = parseSnapshot(updateSnapshot(snapshot, { title: "Updated" }));
  assert.deepEqual(next.unknown, snapshot.unknown);
  assert.ok(!("polluted" in {}));
});
test("sparse arrays and excessive nesting are rejected", () => {
  assert.throws(
    () => serializeSnapshot({ card: minimal, unknown: { sparse: new Array(2) } }),
    InvalidCardError,
  );
  let nested: unknown = null;
  for (let i = 0; i < 34; i++) nested = { nested };
  invalid({ ...minimal, future: nested });
});
test("custom-block container is own namespace and JSON strings cannot close the fence", () => {
  const snapshot = parse({ ...minimal, description: "before\n;;;\nafter" });
  const markdown = customBlockMarkdown(snapshot);
  assert.equal(markdown.split("\n")[0], ";;;" + BLOCK_INFO);
  assert.equal(markdown.split("\n").filter(line => line === ";;;").length, 1);
  assert.deepEqual(parseSnapshot(markdown.slice(markdown.indexOf("\n") + 1, -4)), snapshot);
});
test("synthetic insertion content is deterministic and has no media URLs", () => {
  assert.equal(customBlockMarkdown(syntheticSnapshot()), customBlockMarkdown(syntheticSnapshot()));
  assert.equal(syntheticSnapshot().card.image, undefined);
  assert.equal(syntheticSnapshot().card.favicon, undefined);
});
test("validated navigation URL preserves exact spelling", () => {
  const url = "HTTPS://Example.com/path?one=1&two=%2F#part";
  assert.equal(validateHttpUrl(url), url);
});
