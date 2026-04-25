# proPotsdamMCP

![ProPotsdam MCP banner](proPotsdamMCPBanner.png)

Unofficial local MCP server for the ProPotsdam/Easysquare customer portal.

It runs on your Mac, talks MCP over stdio, stores your portal password in the macOS Keychain, and exposes portal data to Codex through read-first tools. Limited write support is guarded by an explicit confirmation flow and should be treated as experimental.

[![CI](https://github.com/tintveen/proPotsdamMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/tintveen/proPotsdamMCP/actions/workflows/ci.yml)

## Install

Add it to Codex:

```bash
codex mcp add propotsdam -- npx -y propotsdam-mcp serve
```

Store your portal credentials once:

```bash
npx -y propotsdam-mcp auth set
```

Requirements: Node.js 22+, npm/npx, macOS Keychain, and a ProPotsdam/Easysquare account.

For the normal ProPotsdam portal, credential setup does not need a base URL. Local config, session cookies, traces, confirmations, and MCP-created exports live under:

```text
~/Library/Application Support/propotsdam-mcp/
```

## Tools

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
- `propotsdam_request_portal_action_commit`
- `propotsdam_commit_portal_action`

## Development

```bash
npm install
npm run build
npm run auth:set
node dist/cli.js serve
```

Before publishing:

```bash
npm run release:check
```

`npm pack` and `npm publish` run `npm run build` first through `prepack`, so the published CLI includes fresh `dist/` output.

## Security

Passwords are stored in the macOS Keychain under the `propotsdam-mcp` service. Do not share portal credentials, session cookies, CSRF tokens, raw traces, screenshots with personal data, or exported account data in public issues.

See [SECURITY.md](SECURITY.md) and [docs/security-check.md](docs/security-check.md).
