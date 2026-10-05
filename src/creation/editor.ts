import type { Plugin, Protyle } from "siyuan";
import { blockCandidate, immediateCandidate } from "./prefill.ts";
import { CreationError } from "./types.ts";
import type { InsertionTarget } from "./types.ts";
import { NATIVE_YOUTUBE_SANDBOX, NATIVE_YOUTUBE_STYLE, nativeYoutubeSource } from "./youtube.ts";

export type BlockReader = (id: string) => Promise<string>;

/** Captures only the supplied official editor/block/range; never consults an active editor. */
export function captureTarget(
  protyle: Protyle,
  block: HTMLElement,
  owner: Plugin,
  readBlock: BlockReader,
  suppliedRange?: Range,
): InsertionTarget {
  const root = protyle.protyle.wysiwyg?.element;
  const rootId = protyle.protyle.block.rootID;
  const blockId = block.dataset.nodeId;
  let released = false;
  const range = (suppliedRange ?? protyle.getRange(block)).cloneRange();
  function check(current: Range): void {
    const start = protyle.hasClosestBlock(current.startContainer);
    const end = protyle.hasClosestBlock(current.endContainer);
    if (
      released || !root || !rootId || !blockId || protyle.protyle.disabled || !root.isConnected
      || root !== protyle.protyle.wysiwyg?.element || protyle.protyle.block.rootID !== rootId
      || !current.startContainer.isConnected || !current.endContainer.isConnected
      || !root.contains(current.startContainer) || !root.contains(current.endContainer)
      || !start || !end || start.dataset.nodeId !== blockId || end.dataset.nodeId !== blockId
    ) throw new CreationError("stale-target");
  }
  check(range);
  let handle = protyle.trackRange(range, { owner, affinity: "before" });
  let active = true;
  let checkpoint: {
    range: Range;
    block: HTMLElement;
    text: string;
    start: Node;
    end: Node;
    startOffset: number;
    endOffset: number;
  } | undefined;
  function resolve(): Range {
    if (!active) throw new CreationError("stale-target");
    const result = protyle.resolveTrackedRange(handle);
    if (result.status !== "resolved") throw new CreationError("stale-target");
    check(result.range);
    return result.range;
  }
  function releaseHandle(): void {
    if (!active) return;
    active = false;
    protyle.releaseTrackedRange(handle);
  }
  let immediate: string | undefined;
  try {
    immediate = immediateCandidate(range, block);
  } catch {
    releaseHandle();
    throw new CreationError("stale-target");
  }
  const prefill = immediate
    ? Promise.resolve(immediate)
    : Promise.resolve().then(() => released ? "" : readBlock(blockId!)).then(blockCandidate).then(
      value => value ?? "",
      () => "",
    );
  function insertSource(source: string, type: "NodeCustomBlock" | "NodeIFrame", frameSource?: string): void {
    const current = resolve();
    if (!protyle.protyle.toolbar || !protyle.protyle.lute) throw new CreationError("insertion-failed");
    const html = protyle.protyle.lute.Md2BlockDOM(source);
    // Inspect conversion in an inert document; editor insertion is exclusively the public SDK call.
    const parsed = new block.ownerDocument.defaultView!.DOMParser().parseFromString(html, "text/html");
    const native = parsed.querySelectorAll<HTMLElement>(`[data-type="${type}"]`);
    const id = native[0]?.dataset.nodeId;
    if (native.length !== 1 || !id || !/^[a-z0-9-]{1,64}$/u.test(id)) {
      throw new CreationError("insertion-failed");
    }
    if (type === "NodeIFrame") {
      const node = native[0]!;
      const frame = node.querySelector("iframe");
      const expectedAttributes = {
        src: frameSource!,
        title: "YouTube video player",
        sandbox: NATIVE_YOUTUBE_SANDBOX,
        allow: "fullscreen",
        referrerpolicy: "strict-origin",
        allowfullscreen: "",
      };
      const geometry = parsed.createElement("div");
      geometry.setAttribute("style", NATIVE_YOUTUBE_STYLE);
      if (
        parsed.body.children.length !== 1 || parsed.body.firstElementChild !== node
        || parsed.querySelectorAll("[data-node-id]").length !== 1
        || parsed.querySelectorAll("iframe").length !== 1 || !frame
        || parsed.querySelector("script,style,object,embed,[srcdoc]")
        || frame.getAttributeNames().length !== Object.keys(expectedAttributes).length
        || Object.entries(expectedAttributes).some(([key, value]) => frame.getAttribute(key) !== value)
        || node.style.cssText !== geometry.style.cssText
      ) throw new CreationError("insertion-failed");
    }
    check(current);
    protyle.protyle.toolbar.range = current;
    protyle.insert(html, true, true);
    const inserted = root!.querySelector(`[data-node-id="${id}"][data-type="${type}"]`);
    if (!inserted || (frameSource && inserted.querySelector("iframe")?.getAttribute("src") !== frameSource)) {
      throw new CreationError("insertion-failed");
    }
  }
  return {
    prefill,
    assetContext: blockId!,
    resume() {
      if (active) {
        resolve();
        return;
      }
      if (!checkpoint || !checkpoint.block.isConnected || checkpoint.block.textContent !== checkpoint.text) {
        throw new CreationError("stale-target");
      }
      if (
        !checkpoint.start.isConnected || !checkpoint.end.isConnected
        || checkpoint.range.startContainer !== checkpoint.start
        || checkpoint.range.endContainer !== checkpoint.end
        || checkpoint.range.startOffset !== checkpoint.startOffset
        || checkpoint.range.endOffset !== checkpoint.endOffset
      ) throw new CreationError("stale-target");
      check(checkpoint.range);
      handle = protyle.trackRange(checkpoint.range, { owner, affinity: "before" });
      active = true;
      checkpoint = undefined;
    },
    pause() {
      if (!active) return;
      try {
        const current = resolve();
        const currentBlock = protyle.hasClosestBlock(current.startContainer);
        if (!currentBlock) throw new CreationError("stale-target");
        checkpoint = {
          range: current.cloneRange(),
          block: currentBlock,
          text: currentBlock.textContent ?? "",
          start: current.startContainer,
          end: current.endContainer,
          startOffset: current.startOffset,
          endOffset: current.endOffset,
        };
      } finally {
        releaseHandle();
      }
    },
    insert(markdown) {
      insertSource(markdown, "NodeCustomBlock");
    },
    insertYoutube(sourceUrl, confirmedVideoId) {
      let source: string;
      try {
        source = nativeYoutubeSource(sourceUrl, confirmedVideoId);
      } catch {
        throw new CreationError("insertion-failed");
      }
      insertSource(source, "NodeIFrame", `https://www.youtube.com/embed/${confirmedVideoId}`);
    },
    release() {
      released = true;
      checkpoint = undefined;
      releaseHandle();
    },
  };
}
