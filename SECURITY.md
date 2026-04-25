# Security Policy

ProPotsdam MCP is a local, unofficial integration for the ProPotsdam/Easysquare customer portal. It handles sensitive portal data, session cookies, and account credentials, so security reports should avoid public disclosure of private tenant or account details.

## Reporting a Vulnerability

Please do not open a public issue that contains passwords, session cookies, CSRF tokens, portal traces, exported account data, screenshots with personal information, or live customer records.

If this repository is still private, contact the maintainer through the existing private channel. If it is public, use GitHub private vulnerability reporting or a private security advisory when available. Include:

- A short description of the issue.
- The affected version or commit.
- Reproduction steps using fake or redacted data.
- The expected impact.

## Supported Versions

This project is pre-1.0. Security fixes are handled on the current mainline version unless a release branch is explicitly documented.

## Local Sensitive Data

By default, the password is stored in the macOS Keychain under the `propotsdam-mcp` service. Local config, session cookies, traces, confirmations, and exports live under:

```text
~/Library/Application Support/propotsdam-mcp/
```

Remove or redact this data before sharing logs, traces, test fixtures, or issue details.
