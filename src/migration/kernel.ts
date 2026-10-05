import { mediaAttributes } from "../assets/reference.ts";
import { localizeMedia } from "../assets/service.ts";
import type { AssetImporter, MediaResult } from "../assets/service.ts";
import { customBlockMarkdown } from "../schema.ts";
import type { Snapshot } from "../schema.ts";
import { BLOCK_INFO, serializeSnapshot } from "../schema.ts";
import { recognizeLegacy } from "./legacy.ts";
import type { Variant } from "./legacy.ts";

export interface Candidate {
  id: string;
  source: string; // Exact persisted source is the collision-free fingerprint and operation backup.
  markdown: string;
  content: string;
  variant: Variant;
  snapshot: Snapshot;
  sources: { image?: string; favicon?: string; };
  ial: string;
  titleFallback: boolean;
  omittedMedia: number;
  localMedia: number;
}
export interface Preview {
  candidates: Candidate[];
  rejected: number;
  unknown: number;
  variants: Record<Variant, number>;
  categories: { fully: number; localMedia: number; omittedMedia: number; titleFallback: number; };
}
export type Request = (
  path: string,
  body: Record<string, unknown>,
) => Promise<{ code: number; data?: unknown; }>;
export type Outcome = "migrated" | "changed" | "failed" | "cancelled";
const validId = (id: unknown): id is string => typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/.test(id);

