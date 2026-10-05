import type { Dialog } from "siyuan";
import type { Strings } from "../strings.ts";
import { CreationController } from "./controller.ts";
import type { BookmarkResolver, EmbedOptions, InsertionTarget } from "./types.ts";

export type DialogFactory = (options: ConstructorParameters<typeof Dialog>[0]) => Dialog;
let inputId = 0;

/** Native SiYuan dialog, trusted controls built as DOM; prefills only ever enter input.value. */
export function openCardDialog(
  target: InsertionTarget,
  createDialog: DialogFactory,
  resolve: BookmarkResolver,
  strings: Strings,
  onClose: () => void,
  embedOptions: EmbedOptions = {},
): () => void {
  const dialog = createDialog({
    title: strings.cardDialogTitle,
    content: "<div class=\"slc-dialog\"></div>",
    width: "480px",
    destroyCallback: onClose,
  });
  const mount = dialog.element.querySelector<HTMLElement>(".slc-dialog")!;
  const document = mount.ownerDocument;
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = strings.bookmarkUrl;
  const input = document.createElement("input");
  input.className = "b3-text-field fn__block";
  input.id = `slc-url-${++inputId}`;
  label.htmlFor = input.id;
  input.type = "text";
  input.inputMode = "url";
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "none");
  input.spellcheck = false;
  input.placeholder = "https://example.com/";
  const typeLabel = document.createElement("label");
  typeLabel.textContent = strings.cardType;
  const type = document.createElement("select");
  type.id = input.id + "-type";
  type.className = "b3-select fn__block";
  typeLabel.htmlFor = type.id;
  for (const [value, text] of [["bookmark", strings.cardBookmark], ["embed", strings.cardEmbed]]) {
    const option = document.createElement("option");
    option.value = value!;
    option.textContent = text!;
    type.append(option);
  }
  type.value = embedOptions.kind ?? "bookmark";
  const privacy = document.createElement("p");
  privacy.className = "slc-dialog__privacy";
  privacy.id = input.id + "-privacy";
  privacy.textContent = strings.embedNativePrivacy;
  privacy.hidden = type.value !== "embed";
  type.setAttribute("aria-describedby", privacy.id);
  const status = document.createElement("div");
  status.className = "slc-dialog__status";
  status.id = input.id + "-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  input.setAttribute("aria-describedby", status.id);
  function button(text: string): HTMLButtonElement {
    const result = document.createElement("button");
    result.type = "button";
    result.className = "b3-button b3-button--outline";
    result.textContent = text;
    return result;
  }
  const fallback = button(strings.bookmarkSimple);
  fallback.hidden = true;
  const cancel = button(strings.bookmarkCancel);
  const insert = button(strings.bookmarkInsert);
  insert.type = "submit";
  insert.className = "b3-button";
  const actions = document.createElement("div");
  actions.className = "slc-dialog__actions";
  actions.append(cancel, insert);
  form.append(label, input, typeLabel, type, privacy, status, fallback, actions);
  mount.append(form);
  let dirty = false;
  const controller = new CreationController(
    target,
    {
      value: () => input.value,
      prefill: value => {
        if (!dirty && !input.value) input.value = value;
      },
      busy: value => {
        form.setAttribute("aria-busy", String(value));
        input.disabled = value;
        type.disabled = value;
        insert.disabled = value;
        fallback.disabled = value;
        insert.textContent = value
          ? (type.value === "embed" ? strings.embedBusy : strings.bookmarkBusy)
          : strings.bookmarkInsert;
      },
      status: (text, error = false) => {
        status.textContent = text;
        status.classList.toggle("slc-dialog__status--error", error);
        status.setAttribute("aria-live", error ? "assertive" : "polite");
      },
      fallback: show => {
        if (show) {
          fallback.textContent = strings.bookmarkSimple;
          fallback.dataset.action = "simple";
        }
        fallback.hidden = !show;
      },
      bookmarkFallback: show => {
        if (show) {
          fallback.textContent = strings.embedBookmarkFallback;
          fallback.dataset.action = "bookmark";
        }
        fallback.hidden = !show;
      },
      type: kind => {
        type.value = kind;
        privacy.hidden = kind !== "embed";
      },
      terminal: () => {
        type.disabled = true;
        insert.disabled = true;
        fallback.disabled = true;
      },
      close: () => dialog.destroy(),
    },
    resolve,
    strings,
    embedOptions,
  );
  const changed = () => {
    dirty = true;
    controller.inputChanged();
  };
  const submitted = (event: Event) => {
    event.preventDefault();
    void controller.submit();
  };
  const simple = () => {
    if (fallback.dataset.action === "bookmark") void controller.bookmark();
    else controller.simple();
  };
  const typeChanged = () => controller.typeChanged(type.value === "embed" ? "embed" : "bookmark");
  const close = () => dialog.destroy();
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  input.addEventListener("input", changed);
  type.addEventListener("change", typeChanged);
  form.addEventListener("submit", submitted);
  fallback.addEventListener("click", simple);
  cancel.addEventListener("click", close);
  dialog.element.addEventListener("keydown", escape, true);
  const destroy = dialog.destroy.bind(dialog);
  let closing = false;
  // Native destroyCallback runs after its close animation. Cancel synchronously on EVERY close path.
  // Wrap only the public destroy method of our own dialog, including scrim/native Escape closures.
  dialog.destroy = options => {
    if (closing) return;
    closing = true;
    controller.cancel();
    input.removeEventListener("input", changed);
    type.removeEventListener("change", typeChanged);
    form.removeEventListener("submit", submitted);
    fallback.removeEventListener("click", simple);
    cancel.removeEventListener("click", close);
    dialog.element.removeEventListener("keydown", escape, true);
    destroy(options);
  };
  dialog.bindInput(input, () => {
    void controller.submit();
  });
  return close;
}
