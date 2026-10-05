import { extractMetadata } from "../metadata/extract.ts";
import { retrieveHtml, retrieveJsonResponse } from "../metadata/http.ts";
import type { ProxyTransport } from "../metadata/http.ts";
import { checkCancelled, ResolutionError } from "../metadata/types.ts";
import { discoverOembed } from "./discovery.ts";
import { normalizeOembed } from "./normalize.ts";
import { OembedResolutionError } from "./types.ts";
import type { OembedResult } from "./types.ts";

export async function resolveOembed(
  url: string,
  services: { transport: ProxyTransport; document: Document; },
  signal?: AbortSignal,
): Promise<OembedResult> {
  try {
    const page = await retrieveHtml(url, services.transport, signal);
    checkCancelled(signal);
    const endpoint = discoverOembed(page.html, page.resolvedUrl, services.document);
    const json = await retrieveJsonResponse(endpoint, services.transport, signal);
    checkCancelled(signal);
    const snapshot = normalizeOembed(json.body, url, {
      resolvedUrl: page.resolvedUrl,
      endpoint: json.resolvedUrl,
    });
    // Reuse the already fetched target page, never the provider name/URL or response logo.
    // New video results become native iframes and keep their existing production path unchanged.
    if (snapshot.card.resource.kind !== "video") {
      const metadata = extractMetadata(page.html, page.resolvedUrl, services.document);
      if (metadata.favicon) snapshot.card.favicon = metadata.favicon;
      return {
        ok: true,
        snapshot,
        ...(metadata.faviconCandidates ? { faviconCandidates: metadata.faviconCandidates } : {}),
      };
    }
    return { ok: true, snapshot };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ResolutionError || error instanceof OembedResolutionError
        ? error.failure
        : { kind: "invalid-response" },
    };
  }
}
