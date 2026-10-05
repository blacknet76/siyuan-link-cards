import { localizeMedia } from "../assets/service.ts";
import { ResolutionError } from "../metadata/types.ts";
import type { FailureKind } from "../metadata/types.ts";
import { publicHttpUrl } from "../metadata/url-policy.ts";
import { oembedMarkdown } from "../oembed/schema.ts";
import type { OembedFailure } from "../oembed/types.ts";
import { customBlockMarkdown } from "../schema.ts";
import type { Strings } from "../strings.ts";
import { metadataSnapshot, simpleSnapshot } from "./snapshot.ts";
import { CreationError } from "./types.ts";
import type { BookmarkResolver, CreationKind, EmbedOptions, InsertionTarget } from "./types.ts";

export interface CreationView {
  value(): string;
  prefill(value: string): void;
  busy(value: boolean): void;
  status(message: string, error?: boolean): void;
  fallback(show: boolean): void;
  bookmarkFallback?(show: boolean): void;
  type?(kind: CreationKind): void;
  terminal(): void;
  close(): void;
}

export function failureLabel(kind: FailureKind, strings: Strings): string {
  const key = ({
    "invalid-url": "resolverInvalidUrl",
    "blocked-target": "resolverBlockedTarget",
    "redirect-error": "resolverRedirectError",
    "network-error": "resolverNetworkError",
    "http-error": "resolverHttpError",
    "unsupported-content": "resolverUnsupportedContent",
    "response-too-large": "resolverResponseTooLarge",
    "parse-error": "resolverParseError",
    cancelled: "resolverCancelled",
  } as const)[kind];
  return strings[key];
}

export function embedFailureLabel(error: OembedFailure, strings: Strings): string {
  const labels: Partial<Record<OembedFailure["kind"], keyof Strings>> = {
    "no-discovery": "embedNoDiscovery",
    "xml-only": "embedXmlOnly",
    "invalid-response": "embedInvalidResponse",
    "invalid-version": "embedInvalidVersion",
    "unsupported-type": "embedUnsupportedType",
    "invalid-photo": "embedInvalidPhoto",
    "invalid-video": "embedInvalidVideo",
    "native-video-unavailable": "embedNativeUnavailable",
    "unsupported-content": "embedUnsupportedContent",
  };
  const key = labels[error.kind];
  return key ? strings[key] : failureLabel(error.kind as FailureKind, strings);
}

/** One independent attempt/dialog; no global URL, active editor or shared request state. */
export class CreationController {
  private closed = false;
  private working = false;
  private deadTarget = false;
  private failedUrl: string | undefined;
  private kind: CreationKind;
  private failedKind: CreationKind | undefined;
  private readonly embedOptions: EmbedOptions;
  private abort: AbortController | undefined;
  private readonly target: InsertionTarget;
  private readonly view: CreationView;
  private readonly resolve: BookmarkResolver;
  private readonly strings: Strings;
  constructor(
    target: InsertionTarget,
    view: CreationView,
    resolve: BookmarkResolver,
    strings: Strings,
    embedOptions: EmbedOptions = {},
  ) {
    this.target = target;
    this.view = view;
    this.resolve = resolve;
    this.strings = strings;
    this.embedOptions = embedOptions;
    this.kind = embedOptions.kind ?? "bookmark";
    void target.prefill.then(value => {
      if (!this.closed && !this.working && !this.deadTarget) view.prefill(value);
    }, () => {/* Prefill scarcity/read failure is not a creation failure. */});
  }

  inputChanged(): void {
    if (this.closed || this.working || this.deadTarget) return;
    this.failedUrl = undefined;
    this.failedKind = undefined;
    this.view.fallback(false);
    this.view.bookmarkFallback?.(false);
    this.view.status("");
  }

  typeChanged(kind: CreationKind): void {
    if (this.closed || this.working || this.deadTarget) return;
    this.kind = kind;
    this.view.type?.(kind);
    this.inputChanged();
  }

  async bookmark(): Promise<void> {
    if (
      this.closed || this.working || this.deadTarget || this.failedKind !== "embed"
      || !this.failedUrl || this.view.value().trim() !== this.failedUrl
    ) return;
    this.typeChanged("bookmark");
    await this.submit();
  }

