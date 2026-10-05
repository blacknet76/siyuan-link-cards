import { youtubeSourceId, youtubeVideoId } from "../oembed/youtube.ts";

/** Fixed local geometry: Lute lifts this style onto the native block/IAL (4px host padding). */
export const NATIVE_YOUTUBE_STYLE = "width:calc(100% - 8px);height:auto;aspect-ratio:16 / 9;min-height:0;";
export const NATIVE_YOUTUBE_SANDBOX = "allow-scripts allow-same-origin allow-presentation";

/** No HTML, embed URL, remote title or attributes are accepted by this adapter. */
export function nativeYoutubeSource(sourceUrl: string, confirmedVideoId: string): string {
  if (!youtubeVideoId(confirmedVideoId) || youtubeSourceId(sourceUrl) !== confirmedVideoId) {
    throw new Error("Invalid native YouTube source");
  }
  return `<iframe src="https://www.youtube.com/embed/${confirmedVideoId}" title="YouTube video player" sandbox="${NATIVE_YOUTUBE_SANDBOX}" allow="fullscreen" referrerpolicy="strict-origin" allowfullscreen style="${NATIVE_YOUTUBE_STYLE}"></iframe>\n`;
}

/** Reviewed desktop hosts only; native remote connections must retain the passive fallback. */
export function nativeYoutubeAvailable(frontend: string, parentUrl: string): boolean {
  try {
    const url = new URL(parentUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.searchParams.get("remote") === "1") return false;
    if (frontend === "browser-desktop") return url.origin !== "https://www.youtube.com";
    return ["desktop", "desktop-window"].includes(frontend)
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
