# ProPotsdam MCP

Lokaler MCP-Server fuer das ProPotsdam/Easysquare-Kundenportal. Die erste Version ist macOS-first, nutzt die Apple Keychain fuer Zugangsdaten und stellt read-only Portalwerkzeuge plus lokale Dokument-Downloads bereit.

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

Das Passwort wird in der Apple Keychain unter dem Service `propotsdam-mcp` gespeichert. Lokale Config, Session-Cookies, Traces und Downloads liegen unter:

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
- `propotsdam_list_inbox`
- `propotsdam_get_inbox_item`
- `propotsdam_list_documents`
- `propotsdam_download_document`

## Account-Capability-Map

```bash
npm run discover -- --json
```

Der Discovery-Lauf meldet die sichtbaren Portal-Services, erkannte Bereiche, Boxlist-Verfuegbarkeit, Item-Zaehler und Download-Faehigkeiten. Ein redigierter Report wird zusaetzlich unter `~/Library/Application Support/propotsdam-mcp/traces/` abgelegt.

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
