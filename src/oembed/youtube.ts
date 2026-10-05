import { publicHttpUrl } from "../metadata/url-policy.ts";

export function youtubeVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}
function https(value: string): URL | undefined {
  try {
    const url = publicHttpUrl(value);
    return url.protocol === "https:" && !url.port && !url.hash ? url : undefined;
  } catch {
    return undefined;
  }
}
/** Deliberately small source allowlist; queries never become player parameters. */
export function youtubeSourceId(value: string): string | undefined {
  const url = https(value);
  if (!url) return undefined;
  // URL parsing normalizes dot segments; those are not one of our ordinary source forms.
  if (
    !/^https:\/\/(?:www\.)?youtube\.com(?::443)?\/watch(?:\?|$)/i.test(value)
    && !/^https:\/\/youtu\.be(?::443)?\/[A-Za-z0-9_-]{11}(?:\?|$)/i.test(value)
  ) return undefined;
  const watch = ["www.youtube.com", "youtube.com"].includes(url.hostname) && url.pathname === "/watch";
  const short = url.hostname === "youtu.be" && /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname);
  if (!watch && !short) return undefined;
  const allowed = watch ? ["v", "t", "si", "feature"] : ["t", "si"];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return undefined;
  }
  // Common share parameters are source-only; reject malformed/empty values conservatively.
  const time = url.searchParams.get("t");
  if (time !== null && !/^(?:\d+|(?:\d+h)?(?:\d+m)?\d+s)$/.test(time)) return undefined;
  const share = url.searchParams.get("si");
  if (share !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(share)) return undefined;
  const feature = url.searchParams.get("feature");
  if (feature !== null && !["youtu.be", "shared"].includes(feature)) return undefined;
  const id = watch ? url.searchParams.get("v") : url.pathname.slice(1);
  return youtubeVideoId(id) ? id : undefined;
}
export function youtubeProviderUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const url = https(value);
  return !!url && ["www.youtube.com", "youtube.com"].includes(url.hostname)
    && url.pathname === "/" && !url.search;
}
export function youtubeEndpoint(value: string, videoId: string): boolean {
  const url = https(value);
  return !!url && url.hostname === "www.youtube.com" && url.pathname === "/oembed"
    && url.searchParams.getAll("format").length === 1 && url.searchParams.get("format") === "json"
    && url.searchParams.getAll("url").length === 1
    && youtubeSourceId(url.searchParams.get("url")!) === videoId
    && [...url.searchParams.keys()].every(key => key === "format" || key === "url");
}
/** Optional thumbnail is tied to this video, never arbitrary provider-controlled media. */
export function youtubeThumbnailUrl(value: unknown, videoId: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = https(value);
  if (
    !url || url.hostname !== "i.ytimg.com" || url.search
    || !["default", "mqdefault", "hqdefault", "sddefault", "maxresdefault"].some(
      name => url.pathname === `/vi/${videoId}/${name}.jpg`,
    )
  ) return undefined;
  return url.href;
}
/** Only the reviewed browser frontend preserves the origin isolation needed by this policy. */
export function youtubePlaybackAllowed(frontend: unknown, parentUrl: string): boolean {
  if (frontend !== "browser-desktop") return false;
  try {
    const parent = new URL(parentUrl);
    return ["http:", "https:"].includes(parent.protocol) && parent.origin !== "https://www.youtube.com";
  } catch {
    return false;
  }
}
export const YOUTUBE_SANDBOX = "allow-scripts allow-same-origin";
export const YOUTUBE_ALLOW = "fullscreen https://www.youtube.com";
export const YOUTUBE_REFERRER_POLICY = "strict-origin";
export function youtubeEmbedUrl(videoId: string): string {
  if (!youtubeVideoId(videoId)) throw new Error("Invalid YouTube video ID");
  return `https://www.youtube.com/embed/${videoId}?autoplay=0`;
}
