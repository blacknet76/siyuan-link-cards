import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Plugin, Protyle } from "siyuan";
import ts from "typescript";
import manifest from "../plugin.json" with { type: "json" };
import { nativeYoutubeAvailable } from "../src/creation/youtube.ts";
import german from "../src/i18n/de-DE.json" with { type: "json" };
import english from "../src/i18n/en.json" with { type: "json" };
import { localizedStrings } from "../src/strings.ts";

// Execute the actual registration source with the official SDK boundary and creation services isolated.
// The real minified CommonJS export is additionally checked during package validation.
const source = ts.transpileModule(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function registration(
  dev = false,
  readonly = false,
  publish = false,
  frontend = "browser-desktop",
  language = english,
) {
  const document = new JSDOM().window.document;
  const icons: string[] = [];
  class HostPlugin {
    addIcons(svg: string) {
      icons.push(svg);
      const defs = document.querySelector("svg[data-name=\"siyuan-link-cards\"] defs");
      if (defs) defs.insertAdjacentHTML("afterbegin", svg);
      else {document.body.insertAdjacentHTML(
          "afterbegin",
          `<svg data-name="siyuan-link-cards"><defs>${svg}</defs></svg>`,
        );}
    }
    i18n = language;
    customBlockRenders: Plugin["customBlockRenders"] = {};
    protyleSlash: Plugin["protyleSlash"] = [];
    commands: Parameters<Plugin["addCommand"]>[0][] = [];
    addCommand(command: Parameters<Plugin["addCommand"]>[0]) {
      this.commands.push(command);
    }
  }
  const captures: unknown[][] = [];
  const targets: object[] = [];
  const opens: unknown[][] = [];
  const renders: unknown[][] = [];
  const migrations: unknown[][] = [];
  let requests = 0, closed = 0;
  const exports: {
    default?: new() => HostPlugin & {
      onload(): void;
      onunload(): void;
      updateProtyleToolbar(toolbar: import("siyuan").IMenuItem[]): import("siyuan").IMenuItem[];
    };
  } = {};
  const services: Record<string, unknown> = {
    siyuan: {
      Plugin: HostPlugin,
      Dialog: class {},
      getFrontend: () => frontend,
      fetchSyncPost: async () => {
        requests++;
        return { code: 0, data: { kramdown: "https://example.com/" } };
      },
      showMessage: () => assert.fail("valid supplied context must not report a capture error"),
    },
    "./creation/dialog.ts": {
      openCardDialog: (...args: unknown[]) => {
        opens.push(args);
        return () => {
          closed++;
        };
      },
    },
    "./creation/editor.ts": {
      captureTarget: (...args: unknown[]) => {
        captures.push(args);
        const target = { id: captures.length, release: () => {} };
        targets.push(target);
        return target;
      },
    },
    "./creation/youtube.ts": { nativeYoutubeAvailable },
    "./assets/service.ts": { assetImporter: () => () => assert.fail("no asset import before Insert") },
    "./metadata/http.ts": { kernelTransport: () => ({}) },
    "./metadata/resolver.ts": { resolveBookmark: () => assert.fail("no resolution before Insert") },
    "./maintenance/favicon-kernel.ts": {
      FaviconRepairKernel: class {
        readonly kind = "favicon";
      },
    },
    "./maintenance/favicon-dialog.ts": {
      openFaviconRepairDialog: (...args: unknown[]) => {
        migrations.push(args);
        return () => {
          closed++;
        };
      },
    },
    "./migration/kernel.ts": {
      MigrationKernel: class {
        readonly kind = "bookmark";
      },
    },
    "./migration/youtube-kernel.ts": {
      YoutubeMigrationKernel: class {
        readonly kind = "youtube";
      },
    },
    "./migration/youtube-dialog.ts": {
      openYoutubeMigrationDialog: (...args: unknown[]) => {
        migrations.push(args);
        return () => {
          closed++;
        };
      },
    },
    "./migration/dialog.ts": {
      openMigrationDialog: (...args: unknown[]) => {
        migrations.push(args);
        return () => {
          closed++;
        };
      },
    },
    "./oembed/renderer.ts": {
      renderOembed: (...args: unknown[]) => {
        renders.push(args);
      },
    },
    "./oembed/resolver.ts": { resolveOembed: () => assert.fail("no resolution before Insert") },
    "./oembed/schema.ts": { OEMBED_TYPE: "oembed" },
    "./navigation.ts": { navigateExternal: () => {} },
    "./renderer.ts": { renderLinkCard: () => {} },
    "./schema.ts": { BLOCK_TYPE: "link-card" },
    "./strings.ts": { localizedStrings },
    "./index.css": {},
    "./icons/icon-embed.svg": readFileSync(new URL("../src/icons/icon-embed.svg", import.meta.url), "utf8"),
    "./icons/icon-link-card.svg": readFileSync(
      new URL("../src/icons/icon-link-card.svg", import.meta.url),
      "utf8",
    ),
  };
  runInNewContext(source, {
    exports,
    require: (name: string) => {
      assert.ok(name in services, `unexpected registration dependency: ${name}`);
      return services[name];
    },
    __DEV__: dev,
    window: {
      siyuan: { config: { readonly }, isPublish: publish },
      location: { href: "http://127.0.0.1:18173/stage/build/desktop/" },
    },
    document,
  });
  const instance = new exports.default!();
  instance.onload();
  return {
    instance,
    icons,
    document,
    captures,
    targets,
    opens,
    migrations,
    renders,
    requests: () => requests,
    closed: () => closed,
  };
}
test("oEmbed receives official frontend identity without host internals or network", () => {
  for (const frontend of ["browser-desktop", "desktop", "desktop-window", "mobile", "browser-mobile"]) {
    const h = registration(false, false, false, frontend);
    h.instance.customBlockRenders["oembed"]!.render({
      element: {} as HTMLElement,
      content: "",
      setContent: () => false,
    });
    assert.equal((h.renders[0]![1] as { frontend: string; }).frontend, frontend);
    assert.equal(h.requests(), 0);
  }
});

test("production and development register two visible creation actions and four explicit commands without a scan", () => {
  for (const dev of [false, true]) {
    const h = registration(dev);
    assert.deepEqual(Array.from(h.instance.protyleSlash, entry => entry.id), [
      "linkcard",
      "embed",
    ]);
    assert.deepEqual(h.instance.commands.map(command => command.langKey), [
      "bookmarkCommand",
      "migrationCommand",
      "youtubeMigrationCommand",
      "faviconRepairCommand",
    ]);
    assert.equal(h.migrations.length, 0);
    assert.ok(h.instance.customBlockRenders["link-card"]);
    assert.ok(h.instance.customBlockRenders["oembed"]);
    assert.equal(h.opens.length, 0);
    assert.equal(h.requests(), 0);
  }
});
test("migration starts only from its command, rejects duplicate dialogs and closes on unload", () => {
  const h = registration();
  const command = h.instance.commands[1]!;
  const context = {
    protyle: { disabled: false, getInstance: () => ({ protyle: { lute: {} } }) },
  } as unknown as Parameters<NonNullable<typeof command.execute>>[0];
  assert.equal(command.enabled!(context), true);
  command.execute!(context);
  command.execute!(context);
  assert.equal(h.migrations.length, 1);
  assert.equal(command.enabled!(context), false);
  assert.equal(h.requests(), 0);
  h.instance.onunload();
  assert.equal(h.closed(), 1);
});
test("all aliases share capture-before-dialog and use only supplied original editor/block", () => {
  const h = registration();
  const protyle = {} as Protyle, block = {} as HTMLElement;
  for (const entry of h.instance.protyleSlash) {
    for (const alias of entry.filter) {
      const matched = h.instance.protyleSlash.find(row => row.filter.includes(alias))!;
      assert.equal(matched, entry);
      matched.callback(protyle, block);
    }
  }
  assert.equal(h.captures.length, 5);
  assert.equal(h.opens.length, 5);
  for (const [i, capture] of h.captures.entries()) {
    assert.equal(capture[0], protyle);
    assert.equal(capture[1], block);
    assert.equal(capture[2], h.instance);
    assert.equal(capture[4], undefined);
    assert.equal(h.opens[i]![0], h.targets[i]);
    assert.equal((h.opens[i]![5] as { kind: string; }).kind, i < 3 ? "bookmark" : "embed");
    assert.equal((h.opens[i]![5] as { nativeYoutubeAvailable: boolean; }).nativeYoutubeAvailable, true);
  }
  assert.equal(h.requests(), 0);
});
test("command palette passes its supplied range and editor instance into the shared workflow", () => {
  const h = registration();
  const block = {} as HTMLElement, range = { startContainer: {} } as Range;
  const protyle = { hasClosestBlock: () => block } as unknown as Protyle;
  const context = {
    protyle: { disabled: false, getInstance: () => protyle },
    range,
  } as Parameters<NonNullable<Parameters<Plugin["addCommand"]>[0]["execute"]>>[0];
  const command = h.instance.commands[0]!;
  assert.equal(command.enabled!(context), true);
  command.execute!(context);
  assert.equal(h.captures[0]![0], protyle);
  assert.equal(h.captures[0]![1], block);
  assert.equal(h.captures[0]![4], range);
  assert.equal(h.opens.length, 1);
});
test("readonly/publish still render but register no editing workflow", () => {
  for (const [readonly, publish] of [[true, false], [false, true]]) {
    const h = registration(false, readonly, publish);
    assert.ok(h.instance.customBlockRenders["link-card"]);
    assert.ok(h.instance.customBlockRenders["oembed"]);
    assert.equal(h.instance.protyleSlash.length, 0);
    assert.equal(h.instance.commands.length, 0);
    assert.equal(h.requests(), 0);
  }
});
test("plugin unload closes every owned dialog without requests or another editor lookup", () => {
  const h = registration();
  for (const entry of h.instance.protyleSlash) entry.callback({} as Protyle, {} as HTMLElement);
  h.instance.onunload();
  h.instance.onunload();
  assert.equal(h.closed(), 2);
  assert.equal(h.requests(), 0);
});

test("two visible slash rows retain all aliases, localized labels and approved plugin icons", () => {
  const h = registration();
  assert.deepEqual(Array.from(h.instance.protyleSlash[0]!.filter), ["linkcard", "bookmark", "card"]);
  assert.deepEqual(Array.from(h.instance.protyleSlash[1]!.filter), ["embed", "oembed"]);
  for (const [i, entry] of h.instance.protyleSlash.entries()) {
    // SDK 1.2.9 carries icons in html; SiYuan 3.8.6 renders that inside a two-line list button.
    assert.deepEqual(Object.keys(entry).sort(), ["callback", "filter", "html", "id"]);
    const document =
      new JSDOM(`<button class="b3-list-item b3-list-item--two">${entry.html}</button>`).window.document;
    const button = document.querySelector("button")!;
    assert.equal(button.children.length, 1);
    const row = button.firstElementChild!;
    assert.equal(row.className, "b3-list-item__first");
    assert.equal(row.children.length, 2);
    assert.equal(row.children[0]!.classList.contains("b3-list-item__graphic"), true);
    assert.equal(row.children[1]!.classList.contains("b3-list-item__text"), true);
    assert.equal(
      row.querySelector("use")!.getAttribute("xlink:href"),
      i === 0 ? "#icon-siyuan-link-cards-card" : "#icon-siyuan-link-cards-embed",
    );
    assert.equal(row.children[1]!.textContent, i === 0 ? english.insertCardAction : english.embedCommand);
  }
  assert.ok(!h.instance.protyleSlash[0]!.html.includes("(/"));
});
test("one toolbar action preserves supplied selection/caret range and original target in shared workflow", () => {
  const h = registration();
  const toolbar = h.instance.updateProtyleToolbar([]);
  assert.equal(toolbar.length, 1);
  const action = toolbar[0]!;
  assert.equal(action.icon, "icon-siyuan-link-cards-card");
  assert.equal(action.tip, english.insertCardAction);
  assert.equal(h.instance.updateProtyleToolbar(toolbar).length, 1);
  const range = { startContainer: {} } as Range, block = {} as HTMLElement;
  const protyle = { protyle: { toolbar: { range } }, hasClosestBlock: () => block } as unknown as Protyle;
  action.click!(protyle);
  assert.equal(h.captures[0]![0], protyle);
  assert.equal(h.captures[0]![1], block);
  assert.equal(h.captures[0]![4], range);
  assert.equal(h.opens[0]![0], h.targets[0]);
  assert.equal((h.opens[0]![5] as { kind: string; }).kind, "bookmark");
  assert.equal(h.requests(), 0);
  h.instance.onunload();
  assert.equal(h.instance.updateProtyleToolbar([]).length, 0);
  for (const flags of [[true, false], [false, true]]) {
    assert.equal(
      registration(false, ...flags as [boolean, boolean]).instance.updateProtyleToolbar([]).length,
      0,
    );
  }
});

test("migration is registered once in commands and absent from slash and toolbar", () => {
  const h = registration();
  assert.equal(h.instance.commands.filter(command => command.langKey === "migrationCommand").length, 1);
  assert.equal(
    h.instance.protyleSlash.some(entry =>
      /migration|migrate/i.test(entry.id + entry.html + entry.filter.join(" "))
    ),
    false,
  );
  const toolbar = h.instance.updateProtyleToolbar([]);
  assert.deepEqual(Array.from(toolbar, item => item.name), ["slc-insert-card"]);
});

test("both approved SVGs retain every root and geometry attribute as namespaced symbols", () => {
  const h = registration();
  assert.equal(h.icons.length, 2);
  for (
    const [id, file] of [["icon-siyuan-link-cards-card", "icon-link-card.svg"], [
      "icon-siyuan-link-cards-embed",
      "icon-embed.svg",
    ]] as const
  ) {
    const original = new JSDOM(readFileSync(new URL(`../src/icons/${file}`, import.meta.url), "utf8"), {
      contentType: "image/svg+xml",
    }).window.document.documentElement;
    const symbol = h.document.getElementById(id)!;
    assert.equal(symbol.localName, "symbol");
    assert.equal(symbol.namespaceURI, "http://www.w3.org/2000/svg");
    assert.deepEqual(
      Array.from(symbol.attributes, attr => [attr.name, attr.value]).filter(([name]) => name !== "id"),
      Array.from(original.attributes, attr => [attr.name, attr.value]),
    );
    const shapes = (element: Element) =>
      Array.from(
        element.children,
        child => ({
          tag: child.localName,
          namespace: child.namespaceURI,
          attributes: Array.from(child.attributes, attr => [attr.name, attr.value]),
        }),
      );
    assert.deepEqual(shapes(symbol), shapes(original));
    assert.equal(h.document.querySelectorAll(`#${id}`).length, 1);
  }
  assert.equal(source.includes("iconPreview"), false);
  assert.equal(source.includes("iconHTML5"), false);
  for (const flags of [[true, false], [false, true]]) {
    assert.equal(registration(false, ...flags as [boolean, boolean]).icons.length, 0);
  }
});
test("both symbols register exactly once and recover independently on reload", () => {
  const h = registration();
  h.instance.onload();
  assert.equal(h.icons.length, 2);
  assert.equal(h.document.querySelectorAll("svg[data-name=\"siyuan-link-cards\"]").length, 1);
  for (const [i, id] of ["icon-siyuan-link-cards-embed", "icon-siyuan-link-cards-card"].entries()) {
    h.document.getElementById(id)!.remove();
    h.instance.onload();
    assert.equal(h.icons.length, 3 + i);
    for (const symbol of ["icon-siyuan-link-cards-card", "icon-siyuan-link-cards-embed"]) {
      assert.equal(h.document.querySelectorAll(`#${symbol}`).length, 1);
    }
  }
  h.document.querySelector("svg[data-name=\"siyuan-link-cards\"]")!.remove();
  h.instance.onload();
  assert.equal(h.icons.length, 6);
  for (const id of ["icon-siyuan-link-cards-card", "icon-siyuan-link-cards-embed"]) {
    assert.equal(h.document.querySelectorAll(`#${id}`).length, 1);
  }
});

test("legacy YouTube command is plugin-wide once, shares migration exclusion and keeps slash/toolbar unchanged", () => {
  const h = registration();
  const command = h.instance.commands.find(c => c.langKey === "youtubeMigrationCommand")!;
  assert.equal(h.instance.commands.filter(c => c.langKey === "youtubeMigrationCommand").length, 1);
  const context = {
    protyle: { disabled: false, getInstance: () => ({ protyle: { lute: {} } }) },
  } as unknown as Parameters<NonNullable<typeof command.execute>>[0];
  assert.equal(command.enabled!(context), true);
  command.execute!(context);
  command.execute!(context);
  h.instance.commands.find(c => c.langKey === "migrationCommand")!.execute!(context);
  assert.equal(h.migrations.length, 1);
  assert.equal(command.enabled!(context), false);
  assert.equal(h.instance.protyleSlash.length, 2);
  assert.equal(h.instance.updateProtyleToolbar([]).length, 1);
  assert.ok(!h.instance.protyleSlash.some(c => /migration/i.test(c.id + c.html)));
  assert.equal(h.requests(), 0);
  h.instance.onunload();
  assert.equal(h.closed(), 1);
  for (const frontend of ["mobile", "browser-mobile", "unknown"]) {
    const blocked = registration(false, false, false, frontend);
    const c = blocked.instance.commands.find(c => c.langKey === "youtubeMigrationCommand")!;
    assert.equal(c.enabled!(context), false);
    c.execute!(context);
    assert.equal(blocked.migrations.length, 0);
  }
});

test("favicon maintenance is one plugin-wide command, mutually exclusive with migrations; no slash/toolbar action", () => {
  const h = registration();
  const command = h.instance.commands.find(c => c.langKey === "faviconRepairCommand")!;
  assert.equal(h.instance.commands.filter(c => c.langKey === "faviconRepairCommand").length, 1);
  const context = {
    protyle: { disabled: false, getInstance: () => ({ protyle: { lute: {} } }) },
  } as unknown as Parameters<NonNullable<typeof command.execute>>[0];
  assert.equal(command.enabled!(context), true);
  command.execute!(context);
  command.execute!(context);
  for (const key of ["migrationCommand", "youtubeMigrationCommand"]) {
    const c = h.instance.commands.find(c => c.langKey === key)!;
    assert.equal(c.enabled!(context), false);
    c.execute!(context);
  }
  assert.equal(h.migrations.length, 1);
  assert.equal(h.requests(), 0);
  assert.equal(h.instance.protyleSlash.length, 2);
  assert.equal(h.instance.updateProtyleToolbar([]).length, 1);
  h.instance.onunload();
  assert.equal(h.closed(), 1);
});

test("maintenance labels use the native single Link Cards prefix with exact DE/EN names and unchanged IDs", () => {
  const ids = ["migrationCommand", "youtubeMigrationCommand", "faviconRepairCommand"];
  for (
    const [language, displayName, names] of [
      [german, manifest.displayName["de-DE"], [
        "Link Cards: Legacy-Link-Karten migrieren…",
        "Link Cards: Alte YouTube-Einbettungen migrieren…",
        "Link Cards: Fehlende Favicons ergänzen…",
      ]],
      [english, manifest.displayName.default, [
        "Link Cards: Migrate legacy Link Cards…",
        "Link Cards: Migrate legacy YouTube embeds…",
        "Link Cards: Repair missing favicons…",
      ]],
    ] as const
  ) {
    const h = registration(false, false, false, "browser-desktop", language);
    const commands = h.instance.commands.filter(command => ids.includes(command.langKey));
    assert.equal(commands.length, 3);
    assert.deepEqual(commands.map(command => command.langKey), ids);
    // Current host supplies `${plugin.displayName}: ${command.langText}` and searches the localized label.
    const labels = commands.map(command => `${displayName}: ${command.langText}`);
    assert.deepEqual(labels, Array.from(names));
    assert.equal(new Set(labels).size, 3);
    for (const label of labels) assert.equal(label.split("Link Cards:").length - 1, 1);
    assert.equal(
      labels.some(label =>
        /Card-Link|SiYuan Link Cards:|missing Link Card favicons|Link-Card-Favicons/.test(label)
      ),
      false,
    );
    assert.equal(h.instance.commands.length, 4); // Existing insertion command is independent.
    assert.equal(h.requests(), 0);
    assert.equal(h.migrations.length, 0);
    assert.equal(
      language.faviconRepairCommand,
      language === german ? "Fehlende Link-Card-Favicons ergänzen…" : "Repair missing Link Card favicons…",
    );
  }
});

test("each unchanged maintenance callback opens its own existing dialog; close releases the shared slot", () => {
  for (
    const [key, kind] of [["migrationCommand", "bookmark"], ["youtubeMigrationCommand", "youtube"], [
      "faviconRepairCommand",
      "favicon",
    ]] as const
  ) {
    const h = registration(), command = h.instance.commands.find(c => c.langKey === key)!;
    const context = {
      protyle: { disabled: false, getInstance: () => ({ protyle: { lute: {} } }) },
    } as unknown as Parameters<NonNullable<typeof command.execute>>[0];
    command.execute!(context);
    assert.equal((h.migrations[0]![0] as { kind: string; }).kind, kind);
    assert.deepEqual(h.migrations[0]![2], localizedStrings(english));
    assert.equal(command.enabled!(context), false);
    (h.migrations[0]![3] as () => void)();
    assert.equal(command.enabled!(context), true);
    assert.equal(h.requests(), 0);
  }
});
