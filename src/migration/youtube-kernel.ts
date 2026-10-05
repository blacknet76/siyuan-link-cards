import { NATIVE_YOUTUBE_STYLE } from "../creation/youtube.ts";
import type { Outcome, Request } from "./kernel.ts";
import { HISTORICAL_YOUTUBE_MARKER, migrationId, recognizeHistoricalYoutube } from "./youtube-legacy.ts";
import type { YoutubeRecognition } from "./youtube-legacy.ts";

type Confirmed = Extract<YoutubeRecognition, { kind: "confirmed"; }>;
interface Location {
  id: string;
  root_id: string;
  parent_id: string;
  box: string;
  path: string;
  sort: number;
}
export interface YoutubeCandidate extends Location {
  source: string;
  videoId: string;
}
export interface YoutubePreview {
  candidates: YoutubeCandidate[];
  unsupported: number;
  changed: number;
}

/** Read-only HTML discovery; the only write endpoint is the explicitly confirmed update transaction. */
export class YoutubeMigrationKernel {
  private readonly request: Request;
  private readonly document: Document;
  private readonly convert: (markdown: string) => string;
  private readonly writable: () => boolean;
  constructor(
    request: Request,
    document: Document,
    convert: (markdown: string) => string,
    writable: () => boolean = () => true,
  ) {
    this.request = request;
    this.document = document;
    this.convert = convert;
    this.writable = writable;
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
    const template = this.document.createElement("template");
    template.innerHTML = html;
    const block = template.content.firstElementChild as HTMLElement | null;
    if (
      !block || template.content.children.length !== 1 || block.dataset.nodeId !== id
      || template.content.querySelectorAll("[data-node-id]").length !== 1
    ) throw new Error("identity");
    return block;
  }
  private async source(id: string): Promise<string> {
    const data = await this.call("/api/block/getBlockKramdown", { id }) as
      | { id?: unknown; kramdown?: unknown; }
      | undefined;
    if (!data || data.id !== id || typeof data.kramdown !== "string") throw new Error("source");
    return data.kramdown;
  }
  private async dom(id: string): Promise<{ html: string; block: HTMLElement; }> {
    const data = await this.call("/api/block/getBlockDOM", { id }) as
      | { id?: unknown; dom?: unknown; }
      | undefined;
    if (!data || data.id !== id || typeof data.dom !== "string") throw new Error("dom");
    return { html: data.dom, block: this.block(data.dom, id) };
  }
  private converted(value: Confirmed, id: string): string {
    const html = this.convert(value.markdown), block = this.block(html, id);
    // Derive iframe attributes from the shared production builder, not a second security policy.
    const canonical = this.document.createElement("template");
    canonical.innerHTML = value.markdown.slice(0, value.markdown.indexOf("\n{:"));
    const expected = canonical.content.querySelector("iframe")!;
    const frame = block.querySelector("iframe");
    const names = expected.getAttributeNames().filter(name => name !== "style");
    const geometry = this.document.createElement("div");
    geometry.setAttribute("style", NATIVE_YOUTUBE_STYLE);
    if (
      block.dataset.type !== "NodeIFrame" || !frame || block.querySelectorAll("iframe").length !== 1
      || block.querySelector("script,style,object,embed,[srcdoc]")
      || frame.getAttributeNames().length !== names.length
      || names.some(name => frame.getAttribute(name) !== expected.getAttribute(name))
      || block.style.cssText !== geometry.style.cssText
      || Object.entries(value.attributes).some(([key, entry]) =>
        key !== "id" && block.getAttribute(key) !== entry
      )
    ) throw new Error("conversion");
    return html;
  }
  private originalMatches(block: HTMLElement, value: Confirmed): boolean {
    return block.getAttribute(HISTORICAL_YOUTUBE_MARKER) === value.sourceUrl
      && block.querySelectorAll("protyle-html").length === 1
      && block.querySelector("protyle-html")?.getAttribute("data-content")?.trim() === value.html
      && Object.entries(value.attributes).every(([key, entry]) =>
        key === "id" || block.getAttribute(key) === entry
      );
  }
  async scan(active: () => boolean): Promise<YoutubePreview> {
    const preview: YoutubePreview = { candidates: [], unsupported: 0, changed: 0 };
    let cursor = "";
    while (active()) {
      const rows = await this.call("/api/query/sql", {
        stmt:
          `SELECT id,root_id,parent_id,box,path,sort FROM blocks WHERE type = 'html' AND id > '${cursor}' ORDER BY id LIMIT 128`,
      });
      if (!Array.isArray(rows) || rows.length > 128) throw new Error("scan");
      for (const item of rows) {
        if (!active()) throw new Error("cancelled");
        const row = this.location(item);
        if (row.id <= cursor) throw new Error("scan");
        cursor = row.id;
        const source = await this.source(row.id), { block } = await this.dom(row.id);
        if (!active()) throw new Error("cancelled");
        if (block.dataset.type !== "NodeHTMLBlock" || await this.source(row.id) !== source) {
          preview.changed++;
          continue;
        }
        // No historical origin marker: unrelated HTML is outside this command, including malformed HTML.
        if (!block.hasAttribute(HISTORICAL_YOUTUBE_MARKER)) continue;
        const result = recognizeHistoricalYoutube(block.dataset.type, row.id, source, this.document);
        if (
          result.kind === "unsupported"
          || (result.kind === "confirmed" && !this.originalMatches(block, result))
        ) {
          preview.unsupported++;
        } else if (result.kind === "confirmed") {
          this.converted(result, row.id);
          preview.candidates.push({ ...row, source, videoId: result.videoId });
        }
      }
      if (rows.length < 128) return preview;
    }
    throw new Error("cancelled");
  }
  async migrate(candidate: YoutubeCandidate, active: () => boolean): Promise<Outcome> {
    try {
      if (!migrationId(candidate.id)) return "changed";
      if (!active() || !this.writable()) return "cancelled";
      const original = await this.dom(candidate.id);
      const rows = await this.call("/api/query/sql", {
        stmt:
          `SELECT id,root_id,parent_id,box,path,sort FROM blocks WHERE id = '${candidate.id}' AND type = 'html'`,
      });
      if (!Array.isArray(rows) || rows.length !== 1) return "changed";
      const location = this.location(rows[0]);
      if (
        ["id", "root_id", "parent_id", "box", "path", "sort"].some(key =>
          location[key as keyof Location] !== candidate[key as keyof Location]
        )
      ) return "changed";
      // This is the final awaited read before submission; check full source, IAL, signature and ID again.
      const source = await this.source(candidate.id);
      if (!active() || !this.writable()) return "cancelled";
      if (source !== candidate.source || original.block.dataset.type !== "NodeHTMLBlock") return "changed";
      const result = recognizeHistoricalYoutube(
        original.block.dataset.type,
        candidate.id,
        source,
        this.document,
      );
      if (
        result.kind !== "confirmed" || result.videoId !== candidate.videoId
        || !this.originalMatches(original.block, result)
      ) return "changed";
      const html = this.converted(result, candidate.id);
      await this.call("/api/transactions", {
        reqId: Date.now(),
        transactions: [{
          doOperations: [{ action: "update", id: candidate.id, data: html }],
          undoOperations: [{ action: "update", id: candidate.id, data: original.html }],
        }],
      });
      const persisted = await this.dom(candidate.id);
      // Verify normalized persisted output against the same builder/IAL contract; never allocate an ID.
      const expected = this.block(html, candidate.id);
      if (
        persisted.block.dataset.type !== "NodeIFrame"
        || persisted.block.querySelector("iframe")?.outerHTML !== expected.querySelector("iframe")?.outerHTML
        || Object.entries(result.attributes).some(([key, value]) =>
          key !== "id" && persisted.block.getAttribute(key) !== value
        ) || persisted.block.style.cssText !== expected.style.cssText
      ) return "failed";
      return "migrated";
    } catch {
      return "failed";
    }
  }
}
