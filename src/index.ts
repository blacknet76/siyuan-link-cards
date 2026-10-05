import { Dialog, fetchSyncPost, getFrontend, Plugin, showMessage } from "siyuan";
import type { APIFormData, IMenuItem, Protyle, UploadAssetRequestInput } from "siyuan";
import { assetImporter } from "./assets/service.ts";
import { openCardDialog } from "./creation/dialog.ts";
import { captureTarget } from "./creation/editor.ts";
import type { CreationKind } from "./creation/types.ts";
import { nativeYoutubeAvailable } from "./creation/youtube.ts";
import embedSvg from "./icons/icon-embed.svg";
import linkCardSvg from "./icons/icon-link-card.svg";
import { openFaviconRepairDialog } from "./maintenance/favicon-dialog.ts";
import { FaviconRepairKernel } from "./maintenance/favicon-kernel.ts";
import { kernelTransport } from "./metadata/http.ts";
import { resolveBookmark } from "./metadata/resolver.ts";
import { openMigrationDialog } from "./migration/dialog.ts";
import { MigrationKernel } from "./migration/kernel.ts";
import { openYoutubeMigrationDialog } from "./migration/youtube-dialog.ts";
import { YoutubeMigrationKernel } from "./migration/youtube-kernel.ts";
import { navigateExternal } from "./navigation.ts";
import { renderOembed } from "./oembed/renderer.ts";
import { resolveOembed } from "./oembed/resolver.ts";
import { OEMBED_TYPE } from "./oembed/schema.ts";
import { renderLinkCard } from "./renderer.ts";
import { BLOCK_TYPE } from "./schema.ts";
import { localizedStrings } from "./strings.ts";
import "./index.css";

export const LINK_CARD_ICON = "icon-siyuan-link-cards-card";
export const EMBED_ICON = "icon-siyuan-link-cards-embed";

export const BOOKMARK_ALIASES = ["linkcard", "bookmark", "card"] as const;

export const EMBED_ALIASES = ["embed", "oembed"] as const;

