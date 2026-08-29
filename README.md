# proPotsdamMCP

![ProPotsdam MCP banner](proPotsdamMCPBanner.png)

Unofficial local MCP server for the ProPotsdam/Easysquare customer portal, STEP bulky-waste pickup, and Potsdam abandoned-waste reports.

It runs on your Mac, talks MCP over stdio, stores your portal password in the macOS Keychain, and exposes portal data to Codex through read-first tools. ProPotsdam, STEP, and Potsdam writes all use one explicit conversational-approval model. All write support should be treated as experimental.

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

For the normal ProPotsdam portal, credential setup does not need a base URL. Local config, session cookies, traces, shared pending actions and their short-lived staged attachments or normalized report photos, and MCP-created exports live under:

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
npx -y propotsdam-cli actions send cmdsend --attachment-file ./schaden.jpg --value msg_txt="Deckel defekt" --value TOPIC_IW_...="Abfallbehälter"
npx -y propotsdam-cli actions send save_partner --value phone_ref="+491234567"
npx -y propotsdam-cli writes list --domain repair_report
```

Human output uses compact tables for lists and readable detail sections for single records. Add `--json` to get redacted machine-readable output using the underlying client result shape, for example `{ "items": [...], "source": "boxlist" }`.

TTY sessions can guide missing ids and write fields with prompts. Non-interactive prepare-only runs never prompt; pass ids and values explicitly with `--value key=value`, `--values-json '{"key":"value"}'`, or `--values-file values.json`. `actions send` is deliberately interactive: it stages the immutable write, displays the exact diff, asks `Send this exact change to ProPotsdam? [y/N]`, commits on yes, and cancels on no. It refuses non-TTY use and provides no `--yes` bypass. For repair photos, pass a local JPEG/PNG path with `--attachment-file <path>`; the client stages a private hashed copy only when the portal form exposes a supported upload endpoint.

Live ProPotsdam commits are intentionally limited. This version can commit only exact `Meine Daten`/`save_partner` profile changes and detail-based `Reparatur`/`cmdsend` damage reports. MCP clients first stage a ten-minute immutable pending action, show its exact review, stop, and wait for a new user message. The user can then approve naturally—for example, “yes, send it” or “ja, abschicken”—without seeing or copying an internal handle. Ambiguous assent such as “looks good” is not approval, and changed instructions require a newly staged review.

The LLM or MCP host is the conversational approval trust boundary: the server cannot inspect the chat or independently prove that approval occurred. There is no global write-enable switch. A visual approval control may only create a normal, visible user-authored message; it must never call the commit tool directly. The server still binds each approved draft to its exact destination, remote contract, values, and artifact hashes; atomically consumes it once; and does not retry after a possible dispatch. MCP annotations are advisory hints, not authorization enforcement. All other discovered ProPotsdam write domains remain draft-only until their exact portal contracts pass the release gate in [the write-safety PRD](docs/prd-safe-write-coverage.md).

## Bulky and abandoned waste

The MCP has two separate domain workflows that share the same pending-action queue and conversational approval boundary:

- Use STEP pickup for items you are disposing of yourself, for example: “Prepare a bulky-waste pickup for one bed from my contract address, available from 2026-08-20.”
- Use the Potsdam abandoned-waste report for an existing pile whose owner is unknown, for example: “Prepare an abandoned-waste report for the pile at my contract address using `/path/to/photo.jpg`.”

Contact and address fields may be derived from one unambiguous, high-confidence ProPotsdam contract. Explicit values always win. Multiple contract addresses are returned as choices instead of being guessed.

Preparation never creates the external request or a pending action. A complete draft is staged for ten minutes, shown in full, and committed through `propotsdam_commit_pending_writes` only after explicit approval in a new user message. Internal handles stay hidden from people. The shared list and cancel tools work across ProPotsdam, STEP, and Potsdam actions, including explicitly approved mixed batches and named subsets. STEP returns `request_received`; the actual collection date may follow later. Guest Potsdam reports return `awaiting_email_confirmation` and require activation through the email sent by the city.

If a final network response cannot be verified, the item returns `outcome: "outcomeUncertain"` and consumes the pending action. Do not retry automatically; first check for the STEP response or Potsdam activation email to avoid a duplicate request.

Abandoned-waste report descriptions, locations, and photos may become public. This warning is repeated prominently in every staged review. Photos are normalized to metadata-free JPEG before staging; JPEG, PNG, and static WebP inputs are supported, while GIF, HEIC, and HEIF require conversion first.

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
- `propotsdam_stage_portal_action`
- `propotsdam_list_pending_writes`
- `propotsdam_cancel_pending_writes`
- `propotsdam_commit_pending_writes`
- `propotsdam_prepare_bulky_waste_pickup`
- `propotsdam_stage_bulky_waste_pickup`
- `propotsdam_prepare_abandoned_waste_report`
- `propotsdam_stage_abandoned_waste_report`

## Development

```bash
npm ci
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
