import type { ExternalNavigation } from "./navigation.ts";
import { createPassiveCard } from "./presentation.ts";
import { parseSnapshot } from "./schema.ts";
import type { Snapshot } from "./schema.ts";
import type { Strings } from "./strings.ts";

export interface RenderOptions {
  element: HTMLElement;
  content: string;
  setContent: (content: string) => boolean;
}

export interface RenderServices {
  strings: Strings;
  navigate: ExternalNavigation;
}

export function renderLinkCard(options: RenderOptions, services: RenderServices): () => void {
  const { element } = options;
  const document = element.ownerDocument;
  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(options.content);
  } catch {
    const fallback = document.createElement("p");
    fallback.className = "slc-unavailable";
    fallback.textContent = services.strings.unavailable;
    element.replaceChildren(fallback);
    return () => fallback.remove();
  }

  const card = snapshot.card;
  const view = createPassiveCard(document, {
    url: card.url,
    title: card.title,
    description: card.description,
    identity: card.siteName ?? new URL(card.url).hostname,
    favicon: card.favicon,
    image: card.image ? { url: card.image } : undefined,
  }, services);
  element.replaceChildren(view.root);
  return view.dispose;
}
