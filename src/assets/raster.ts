export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_PIXELS = 16_000_000;
export type RasterMime = "image/png" | "image/jpeg" | "image/webp";
export interface Raster {
  bytes: Uint8Array;
  mime: RasterMime;
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}
function fail(): never {
  throw new Error("invalid-raster");
}
function size(width: number, height: number): void {
  if (!width || !height || width * height > MAX_ASSET_PIXELS) fail();
}
export function decodeBase64(encoded: string): Uint8Array {
  if (
    !encoded || encoded.length > MAX_ASSET_BYTES || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) fail();
  const value = atob(encoded);
  if (btoa(value) !== encoded || value.length > MAX_ASSET_BYTES) fail();
  return Uint8Array.from(value, c => c.charCodeAt(0));
}
export function dataRaster(source: string): Raster {
  if (source.length > MAX_ASSET_BYTES) fail();
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
  if (!match) fail();
  return inspectRaster(decodeBase64(match[2]!), match[1]!);
}
/** Inspect dimensions before invoking an image decoder; MIME must agree with the actual signature. */
export function inspectRaster(bytes: Uint8Array, contentType: string): Raster {
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) fail();
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, count: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0, height = 0, extension: Raster["extension"];
  if (mime === "image/png") {
    if (
      bytes.length < 33 || ascii(1, 3) !== "PNG" || bytes[0] !== 137
      || ascii(4, 4) !== "\r\n\x1a\n" || view.getUint32(8) !== 13 || ascii(12, 4) !== "IHDR"
    ) fail();
    width = view.getUint32(16);
    height = view.getUint32(20);
    extension = "png";
  } else if (mime === "image/jpeg") {
    if (
      bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216
      || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217
    ) fail();
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) fail();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) fail();
      if ([192, 193, 194].includes(marker)) {
        if (length < 8) fail();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
    extension = "jpg";
  } else if (mime === "image/webp") {
    if (
      bytes.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP"
      || view.getUint32(4, true) + 8 !== bytes.length
    ) fail();
    const kind = ascii(12, 4);
    if (kind === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (kind === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 " && ascii(23, 3) === "\x9d\x01\x2a") {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else fail();
    extension = "webp";
  } else fail();
  size(width, height);
  return { bytes, mime: mime as RasterMime, extension, width, height };
}
/** Browser-local decoding only: no remote image URL is ever given to the decoder. */
export async function verifyRaster(raster: Raster): Promise<void> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(raster.bytes)], { type: raster.mime }));
  try {
    size(bitmap.width, bitmap.height);
    if (bitmap.width !== raster.width || bitmap.height !== raster.height) fail();
  } finally {
    bitmap.close();
  }
}
