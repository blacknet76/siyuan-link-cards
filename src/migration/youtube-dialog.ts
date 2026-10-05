import type { DialogFactory } from "../creation/dialog.ts";
import type { Strings } from "../strings.ts";
import type { YoutubeMigrationKernel, YoutubePreview } from "./youtube-kernel.ts";

export interface YoutubeMigrationResult {
  migrated: number;
  changed: number;
  failed: number;
  unsupported: number;
}
export interface YoutubeMigrationView {
  preview(value: YoutubePreview): void;
  progress(done: number, total: number): void;
  result(value: YoutubeMigrationResult): void;
  error(): void;
}
export class YoutubeMigrationController {
  private state: "new" | "scanning" | "ready" | "writing" | "done" | "closed" = "new";
  private preview?: YoutubePreview;
  private readonly kernel: Pick<YoutubeMigrationKernel, "scan" | "migrate">;
  private readonly view: YoutubeMigrationView;
  constructor(
    kernel: Pick<YoutubeMigrationKernel, "scan" | "migrate">,
    view: YoutubeMigrationView,
  ) {
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
      if (this.state !== "scanning") return;
      this.state = "done";
      this.view.error();
    }
  }
  async confirm(): Promise<void> {
    if (this.state !== "ready" || !this.preview?.candidates.length) return;
    this.state = "writing";
    const result: YoutubeMigrationResult = {
      migrated: 0,
      changed: this.preview.changed,
      failed: 0,
      unsupported: this.preview.unsupported,
    };
    let done = 0;
    this.view.progress(done, this.preview.candidates.length);
    for (const candidate of this.preview.candidates) {
      if (this.state !== "writing") return;
      const outcome = await this.kernel.migrate(candidate, () => this.state === "writing");
      if (this.state !== "writing") return;
      if (outcome === "cancelled") {
        this.state = "done";
        this.view.error();
        return;
      }
      result[outcome]++;
      this.view.progress(++done, this.preview.candidates.length);
    }
    this.state = "done";
    this.view.result(result);
  }
  cancel(): void {
    this.state = "closed";
  }
}

export function openYoutubeMigrationDialog(
  kernel: YoutubeMigrationKernel,
  createDialog: DialogFactory,
  strings: Strings,
  onClose: () => void,
): () => void {
  const dialog = createDialog({
    title: strings.youtubeMigrationCommand,
    content: "<div class=\"slc-dialog slc-migration slc-youtube-migration\"></div>",
    width: "480px",
    destroyCallback: onClose,
  });
  const mount = dialog.element.querySelector<HTMLElement>(".slc-youtube-migration")!;
  const document = mount.ownerDocument;
  const status = document.createElement("div"), summary = document.createElement("dl");
  status.className = "slc-dialog__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = strings.youtubeMigrationScanning;
  const counts = (rows: [string, number][]) => {
    summary.replaceChildren();
    for (const [label, value] of rows) {
      const term = document.createElement("dt"), count = document.createElement("dd");
      term.textContent = label;
      count.textContent = String(value);
      summary.append(term, count);
    }
  };
  const note = document.createElement("p");
  note.textContent = strings.youtubeMigrationNotice;
  const cancel = document.createElement("button"), confirm = document.createElement("button");
  cancel.type = confirm.type = "button";
  cancel.className = "b3-button b3-button--outline";
  confirm.className = "b3-button";
  confirm.disabled = true;
  cancel.textContent = strings.bookmarkCancel;
  confirm.textContent = strings.youtubeMigrationCommand;
  const actions = document.createElement("div");
  actions.className = "slc-dialog__actions";
  actions.append(cancel, confirm);
  mount.append(status, summary, note, actions);
  mount.setAttribute("aria-busy", "true");
  const controller = new YoutubeMigrationController(kernel, {
    preview: preview => {
      mount.setAttribute("aria-busy", "false");
      counts([
        [strings.youtubeMigrationFound, preview.candidates.length],
        [strings.youtubeMigrationUnsupported, preview.unsupported],
        [strings.migrationChanged, preview.changed],
      ]);
      status.textContent = preview.candidates.length
        ? strings.youtubeMigrationPreview
        : strings.youtubeMigrationEmpty;
      confirm.textContent = preview.candidates.length === 1
        ? strings.youtubeMigrationConfirmOne
        : strings.youtubeMigrationConfirm.replace("{count}", String(preview.candidates.length));
      confirm.disabled = !preview.candidates.length;
    },
    progress: (done, total) => {
      mount.setAttribute("aria-busy", "true");
      confirm.disabled = true;
      status.textContent = strings.migrationProgress.replace("{done}", String(done)).replace(
        "{total}",
        String(total),
      );
    },
    result: result => {
      mount.setAttribute("aria-busy", "false");
      status.textContent = strings.migrationResult;
      counts([
        [strings.migrationMigrated, result.migrated],
        [strings.migrationChanged, result.changed],
        [strings.youtubeMigrationUnsupported, result.unsupported],
        [strings.migrationFailed, result.failed],
      ]);
      cancel.textContent = strings.migrationClose;
    },
    error: () => {
      mount.setAttribute("aria-busy", "false");
      confirm.disabled = true;
      status.textContent = strings.migrationError;
      status.classList.add("slc-dialog__status--error");
    },
  });
  const close = () => dialog.destroy();
  const confirmed = () => {
    void controller.confirm();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", confirmed);
  dialog.element.addEventListener("keydown", escape, true);
  const destroy = dialog.destroy.bind(dialog);
  let closing = false;
  dialog.destroy = options => {
    if (closing) return;
    closing = true;
    controller.cancel();
    cancel.removeEventListener("click", close);
    confirm.removeEventListener("click", confirmed);
    dialog.element.removeEventListener("keydown", escape, true);
    destroy(options);
  };
  void controller.scan();
  cancel.focus();
  return close;
}