/** Read-only discovery; only explicit migration may invoke the shared optional media importer. No metadata resolver. */
export class MigrationKernel {
  private readonly request: Request;
  private readonly document: Document;
  private readonly convert: (markdown: string) => string;
  private readonly writable: () => boolean;
  private readonly importer: AssetImporter | undefined;
  private abort?: AbortController;
  readonly mediaResults = new Map<string, MediaResult>();
  constructor(
    request: Request,
    document: Document,
    convert: (markdown: string) => string,
    writable: () => boolean = () => true,
    importer?: AssetImporter,
  ) {
    this.request = request;
    this.document = document;
    this.convert = convert;
    this.writable = writable;
    this.importer = importer;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(path, body);
    if (response.code !== 0) throw new Error("kernel");
    return response.data;
  }
  private async source(id: string): Promise<string> {
    const data = await this.call("/api/block/getBlockKramdown", { id });
    if (
      !data || typeof data !== "object" || !("id" in data) || data.id !== id
      || !("kramdown" in data) || typeof data.kramdown !== "string"
    ) throw new Error("source");
    return data.kramdown;
  }
  private async dom(id: string): Promise<{ html: string; block: HTMLElement; }> {
    const data = await this.call("/api/block/getBlockDOM", { id });
    if (
      !data || typeof data !== "object" || !("id" in data) || data.id !== id
      || !("dom" in data) || typeof data.dom !== "string"
    ) throw new Error("dom");
    return { html: data.dom, block: this.block(data.dom, id) };
  }
  private block(html: string, id: string): HTMLElement {
    const template = this.document.createElement("template");
    template.innerHTML = html; // Kernel/Lute BlockDOM is inspected inertly, never attached or persisted as HTML.
    const block = template.content.firstElementChild as HTMLElement | null;
    if (template.content.children.length !== 1 || !block || block.dataset.nodeId !== id) {
      throw new Error("identity");
    }
    return block;
  }
  async scan(active: () => boolean): Promise<Preview> {
    const preview: Preview = {
      candidates: [],
      rejected: 0,
      unknown: 0,
      categories: { fully: 0, localMedia: 0, omittedMedia: 0, titleFallback: 0 },
      variants: { imageDescription: 0, descriptionOnly: 0, imageOnly: 0, titleOnly: 0 },
    };
    let cursor = "";
    while (active()) {
      // Keyset paging avoids the SQL API's default row limit. IDs are validated before interpolation.
      const rows = await this.call("/api/query/sql", {
        stmt: `SELECT id FROM blocks WHERE type = 'c' AND id > '${cursor}' ORDER BY id LIMIT 128`,
      });
      if (!Array.isArray(rows) || rows.length > 128) throw new Error("discovery");
      for (const row of rows) {
        if (!active()) throw new Error("cancelled");
        if (!row || !validId(row.id) || row.id <= cursor) throw new Error("discovery");
        cursor = row.id;
        const source = await this.source(row.id);
        if (!active()) throw new Error("cancelled");
        if (!source.startsWith("```embed\n")) continue;
        const { block } = await this.dom(row.id);
        const result = recognizeLegacy(block.dataset.type ?? "", source);
        if (result.kind === "rejected") preview.rejected++;
        else if (result.kind === "unknown") preview.unknown++;
        else if (result.kind === "confirmed") {
          // Identity must be encoded in the persisted IAL, not manually patched into BlockDOM.
          const converted = this.block(this.convert(result.markdown), row.id);
          if (
            converted.dataset.type !== "NodeCustomBlock" || converted.dataset.info !== BLOCK_INFO
            || converted.dataset.content !== serializeSnapshot(result.snapshot)
          ) throw new Error("conversion");
          preview.variants[result.variant]++;
          if (!result.localMedia && !result.omittedMedia && !result.titleFallback) preview.categories.fully++;
          if (result.localMedia) preview.categories.localMedia++;
          if (result.omittedMedia) preview.categories.omittedMedia++;
          if (result.titleFallback) preview.categories.titleFallback++;
          preview.candidates.push({
            id: row.id,
            source,
            markdown: result.markdown,
            content: serializeSnapshot(result.snapshot),
            variant: result.variant,
            snapshot: result.snapshot,
            sources: result.sources,
            ial: result.ial,
            titleFallback: result.titleFallback,
            omittedMedia: result.omittedMedia,
            localMedia: result.localMedia,
          });
        }
      }
      if (rows.length < 128) return preview;
    }
    throw new Error("cancelled");
  }
  cancel(): void {
    this.abort?.abort();
  }
  async migrate(candidate: Candidate, active: () => boolean): Promise<Outcome> {
    try {
      if (!active() || !this.writable()) return "cancelled";
      const original = await this.dom(candidate.id);
      if (!active() || !this.writable()) return "cancelled";
      if (original.block.dataset.type !== "NodeCodeBlock") return "changed";
      // Check the exact source before any explicit asset download/upload, then again before the write.
      if (await this.source(candidate.id) !== candidate.source) return "changed";
      if (!active() || !this.writable()) return "cancelled";
      const abort = new AbortController();
      this.abort = abort;
      const localized = await localizeMedia(
        candidate.snapshot,
        candidate.sources,
        candidate.id,
        this.importer,
        abort.signal,
      );
      if (!active() || !this.writable() || abort.signal.aborted) return "cancelled";
      const markdown = customBlockMarkdown(localized.snapshot, candidate.ial);
      const content = serializeSnapshot(localized.snapshot);
      const attrs = mediaAttributes(localized.snapshot.card);
      const html = this.convert(markdown);
      const converted = this.block(html, candidate.id);
      if (
        converted.dataset.type !== "NodeCustomBlock" || converted.dataset.info !== BLOCK_INFO
        || converted.dataset.content !== content
        || Object.entries(attrs).some(([key, value]) => converted.getAttribute(key) !== value)
      ) return "failed";
      // No awaited work between the last full-source comparison and submitting this single update.
      const current = await this.source(candidate.id);
      if (!active() || !this.writable()) return "cancelled";
      if (current !== candidate.source) return "changed";
      await this.call("/api/transactions", {
        reqId: Date.now(),
        transactions: [{
          doOperations: [{ action: "update", id: candidate.id, data: html }],
          undoOperations: [{ action: "update", id: candidate.id, data: original.html }],
        }],
      });
      // A submitted transaction may finish after cancellation. Verify it, but start no next write.
      const persisted = await this.dom(candidate.id);
      if (
        persisted.block.dataset.type !== "NodeCustomBlock" || persisted.block.dataset.info !== BLOCK_INFO
        || persisted.block.dataset.content !== content
        || Object.entries(attrs).some(([key, value]) => persisted.block.getAttribute(key) !== value)
      ) return "failed";
      this.mediaResults.set(candidate.id, {
        imported: localized.media.imported,
        omitted: localized.media.omitted + candidate.omittedMedia,
      });
      return "migrated";
    } catch {
      return "failed";
    }
  }
}