  async submit(): Promise<void> {
    if (this.closed || this.working || this.deadTarget) return;
    const url = this.view.value().trim();
    this.failedUrl = undefined;
    this.failedKind = undefined;
    this.view.fallback(false);
    this.view.bookmarkFallback?.(false);
    try {
      publicHttpUrl(url);
    } catch (error) {
      try {
        this.target.pause();
      } catch (failure) {
        this.failTarget(failure);
        return;
      }
      this.view.status(
        (this.kind === "embed" ? this.strings.embedFailure + " " : "")
          + failureLabel(error instanceof ResolutionError ? error.failure.kind : "invalid-url", this.strings),
        true,
      );
      return;
    }
    try {
      this.target.resume();
    } catch (error) {
      this.failTarget(error);
      return;
    }
    this.working = true;
    this.view.busy(true);
    this.view.status(this.kind === "embed" ? this.strings.embedBusy : this.strings.bookmarkBusy);
    const abort = new AbortController();
    this.abort = abort;
    try {
      if (this.kind === "embed") {
        const resolveEmbed = this.embedOptions.resolveEmbed;
        if (!resolveEmbed) throw new CreationError("insertion-failed");
        const result = await resolveEmbed(url, abort.signal).catch(
          () => ({ ok: false, error: { kind: "network-error" } } as const),
        );
        if (this.closed || abort.signal.aborted) return;
        if (!result.ok) {
          this.resolutionFailed(url, result.error, "embed");
          return;
        }
        if (result.snapshot.card.url !== url) throw new CreationError("insertion-failed");
        if (result.snapshot.card.resource.kind === "video") {
          if (this.embedOptions.nativeYoutubeAvailable === false) {
            this.resolutionFailed(url, { kind: "native-video-unavailable" }, "embed");
            return;
          }
          this.target.insertYoutube(url, result.snapshot.card.resource.videoId);
          this.complete();
        } else {
          const localized = await localizeMedia(
            result.snapshot,
            {
              ...result.snapshot.card,
              ...(result.faviconCandidates ? { faviconCandidates: result.faviconCandidates } : {}),
            },
            this.target.assetContext ?? "",
            this.embedOptions.importAsset,
            abort.signal,
          );
          if (this.closed || abort.signal.aborted) return;
          this.finish(oembedMarkdown(localized.snapshot));
          if (localized.media.omitted) this.embedOptions.notifyMediaOmitted?.();
        }
      } else {
        const result = await this.resolve(url, abort.signal).catch(
          () => ({ ok: false, error: { kind: "network-error" } } as const),
        );
        if (this.closed || abort.signal.aborted) return;
        if (!result.ok) {
          this.resolutionFailed(url, result.error, "bookmark");
          return;
        }
        if (result.metadata.originalUrl !== url) throw new CreationError("insertion-failed");
        const snapshot = metadataSnapshot(result.metadata);
        const localized = await localizeMedia(
          snapshot,
          {
            ...snapshot.card,
            ...(result.metadata.faviconCandidates
              ? { faviconCandidates: result.metadata.faviconCandidates }
              : {}),
          },
          this.target.assetContext ?? "",
          this.embedOptions.importAsset,
          abort.signal,
        );
        if (this.closed || abort.signal.aborted) return;
        this.finish(customBlockMarkdown(localized.snapshot));
        if (localized.media.omitted) this.embedOptions.notifyMediaOmitted?.();
      }
    } catch (error) {
      if (!this.closed) this.failTarget(error);
    }
  }

  simple(): void {
    if (
      this.closed || this.working || this.deadTarget || this.failedKind !== "bookmark" || !this.failedUrl
      || this.view.value().trim() !== this.failedUrl
    ) return;
    try {
      this.target.resume();
      this.working = true;
      this.view.busy(true);
      this.finish(customBlockMarkdown(simpleSnapshot(this.failedUrl)));
    } catch (error) {
      this.failTarget(error);
    }
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.target.release();
  }

  private resolutionFailed(url: string, error: OembedFailure, kind: CreationKind): void {
    this.target.pause();
    this.working = false;
    this.view.busy(false);
    this.view.status(
      kind === "embed"
        ? `${this.strings.embedFailure} ${embedFailureLabel(error, this.strings)}`
        : `${this.strings.bookmarkMetadataFailure} ${failureLabel(error.kind as FailureKind, this.strings)}`,
      true,
    );
    if (
      error.kind !== "cancelled"
      && (kind === "embed" || !["invalid-url", "blocked-target"].includes(error.kind))
    ) {
      // Source validation already passed: even a rejected discovered endpoint permits an explicit Bookmark attempt.
      this.failedUrl = url;
      this.failedKind = kind;
      if (kind === "embed") this.view.bookmarkFallback?.(true);
      else this.view.fallback(true);
    }
  }

  private finish(markdown: string): void {
    this.target.insert(markdown);
    this.complete();
  }

  private complete(): void {
    this.closed = true;
    this.target.release();
    this.view.close();
  }

  private failTarget(error: unknown): void {
    this.deadTarget = true;
    this.working = false;
    this.target.release();
    this.view.busy(false);
    this.view.fallback(false);
    this.view.bookmarkFallback?.(false);
    this.view.terminal();
    this.view.status(
      error instanceof CreationError && error.kind === "stale-target"
        ? this.strings.bookmarkStaleTarget
        : this.strings.bookmarkInsertionFailure,
      true,
    );
  }
}
