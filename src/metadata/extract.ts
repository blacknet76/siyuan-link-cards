import type { BookmarkMetadata } from "./types.ts";
import { publicHttpUrl, resolvePublicUrl } from "./url-policy.ts";

export type ExtractedMetadata = Omit<BookmarkMetadata, "originalUrl" | "resolvedUrl" | "resolvedAt">;

function inertFragment(html: string, document: Document): DocumentFragment {
  const template = document.createElement("template");
  // Only a detached template in an inactive document. Never adopted into live DOM.
  // Its contents remain inert, including images, frames, custom elements and scripts.
  template.innerHTML = html;
  return template.content;
}

export function extractMetadata(html: string, resolvedUrl: string, owner: Document): ExtractedMetadata {
  const target = publicHttpUrl(resolvedUrl);
  const document = owner.implementation.createHTMLDocument("");
  const fragment = inertFragment(html, document);
  const values = new Map<string, string[]>();
  for (const meta of fragment.querySelectorAll("meta")) {
    const key = (meta.getAttribute("property") ?? meta.getAttribute("name") ?? "").trim().toLowerCase();
    if (
      !/^(?:og:(?:title|description|image(?::secure_url)?|site_name)|twitter:(?:title|description|image)|description)$/
        .test(key)
    ) continue;
    const content = meta.getAttribute("content");
    if (content !== null) {
      const existing = values.get(key);
      if (existing) existing.push(content);
      else values.set(key, [content]);
    }
  }
  function text(value: string, limit: number): string | undefined {
    let plain = value;
    if (value.includes("<")) {
      const content = inertFragment(value, document);
      for (const node of content.querySelectorAll("script, style, template, iframe, object")) node.remove();
      plain = content.textContent ?? "";
    }
    // eslint-disable-next-line no-control-regex -- Remove non-display controls from extracted text.
    plain = plain.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
      .replace(/\s+/gu, " ").trim().slice(0, limit).replace(/[\ud800-\udbff]$/u, "").trim();
    return plain || undefined;
  }
  function pickText(keys: string[], limit: number): string | undefined {
    for (const key of keys) {
      for (const value of values.get(key) ?? []) {
        const normalized = text(value, limit);
        if (normalized) return normalized;
      }
    }
    return undefined;
  }
  let base = target.href;
  const baseValue = fragment.querySelector("base[href]")?.getAttribute("href");
  if (baseValue) {
    try {
      base = resolvePublicUrl(baseValue, target.href).href;
    } catch { /* Invalid base never replaces final document base. */ }
  }
  function resource(value: string): string | undefined {
    try {
      return resolvePublicUrl(value, base).href;
    } catch {
      return undefined;
    }
  }
  function pickResource(keys: string[]): string | undefined {
    for (const key of keys) {
      for (const value of values.get(key) ?? []) {
        const normalized = resource(value);
        if (normalized) return normalized;
      }
    }
    return undefined;
  }
  const title = pickText(["og:title", "twitter:title"], 512)
    ?? text(fragment.querySelector("title")?.textContent ?? "", 512) ?? target.hostname;
  const description = pickText(["og:description", "twitter:description", "description"], 4096);
  const image = pickResource(["og:image:secure_url", "og:image", "twitter:image"]);
  const siteName = pickText(["og:site_name"], 256) ?? target.hostname;
  const icons: string[] = [], appleIcons: string[] = [];
  for (const link of fragment.querySelectorAll("link[rel][href]")) {
    const rel = link.getAttribute("rel")!.toLowerCase().split(/\s+/u);
    const candidate = resource(link.getAttribute("href")!);
    if (!candidate) continue;
    if (rel.includes("icon") && icons.length < 8) icons.push(candidate);
    else if (rel.includes("apple-touch-icon") && appleIcons.length < 8) appleIcons.push(candidate);
  }
  const faviconCandidates = [
    ...new Set([...icons, ...appleIcons, resolvePublicUrl("/favicon.ico", target.origin).href]),
  ].slice(0, 8);
  return {
    title,
    siteName,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    favicon: faviconCandidates[0]!,
    faviconCandidates,
  };
}
