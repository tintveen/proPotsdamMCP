---
name: propotsdam-implement
description: Implement focused changes in proPotsdamMCP with observable acceptance cases, meaningful verification, independent review where required, and integration evidence. Use for repository implementation and defect repair.
---

# ProPotsdam implementation

Read the repository's [engineering guide](../../../docs/engineering.md) before working; it owns the shared safety rules, review boundary, evidence states, and authorization policy. Resolve this path from the skill folder, not the shell's working directory.

- Inspect the current repository and the user's existing authorization. Preserve unrelated edits. Convert the request into observable acceptance cases and select the relevant audit invariants from the guide.
- Make routine implementation and test choices independently. Bring the user only product behavior, material cost, new permissions, or an unresolved material risk, with a plain-language recommendation. Keep documentation work proportional; agent instructions and safety/release policy still require independent review.
- Trace the affected call paths and implement a focused change using the existing TypeScript, Vitest, and MCP patterns. For a reproducible defect, demonstrate failure against the old behavior and success against the candidate. Explain any missing reproduction instead of claiming it happened.
- Run meaningful targeted tests and the checks required by the guide. Keep generated cases deterministic and external services synthetic. Do not weaken verification to clear a failure.
- For changes requiring independent review, commit the candidate and run `npm run engineering:review -- --base <trusted-ref>`. Give the fresh reviewer raw acceptance and verification evidence without dictating its conclusion. Reproduce findings, fix confirmed defects, and renew evidence after changes to the candidate or base.
- Before an authorized integration, wait for the required CI checks and run `npm run engineering:preflight -- --pr <number>`. A passing preflight does not grant merge or publication permission; use the task's existing scope. If the task ends before integration, leave concrete evidence and identify that remaining step.

Finish with the guide's **Changed, Verified, Unverified, Tradeoff, Recommendation, Decision needed** report, using evidence the next agent can understand without conversation history or personal memory.
