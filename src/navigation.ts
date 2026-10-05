import { validateHttpUrl } from "./schema.ts";

export type ExternalNavigation = (url: string, event: MouseEvent) => void;

/**
 * Keep native anchor activation. SiYuan Desktop routes target=_blank through
 * its host window-open handler; browsers use a separate protected tab.
 * There is no common exported SDK openExternal API. Mobile WebView routing
 * requires device verification; no Electron or undocumented bridge is used.
 */
export const navigateExternal: ExternalNavigation = (url, event) => {
  try {
    validateHttpUrl(url);
    const anchor = event.currentTarget as HTMLAnchorElement | null;
    if (!anchor || anchor.tagName !== "A" || anchor.getAttribute("href") !== url) event.preventDefault();
  } catch {
    event.preventDefault();
  }
};
