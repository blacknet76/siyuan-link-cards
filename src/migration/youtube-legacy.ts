import { nativeYoutubeSource } from "../creation/youtube.ts";
import { youtubeSourceId, youtubeVideoId } from "../oembed/youtube.ts";
import { MAX_PAYLOAD_BYTES } from "../schema.ts";

export const HISTORICAL_YOUTUBE_MARKER = "custom-oembed-link";
export const migrationId = (id: unknown): id is string =>
  typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/.test(id);
export type YoutubeRecognition =
  | { kind: "ignored" | "unsupported"; }
  | {
    kind: "confirmed";
    videoId: string;
    sourceUrl: string;
    html: string;
    ial: string;
    attributes: Record<string, string>;
    markdown: string;
  };

// Strict quoted attribute grammar: do not let an HTML parser repair malformed/duplicate attributes.
function attributes(source: string, document: Document): Record<string, string> | undefined {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let remaining = source;
  while (remaining.trim()) {
    const match = /^\s+([a-z][a-z0-9-]*)="([^"<>]*)"/.exec(remaining);
    if (!match || Object.hasOwn(result, match[1]!)) return undefined;
    const template = document.createElement("template");
    template.innerHTML = `<div ${match[1]}="${match[2]}"></div>`;
    result[match[1]!] = template.content.firstElementChild!.getAttribute(match[1]!)!;
    remaining = remaining.slice(match[0].length);
  }
  return result;
}

/** Only the audited div/YouTube-iframe + IAL signature; never a generic provider HTML converter. */
export function recognizeHistoricalYoutube(
  type: string,
  id: string,
  source: string,
  document: Document,
): YoutubeRecognition {
  if (type !== "NodeHTMLBlock" || !migrationId(id)) return { kind: "ignored" };
  if (new TextEncoder().encode(source).length > MAX_PAYLOAD_BYTES) return { kind: "unsupported" };
  const parts = /^([\s\S]+)\n(\{:([^\n]*)\})\n?$/.exec(source);
  if (!parts) return { kind: "unsupported" };
  const ialAttributes = attributes(parts[3]!, document);
  if (!ialAttributes) return { kind: "unsupported" };
  if (!ialAttributes[HISTORICAL_YOUTUBE_MARKER]) return { kind: "ignored" };
  const html = parts[1]!.trim();
  // Passive historical bookmarks are a separate proven population, not unsupported video candidates.
  if (
    /class="[^"]*\bkg-bookmark-card\b/.test(html) && !/<(?:iframe|embed|object|video|script)\b/i.test(html)
  ) {
    return { kind: "ignored" };
  }
  if (
    ialAttributes.id !== id || !/^\d{14}$/.test(ialAttributes.updated ?? "")
    || "style" in ialAttributes || Object.keys(ialAttributes).some(key => /^on/i.test(key))
  ) return { kind: "unsupported" };
  const structure = /^<div>\s*<iframe(\s[^<>]*?)><\/iframe>\s*<\/div>$/.exec(html);
  if (!structure) return { kind: "unsupported" };
  const frame = attributes(structure[1]!, document);
  const names = [
    "width",
    "height",
    "src",
    "frameborder",
    "allow",
    "referrerpolicy",
    "allowfullscreen",
    "title",
  ];
  if (
    !frame || Object.keys(frame).length !== names.length || names.some(key => !Object.hasOwn(frame, key))
    || !/^[1-9]\d{0,3}$/.test(frame.width!) || !/^[1-9]\d{0,3}$/.test(frame.height!)
    || frame.frameborder !== "0" || frame.allowfullscreen !== ""
    || frame.referrerpolicy !== "strict-origin-when-cross-origin" || !frame.title?.trim()
    || frame.title.length > 1024
    || frame.allow
      !== "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  ) return { kind: "unsupported" };
  const embed = /^https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})(?:\?feature=oembed)?$/.exec(
    frame.src!,
  );
  const sourceUrl = ialAttributes[HISTORICAL_YOUTUBE_MARKER]!;
  const videoId = embed?.[1];
  if (!youtubeVideoId(videoId) || youtubeSourceId(sourceUrl) !== videoId) return { kind: "unsupported" };
  return {
    kind: "confirmed",
    videoId,
    sourceUrl,
    html,
    ial: parts[2]!,
    attributes: ialAttributes,
    markdown: nativeYoutubeSource(sourceUrl, videoId) + parts[2]! + "\n",
  };
}
