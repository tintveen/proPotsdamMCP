# Security Policy

ProPotsdam MCP is a local, unofficial integration for the ProPotsdam/Easysquare customer portal. It handles sensitive portal data, session cookies, and account credentials, so security reports should avoid public disclosure of private tenant or account details.

## Reporting a Vulnerability

Please do not open a public issue that contains passwords, session cookies, CSRF tokens, portal traces, exported account data, screenshots with personal information, or live customer records.

Use [GitHub private vulnerability reporting](https://github.com/tintveen/proPotsdamMCP/security/advisories/new). Do not include sensitive details in a public issue. Include:

- A short description of the issue.
- The affected version or commit.
- Reproduction steps using fake or redacted data.
- The expected impact.

## Supported Versions

This project is pre-1.0. Security fixes are handled only on the current `0.4.x` line and `main` unless a release branch is explicitly documented. Version `0.3.0` remains installable but is no longer supported.

## Local Sensitive Data

By default, the password is stored in the macOS Keychain under the `propotsdam-mcp` service. Local config, session cookies, traces, shared pending actions and their temporary staged attachments or normalized report photos, and exports live under:

```text
~/Library/Application Support/propotsdam-mcp/
```

Remove or redact this data before sharing logs, traces, test fixtures, or issue details.

Every pending action can be claimed only during its ten-minute review window and is stored in a versioned HMAC envelope bound to its kind, destination, reviewed payload, remote contract, and artifact hashes. Records persist safely across restarts and transition atomically from `staged` to `claimed`. Maintenance cannot remove an active in-process claim; after a restart, an abandoned claim becomes cleanup-eligible only after a separate ten-minute stale-claim window. Portal actions additionally remain bound to the authenticated account, target, values, and form contract, and ordinary transport methods reject portal writes without a claimed action's internal permit. The LLM or MCP host—not the MCP server—is responsible for showing the full review, yielding, and waiting for explicit conversational approval before calling the destructive generic commit tool. A UI may create a visible user-authored approval message but may not call commit directly. Tool annotations are advisory and do not independently enforce consent. Once a state-changing request may have been dispatched, the server consumes the pending action and never retries it automatically.

## External Waste Services

STEP pickup requests transmit contact details, the contact and pickup addresses, item details, and scheduling notes to Stadtentsorgung Potsdam. Potsdam abandoned-waste reports transmit coordinates, a description, contact details, and one to three photos; report locations, descriptions, and photos may later be visible publicly.

External form sessions use separate, origin-pinned cookie jars. Easysquare cookies, CSRF values, credentials, and headers must never be forwarded to STEP, Potsdam, or the geocoding service. Hidden external form values and raw response bodies must not be logged or returned through MCP.

External writes use the same hidden pending-action handles as ProPotsdam portal writes; there is no separate confirmation-id API. Abandoned-waste photos are decoded with resource limits, auto-oriented, resized when needed, and re-encoded as metadata-free JPEG. The exact normalized files are stored beneath their pending handle with private filesystem permissions and removed after commit, cancellation, expiry, failed staging, or invalid-record cleanup.

If an external write has an ambiguous network outcome, the pending action remains consumed and the client does not retry automatically. Check for the STEP response or Potsdam activation email before staging a replacement request.