export default class LinkCardsPlugin extends Plugin {
  private readonly dialogs = new Set<() => void>();
  private openCreation:
    | ((protyle: Protyle, block: HTMLElement, range?: Range, kind?: CreationKind) => void)
    | undefined;
  private migrationClose: (() => void) | undefined;
  onload(): void {
    const strings = localizedStrings(this.i18n);
    this.customBlockRenders[BLOCK_TYPE] = {
      render: options => renderLinkCard(options, { strings, navigate: navigateExternal }),
    };
    this.customBlockRenders[OEMBED_TYPE] = {
      render: options =>
        renderOembed(options, { strings, navigate: navigateExternal, frontend: getFrontend() }),
    };
    if (window.siyuan.config?.readonly || window.siyuan.isPublish) return;
    for (const [id, svg] of [[LINK_CARD_ICON, linkCardSvg], [EMBED_ICON, embedSvg]] as const) {
      if (!document.getElementById(id)) {
        // Keep approved geometry/styles intact; only adapt the SVG root to the host symbol API.
        this.addIcons(svg.replace("<svg", `<symbol id="${id}"`).replace("</svg>", "</symbol>"));
      }
    }
    const importAsset = assetImporter(
      kernelTransport(fetchSyncPost),
      (form, signal) =>
        fetchSyncPost("/api/asset/upload", form as APIFormData<UploadAssetRequestInput>, {}, false, signal),
    );
    const open = (protyle: Protyle, block: HTMLElement, range?: Range, kind: CreationKind = "bookmark") => {
      let target: ReturnType<typeof captureTarget> | undefined;
      try {
        target = captureTarget(protyle, block, this, async id => {
          const response = await fetchSyncPost("/api/block/getBlockKramdown", { id }, {}, false);
          if (response.code !== 0 || typeof response.data?.kramdown !== "string") return "";
          return response.data.kramdown;
        }, range);
        const close = openCardDialog(
          target,
          options => new Dialog(options),
          (url, signal) =>
            resolveBookmark(url, { transport: kernelTransport(fetchSyncPost), document }, signal),
          strings,
          () => this.dialogs.delete(close),
          {
            kind,
            nativeYoutubeAvailable: nativeYoutubeAvailable(getFrontend(), window.location.href),
            importAsset,
            notifyMediaOmitted: () => showMessage(strings.assetOmitted),
            resolveEmbed: (url, signal) =>
              resolveOembed(url, { transport: kernelTransport(fetchSyncPost), document }, signal),
          },
        );
        this.dialogs.add(close);
      } catch {
        target?.release();
        showMessage(strings.bookmarkStaleTarget);
      }
    };
    this.openCreation = open;
    this.protyleSlash = [
      {
        id: "linkcard",
        filter: [...BOOKMARK_ALIASES],
        icon: LINK_CARD_ICON,
        label: strings.insertCardAction,
        kind: "bookmark" as const,
      },
      {
        id: "embed",
        filter: [...EMBED_ALIASES],
        icon: EMBED_ICON,
        label: strings.embedCommand,
        kind: "embed" as const,
      },
    ].map(({ id, filter, icon, label, kind }) => ({
      id,
      filter,
      html:
        `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${icon}"></use></svg><span class="b3-list-item__text">${label}</span></div>`,
      callback: (protyle, nodeElement) => open(protyle, nodeElement, undefined, kind),
    }));
    // Supplied command context preserves selections that typing a slash command can replace.
    this.addCommand({
      langKey: "bookmarkCommand",
      langText: strings.bookmarkCommand,
      enabled: context => Boolean(context.protyle && context.range && !context.protyle.disabled),
      execute: context => {
        if (!context.protyle || !context.range) return;
        const protyle = context.protyle.getInstance();
        const block = protyle.hasClosestBlock(context.range.startContainer);
        if (block) open(protyle, block, context.range);
      },
    });
    this.addCommand({
      langKey: "migrationCommand",
      langText: strings.migrationCommand,
      enabled: context => Boolean(context.protyle && !context.protyle.disabled && !this.migrationClose),
      execute: context => {
        if (!context.protyle || context.protyle.disabled || this.migrationClose) return;
        const protyle = context.protyle.getInstance();
        const kernel = new MigrationKernel(
          (path, body) => fetchSyncPost(path, body, {}, false),
          document,
          markdown => {
            if (!protyle.protyle.lute) throw new Error("migration-conversion");
            return protyle.protyle.lute.Md2BlockDOM(markdown);
          },
          () => !protyle.protyle.disabled && !window.siyuan.config?.readonly && !window.siyuan.isPublish,
          importAsset,
        );
        const close = openMigrationDialog(kernel, options => new Dialog(options), strings, () => {
          this.dialogs.delete(close);
          if (this.migrationClose === close) this.migrationClose = undefined;
        });
        this.migrationClose = close;
        this.dialogs.add(close);
      },
    });
    this.addCommand({
      langKey: "youtubeMigrationCommand",
      langText: strings.youtubeMigrationCommand,
      enabled: context =>
        Boolean(
          context.protyle && !context.protyle.disabled && !this.migrationClose
            && nativeYoutubeAvailable(getFrontend(), window.location.href),
        ),
      execute: context => {
        if (
          !context.protyle || context.protyle.disabled || this.migrationClose
          || !nativeYoutubeAvailable(getFrontend(), window.location.href)
        ) return;
        const protyle = context.protyle.getInstance();
        const kernel = new YoutubeMigrationKernel(
          (path, body) => fetchSyncPost(path, body, {}, false),
          document,
          markdown => {
            if (!protyle.protyle.lute) throw new Error("migration-conversion");
            return protyle.protyle.lute.Md2BlockDOM(markdown);
          },
          () =>
            !protyle.protyle.disabled && !window.siyuan.config?.readonly && !window.siyuan.isPublish
            && nativeYoutubeAvailable(getFrontend(), window.location.href),
        );
        const close = openYoutubeMigrationDialog(kernel, options => new Dialog(options), strings, () => {
          this.dialogs.delete(close);
          if (this.migrationClose === close) this.migrationClose = undefined;
        });
        this.migrationClose = close;
        this.dialogs.add(close);
      },
    });
    this.addCommand({
      langKey: "faviconRepairCommand",
      langText: strings.faviconRepairPaletteCommand,
      enabled: context => Boolean(context.protyle && !context.protyle.disabled && !this.migrationClose),
      execute: context => {
        if (!context.protyle || context.protyle.disabled || this.migrationClose) return;
        const protyle = context.protyle.getInstance();
        const kernel = new FaviconRepairKernel(
          (path, body) => fetchSyncPost(path, body, {}, false),
          document,
          markdown => {
            if (!protyle.protyle.lute) throw new Error("maintenance-conversion");
            return protyle.protyle.lute.Md2BlockDOM(markdown);
          },
          (url, signal) =>
            resolveBookmark(url, { transport: kernelTransport(fetchSyncPost), document }, signal),
          importAsset,
          () => !protyle.protyle.disabled && !window.siyuan.config?.readonly && !window.siyuan.isPublish,
          id =>
            Array.from(document.querySelectorAll(`[data-node-id="${id}"]`)).some(block =>
              Boolean(block.querySelector(".slc-card--active,iframe,video,audio"))
            ),
        );
        const close = openFaviconRepairDialog(kernel, options => new Dialog(options), strings, () => {
          this.dialogs.delete(close);
          if (this.migrationClose === close) this.migrationClose = undefined;
        });
        this.migrationClose = close;
        this.dialogs.add(close);
      },
    });
  }
  updateProtyleToolbar(toolbar: Array<string | IMenuItem>): Array<string | IMenuItem> {
    if (!this.openCreation || window.siyuan.config?.readonly || window.siyuan.isPublish) return toolbar;
    return [...toolbar.filter(item => typeof item === "string" || item.name !== "slc-insert-card"), {
      name: "slc-insert-card",
      icon: LINK_CARD_ICON,
      tipPosition: "n",
      tip: localizedStrings(this.i18n).insertCardAction,
      click: protyle => {
        const range = protyle.protyle.toolbar?.range;
        if (!range) return;
        const block = protyle.hasClosestBlock(range.startContainer);
        if (block) this.openCreation?.(protyle, block, range, "bookmark");
      },
    }];
  }
  onunload(): void {
    this.openCreation = undefined;
    for (const close of this.dialogs) close();
    this.dialogs.clear();
  }
}
