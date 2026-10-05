/** Narrow canonical flat raster references returned by SiYuan's multipart upload API. */
export function isAssetReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240
    && /^assets\/[A-Za-z0-9][A-Za-z0-9_-]*-\d{14}-[a-z0-9]{7}\.(?:png|jpg|jpeg|webp)$/.test(value);
}
export function assetReference(value: unknown): string {
  if (!isAssetReference(value)) throw new Error("invalid-asset-reference");
  return value;
}
export const MEDIA_ATTRIBUTES = {
  image: "custom-data-assets-slc-image",
  favicon: "custom-data-assets-slc-favicon",
} as const;
export function mediaAttributes(card: { image?: string; favicon?: string; }): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const field of ["image", "favicon"] as const) {
    if (isAssetReference(card[field])) attrs[MEDIA_ATTRIBUTES[field]] = card[field];
  }
  return attrs;
}
/** One host-recognized reference per attribute. Preserve unrelated original IAL verbatim. */
export function mediaIAL(card: { image?: string; favicon?: string; }, original = ""): string {
  let ial = original.trim();
  if (ial && !/^\{:[^\r\n]*\}$/.test(ial)) throw new Error("invalid-ial");
  ial = ial.replace(/\s+custom-data-assets-slc-(?:image|favicon)="(?:[^"\\]|\\.)*"/g, "");
  if (/custom-data-assets-slc-(?:image|favicon)\s*=/.test(ial)) throw new Error("invalid-media-ial");
  const attrs = Object.entries(mediaAttributes(card)).map(([name, value]) => ` ${name}="${value}"`).join("");
  if (!ial) return attrs ? `{: ${attrs.trim()}}\n` : "";
  return ial.slice(0, -1) + attrs + "}\n";
}
