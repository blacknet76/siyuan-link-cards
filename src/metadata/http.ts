import { checkCancelled, fail, ResolutionError } from "./types.ts";
import { publicHttpUrl, resolvePublicUrl } from "./url-policy.ts";

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const REQUEST_TIMEOUT_MS = 7000;
export const FORWARD_PROXY_PATH = "/api/network/forwardProxy";
export interface ProxyRequest {
  url: string;
  method: "GET";
  timeout: number;
  redirect: false;
  contentType: "text/html" | "application/json" | "image/png";
  responseEncoding: "text" | "base64-std";
  headers: Record<string, string>[];
}
export type ProxyTransport = (request: ProxyRequest, signal?: AbortSignal) => Promise<unknown>;
export type KernelPost = (
  path: typeof FORWARD_PROXY_PATH,
  data: ProxyRequest,
  headers: Record<string, string>,
  process: boolean,
  signal?: AbortSignal,
) => Promise<unknown>;

/** SDK process=false suppresses raw kernel messages. Only local API authentication is inherited. */
export function kernelTransport(post: KernelPost): ProxyTransport {
  return (request, signal) =>
    post(FORWARD_PROXY_PATH, request, { "Content-Type": "application/json" }, false, signal);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function headerValues(headers: unknown, name: string): string[] {
  if (!record(headers)) return [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return [];
    values.push(...value);
  }
  return values;
}

export function validateHtml(body: string, contentType: string): void {
  if (body.length > MAX_HTML_BYTES || new TextEncoder().encode(body).length > MAX_HTML_BYTES) {
    fail("response-too-large");
  }
  // Reject binary indicators even if the server labels them HTML.
  if (
    // eslint-disable-next-line no-control-regex -- Binary/non-text detection before HTML parsing.
    !body.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)
    || /^(?:%PDF-|GIF8[79]a|\u0089PNG)/.test(body)
  ) fail("unsupported-content");
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return;
  if (
    /^(?:image|audio|video|font)\//.test(mime)
    || [
      "application/pdf",
      "application/octet-stream",
      "application/zip",
      "application/json",
      "text/css",
      "text/javascript",
      "application/javascript",
    ].includes(mime)
  ) {
    fail("unsupported-content");
  }
  // Limited fallback for absent/imperfect headers. No attempt at general MIME sniffing.
  if (!/<(?:!doctype\s+html\b|html\b|head\b|title\b|meta\b|body\b)/i.test(body.slice(0, 4096))) {
    fail("unsupported-content");
  }
}

async function retrieveText(
  originalUrl: string,
  transport: ProxyTransport,
  signal: AbortSignal | undefined,
  json: boolean,
  image = false,
): Promise<{ body: string; resolvedUrl: string; contentType: string; }> {
  const first = publicHttpUrl(originalUrl);
  first.hash = "";
  let current = first.href;
  const visited = new Set<string>();
  let hops = 0;
  for (;;) {
    checkCancelled(signal);
    if (visited.has(current)) throw new ResolutionError({ kind: "redirect-error", reason: "loop" });
    visited.add(current);
    let response: unknown;
    try {
      response = await transport({
        url: current,
        method: "GET",
        timeout: REQUEST_TIMEOUT_MS,
        redirect: false,
        contentType: image ? "image/png" : json ? "application/json" : "text/html",
        responseEncoding: image ? "base64-std" : "text",
        headers: [{
          Accept: image ? "image/png, image/jpeg, image/webp" : json
            ? "application/json, application/json+oembed;q=0.9"
            : "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5",
          "User-Agent": "SiYuan-Link-Cards/0.1.0",
        }],
      }, signal);
    } catch {
      checkCancelled(signal);
      return fail("network-error");
    }
    checkCancelled(signal);
    if (!record(response) || response.code !== 0) {
      return fail(record(response) && response.code === 10 ? "response-too-large" : "network-error");
    }
    const data = response.data;
    if (
      !record(data) || !Number.isInteger(data.status) || (data.status as number) < 100
      || (data.status as number) > 599
    ) fail("network-error");
    const status = data.status as number;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (hops >= MAX_REDIRECTS) throw new ResolutionError({ kind: "redirect-error", reason: "limit" });
      const locations = headerValues(data.headers, "location");
      if (locations.length !== 1 || /[\r\n]/.test(locations[0]!)) {
        throw new ResolutionError({ kind: "redirect-error", reason: "location" });
      }
      try {
        const next = resolvePublicUrl(locations[0]!, current);
        next.hash = "";
        current = next.href;
      } catch (error) {
        const reason = error instanceof ResolutionError && error.failure.kind === "blocked-target"
          ? "blocked-target"
          : "invalid-url";
        throw new ResolutionError({ kind: "redirect-error", reason });
      }
      hops++;
      continue;
    }
    if (status < 200 || status >= 300) throw new ResolutionError({ kind: "http-error", httpStatus: status });
    if (typeof data.body !== "string" || data.bodyEncoding !== (image ? "base64-std" : "text")) {
      fail("network-error");
    }
    const contentType = typeof data.contentType === "string" && data.contentType
      ? data.contentType
      : headerValues(data.headers, "content-type")[0] ?? "";
    if (image) {
      if (data.body.length > MAX_HTML_BYTES) fail("response-too-large");
    } else if (json) validateJsonBody(data.body, contentType);
    else validateHtml(data.body, contentType);
    // data.url echoes the request; the manually tracked URL is the network base.
    return { body: data.body, resolvedUrl: current, contentType };
  }
}

export const MAX_JSON_BYTES = 256 * 1024;
export function boundJson(source: string): void {
  if (source.length > MAX_JSON_BYTES || new TextEncoder().encode(source).length > MAX_JSON_BYTES) {
    fail("response-too-large");
  }
}
function validateJsonBody(body: string, contentType: string): void {
  boundJson(body);
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (
    mime && mime !== "text/plain" && mime !== "application/json"
    && !/^application\/[a-z0-9.+-]+\+json$/.test(mime) && mime !== "application/json+oembed"
  ) {
    fail("unsupported-content");
  }
}
export async function retrieveHtml(
  originalUrl: string,
  transport: ProxyTransport,
  signal?: AbortSignal,
): Promise<{ html: string; resolvedUrl: string; }> {
  const result = await retrieveText(originalUrl, transport, signal, false);
  return { html: result.body, resolvedUrl: result.resolvedUrl };
}
export async function retrieveJson(
  endpoint: string,
  transport: ProxyTransport,
  signal?: AbortSignal,
): Promise<string> {
  return (await retrieveJsonResponse(endpoint, transport, signal)).body;
}
/** Retain the manually verified final endpoint for provider identity checks. */
export async function retrieveJsonResponse(
  endpoint: string,
  transport: ProxyTransport,
  signal?: AbortSignal,
): Promise<{ body: string; resolvedUrl: string; }> {
  const { body, resolvedUrl } = await retrieveText(endpoint, transport, signal, true);
  return { body, resolvedUrl };
}

export async function retrieveImage(
  url: string,
  transport: ProxyTransport,
  signal?: AbortSignal,
): Promise<{ body: string; contentType: string; }> {
  return retrieveText(url, transport, signal, false, true);
}
