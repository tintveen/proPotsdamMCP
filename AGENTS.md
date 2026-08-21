# Repository Instructions

## Environment
- Use Node.js 22 or newer.
- Install dependencies with `npm ci`.
- Build output is generated in `dist/` and must not be committed.
- For Codex Cloud live tasks, set:
  - `PROPPOTSDAM_USERNAME`
  - `PROPPOTSDAM_PASSWORD`
  - `PROPPOTSDAM_DATA_DIR=/tmp/propotsdam-mcp-codex`
  - optionally `PROPPOTSDAM_BASE_URL`

## Codex Cloud Environment
- Environment name: `proPotsdamMCP-live`
- Repository: `tintveen/proPotsdamMCP`
- Branch: `main`
- Runtime: Node.js 22
- Setup script:
  ```bash
  set -euxo pipefail
  sudo apt-get update
  sudo apt-get install -y libsecret-1-dev
  npm ci
  npm run build
  ```
- Maintenance script:
  ```bash
  set -euxo pipefail
  npm ci
  npm run build
  ```
- Agent internet access: on, restricted to these exact hosts:
  - `propotsdam-kundenportal.easysquare.com` — `GET`, `HEAD`, `OPTIONS`, `POST`
  - `www.swp-potsdam.de` — `GET`, `POST`
  - `mitgestalten.potsdam.de` — `GET`, `POST`
  - `sg.geodatenzentrum.de` — `GET`
- Do not enable unrestricted internet.

## Commands
- Typecheck: `npm run check`
- Build: `npm run build`
- Test: `npm test`
- Release check: `npm run release:check`
- Live portal test: `npm run test:live`

## Live Portal Safety
- `npm run test:live` is opt-in only and must not be run unless the user explicitly asks for a live portal check.
- Do not print, paste, commit, or expose portal passwords, session cookies, CSRF tokens, raw traces, exports, screenshots with personal data, or personal portal records.
- Summarize live portal results with counts and high-level status only unless the user explicitly asks for specific redacted details.
- Portal write commits are allowed only when the user explicitly provides a confirmation id in the same task. Read and prepare-only actions are otherwise acceptable.
- STEP pickup and Potsdam abandoned-waste commits follow the same rule: no live external write without an explicit confirmation id in the same task.
- Automated tests must never create a real STEP pickup request or Potsdam report. Use injected fetch implementations and redacted fixtures.

## Pull Requests
- Before proposing a PR, run `npm run check`, `npm run build`, and `npm test`.
- Keep changes focused and preserve the existing TypeScript, Vitest, and MCP server patterns.
