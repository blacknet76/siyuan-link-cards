import { isAssetReference, mediaIAL } from "./assets/reference.ts";
import { encodeEntries, isJson } from "./json.ts";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const BLOCK_TYPE = "link-card";
export const BLOCK_INFO = "siyuan-link-cards/link-card";

export interface LinkCard {
  version: 1;
  type: "link-card";
  url: string;
  title: string;
  description?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
  resolvedUrl?: string;
  resolvedAt?: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue; };
export interface Snapshot {
  card: LinkCard;
  unknown: Record<string, JsonValue>;
}

// Known keys always precede lexically sorted extension keys.
export const KEY_ORDER = [
  "version",
  "type",
  "url",
  "title",
  "description",
  "image",
  "favicon",
  "siteName",
  "resolvedUrl",
  "resolvedAt",
] as const;

export class InvalidCardError extends Error {
  constructor() {
    super("Invalid Link Card snapshot");
  }
}

function invalid(): never {
  throw new InvalidCardError();
}

export function validateHttpUrl(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value)
    // eslint-disable-next-line no-control-regex -- URL validation explicitly rejects control characters.
    || /[\s\\\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid();
  }
  const authority = value.split("/")[2];
  if (!parsed.hostname || parsed.username || parsed.password || authority?.includes("@")) invalid();
  return value; // Preserve the confirmed destination, including query/fragment and spelling.
}

/** Shared persisted raster reference: canonical local asset or backward-compatible HTTP(S) URL. */
export function validateMediaReference(value: unknown): string {
  return isAssetReference(value) ? value : validateHttpUrl(value);
}

function text(value: unknown, limit: number, required = false): string | undefined {
  if (
    typeof value !== "string" || value.length > limit
    // eslint-disable-next-line no-control-regex -- Display text must not contain non-whitespace controls.
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) invalid();
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized && required) invalid();
  return normalized || undefined;
}

function utcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    invalid();
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) invalid();
  const canonical = new Date(millis).toISOString();
  if (canonical !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) invalid();
  return canonical;
}

function validateObject(value: unknown): Snapshot {
  if (!isJson(value) || !value || Array.isArray(value) || typeof value !== "object") invalid();
  if (value.version !== 1 || value.type !== BLOCK_TYPE) invalid();
  const card: LinkCard = {
    version: 1,
    type: BLOCK_TYPE,
    url: validateHttpUrl(value.url),
    title: text(value.title, 512, true)!,
  };
  for (const key of ["description", "siteName"] as const) {
    if (key in value) {
      const normalized = text(value[key], key === "description" ? 4096 : 256);
      if (normalized !== undefined) card[key] = normalized;
    }
  }
  for (const key of ["image", "favicon"] as const) {
    if (key in value) card[key] = validateMediaReference(value[key]);
  }
  if ("resolvedUrl" in value) card.resolvedUrl = validateHttpUrl(value.resolvedUrl);
  if ("resolvedAt" in value) card.resolvedAt = utcTimestamp(value.resolvedAt);
  const unknown = Object.fromEntries(
    Object.entries(value).filter(([key]) => !(KEY_ORDER as readonly string[]).includes(key)),
  );
  return { card, unknown };
}

function bound(source: string): void {
  if (source.length > MAX_PAYLOAD_BYTES || new TextEncoder().encode(source).length > MAX_PAYLOAD_BYTES) {
    invalid();
  }
}

export function parseSnapshot(source: string): Snapshot {
  bound(source);
  try {
    return validateObject(JSON.parse(source));
  } catch {
    return invalid();
  }
}

export function serializeSnapshot(snapshot: Snapshot): string {
  if (
    !isJson(snapshot.unknown)
    || Object.keys(snapshot.unknown).some(key => (KEY_ORDER as readonly string[]).includes(key))
  ) invalid();
  const checked = validateObject({ ...snapshot.unknown, ...snapshot.card });
  const pairs: [string, JsonValue][] = KEY_ORDER.filter(key => key in checked.card).map(
    key => [key, checked.card[key]!],
  );
  for (const key of Object.keys(checked.unknown).sort()) pairs.push([key, checked.unknown[key]!]);
  // Explicit entries also keep integer-looking extension keys behind known keys.
  const source = encodeEntries(pairs, 0) + "\n";
  bound(source);
  return source;
}

export function updateSnapshot(
  snapshot: Snapshot,
  patch: Partial<Omit<LinkCard, "version" | "type">>,
): string {
  const next = { ...snapshot.card, ...patch };
  for (const key of Object.keys(next) as (keyof LinkCard)[]) {
    if (next[key] === undefined) delete next[key];
  }
  return serializeSnapshot({ card: next, unknown: snapshot.unknown });
}

export function customBlockMarkdown(snapshot: Snapshot, originalIAL = ""): string {
  return `;;;${BLOCK_INFO}\n${serializeSnapshot(snapshot)};;;\n` + mediaIAL(snapshot.card, originalIAL);
}
