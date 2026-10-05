import { assetReference } from "../assets/reference.ts";
import { isJson } from "../json.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import { migrationId } from "../migration/youtube-legacy.ts";
import { OEMBED_INFO, parseOembedSnapshot } from "../oembed/schema.ts";
import { BLOCK_INFO, MAX_PAYLOAD_BYTES, parseSnapshot, validateMediaReference } from "../schema.ts";
import type { JsonValue } from "../schema.ts";

export interface FaviconSource {
  info: string;
  content: string;
  raw: Record<string, JsonValue>;
  ial: string;
  attributes: Record<string, string>;
  url: string;
}
export type FaviconRecognition =
  | { kind: "ignored"; }
  | { kind: "invalid"; }
  | { kind: "usable" | "unrepairable" | "eligible"; value: FaviconSource; };

/** Only our persisted custom blocks. Runtime image errors never participate in eligibility. */
export function recognizeFavicon(
  type: string,
  id: string,
  source: string,
  document: Document,
): FaviconRecognition {
  if (type !== "NodeCustomBlock" || !migrationId(id)) return { kind: "ignored" };
  if (!source.startsWith(`;;;${BLOCK_INFO}\n`) && !source.startsWith(`;;;${OEMBED_INFO}\n`)) {
    return { kind: "ignored" };
  }
  try {
    const parts = /^;;;([^\n]+)\n([\s\S]*\n);;;\n(\{:([^\n]*)\})\n?$/.exec(source);
    if (!parts || new TextEncoder().encode(parts[2]!).length > MAX_PAYLOAD_BYTES) throw new Error();
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    let remaining = parts[4]!;
    while (remaining.trim()) {
      const match = /^\s+([a-z][a-z0-9-]*)="([^"<>]*)"/.exec(remaining);
      if (!match || Object.hasOwn(attributes, match[1]!)) throw new Error();
      const t = document.createElement("template");
      t.innerHTML = `<div ${match[1]}="${match[2]}"></div>`;
      attributes[match[1]!] = t.content.firstElementChild!.getAttribute(match[1]!)!;
      remaining = remaining.slice(match[0].length);
    }
    if (attributes.id !== id || !/^\d{14}$/.test(attributes.updated ?? "")) throw new Error();
    const raw: unknown = JSON.parse(parts[2]!);
    if (!isJson(raw) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    let usable = false;
    if (Object.hasOwn(raw, "favicon")) {
      try {
        validateMediaReference(raw.favicon);
        usable = true;
      } catch { /* Only a structurally unusable favicon may be removed for validation below. */ }
    }
    const checked = { ...raw };
    if (!usable) delete checked.favicon;
    // Every other field must satisfy the unchanged V1 schema; future schemas stay excluded.
    const validate = parts[1] === BLOCK_INFO ? parseSnapshot : parseOembedSnapshot;
    const snapshot = validate(JSON.stringify(checked));
    const value: FaviconSource = {
      info: parts[1]!,
      content: parts[2]!,
      raw,
      ial: parts[3]!,
      attributes,
      url: snapshot.card.url,
    };
    if (usable) return { kind: "usable", value };
    try {
      publicHttpUrl(value.url);
    } catch {
      return { kind: "unrepairable", value };
    }
    return { kind: "eligible", value };
  } catch {
    return { kind: "invalid" };
  }
}

/** The validated JSON is scanned lexically so unrelated values retain even their original number spelling. */
function patchFavicon(content: string, favicon: string): string {
  const ranges: [number, number][] = [];
  let depth = 0, key = true, field = "", start: number | undefined;
  for (const token of content.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^{}[\],:\s]+/g)) {
    const value = token[0], position = token.index;
    if (depth === 1 && key && value.startsWith("\"")) {
      field = JSON.parse(value) as string;
      key = false;
    } else if (depth === 1 && value === ":" && field === "favicon") {
      start = position + 1;
    } else if (depth === 1 && (value === "," || value === "}")) {
      if (start !== undefined) ranges.push([start, position]);
      start = undefined;
      field = "";
      if (value === ",") key = true;
    }
    if (value === "{" || value === "[") depth++;
    else if (value === "}" || value === "]") depth--;
  }
  if (!ranges.length) {
    const closing = content.lastIndexOf("}");
    return content.slice(0, closing).trimEnd() + `,\n  "favicon": ${JSON.stringify(favicon)}\n`
      + content.slice(closing);
  }
  for (const [start, end] of ranges.reverse()) {
    const old = content.slice(start, end);
    const replacement = /^\s*/.exec(old)![0] + JSON.stringify(favicon) + /\s*$/.exec(old)![0];
    content = content.slice(0, start) + replacement + content.slice(end);
  }
  return content;
}

/** Preserve raw JSON values (including whitespace in display strings); patch only favicon and its IAL. */
export function repairedMarkdown(value: FaviconSource, favicon: string): string {
  const local = assetReference(favicon);
  const content = patchFavicon(value.content, local);
  (value.info === BLOCK_INFO ? parseSnapshot : parseOembedSnapshot)(content);
  const ial = value.ial.replace(/\s+custom-data-assets-slc-favicon="[^"<>]*"/g, "");
  return `;;;${value.info}\n${content};;;\n`
    + ial.slice(0, -1) + ` custom-data-assets-slc-favicon="${local}"}\n`;
}
