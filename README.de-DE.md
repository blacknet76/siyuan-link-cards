# SiYuan Link Cards

[English](README.md)

Passive Rich Link Cards und native YouTube-Einbettungen in SiYuan. Bookmark-Karten und unterstützte
oEmbed-Link-/Foto-Karten teilen ein responsives Design und speichern Metadaten im Dokument.
Link Card erzeugt einen passiven Snapshot, Embed ein unterstütztes abspielbares YouTube-Video.

![Drei aktuelle passive Link-Karten im hellen Design](docs/screenshots/link-cards-light.png)

## Funktionen

- Ein responsives passives Kartendesign für Bookmarks einschließlich YouTube-URLs und oEmbed-Links/-Fotos.
- Native responsive YouTube-Einbettungen aus normalen Video-URLs; kein iframe-HTML zum Kopieren.
- Optionale Beschreibung, Vorschaubild und Website-/Anbieteridentität, in Hell und Dunkel.
- Bookmark- und Embed-Einfügung über zwei Slashaktionen und eine Link-Card-Aktion in der Auswahltoolbar.
- Deutsche und englische Oberfläche, URL-Vorbelegung und natives Undo/Redo.
- Gespeichertes JSON bleibt bei deaktiviertem Plugin lesbar.

![Dieselben drei passiven Link-Karten im dunklen Design](docs/screenshots/link-cards-dark.png)

## Link Cards erstellen

`/linkcard`, `/bookmark` oder `/card` eingeben, **Link-Karte einfügen** wählen, URL prüfen und
**Einfügen** klicken. Das Plugin liest Metadaten aus Open Graph, Twitter oder HTML. Eine URL auswählen
und die Link-Card-Toolbaraktion oder **Link Cards: Lesezeichenkarte einfügen** in der Befehlspalette
verwenden, um die Vorbelegung zu erhalten. Im selben Dialog kann zwischen **Lesezeichenkarte** und
**Einbettung** gewechselt werden, ohne die URL zu verlieren. Abbrechen fügt nichts ein. Falls Metadaten
nicht aufgelöst werden können, lässt sich ausdrücklich eine einfache Karte mit URL und Hostname wählen.

![Einfügedialog mit URL und Typauswahl](docs/screenshots/insert-dialog.png)

## Embed mit oEmbed und YouTube

`/embed` oder `/oembed` öffnet den gemeinsamen Dialog mit gewählter **Einbettung**. Eine unterstützte
normale YouTube-URL wird geprüft und als nativer SiYuan-iframe-Block mit responsiver 16:9-Größe
eingefügt. SiYuan übernimmt den Player; neue Einbettungen erzeugen keine Plugin-Videokarte und
keinen **Video laden**-Schritt. Aktive Videoeinbettung ist **ausschließlich für YouTube** unterstützt.
Anbieter-HTML wird nicht ausgeführt.

Unterstützte Quellen sind HTTPS `youtube.com/watch?v=ID`, `www.youtube.com/watch?v=ID` und `youtu.be/ID`.
Du musst kein iframe-HTML beschaffen oder einfügen. Quellparameter werden nicht in die Player-URL
kopiert. Shorts-, Live- und Playlist-Links werden nicht unterstützt. Für nicht unterstützte Inhalte/
Frontends gibt es den ausdrücklichen **Lesezeichenkarten**-Fallback; keine automatische Konvertierung.

