import type { DialogFactory } from "../creation/dialog.ts";
import type { Strings } from "../strings.ts";
import { MigrationController } from "./controller.ts";
import type { MigrationKernel } from "./kernel.ts";

export function openMigrationDialog(
  kernel: MigrationKernel,
  createDialog: DialogFactory,
  strings: Strings,
  onClose: () => void,
): () => void {
  const dialog = createDialog({
    title: strings.migrationCommand,
    content: "<div class=\"slc-dialog slc-migration\"></div>",
    width: "480px",
    destroyCallback: onClose,
  });
  const mount = dialog.element.querySelector<HTMLElement>(".slc-migration")!;
  const document = mount.ownerDocument;
  const status = document.createElement("div");
  status.className = "slc-dialog__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = strings.migrationScanning;
  const summary = document.createElement("dl");
  function counts(rows: [string, number][]) {
    summary.replaceChildren();
    for (const [label, value] of rows) {
      const term = document.createElement("dt"), count = document.createElement("dd");
      term.textContent = label;
      count.textContent = String(value);
      summary.append(term, count);
    }
  }
  const note = document.createElement("p");
  note.textContent = strings.migrationNotice;
  const cancel = document.createElement("button"), confirm = document.createElement("button");
  cancel.type = confirm.type = "button";
  cancel.className = "b3-button b3-button--outline";
  confirm.className = "b3-button";
  cancel.textContent = strings.bookmarkCancel;
  confirm.textContent = strings.migrationCommand;
  confirm.disabled = true;
  const actions = document.createElement("div");
  actions.className = "slc-dialog__actions";
  actions.append(cancel, confirm);
  mount.append(status, summary, note, actions);
  mount.setAttribute("aria-busy", "true");
  const controller = new MigrationController(kernel, {
    preview: preview => {
      mount.setAttribute("aria-busy", "false");
      counts([
        [strings.migrationFound, preview.candidates.length],
        [strings.migrationFully, preview.categories.fully],
        [strings.migrationLocalPlan, preview.categories.localMedia],
        [strings.migrationOmitted, preview.categories.omittedMedia],
        [strings.migrationTitleFallback, preview.categories.titleFallback],
        [strings.migrationImageDescription, preview.variants.imageDescription],
        [strings.migrationDescriptionOnly, preview.variants.descriptionOnly],
        [strings.migrationImageOnly, preview.variants.imageOnly],
        [strings.migrationTitleOnly, preview.variants.titleOnly],
        [strings.migrationRejected, preview.rejected],
        [strings.migrationUnknown, preview.unknown],
      ]);
      status.textContent = preview.candidates.length ? strings.migrationPreview : strings.migrationEmpty;
      confirm.textContent = preview.candidates.length === 1
        ? strings.migrationConfirmOne
        : strings.migrationConfirm.replace("{count}", String(preview.candidates.length));
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
        [strings.migrationFully, result.fully],
        [strings.migrationLocalResult, result.localMedia],
        [strings.migrationOmitted, result.omittedMedia],
        [strings.migrationTitleFallback, result.titleFallback],
        [strings.migrationChanged, result.changed],
        [strings.migrationSkipped, result.skipped],
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
