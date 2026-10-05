import type { DialogFactory } from "../creation/dialog.ts";
import type { Strings } from "../strings.ts";
import type { FaviconPreview, FaviconRepairKernel } from "./favicon-kernel.ts";

export interface FaviconRepairResult {
  repaired: number;
  unchanged: number;
  usable: number;
  unrepairable: number;
  invalid: number;
  active: number;
  changed: number;
  failed: number;
}
export interface FaviconRepairView {
  preview(value: FaviconPreview): void;
  progress(done: number, total: number): void;
  result(value: FaviconRepairResult): void;
  error(): void;
}
export class FaviconRepairController {
  private state: "new" | "scanning" | "ready" | "writing" | "done" | "closed" = "new";
  private preview?: FaviconPreview;
  private readonly kernel: Pick<FaviconRepairKernel, "scan" | "repair" | "cancel">;
  private readonly view: FaviconRepairView;
  constructor(
    kernel: Pick<FaviconRepairKernel, "scan" | "repair" | "cancel">,
    view: FaviconRepairView,
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
    const result: FaviconRepairResult = {
      repaired: 0,
      unchanged: 0,
      usable: this.preview.usable,
      unrepairable: this.preview.unrepairable,
      invalid: this.preview.invalid,
      active: this.preview.active,
      changed: this.preview.changed,
      failed: 0,
    };
    let done = 0;
    this.view.progress(done, this.preview.candidates.length);
    for (const candidate of this.preview.candidates) {
      if (this.state !== "writing") return;
      const outcome = await this.kernel.repair(candidate, () => this.state === "writing");
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
    this.kernel.cancel();
  }
}

export function openFaviconRepairDialog(
  kernel: FaviconRepairKernel,
  createDialog: DialogFactory,
  strings: Strings,
  onClose: () => void,
): () => void {
  const dialog = createDialog({
    title: strings.faviconRepairCommand,
    content: "<div class=\"slc-dialog slc-migration slc-favicon-repair\"></div>",
    width: "480px",
    destroyCallback: onClose,
  });
  const mount = dialog.element.querySelector<HTMLElement>(".slc-favicon-repair")!;
  const document = mount.ownerDocument;
  const status = document.createElement("div"), summary = document.createElement("dl");
  status.className = "slc-dialog__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = strings.faviconRepairScanning;
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
  note.textContent = strings.faviconRepairNotice;
  const cancel = document.createElement("button"), confirm = document.createElement("button");
  cancel.type = confirm.type = "button";
  cancel.className = "b3-button b3-button--outline";
  confirm.className = "b3-button";
  confirm.disabled = true;
  cancel.textContent = strings.bookmarkCancel;
  confirm.textContent = strings.faviconRepairCommand;
  const actions = document.createElement("div");
  actions.className = "slc-dialog__actions";
  actions.append(cancel, confirm);
  mount.append(status, summary, note, actions);
  mount.setAttribute("aria-busy", "true");
  const controller = new FaviconRepairController(kernel, {
    preview: preview => {
      mount.setAttribute("aria-busy", "false");
      counts([
        [strings.faviconRepairFound, preview.candidates.length],
        [strings.faviconRepairUsable, preview.usable],
        [strings.faviconRepairUnrepairable, preview.unrepairable],
        [strings.faviconRepairInvalid, preview.invalid],
        [strings.faviconRepairActive, preview.active],
        [strings.migrationChanged, preview.changed],
      ]);
      status.textContent = preview.candidates.length
        ? strings.faviconRepairPreview
        : strings.faviconRepairEmpty;
      confirm.textContent = preview.candidates.length === 1
        ? strings.faviconRepairConfirmOne
        : strings.faviconRepairConfirm.replace("{count}", String(preview.candidates.length));
      confirm.disabled = !preview.candidates.length;
    },
    progress: (done, total) => {
      mount.setAttribute("aria-busy", "true");
      confirm.disabled = true;
      status.textContent = strings.faviconRepairProgress.replace("{done}", String(done)).replace(
        "{total}",
        String(total),
      );
    },
    result: result => {
      mount.setAttribute("aria-busy", "false");
      status.textContent = strings.faviconRepairResult;
      counts([
        [strings.faviconRepairRepaired, result.repaired],
        [strings.faviconRepairUnchanged, result.unchanged],
        [strings.faviconRepairUsable, result.usable],
        [strings.faviconRepairUnrepairable, result.unrepairable],
        [strings.faviconRepairInvalid, result.invalid],
        [strings.faviconRepairActive, result.active],
        [strings.migrationChanged, result.changed],
        [strings.migrationFailed, result.failed],
      ]);
      cancel.textContent = strings.migrationClose;
    },
    error: () => {
      mount.setAttribute("aria-busy", "false");
      confirm.disabled = true;
      status.textContent = strings.faviconRepairError;
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
