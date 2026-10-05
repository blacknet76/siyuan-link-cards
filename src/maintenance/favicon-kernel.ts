import type { AssetImporter } from "../assets/service.ts";
import { localizeMedia } from "../assets/service.ts";
import type { ResolutionResult } from "../metadata/types.ts";
import type { Request } from "../migration/kernel.ts";
import { migrationId } from "../migration/youtube-legacy.ts";
import { recognizeFavicon, repairedMarkdown } from "./favicon.ts";
import type { FaviconSource } from "./favicon.ts";

interface Location {
  id: string;
  root_id: string;
  parent_id: string;
  box: string;
  path: string;
  sort: number;
}
export interface FaviconCandidate extends Location {
  source: string;
}
export interface FaviconPreview {
  candidates: FaviconCandidate[];
  usable: number;
  unrepairable: number;
  invalid: number;
  changed: number;
  active: number;
}
export type FaviconOutcome = "repaired" | "unchanged" | "changed" | "failed" | "cancelled";
export type FaviconResolver = (url: string, signal: AbortSignal) => Promise<ResolutionResult>;

export class FaviconRepairKernel {
  private readonly request: Request;
  private readonly document: Document;
  private readonly convert: (markdown: string) => string;
  private readonly resolve: FaviconResolver;
  private readonly importer: AssetImporter;
  private readonly writable: () => boolean;
  private readonly isActive: (id: string) => boolean;
  private readonly abort = new AbortController();
  constructor(
    request: Request,
    document: Document,
    convert: (markdown: string) => string,
    resolve: FaviconResolver,
    importer: AssetImporter,
    writable: () => boolean = () => true,
    isActive: (id: string) => boolean = () => false,
  ) {
    this.request = request;
    this.document = document;
    this.convert = convert;
    this.resolve = resolve;
    this.importer = importer;
    this.writable = writable;
    this.isActive = isActive;
  }
  cancel(): void {
    this.abort.abort();
  }
  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(path, body);
    if (response.code !== 0) throw new Error("kernel");
    return response.data;
  }
  private location(value: unknown): Location {
    const row = value as Partial<Location> | null;
    if (
      !row || !migrationId(row.id) || !migrationId(row.root_id) || !migrationId(row.parent_id)
      || !migrationId(row.box) || typeof row.path !== "string" || !row.path.endsWith(".sy")
      || typeof row.sort !== "number" || !Number.isFinite(row.sort)
    ) throw new Error("identity");
    return row as Location;
  }
  private block(html: string, id: string): HTMLElement {
    const t = this.document.createElement("template");
    t.innerHTML = html;
    const block = t.content.firstElementChild as HTMLElement | null;
    if (
      !block || t.content.children.length !== 1 || block.dataset.nodeId !== id
      || t.content.querySelectorAll("[data-node-id]").length !== 1
    ) throw new Error("identity");
    return block;
  }
  private async source(id: string): Promise<string> {
    const data = await this.call("/api/block/getBlockKramdown", { id }) as {
      id?: unknown;
      kramdown?: unknown;
    };
    if (!data || data.id !== id || typeof data.kramdown !== "string") throw new Error("source");
    return data.kramdown;
  }
  private async dom(id: string): Promise<{ html: string; block: HTMLElement; }> {
    const data = await this.call("/api/block/getBlockDOM", { id }) as { id?: unknown; dom?: unknown; };
    if (!data || data.id !== id || typeof data.dom !== "string") throw new Error("dom");
    return { html: data.dom, block: this.block(data.dom, id) };
  }
  private matches(block: HTMLElement, value: FaviconSource): boolean {
    return block.dataset.type === "NodeCustomBlock" && block.dataset.info === value.info
      && block.dataset.content === value.content
      && Object.entries(value.attributes).every(([key, entry]) =>
        key === "id" || block.getAttribute(key) === entry
      );
  }
  async scan(active: () => boolean): Promise<FaviconPreview> {
    const preview: FaviconPreview = {
      candidates: [],
      usable: 0,
      unrepairable: 0,
      invalid: 0,
      changed: 0,
      active: 0,
    };
    let cursor = "";
    while (active() && !this.abort.signal.aborted) {
      const rows = await this.call("/api/query/sql", {
        stmt:
          `SELECT id,root_id,parent_id,box,path,sort FROM blocks WHERE type = 'custom' AND id > '${cursor}' ORDER BY id LIMIT 128`,
      });
      if (!Array.isArray(rows) || rows.length > 128) throw new Error("scan");
      for (const item of rows) {
        if (!active() || this.abort.signal.aborted) throw new Error("cancelled");
        const row = this.location(item);
        if (row.id <= cursor) throw new Error("scan");
        cursor = row.id;
        try {
          const source = await this.source(row.id), { block } = await this.dom(row.id);
          if (await this.source(row.id) !== source) {
            preview.changed++;
            continue;
          }
          const result = recognizeFavicon(block.dataset.type ?? "", row.id, source, this.document);
          if (result.kind === "ignored") continue;
          if (this.isActive(row.id)) {
            preview.active++;
            continue;
          }
          if (result.kind === "invalid" || !this.matches(block, result.value)) {
            preview.invalid++;
            continue;
          }
          if (result.kind === "eligible") preview.candidates.push({ ...row, source });
          else preview[result.kind]++;
        } catch {
          preview.changed++;
        }
      }
      if (rows.length < 128) return preview;
    }
    throw new Error("cancelled");
  }
  private running(active: () => boolean): boolean {
    return active() && !this.abort.signal.aborted && this.writable();
  }
  /** Repeated before network and immediately before write; last awaited read is exact source/IAL. */
  private async current(
    candidate: FaviconCandidate,
  ): Promise<{ html: string; value: FaviconSource; } | undefined> {
    if (!migrationId(candidate.id) || this.isActive(candidate.id)) return undefined;
    const original = await this.dom(candidate.id);
    const rows = await this.call("/api/query/sql", {
      stmt:
        `SELECT id,root_id,parent_id,box,path,sort FROM blocks WHERE id = '${candidate.id}' AND type = 'custom'`,
    });
    if (!Array.isArray(rows) || rows.length !== 1) return undefined;
    const location = this.location(rows[0]);
    if (
      ["id", "root_id", "parent_id", "box", "path", "sort"].some(key =>
        location[key as keyof Location] !== candidate[key as keyof Location]
      )
    ) return undefined;
    const source = await this.source(candidate.id);
    if (source !== candidate.source || this.isActive(candidate.id)) return undefined;
    const result = recognizeFavicon(original.block.dataset.type ?? "", candidate.id, source, this.document);
    if (result.kind !== "eligible" || !this.matches(original.block, result.value)) return undefined;
    return { html: original.html, value: result.value };
  }
  async repair(candidate: FaviconCandidate, active: () => boolean): Promise<FaviconOutcome> {
    try {
      if (!this.running(active)) return "cancelled";
      const initial = await this.current(candidate);
      if (!this.running(active)) return "cancelled";
      if (!initial) return "changed";
      const discovery = await this.resolve(initial.value.url, this.abort.signal);
      if (!this.running(active)) return "cancelled";
      if (!discovery.ok) return "unchanged";
      // A fresh temporary media holder prevents any image/title/other original field from entering localization.
      const media = await localizeMedia(
        { card: {} as { favicon?: string; } },
        {
          ...(discovery.metadata.favicon ? { favicon: discovery.metadata.favicon } : {}),
          ...(discovery.metadata.faviconCandidates
            ? { faviconCandidates: discovery.metadata.faviconCandidates }
            : {}),
        },
        candidate.id,
        this.importer,
        this.abort.signal,
      );
      if (!this.running(active)) return "cancelled";
      const favicon = media.snapshot.card.favicon;
      if (!favicon) return "unchanged";
      const original = await this.current(candidate);
      if (!this.running(active)) return "cancelled";
      if (!original) return "changed";
      const markdown = repairedMarkdown(original.value, favicon);
      const html = this.convert(markdown), block = this.block(html, candidate.id);
      const expected = recognizeFavicon("NodeCustomBlock", candidate.id, markdown, this.document);
      if (expected.kind !== "usable" || !this.matches(block, expected.value)) throw new Error("conversion");
      if (!this.running(active)) return "cancelled";
      if (this.isActive(candidate.id)) return "changed";
      await this.call("/api/transactions", {
        reqId: Date.now(),
        transactions: [{
          doOperations: [{ action: "update", id: candidate.id, data: html }],
          undoOperations: [{ action: "update", id: candidate.id, data: original.html }],
        }],
      });
      const persisted = await this.dom(candidate.id);
      if (!this.matches(persisted.block, expected.value)) return "failed";
      return "repaired";
    } catch {
      return this.running(active) ? "failed" : "cancelled";
    }
  }
}
