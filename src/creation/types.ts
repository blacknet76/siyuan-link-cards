import type { ResolutionResult } from "../metadata/types.ts";

export type CreationFailure = "stale-target" | "insertion-failed";
export class CreationError extends Error {
  readonly kind: CreationFailure;
  constructor(kind: CreationFailure) {
    super(kind);
    this.kind = kind;
  }
}

export interface InsertionTarget {
  prefill: Promise<string>;
  assetContext?: string;
  resume(): void;
  /** Release the current attempt's handle; a stable checkpoint permits a new explicit attempt. */
  pause(): void;
  insert(markdown: string): void;
  /** Only normal validated YouTube source + confirmed ID, never raw iframe/HTML. */
  insertYoutube(sourceUrl: string, confirmedVideoId: string): void;
  release(): void;
}
export type BookmarkResolver = (url: string, signal: AbortSignal) => Promise<ResolutionResult>;

export type CreationKind = "bookmark" | "embed";
export type EmbedResolver = (
  url: string,
  signal: AbortSignal,
) => Promise<import("../oembed/types.ts").OembedResult>;
export interface EmbedOptions {
  kind?: CreationKind;
  nativeYoutubeAvailable?: boolean;
  resolveEmbed?: EmbedResolver;
  importAsset?: import("../assets/service.ts").AssetImporter;
  notifyMediaOmitted?: () => void;
}
