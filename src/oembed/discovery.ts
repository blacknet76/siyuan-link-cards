import { ResolutionError } from "../metadata/types.ts";
import { publicHttpUrl, resolvePublicUrl } from "../metadata/url-policy.ts";
import { oembedFail } from "./types.ts";

/** First valid JSON alternate in document order. Never adopts source DOM or loads its assets. */
export function discoverOembed(html: string, resolvedUrl: string, owner: Document): string {
  const final = publicHttpUrl(resolvedUrl).href;
  const document = owner.implementation.createHTMLDocument("");
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  let base = final;
  const declared = fragment.querySelector("base[href]")?.getAttribute("href");
  if (declared) {
    try {
      base = resolvePublicUrl(declared, final).href;
    } catch { /* Same first-base policy as bookmarks. */ }
  }
  let xml = false;
  let rejected: ResolutionError | undefined;
  for (const link of fragment.querySelectorAll("link[rel][type]")) {
    if (!link.getAttribute("rel")!.trim().toLowerCase().split(/\s+/u).includes("alternate")) continue;
    const mime = link.getAttribute("type")!.trim().toLowerCase();
    if (mime === "text/xml+oembed") xml = true;
    if (mime !== "application/json+oembed") continue;
    try {
      return resolvePublicUrl(link.getAttribute("href") ?? "", base).href;
    } catch (error) {
      if (error instanceof ResolutionError) rejected ??= error;
    }
  }
  if (rejected) throw rejected;
  return oembedFail(xml ? "xml-only" : "no-discovery");
}
