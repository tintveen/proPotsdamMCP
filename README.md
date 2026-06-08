# proPotsdamMCP

![ProPotsdam MCP banner](proPotsdamMCPBanner.png)

Unofficial local MCP server for the ProPotsdam/Easysquare customer portal.

It runs on your Mac, talks MCP over stdio, stores your portal password in the macOS Keychain, and exposes portal data to Codex through read-first tools. Limited write support is guarded by an explicit confirmation flow and should be treated as experimental.

[![CI](https://github.com/tintveen/proPotsdamMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/tintveen/proPotsdamMCP/actions/workflows/ci.yml)

## Install

Add it to Codex:

```bash
codex mcp add proPotsdam -- npx -y propotsdam-mcp serve
```

If you previously installed the MCP server as `propotsdam`, re-add it under the display-correct name:

```bash
codex mcp remove propotsdam
codex mcp add proPotsdam -- npx -y propotsdam-mcp serve
```

Restart Codex afterward so the tool namespace refreshes.

Store your portal credentials once:

```bash
npx -y propotsdam-cli auth set
```

Requirements: Node.js 22+, npm/npx, macOS Keychain, and a ProPotsdam/Easysquare account.

For the normal ProPotsdam portal, credential setup does not need a base URL. Local config, session cookies, traces, confirmations, and MCP-created exports live under:

```text
~/Library/Application Support/propotsdam-mcp/
```

## CLI

The package publishes two commands that share the same local credentials and data directory:

- `propotsdam-mcp serve` starts the MCP server.
- `propotsdam-cli` is the terminal and agent-friendly CLI.

Both binaries accept the same commands. Running either one without arguments prints help; the MCP server is started only with `serve`.

```bash
npx -y propotsdam-cli auth status
npx -y propotsdam-cli inbox list
npx -y propotsdam-cli records list --domain repair_status
npx -y propotsdam-cli records raw get REC-1 --json
npx -y propotsdam-cli files export REC-1 --output-dir /tmp/propotsdam-exports
npx -y propotsdam-cli actions list --kind form
npx -y propotsdam-cli actions prepare DMG-NEW --value description="Heizung bleibt kalt"
npx -y propotsdam-cli actions request-commit save_partner --value phone_ref="+491234567"
npx -y propotsdam-cli actions commit <confirmation-id>
npx -y propotsdam-cli writes list --domain repair_report
```

Human output uses compact tables for lists and readable detail sections for single records. Add `--json` to get redacted machine-readable output using the underlying client result shape, for example `{ "items": [...], "source": "boxlist" }`.

TTY sessions can guide missing ids and write fields with prompts. Non-interactive runs never prompt; pass ids and values explicitly with `--value key=value`, `--values-json '{"key":"value"}'`, or `--values-file values.json`.

German aliases are available for common groups:

- `posteingang` for `inbox`
- `dateien` for `files`
- `aktionen` for `actions`

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
- `propotsdam_list_portal_files`
- `propotsdam_export_portal_file`
- `propotsdam_list_structured_portal_records`
- `propotsdam_get_structured_portal_record`
- `propotsdam_list_portal_actions`
- `propotsdam_get_portal_action`
- `propotsdam_list_portal_write_capabilities`
- `propotsdam_prepare_portal_write`
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
