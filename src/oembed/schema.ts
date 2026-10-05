import { mediaIAL } from "../assets/reference.ts";
import { encodeEntries, isJson } from "../json.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import type { JsonValue } from "../schema.ts";
import { MAX_PAYLOAD_BYTES, validateMediaReference } from "../schema.ts";
import { youtubeProviderUrl, youtubeSourceId, youtubeThumbnailUrl, youtubeVideoId } from "./youtube.ts";

export const OEMBED_TYPE = "oembed";
export const OEMBED_INFO = "siyuan-link-cards/oembed";
export interface Provider {
  name?: string;
  url?: string;
}
export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}
export type Resource = { kind: "link"; } | { kind: "photo"; url: string; width: number; height: number; } | {
  kind: "video";
  provider: "youtube";
  videoId: string;
  thumbnail?: Thumbnail;
};
export interface OembedCard {
  version: 1;
  type: "oembed";
  url: string;
  title: string;
  provider?: Provider;
  favicon?: string;
  resource: Resource;
}
export interface OembedSnapshot {
  card: OembedCard;
  unknown: Record<string, JsonValue>;
}
const keys = ["version", "type", "url", "title", "provider", "resource", "favicon"] as const;
export class InvalidOembedError extends Error {
  constructor() {
    super("Invalid oEmbed snapshot");
  }
}
function invalid(): never {
  throw new InvalidOembedError();
}
function object(value: unknown): value is Record<string, JsonValue> {
  return isJson(value) && value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" || value.length > max
    // eslint-disable-next-line no-control-regex -- Persisted display text rejects controls.
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) invalid();
  const result = value.replace(/\s+/gu, " ").trim();
  if (!result) invalid();
  return result;
}
function url(value: unknown): string {
  if (typeof value !== "string") invalid();
  try {
    publicHttpUrl(value);
    return value;
  } catch {
    return invalid();
  }
}
export function positiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function checked(value: unknown): OembedSnapshot {
  if (!object(value) || value.version !== 1 || value.type !== OEMBED_TYPE || !object(value.resource)) {
    invalid();
  }
  const resource = value.resource;
  if (resource.kind !== "link" && resource.kind !== "photo" && resource.kind !== "video") invalid();
  if (
    resource.kind === "photo" && (!positiveDimension(resource.width) || !positiveDimension(resource.height))
  ) invalid();
  let video: Extract<Resource, { kind: "video"; }> | undefined;
  if (resource.kind === "video") {
    if (
      resource.provider !== "youtube" || !youtubeVideoId(resource.videoId)
      || youtubeSourceId(url(value.url)) !== resource.videoId
    ) invalid();
    video = { ...resource, kind: "video", provider: "youtube", videoId: resource.videoId };
    if ("thumbnail" in resource) {
      const thumbnail = resource.thumbnail;
      if (
        !object(thumbnail) || !youtubeThumbnailUrl(thumbnail.url, resource.videoId)
        || !positiveDimension(thumbnail.width) || !positiveDimension(thumbnail.height)
      ) invalid();
      video.thumbnail = {
        ...thumbnail,
        url: url(thumbnail.url),
        width: thumbnail.width,
        height: thumbnail.height,
      };
    }
  }
  const card: OembedCard = {
    version: 1,
    type: OEMBED_TYPE,
    url: url(value.url),
    title: text(value.title, 512),
    resource: video ?? (resource.kind === "link" ? { ...resource, kind: "link" } : {
      ...resource,
      kind: "photo",
      url: url(resource.url),
      width: resource.width as number,
      height: resource.height as number,
    }),
  };
  if ("favicon" in value) card.favicon = validateMediaReference(value.favicon);
  if ("provider" in value) {
    if (!object(value.provider)) invalid();
    const provider: Provider = { ...value.provider };
    if ("name" in value.provider) provider.name = text(value.provider.name, 256);
    if ("url" in value.provider) provider.url = url(value.provider.url);
    card.provider = provider;
    if (video && (provider.name !== "YouTube" || !youtubeProviderUrl(provider.url))) invalid();
  }
  return {
    card,
    unknown: Object.fromEntries(
      Object.entries(value).filter(([key]) => !(keys as readonly string[]).includes(key)),
    ),
  };
}
function bound(source: string): void {
  if (source.length > MAX_PAYLOAD_BYTES || new TextEncoder().encode(source).length > MAX_PAYLOAD_BYTES) {
    invalid();
  }
}
export function parseOembedSnapshot(source: string): OembedSnapshot {
  bound(source);
  try {
    return checked(JSON.parse(source));
  } catch {
    return invalid();
  }
}
export function serializeOembedSnapshot(snapshot: OembedSnapshot): string {
  if (
    !object(snapshot.unknown)
    || Object.keys(snapshot.unknown).some(key => (keys as readonly string[]).includes(key))
  ) invalid();
  const result = checked({ ...snapshot.unknown, ...snapshot.card });
  const pairs: [string, JsonValue][] = keys.filter(key => key in result.card).map(
    key => [key, result.card[key] as JsonValue],
  );
  for (const key of Object.keys(result.unknown).sort()) pairs.push([key, result.unknown[key]!]);
  const source = encodeEntries(pairs, 0) + "\n";
  bound(source);
  return source;
}
export function oembedMarkdown(snapshot: OembedSnapshot): string {
  return `;;;${OEMBED_INFO}\n${serializeOembedSnapshot(snapshot)};;;\n` + mediaIAL(snapshot.card);
}
