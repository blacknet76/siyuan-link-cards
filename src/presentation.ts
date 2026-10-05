import { isAssetReference } from "./assets/reference.ts";
import type { RenderServices } from "./renderer.ts";

/** Derived renderer state only. Callers supply schema-validated fields and trusted action controls. */
export interface PassiveCard {
  url: string;
  title: string;
  description?: string | undefined;
  identity: string;
  favicon?: string | undefined;
  image?: { url: string; width?: number; height?: number; } | undefined;
  actions?: HTMLElement | undefined;
}

/** One passive shell for bookmarks, links, photos and unloaded videos; never writes or resolves. */
export function createPassiveCard(document: Document, model: PassiveCard, services: RenderServices) {
  const disposers: (() => void)[] = [];
  let disposed = false;
  const root = document.createElement("div");
  root.className = "slc-root";
  const link = document.createElement("a");
  link.setAttribute("href", model.url);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.setAttribute(
    "aria-label",
    services.strings.destination.replace("{title}", () => model.title).replace("{url}", () => model.url),
  );
  // Buttons cannot be nested in a navigation anchor. Action cards retain a separate source link.
  const card = model.actions ? document.createElement("div") : link;
  card.className = "slc-card";
  const body = document.createElement("div");
  body.className = "slc-card__body";
  const title = document.createElement("span");
  title.className = "slc-card__title";
  title.textContent = model.title;
  if (model.actions) {
    link.className = "slc-card__source";
    link.append(title);
    body.append(link);
  } else body.append(title);
  if (model.description) {
    const description = document.createElement("span");
    description.className = "slc-card__description";
    description.textContent = model.description;
    body.append(description);
  }
  const identity = document.createElement("span");
  identity.className = "slc-card__identity";
  const site = document.createElement("span");
  site.className = "slc-card__site";
  site.textContent = model.identity;
  function image(url: string, className: string, failed: () => void) {
    const node = document.createElement("img");
    node.className = className;
    node.alt = "";
    node.setAttribute("aria-hidden", "true");
    node.referrerPolicy = "no-referrer";
    node.loading = "lazy";
    node.decoding = "async";
    node.addEventListener("error", failed, { once: true });
    disposers.push(() => node.removeEventListener("error", failed));
    node.src = isAssetReference(url) ? "/" + url : url;
    return node;
  }
  function globe() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "slc-card__favicon slc-card__globe");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "#iconGlobe");
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#iconGlobe");
    svg.append(use);
    return svg;
  }
  if (model.favicon) {
    const icon = image(model.favicon, "slc-card__favicon", () => icon.replaceWith(globe()));
    identity.append(icon);
  } else identity.append(globe());
  identity.append(site);
  body.append(identity);
  if (model.actions) body.append(model.actions);
  card.append(body);
  if (model.image) {
    const region = document.createElement("span");
    region.className = "slc-card__image";
    const preview = image(model.image.url, "slc-card__preview", () => region.remove());
    // Validated photo/thumbnail dimensions are facts, never display width caps or inline CSS.
    if (model.image.width) preview.width = model.image.width;
    if (model.image.height) preview.height = model.image.height;
    region.append(preview);
    card.append(region);
  }
  const activate = (event: MouseEvent) => services.navigate(model.url, event);
  link.addEventListener("click", activate);
  disposers.push(() => link.removeEventListener("click", activate));
  root.append(card);
  return {
    root,
    card,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) dispose();
      root.remove();
    },
  };
}
