import { retrieveImage } from "../metadata/http.ts";
import type { ProxyTransport } from "../metadata/http.ts";
import { checkCancelled } from "../metadata/types.ts";
import { dataRaster, decodeBase64, inspectRaster, verifyRaster } from "./raster.ts";
import type { Raster } from "./raster.ts";
import { assetReference } from "./reference.ts";

export type AssetImporter = (source: string, blockId: string, signal?: AbortSignal) => Promise<string>;
export type AssetUpload = (form: FormData, signal?: AbortSignal) => Promise<unknown>;
export interface MediaResult {
  imported: number;
  omitted: number;
}
export async function assetFilename(raster: Raster): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(raster.bytes));
  return "slc-" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("")
    + "." + raster.extension;
}
/** One reusable explicit-operation service. Never receives a renderer or filesystem handle. */
export function assetImporter(
  transport: ProxyTransport,
  upload: AssetUpload,
  verify: (raster: Raster) => Promise<void> = verifyRaster,
): AssetImporter {
  return async (source, blockId, signal) => {
    checkCancelled(signal);
    if (!/^\d{14}-[a-z0-9]{7}$/.test(blockId)) throw new Error("asset-context");
    const raster = source.startsWith("data:") ? dataRaster(source) : await (async () => {
      const response = await retrieveImage(source, transport, signal);
      return inspectRaster(decodeBase64(response.body), response.contentType);
    })();
    checkCancelled(signal);
    await verify(raster);
    const name = await assetFilename(raster);
    checkCancelled(signal);
    const form = new FormData();
    form.append("id", blockId);
    // Documented global placement keeps ordinary notebook/document moves path-stable.
    form.append("assetsDirPath", "/assets/");
    form.append("file[]", new Blob([new Uint8Array(raster.bytes)], { type: raster.mime }), name);
    const response = await upload(form, signal);
    checkCancelled(signal);
    if (
      !response || typeof response !== "object" || !("code" in response) || response.code !== 0
      || !("data" in response) || !response.data || typeof response.data !== "object"
    ) throw new Error("asset-upload");
    const data = response.data as Record<string, unknown>;
    if (
      (data.errFiles !== null && (!Array.isArray(data.errFiles) || data.errFiles.length)) || !data.succMap
      || typeof data.succMap !== "object"
      || Object.keys(data.succMap).length !== 1
    ) throw new Error("asset-upload");
    return assetReference((data.succMap as Record<string, unknown>)[name]);
  };
}
/** Optional failures degrade only media, never the otherwise valid card. Cancellation still stops insertion. */
export async function localizeMedia<T extends { card: { image?: string; favicon?: string; }; }>(
  snapshot: T,
  sources: { image?: string; favicon?: string; faviconCandidates?: readonly string[]; },
  blockId: string,
  importer?: AssetImporter,
  signal?: AbortSignal,
): Promise<{ snapshot: T; media: MediaResult; }> {
  const card = { ...snapshot.card };
  const media = { imported: 0, omitted: 0 };
  for (const field of ["image", "favicon"] as const) {
    delete card[field];
    const candidates = field === "favicon"
      ? [
        ...new Set(
          [sources.favicon, ...(sources.faviconCandidates ?? [])].filter((value): value is string =>
            Boolean(value)
          ),
        ),
      ].slice(0, 8)
      : sources.image
      ? [sources.image]
      : [];
    if (!candidates.length) continue;
    for (const source of candidates) {
      checkCancelled(signal);
      try {
        if (!importer) throw new Error("asset-service-unavailable");
        card[field] = assetReference(await importer(source, blockId, signal));
        media.imported++;
        break;
      } catch {
        checkCancelled(signal);
      }
      if (!importer) break;
    }
    if (!card[field]) media.omitted++;
  }
  return { snapshot: { ...snapshot, card }, media };
}
