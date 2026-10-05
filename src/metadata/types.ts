export type FailureKind =
  | "invalid-url"
  | "blocked-target"
  | "redirect-error"
  | "network-error"
  | "http-error"
  | "unsupported-content"
  | "response-too-large"
  | "parse-error"
  | "cancelled";
export type RedirectReason = "limit" | "loop" | "location" | "invalid-url" | "blocked-target";
export interface ResolverFailure {
  kind: FailureKind;
  httpStatus?: number;
  reason?: RedirectReason;
}
export class ResolutionError extends Error {
  readonly failure: ResolverFailure;
  constructor(failure: ResolverFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}
export interface BookmarkMetadata {
  originalUrl: string;
  resolvedUrl: string;
  title: string;
  description?: string;
  image?: string;
  favicon?: string;
  /** Ordered validated candidates for explicit optional import only; never persisted. */
  faviconCandidates?: string[];
  siteName: string;
  resolvedAt: string;
}
export type ResolutionResult = { ok: true; metadata: BookmarkMetadata; } | {
  ok: false;
  error: ResolverFailure;
};

export function fail(kind: FailureKind): never {
  throw new ResolutionError({ kind });
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("cancelled");
}
