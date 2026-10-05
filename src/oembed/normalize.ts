import { boundJson } from "../metadata/http.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import { parseOembedSnapshot, positiveDimension } from "./schema.ts";
import type { OembedSnapshot, Provider, Resource } from "./schema.ts";
import { oembedFail } from "./types.ts";
import { youtubeEndpoint, youtubeProviderUrl, youtubeSourceId, youtubeThumbnailUrl } from "./youtube.ts";

function plain(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- Normalize provider strings as text, never as HTML.
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ").trim().slice(0, limit).replace(/[\ud800-\udbff]$/u, "").trim();
  return text || undefined;
}
function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return publicHttpUrl(value.trim()).href;
  } catch {
    return undefined;
  }
}
export function normalizeOembed(
  source: string,
  originalUrl: string,
  context?: { resolvedUrl: string; endpoint: string; },
): OembedSnapshot {
  boundJson(source); // Before JSON.parse, including direct normalization calls.
  const original = publicHttpUrl(originalUrl);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return oembedFail("invalid-response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) oembedFail("invalid-response");
  const data = value as Record<string, unknown>;
  if (data.version !== "1.0" && data.version !== 1) oembedFail("invalid-version");
  let resource: Resource;
  if (data.type === "link") resource = { kind: "link" };
  else if (data.type === "photo") {
    const url = mediaUrl(data.url);
    if (!url || !positiveDimension(data.width) || !positiveDimension(data.height)) {
      oembedFail("invalid-photo");
    }
    resource = { kind: "photo", url, width: data.width, height: data.height };
  } else if (data.type === "video") {
    const videoId = youtubeSourceId(originalUrl);
    if (!videoId) return oembedFail("unsupported-type");
    if (
      data.provider_name !== "YouTube" || !youtubeProviderUrl(data.provider_url)
      || !context || youtubeSourceId(context.resolvedUrl) !== videoId
      || !youtubeEndpoint(context.endpoint, videoId)
    ) return oembedFail("invalid-video");
    resource = { kind: "video", provider: "youtube", videoId };
    const thumbnail = youtubeThumbnailUrl(data.thumbnail_url, videoId);
    if (thumbnail && positiveDimension(data.thumbnail_width) && positiveDimension(data.thumbnail_height)) {
      resource.thumbnail = { url: thumbnail, width: data.thumbnail_width, height: data.thumbnail_height };
    }
  } else return oembedFail("unsupported-type");
  const provider: Provider = {};
  const name = plain(data.provider_name, 256), url = mediaUrl(data.provider_url);
  if (name) provider.name = name;
  if (url) provider.url = url;
  if (resource.kind === "video") {
    provider.name = "YouTube";
    provider.url = "https://www.youtube.com/";
  }
  // Explicit whitelist: html, scripts, author, cache_age and unknown response data are ignored.
  return parseOembedSnapshot(JSON.stringify({
    version: 1,
    type: "oembed",
    url: originalUrl,
    title: plain(data.title, 512) ?? original.hostname,
    ...(name || url ? { provider } : {}),
    resource,
  }));
}
