# Pre-Publication Security Check

Review date: 2026-04-25

This repository was reviewed for GitHub publication readiness while keeping the repository private for now.

## Checks Performed

- Searched tracked and local project files for likely secrets, credentials, cookies, CSRF tokens, API keys, private keys, `.env` files, local databases, oversized artifacts, and generated build output.
- Confirmed `dist/`, `node_modules/`, coverage output, logs, and `.DS_Store` are ignored.
- Reviewed local storage behavior for config, session cookies, traces, exports, and action confirmations.
- Verified dependency status with `npm audit` and `npm audit --omit=dev`.
- Verified TypeScript and test health with `npm run check` and `npm test`.
- Checked packaging with `npm pack --dry-run`.

## Sensitive Local Paths

Runtime data is local by design and must not be committed or pasted into public issues:

```text
~/Library/Application Support/propotsdam-mcp/config.json
~/Library/Application Support/propotsdam-mcp/session.json
~/Library/Application Support/propotsdam-mcp/traces/
~/Library/Application Support/propotsdam-mcp/exports/
~/Library/Application Support/propotsdam-mcp/confirmations/
```

The portal password is stored through macOS Keychain using the service name `propotsdam-mcp`.

## Residual Risks

- Session cookies are stored locally in `session.json` so the MCP server can reuse authenticated sessions.
- Traces and exports may contain portal-derived personal or account data even when secret-like fields are redacted.
- Live tests require a real configured account and must stay opt-in through `PROPPOTSDAM_LIVE_TEST=1`.
- Public reports must never include portal credentials, cookies, CSRF tokens, screenshots with personal data, raw traces, or exported account data.

## Release Checklist

Before making the repository public or publishing an npm package:

- Run `npm run check`.
- Run `npm test`.
- Run `npm audit` and `npm audit --omit=dev`.
- Run `git diff --check`.
- Run `npm pack --dry-run` and confirm `src/` and `tests/` are not included.
- Review `git status --short` for accidental local files.
- Re-run a targeted secret scan after final edits.
