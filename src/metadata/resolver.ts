import { extractMetadata } from "./extract.ts";
import { retrieveHtml } from "./http.ts";
import type { ProxyTransport } from "./http.ts";
import { checkCancelled, ResolutionError } from "./types.ts";
import type { ResolutionResult } from "./types.ts";

export interface ResolverServices {
  transport: ProxyTransport;
  document: Document;
  now?: () => Date;
}

/** Returns data only: no block serialization, editor, persistence, assets or UI side effects. */
export async function resolveBookmark(
  originalUrl: string,
  services: ResolverServices,
  signal?: AbortSignal,
): Promise<ResolutionResult> {
  try {
    const { html, resolvedUrl } = await retrieveHtml(originalUrl, services.transport, signal);
    checkCancelled(signal);
    const metadata = extractMetadata(html, resolvedUrl, services.document);
    checkCancelled(signal);
    const resolvedAt = (services.now?.() ?? new Date()).toISOString();
    return { ok: true, metadata: { originalUrl, resolvedUrl, ...metadata, resolvedAt } };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: { kind: "cancelled" } };
    return { ok: false, error: error instanceof ResolutionError ? error.failure : { kind: "parse-error" } };
  }
}
