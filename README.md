# ProPotsdam MCP

Lokaler MCP-Server fuer das ProPotsdam/Easysquare-Kundenportal. Die erste Version ist macOS-first, nutzt die Apple Keychain fuer Zugangsdaten und stellt read-only Werkzeuge fuer auslesbare Portal-Daten sowie prepare-only Werkzeuge fuer Portal-Aktionsentwuerfe bereit.

## Installation

```bash
npm install
npm run build
```

## Credentials einrichten

```bash
npm run build
npm run auth:set
```

`auth:set` fragt nur Benutzername und Passwort ab. Fuer ProPotsdam wird die Standard-Base-URL verwendet; ein Override ist nur fuer Debug/Advanced-Faelle noetig:

```bash
npm run auth:set -- --base-url https://portal.example.test
```

Das Passwort wird in der Apple Keychain unter dem Service `propotsdam-mcp` gespeichert. Lokale Config, Session-Cookies, Traces und MCP-erzeugte Exporte liegen unter:

```text
~/Library/Application Support/propotsdam-mcp/
```

## MCP starten

```bash
propotsdam-mcp serve
```

Der Server spricht MCP ueber stdio und bietet diese Tools:

- `propotsdam_auth_status`
- `propotsdam_auth_login`
- `propotsdam_auth_logout`
- `propotsdam_discover_capabilities`
- `propotsdam_discover_write_actions`
- `propotsdam_list_inbox`
- `propotsdam_get_inbox_item`
- `propotsdam_list_portal_records`
- `propotsdam_get_portal_record`
- `propotsdam_list_portal_actions`
- `propotsdam_get_portal_action`
- `propotsdam_prepare_portal_action`

## Account-Capability-Map

```bash
npm run discover -- --json
```

Der Discovery-Lauf meldet die sichtbaren Portal-Services, erkannte Bereiche, Boxlist-Verfuegbarkeit, Item-Zaehler und lesbare Portal-Daten. Ein redigierter Report wird zusaetzlich unter `~/Library/Application Support/propotsdam-mcp/traces/` abgelegt. ProPotsdam stellt in der aktuellen Account-Abbildung keine bestaetigte Datei-Freigabe als eigene Portal-Funktion dar; lokale Dateien waeren MCP-erzeugte Exporte aus bereits auslesbaren Daten.

## Portal-Aktionen

```bash
npm run build
node dist/cli.js actions --json
```

Die Action-Map meldet Portal-Oberflaechen, die nach Zustand veraendernden Formularen oder Aktionen aussehen. Dafuer werden neben Boxlists auch lesbare Detail-Formulare geprueft, zum Beispiel `Meine Daten` mit `save_partner`. `propotsdam_prepare_portal_action` erzeugt nur einen lokalen Entwurf zur Pruefung, uebernimmt nur bekannte editierbare Felder und meldet gesperrte oder unbekannte Felder als Validierungsproblem.

Echte Portal-Schreibvorgaenge sind in dieser Version auf `Meine Daten` / `save_partner` begrenzt. Dafuer gilt ein zweistufiger MCP-Flow: `propotsdam_request_portal_action_commit` erzeugt eine kurzlebige Confirmation mit Diff und sendet nichts; erst `propotsdam_commit_portal_action` mit dieser Confirmation-ID fuehrt den Schreibvorgang aus. Alle anderen Aktionen bleiben prepare-only.

## Entwicklung

```bash
npm run check
npm run build
npm test
```

Live-Read-Pass gegen ein echtes Konto:

```bash
PROPPOTSDAM_LIVE_TEST=1 npm run test:live
```
