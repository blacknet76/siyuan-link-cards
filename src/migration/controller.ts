import type { MigrationKernel, Outcome, Preview } from "./kernel.ts";

export interface MigrationResult {
  migrated: number;
  changed: number;
  failed: number;
  skipped: number;
  fully: number;
  localMedia: number;
  omittedMedia: number;
  titleFallback: number;
}
export interface MigrationView {
  preview(value: Preview): void;
  progress(done: number, total: number): void;
  result(value: MigrationResult): void;
  error(): void;
}

export class MigrationController {
  private state: "new" | "scanning" | "ready" | "writing" | "done" | "closed" = "new";
  private preview?: Preview;
  private readonly kernel: MigrationKernel;
  private readonly view: MigrationView;
  readonly outcomes: { id: string; outcome: Outcome; }[] = [];
  constructor(kernel: MigrationKernel, view: MigrationView) {
    this.kernel = kernel;
    this.view = view;
  }
  async scan(): Promise<void> {
    if (this.state !== "new") return;
    this.state = "scanning";
    try {
      const preview = await this.kernel.scan(() => this.state === "scanning");
      if (this.state !== "scanning") return;
      this.preview = preview;
      this.state = "ready";
      this.view.preview(preview);
    } catch {
      if (this.state === "scanning") {
        this.state = "done";
        this.view.error();
      }
    }
  }
  async confirm(): Promise<void> {
    if (this.state !== "ready" || !this.preview?.candidates.length) return;
    this.state = "writing";
    const result: MigrationResult = {
      migrated: 0,
      fully: 0,
      localMedia: 0,
      omittedMedia: 0,
      titleFallback: 0,
      changed: 0,
      failed: 0,
      skipped: this.preview.rejected + this.preview.unknown,
    };
    this.view.progress(0, this.preview.candidates.length);
    for (const candidate of this.preview.candidates) {
      if (this.state !== "writing") return;
      const outcome = await this.kernel.migrate(candidate, () => this.state === "writing");
      this.outcomes.push({ id: candidate.id, outcome });
      if (this.state !== "writing") return;
      if (outcome === "cancelled") {
        this.state = "done";
        this.view.error();
        return;
      }
      result[outcome]++;
      if (outcome === "migrated") {
        const media = this.kernel.mediaResults.get(candidate.id);
        if (media?.imported) result.localMedia++;
        if (media?.omitted) result.omittedMedia++;
        if (candidate.titleFallback) result.titleFallback++;
        if (!media?.imported && !media?.omitted && !candidate.titleFallback) result.fully++;
      }
      this.view.progress(result.migrated + result.changed + result.failed, this.preview.candidates.length);
    }
    this.state = "done";
    this.view.result(result);
  }
  cancel(): void {
    this.state = "closed";
    this.kernel.cancel();
    // Completed/pending operation retains its exact sources until its async work finishes.
  }
}
