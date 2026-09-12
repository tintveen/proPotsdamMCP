# Repository Instructions

## Working agreement

- Read [the engineering guide](docs/engineering.md) for the workflow, safety policy, evidence requirements, and environment setup. Its safety rules apply to every task.
- Turn requests into observable acceptance examples and identify the safety rules affected. Choose routine implementation and testing approaches independently. Ask the user about product behavior, material cost, new permissions, or a material risk that cannot be resolved from evidence.
- Keep changes focused and preserve the existing TypeScript, Vitest, and MCP server patterns. Preserve unrelated edits; use an isolated checkout when needed.
- Require independent review for runtime, dependency, test, workflow, agent-instruction, and safety or release-policy changes. Ordinary documentation work receives proportional checks. The [review boundary](docs/engineering.md#independent-review) explains the distinction.
- For reproducible defects, capture failing-before and passing-after evidence. Treat any weakening of verification or permissions as an explicit scope decision, even if it makes a check pass.
- Follow authorization already given for the current task. An implementation request does not itself authorize a release. Prepare the reviewable result before asking for a missing decision.
- Finish meaningful tasks with **Changed, Verified, Unverified, Tradeoff, Recommendation, Decision needed**. State the user-visible outcome, evidence, and remaining limits in plain language; use “None” where appropriate.

## Environment and commands

- Use Node.js 26 or newer and install dependencies with `npm ci`.
- Release validation uses the official Node.js `26.8.1` distribution and npm `11.19.0`; see [release readiness](docs/engineering.md#release-readiness).
- Build output in `dist/` must not be committed.
- Typecheck: `npm run check`; build: `npm run build`; tests: `npm test`; package and release validation: `npm run release:check`.
- Readiness: `npm run engineering:doctor`; deterministic safeguards: `npm run engineering:check`.
- Independent review of a clean, committed candidate: `npm run engineering:review -- --base <ref>`.
- Integration readiness without merging: `npm run engineering:preflight -- --pr <number>`.
- Before proposing a PR, run `npm run check`, `npm run build`, and `npm test`; sensitive changes also need the engineering safeguards and independent review.
- The saved Cloud environment has no portal credentials. Use the exact [Codex Cloud setup and access restrictions](docs/engineering.md#codex-cloud-environment); do not enable unrestricted internet.

## Live safety

- `npm run test:live` is opt-in only and requires an explicit request for a live portal check.
- Keep credentials, cookies, tokens, raw traces, exports, screenshots with personal data, and personal portal records out of output and Git. Use synthetic data for automated checks.
- Portal, STEP pickup, and Potsdam abandoned-waste commits require the exact staged action to be shown and explicit approval in a later user message in the same task. Keep pending-action handles hidden in structured tool data.
- After an uncertain external write, stop and reconcile its outcome before deciding what to do next. Do not retry automatically.
- Read the complete [live safety policy](docs/engineering.md#live-safety-policy) before handling any live task.

## Repository skills

The automatically discoverable skills in `.agents/skills` share the engineering guide:

- [propotsdam-implement](.agents/skills/propotsdam-implement/SKILL.md): acceptance cases, implementation, verification, and integration evidence.
- [propotsdam-review](.agents/skills/propotsdam-review/SKILL.md): independent review of changes and surrounding call paths without editing them.
- [propotsdam-release](.agents/skills/propotsdam-release/SKILL.md): authorized releases, reviewed commits, publication reconciliation, and public artifact integrity.
