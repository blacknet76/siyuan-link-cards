import { dataRaster } from "../assets/raster.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import { customBlockMarkdown, MAX_PAYLOAD_BYTES, parseSnapshot } from "../schema.ts";
import type { Snapshot } from "../schema.ts";

export type Variant = "imageDescription" | "descriptionOnly" | "imageOnly" | "titleOnly";
export type Recognition =
  | { kind: "ignored" | "rejected"; }
  | { kind: "unknown"; fields: string[]; }
  | {
    kind: "confirmed";
    snapshot: Snapshot;
    markdown: string;
    variant: Variant;
    sources: { image?: string; favicon?: string; };
    titleFallback: boolean;
    omittedMedia: number;
    localMedia: number;
    ial: string;
  };
const required = ["title", "image", "description", "url", "favicon"] as const;
const known = new Set<string>([...required, "aspectRatio"]);

/** Only the audited flat, double-quoted, single-line YAML string subset; NOT arbitrary YAML. */
export function recognizeLegacy(type: string, source: string): Recognition {
  if (type !== "NodeCodeBlock" || !source.startsWith("```embed\n")) return { kind: "ignored" };
  if (source.length > MAX_PAYLOAD_BYTES || new TextEncoder().encode(source).length > MAX_PAYLOAD_BYTES) {
    return { kind: "rejected" };
  }
  // The persisted block must contain one fence and its own optional block IAL, nothing else.
  const fence = /^```embed\n([\s\S]*?)\n```\n?(?:\n*(\{:[^\n]*\})\n?)?$/.exec(source);
  if (!fence) return { kind: "rejected" };
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  try {
    for (const line of fence[1]!.split("\n")) {
      const entry = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*("(?:[^"\\\r\n]|\\[^\r\n])*")[ \t]*$/.exec(line);
      if (!entry || Object.hasOwn(values, entry[1]!)) return { kind: "rejected" };
      const value: unknown = JSON.parse(entry[2]!.replaceAll("\t", "\\t"));
      if (typeof value !== "string") return { kind: "rejected" };
      values[entry[1]!] = value;
    }
    if (required.some(key => !Object.hasOwn(values, key))) return { kind: "rejected" };
    const url = publicHttpUrl(values.url);
    const sources: { image?: string; favicon?: string; } = {};
    let omittedMedia = 0, localMedia = 0;
    const remote: { image?: string; favicon?: string; } = {};
    for (const key of ["image", "favicon"] as const) {
      if (!values[key]) continue;
      try {
        if (values[key]!.startsWith("data:")) dataRaster(values[key]!);
        else {
          publicHttpUrl(values[key]);
          remote[key] = values[key];
        }
        sources[key] = values[key];
        localMedia++;
      } catch {
        omittedMedia++;
      }
    }
    const titleFallback = !values.title!.trim();
    if (
      Object.hasOwn(values, "aspectRatio")
      && (!/^\d+(?:\.\d+)?$/.test(values.aspectRatio!) || !Number.isFinite(Number(values.aspectRatio))
        || Number(values.aspectRatio) <= 0)
    ) return { kind: "rejected" };
    const snapshot = parseSnapshot(JSON.stringify({
      version: 1,
      type: "link-card",
      url: values.url,
      title: titleFallback ? url.hostname : values.title,
      siteName: url.hostname,
      ...(values.description ? { description: values.description } : {}),
      ...remote,
    }));
    const fields = Object.keys(values).filter(key => !known.has(key));
    if (fields.length) return { kind: "unknown", fields };
    const variant: Variant = sources.image
      ? (snapshot.card.description ? "imageDescription" : "imageOnly")
      : (snapshot.card.description ? "descriptionOnly" : "titleOnly");
    return {
      kind: "confirmed",
      snapshot,
      variant,
      sources,
      titleFallback,
      omittedMedia,
      localMedia,
      ial: fence[2] ?? "",
      markdown: customBlockMarkdown(snapshot, fence[2] ?? ""),
    };
  } catch {
    return { kind: "rejected" };
  }
}
