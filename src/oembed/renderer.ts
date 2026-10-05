import { createPassiveCard } from "../presentation.ts";
import type { RenderOptions, RenderServices } from "../renderer.ts";
import { parseOembedSnapshot } from "./schema.ts";
import {
  YOUTUBE_ALLOW,
  YOUTUBE_REFERRER_POLICY,
  YOUTUBE_SANDBOX,
  youtubeEmbedUrl,
  youtubePlaybackAllowed,
} from "./youtube.ts";

let videoHintId = 0;

export function renderOembed(
  options: RenderOptions,
  services: RenderServices & { frontend?: string; },
): () => void {
  const document = options.element.ownerDocument;
  let snapshot;
  try {
    snapshot = parseOembedSnapshot(options.content);
  } catch {
    const fallback = document.createElement("p");
    fallback.className = "slc-unavailable";
    fallback.textContent = services.strings.embedUnavailable;
    options.element.replaceChildren(fallback);
    return () => fallback.remove();
  }
  const card = snapshot.card;
  let disposed = false;
  const video = card.resource.kind === "video" ? card.resource : undefined;
  const actions = video ? document.createElement("div") : undefined;
  let loadButton: HTMLButtonElement | undefined;
  let loadVideo: (() => void) | undefined;
  let hint: HTMLParagraphElement | undefined;
  const allowed = youtubePlaybackAllowed(services.frontend, document.URL);
  if (actions) {
    actions.className = "slc-video__actions";
    loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "slc-video__load";
    loadButton.textContent = services.strings.videoLoad;
    loadButton.setAttribute("aria-label", `${services.strings.videoLoad}: ${card.title}`);
    hint = document.createElement("p");
    hint.className = "slc-video__hint";
    hint.id = `slc-video-help-${++videoHintId}`;
    loadButton.setAttribute("aria-describedby", hint.id);
    hint.textContent = allowed ? services.strings.videoHint : services.strings.videoHostBlocked;
    loadButton.disabled = !allowed;
    actions.append(loadButton, hint);
  }
  const view = createPassiveCard(document, {
    url: card.url,
    title: card.title,
    identity: card.provider?.name ?? new URL(card.url).hostname,
    favicon: card.favicon,
    image: card.resource.kind === "photo" ? card.resource : video?.thumbnail,
    actions,
  }, services);
  if (video) {
    let requested = false;
    loadVideo = () => {
      // A stale render (including replacement without cleanup) cannot activate remote content.
      if (
        !allowed || disposed || requested || !view.root.isConnected
        || view.root.parentNode !== options.element
      ) {
        return;
      }
      if (view.card.clientWidth < 200) {
        hint!.textContent = services.strings.videoNarrow;
        return;
      }
      requested = true;
      loadButton!.disabled = true;
      const frame = document.createElement("iframe");
      frame.className = "slc-video__frame";
      frame.title = `YouTube: ${card.title}`;
      frame.setAttribute("sandbox", YOUTUBE_SANDBOX);
      frame.setAttribute("allow", YOUTUBE_ALLOW);
      frame.referrerPolicy = YOUTUBE_REFERRER_POLICY;
      // No load/error detector: cross-origin load does not prove successful playback.
      frame.src = youtubeEmbedUrl(video.videoId);
      view.card.querySelector(".slc-card__image")?.remove();
      view.card.classList.add("slc-card--active");
      view.card.append(frame);
    };
    loadButton!.addEventListener("click", loadVideo);
  }
  options.element.replaceChildren(view.root);
  return () => {
    if (disposed) return;
    disposed = true;
    if (loadButton && loadVideo) loadButton.removeEventListener("click", loadVideo);
    view.dispose();
  };
}
