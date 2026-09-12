---
name: propotsdam-release
description: Prepare or verify authorized proPotsdamMCP releases, including reviewed commits, protections, exact toolchain, package contents, publication reconciliation, and public artifact integrity. Use for release work or uncertain publication outcomes.
---

# ProPotsdam release verification

Read [release readiness and shared safety policy](../../../docs/engineering.md#release-readiness) and the [release procedure](../../../docs/releasing.md). Resolve these paths from the skill folder. These repository files provide the policy; no personal memory or prior conversation is required to use this skill.

- Inspect the current task's authorization for merging, tagging, publishing, and protected-environment approval. Continue already authorized actions; prepare the evidence before asking for a missing decision. Merely selecting this skill grants no external-write permission.
- Verify the current clean candidate, reviewed commit, required CI, and live protections with the engineering doctor. Use preflight before a pending PR integration; after merging, reconcile the integrated commit and tree with the reviewed candidate. Respect the distinction between GitHub-enforced checks and local independent-review evidence.
- Select the exact official Node/npm release toolchain specified by the guide and release workflow, then run `npm run engineering:doctor -- --release` and `npm run release:check`. Do not use live portal data. Inspect the exact archive and confirm development workflow files, skills, review evidence, and sensitive data are excluded.
- Follow the existing protected publication procedure only within current authorization. Keep the reviewed commit, version, tag, archive integrity, registry result, and GitHub asset checksum linked by evidence. A dry run or a successfully dispatched command is not proof of publication.
- If publication is uncertain, reconcile authoritative workflow, registry, and release state before taking another publishing action. Do not automatically retry or change the version to avoid uncertainty. Apply the documented recovery procedure only after reconciliation and stop on an artifact mismatch.
- Verify the exact public package version and artifact integrity after a confirmed publication. Report partial outcomes accurately, such as a confirmed registry version with a missing GitHub asset. Preserve immutable published versions and protected tags.

Finish with **Changed, Verified, Unverified, Tradeoff, Recommendation, Decision needed**, including the exact commit/version covered and any publication outcome that remains unresolved.
