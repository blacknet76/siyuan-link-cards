import type { ResolverFailure } from "../metadata/types.ts";
import type { OembedSnapshot } from "./schema.ts";
export type OembedFailureKind =
  | "no-discovery"
  | "xml-only"
  | "invalid-response"
  | "invalid-version"
  | "unsupported-type"
  | "invalid-photo"
  | "invalid-video"
  | "native-video-unavailable";
export type OembedFailure = ResolverFailure | { kind: OembedFailureKind; };
export type OembedResult = { ok: true; snapshot: OembedSnapshot; faviconCandidates?: string[]; } | {
  ok: false;
  error: OembedFailure;
};
export class OembedResolutionError extends Error {
  readonly failure: OembedFailure;
  constructor(kind: OembedFailureKind) {
    super(kind);
    this.failure = { kind };
  }
}
export function oembedFail(kind: OembedFailureKind): never {
  throw new OembedResolutionError(kind);
}