Dieselbe YouTube-URL über `/card`, `/bookmark` oder `/linkcard` erzeugt eine normale **passive Link Card**.
Sichere JSON-oEmbed-**Link**-/**Foto**-Ergebnisse bleiben ebenfalls passive Karten statt nativer iframes.

![Native SiYuan-YouTube-Einbettung über /embed](docs/screenshots/youtube-preview.png)

## Lokale Vorschaumedien

Alle passiven Karten zeigen das echte Seitenfavicon, wenn verfügbar, sonst eine neutrale Weltkugel.
Bilder neuer Bookmark-Karten und Favicons passiver Karten werden nach Möglichkeit als SiYuan-Assets importiert.
PNG, JPEG und WebP sind unterstützt; nicht unterstützte Medien oder fehlgeschlagene optionale Imports
werden ausgelassen, ohne die Karte zu verhindern. Rendering aktualisiert keine Metadaten und importiert keine Assets. Dateien können
zwischen Karten geteilt werden und bleiben nach Undo oder Kartenlöschung erhalten; für ungenutzte
Dateien die normale Assetverwaltung von SiYuan verwenden.

## Datenschutz und Netzwerkverhalten

- Seitenmetadaten werden erst nach **Einfügen** oder ausdrücklich bestätigter Favicon-Ergänzung abgerufen. Rendering aktualisiert sie nicht.
- Neue Bookmark-Medien werden nach Möglichkeit lokalisiert. Bestehende Remote-Snapshots bleiben
  kompatibel; deren Bilder, oEmbed-Fotos und YouTube-Thumbnails können beim Rendering externe Hosts kontaktieren.
- Neue native YouTube-Einbettungen können bei jedem Rendern oder Wiederladen des Blocks YouTube
  kontaktieren, bereits vor Play. **Einbettung** wählt diesen aktiven Inhalt; für einen passiven
  Metadatensnapshot **Lesezeichenkarte** wählen. Kein Autoplayparameter wird hinzugefügt.
- Bestehende video-v1-Karten behalten den **Video laden**-Schritt; Thumbnails können vorher laden.
- Kein beliebiges Anbieter-iframe-HTML, Script oder srcdoc wird eingefügt.
- Keine automatische Paste-Konvertierung und kein Metadaten-Crawler im Hintergrund.

Vertrauenswürdige Links verwenden. Netzwerkverfügbarkeit und Zugriffsbeschränkungen hängen von
SiYuan und dem Anbieter ab.

## Kompatibilität und Grenzen

Benötigt **SiYuan 3.8.3+**. Mobile-, Export- und verschlüsselte Notebookabläufe sind nicht verifiziert.
Nur angekündigtes JSON-oEmbed ist unterstützt; XML, rich HTML und andere Videoanbieter nicht.
Die native Auswahltoolbar erscheint bei markiertem Text; bei reinem Caret die Befehlspalette verwenden.
Metadaten sind ein gespeicherter Snapshot, keine Live-Seitenansicht.

Bestehende Videokarten behalten ihre Vorschau mit **Video laden** und werden nicht automatisch umgeschrieben.

## Installation

`package.zip` aus einem veröffentlichten [GitHub Release](https://github.com/blacknet76/siyuan-link-cards/releases)
laden. Den Inhalt direkt nach `data/plugins/siyuan-link-cards/` im eigenen Workspace entpacken,
dann **Link Cards** unter **Einstellungen → Marktplatz → Heruntergeladen** aktivieren. Nach einem
Update SiYuan neu laden. Sobald gelistet, ist auch die Installation über den Marktplatz möglich.

## Wartung

Ältere oder migrierte Karten können vor dem Faviconimport entstanden sein. In einem bearbeitbaren
Dokument **Link Cards: Fehlende Favicons ergänzen…** in der Befehlspalette wählen. Die Zählervorschau
ist lokal und schreibgeschützt; erst ausdrückliche Bestätigung kontaktiert gespeicherte Quellwebsites
und ergänzt fehlende oder formal unbrauchbare Favicons. Bestehende Favicons und alle anderen
Metadaten bleiben erhalten.

## Legacy-Migration

Für kompatible historische `embed`-Link-Card-Codeblöcke ein bearbeitbares Dokument fokussieren und
**Link Cards: Legacy-Link-Karten migrieren…** in der Befehlspalette wählen. Den Workspace-Scan prüfen und ausdrücklich bestätigen. Unbekannte oder
mehrdeutige Formate werden übersprungen; optionale nicht unterstützte Medien können entfallen.
Die Migration erhält Block-IDs und nutzt gespeicherte Titel und Beschreibungen ohne Aktualisierung
der Seitenmetadaten. Erst nach Bestätigung können gespeicherte Medien für den lokalen Import
heruntergeladen werden. Natives Undo gilt je Karte innerhalb der temporären SiYuan-History;
wichtige Notizen vor der Migration sichern. Es gibt keine automatische Migration.

Ältere unterstützte YouTube-Einbettungen lassen sich über **Link Cards: Alte YouTube-Einbettungen migrieren…**
in der Befehlspalette ausdrücklich in native SiYuan-Einbettungen umwandeln. Vorschau prüfen und
bestätigen; Blockidentität und natives Undo/Redo bleiben erhalten.

## Entwicklung

Benötigt Node.js 24+:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build:dev
npm run package
```

`npm run dev` beobachtet die Quellen und schreibt nach `dev/`. Produktionsbuilds erzeugen `dist/`
und `package.zip`. Buildausgaben bleiben in Git ignoriert; `package.zip` wird als GitHub-Release-Anhang
verteilt. Das Paket ist nicht zur Veröffentlichung auf npm vorgesehen.

## Lizenz

[MIT](LICENSE). Die [Drittanbieterhinweise](THIRD_PARTY_NOTICES.md) dokumentieren die
SiYuan-Buildkonventionen und Entwicklungsabhängigkeiten.
