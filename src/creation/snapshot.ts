import type { BookmarkMetadata } from "../metadata/types.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import type { Snapshot } from "../schema.ts";

/** Whitelist persisted fields; never spread response/diagnostic extensions into document data. */
export function metadataSnapshot(metadata: BookmarkMetadata): Snapshot {
  publicHttpUrl(metadata.originalUrl);
  return {
    card: {
      version: 1,
      type: "link-card",
      url: metadata.originalUrl,
      title: metadata.title,
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.image ? { image: metadata.image } : {}),
      ...(metadata.favicon ? { favicon: metadata.favicon } : {}),
      siteName: metadata.siteName,
      resolvedUrl: metadata.resolvedUrl,
      resolvedAt: metadata.resolvedAt,
    },
    unknown: {},
  };
}

export function simpleSnapshot(url: string): Snapshot {
  const hostname = publicHttpUrl(url).hostname;
  return { card: { version: 1, type: "link-card", url, title: hostname, siteName: hostname }, unknown: {} };
}
