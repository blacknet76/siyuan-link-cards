import { publicHttpUrl } from "../metadata/url-policy.ts";

interface UrlMatch {
  value: string;
  start: number;
  end: number;
}

function matches(text: string): UrlMatch[] {
  if (text.length > 64 * 1024) return [];
  const found: UrlMatch[] = [];
  // SiYuan's editable paragraph boundary uses U+200B; it is not part of a URL.
  for (const match of text.matchAll(/https?:\/\/[^\s\u200b<>"'`]+/giu)) {
    let value = match[0].replace(/[.,;!?]+$/u, "");
    // Markdown/sentence closing delimiters are not part of the target; balanced URL parentheses are.
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) {
        value = value.slice(0, -1);
      }
    }
    try {
      publicHttpUrl(value);
      found.push({ value, start: match.index, end: match.index + value.length });
    } catch { /* Invalid/blocked candidates never prefill. */ }
  }
  return found;
}

function unique(values: string[]): string | undefined {
  const urls = new Map<string, string>();
  for (const value of values) {
    try {
      const key = publicHttpUrl(value).href;
      if (!urls.has(key)) urls.set(key, value);
    } catch { /* Ignore unusable inline link targets. */ }
  }
  return urls.size === 1 ? urls.values().next().value : undefined;
}

/** Official current-block Kramdown only; no document-wide scan or general Markdown parser. */
export function blockCandidate(kramdown: string): string | undefined {
  return unique(matches(kramdown).map(match => match.value));
}

function within(range: Range, block: HTMLElement): boolean {
  return block.contains(range.startContainer) && block.contains(range.endContainer);
}

function linkTarget(element: Element | null, block: HTMLElement): string | undefined {
  const link = element?.closest("a[href], [data-type~='a'][data-href]");
  if (!link || !block.contains(link)) return undefined;
  return link.getAttribute("data-href") ?? link.getAttribute("href") ?? undefined;
}

export function selectionCandidate(range: Range, block: HTMLElement): string | undefined {
  if (range.collapsed || !within(range, block)) return undefined;
  const values = matches(range.toString()).map(match => match.value);
  for (const link of block.querySelectorAll("a[href], [data-type~='a'][data-href]")) {
    if (!range.intersectsNode(link)) continue;
    const value = linkTarget(link, block);
    if (value) values.push(value);
  }
  return unique(values);
}

/** Narrow DOM boundary: only the supplied block and the supplied range. */
export function caretCandidate(range: Range, block: HTMLElement): string | undefined {
  if (!within(range, block)) return undefined;
  // A slash invocation selects its typed command. Never reconstruct an earlier selection.
  if (!range.collapsed && !/^\/?(?:bookmark|linkcard|card|embed|oembed)$/u.test(range.toString())) {
    return undefined;
  }
  const node = range.startContainer;
  const parent = node.nodeType === 1 ? node as Element : node.parentElement;
  const direct = linkTarget(parent, block);
  if (direct) return unique([direct]);
  if (node.nodeType === 1) {
    const neighbors = [node.childNodes[range.startOffset - 1], node.childNodes[range.startOffset]];
    const values = neighbors.map(child => {
      const element = child?.nodeType === 1 ? child as Element : child?.parentElement;
      return linkTarget(element ?? null, block);
    }).filter((value): value is string => Boolean(value));
    const candidate = unique(values);
    if (candidate) return candidate;
  }
  const prefix = range.cloneRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(node, range.startOffset);
  const offset = prefix.toString().length;
  return unique(
    matches(block.textContent ?? "").filter(match =>
      (offset >= match.start && offset <= match.end)
      || (offset === match.end + 1 && /[\s\u200b]/u.test((block.textContent ?? "")[match.end] ?? ""))
    ).map(match => match.value),
  );
}

export function immediateCandidate(range: Range, block: HTMLElement): string | undefined {
  return selectionCandidate(range, block) ?? caretCandidate(range, block);
}
