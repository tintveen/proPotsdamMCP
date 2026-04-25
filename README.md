# ProPotsdam MCP

Lokaler MCP-Server fuer das ProPotsdam/Easysquare-Kundenportal. Die erste Version ist macOS-first, nutzt die Apple Keychain fuer Zugangsdaten und stellt read-only Portalwerkzeuge plus lokale Dokument-Downloads bereit.

## Installation

```bash
npm install
npm run build
```

## Credentials einrichten

```bash
propotsdam-mcp auth set
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
- `propotsdam_list_inbox`
- `propotsdam_get_inbox_item`
- `propotsdam_list_documents`
- `propotsdam_download_document`

## Entwicklung

```bash
npm run check
npm run build
npm test
```
