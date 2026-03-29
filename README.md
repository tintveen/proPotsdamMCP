# ProPotsdam CLI

Eine lokale TypeScript/Node-CLI für das ProPotsdam-Kundenportal mit interaktivem Browser-Login via Playwright.

## Voraussetzungen

- Node.js 22+
- Ein lokaler Chromium-Start muss möglich sein

## Installation

```bash
npm install
```

## Entwicklung

```bash
npm run check
npm run build
npm test
```

## Nutzung

```bash
node dist/src/cli.js auth login
node dist/src/cli.js auth status --json
node dist/src/cli.js inbox list --json
node dist/src/cli.js inbox get <id> --json
node dist/src/cli.js documents list --json
node dist/src/cli.js documents download <id> --out ./document.pdf
node dist/src/cli.js debug trace --seconds 30
```

## Architektur

- `src/auth`: Login, Logout, Session-Prüfung
- `src/transport`: HTTP-Probing und Request-Trace-Aufzeichnung
- `src/portal`: Fachlogik für Postfach, Dokumente und UI-/Trace-Extraktion
- `src/cli.ts`: Commander-basierte CLI

## Hinweise

- Es werden keine Passwörter gespeichert, nur Playwright-Session-State.
- Portal-Daten werden bevorzugt aus Netzwerkantworten extrahiert; UI-Scraping ist der Fallback.
- Falls das Portal andere Bezeichnungen für Dokumente oder Postfach nutzt, lassen sich die Aliase in der Profil-Datei im App-Datenverzeichnis anpassen.
