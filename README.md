# ProPotsdam MCP

Unofficial local MCP server for the ProPotsdam/Easysquare customer portal.

It runs on your machine, talks MCP over stdio, stores your portal password in the macOS Keychain, and exposes portal data to MCP clients through read-first tools. Limited write support is guarded by an explicit confirmation flow and should be treated as experimental.

```bash
npm install
npm run build
npm run auth:set
node dist/cli.js serve
```

## What It Does

- Authenticates against the ProPotsdam/Easysquare portal with credentials stored locally.
- Discovers visible portal services and readable account areas.
- Reads inbox items and portal records exposed by the current account.
- Prepares portal action drafts for review.
- Supports a limited confirmation-based commit flow for known safe write actions.

This project is macOS-first because it uses Apple Keychain through `keytar`.

## Requirements

- Node.js 22 or newer
- npm
- macOS Keychain access
- A ProPotsdam/Easysquare portal account

## Setup

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Store credentials:

```bash
npm run auth:set
```

The command asks for username and password. For the normal ProPotsdam portal, no base URL is needed. Advanced/debug usage can override it:

```bash
npm run auth:set -- --base-url https://portal.example.test
```

The password is stored in the macOS Keychain under the service name `propotsdam-mcp`. Local config, session cookies, traces, confirmations, and MCP-created exports live here:

```text
~/Library/Application Support/propotsdam-mcp/
```

## Run The MCP Server

From a local checkout:

```bash
node dist/cli.js serve
```

After linking or installing the package as a CLI, the binary is:

```bash
propotsdam-mcp serve
```

The server uses MCP over stdio, so configure your MCP client to run one of those commands.

## Discovery

Generate a capability report for the configured account:

```bash
npm run discover -- --json
```

The report describes visible portal services, recognized areas, boxlist availability, item counts, and readable portal data. A redacted trace is also written under:

```text
~/Library/Application Support/propotsdam-mcp/traces/
```

## Portal Actions

Inspect action-like portal surfaces:

```bash
npm run build
node dist/cli.js actions --json
```

Action handling is intentionally conservative. `propotsdam_prepare_portal_action` creates a local draft, accepts only known editable fields, and reports locked or unknown fields as validation problems.

Real portal writes are limited to supported actions such as `Meine Daten` / `save_partner`. They require two MCP steps: request a short-lived confirmation with a diff, then commit with the returned confirmation ID. Unsupported actions remain prepare-only.

<details>
<summary>MCP tools</summary>

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

</details>

## Security Notes

Do not share portal credentials, session cookies, CSRF tokens, raw traces, screenshots with personal data, or exported account data in public issues.

See [SECURITY.md](SECURITY.md) and [docs/security-check.md](docs/security-check.md) for the reporting policy and the pre-publication security checklist.

## Development

```bash
npm run check
npm run build
npm test
```

Live read tests are opt-in and require a real configured account:

```bash
PROPPOTSDAM_LIVE_TEST=1 npm run test:live
```

Before publishing or making the repository public, run:

```bash
npm run check
npm test
npm audit
npm audit --omit=dev
git diff --check
npm pack --dry-run
```

## License

MIT. See [LICENSE](LICENSE).
