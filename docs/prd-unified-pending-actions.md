# PRD: Unified Pending Actions and Conversational Waste Approval

**Status:** Draft for owner review

**Date:** 2026-08-29

**Product:** proPotsdamMCP

**Target release:** Next pre-1.0 minor release

**Investment:** 15 development tokens and 16 human-review-attention tokens for the shared kernel and waste migration; the partnership-readiness appendix retains a separate 5 development and 7 human-review tokens

**Implementation note:** Version 0.2 already uses conversational approval and persistent integrity-protected pending writes for the authenticated ProPotsdam portal. STEP bulky-waste pickup and Potsdam abandoned-waste reporting still expose confirmation ids through separate tools and storage. This PRD unifies those safety models without enabling any new external workflow.

## 1. Summary

proPotsdamMCP will use one pending-action lifecycle for authenticated ProPotsdam writes, STEP bulky-waste pickup requests, and Potsdam abandoned-waste reports.

Every supported external write follows the same product contract:

1. Prepare or stage the exact action without making a state-changing request.
2. Show the complete human-readable review, destination, warnings, and expiry.
3. Stop and wait for a new user message.
4. Treat only explicit approval of the displayed action or batch as permission to continue.
5. Commit the immutable pending action once through a hidden internal handle.
6. Report whether it succeeded, was not sent, was rejected, or has an uncertain outcome.

Users never copy, read, paste, or manage confirmation ids or pending-write handles. Future review controls may create a visible user-authored approval message, but they cannot invoke a commit tool directly. The model may commit only in the subsequent conversational turn.

The shared lifecycle does not merge the external executors. ProPotsdam, STEP, and Potsdam retain separate clients, origin-pinned sessions, preflight rules, success evidence, and failure handling.

## 2. Problem

The product currently has two similar but incompatible approval systems:

- ProPotsdam portal writes use immutable pending writes, hidden handles, a persistent HMAC key, generic list/cancel/commit tools, and natural-language approval.
- STEP and Potsdam waste workflows create a visible confirmation id and require a workflow-specific commit tool. Their confirmation integrity key is process-local, so an outstanding record cannot be trusted after a restart.

This split creates four product problems:

1. Residents must understand different approval mechanics for actions that feel equivalent.
2. Hosts and future review interfaces need separate orchestration rules and queues.
3. Waste confirmation files and staged photos have a parallel lifecycle that can drift from the portal safety implementation.
4. Every future action, receipt view, privacy control, or review surface would otherwise need to support both models.

The existing [portal-write PRD](prd-safe-write-coverage.md) deliberately excludes external municipal workflows. This document extends the implemented safety foundation to those workflows without changing their external contracts or adding another live-write capability.

## 3. Product Outcome

A resident can prepare any currently supported write, inspect one consistent review format, approve it conversationally, and understand the result without seeing implementation identifiers.

The system provides:

- one queue of active pending writes across all supported destinations;
- one list, cancel, and commit interface for hosts;
- one ten-minute expiry and atomic single-use contract;
- one outcome vocabulary with workflow-specific details preserved;
- one rule that approval must arrive in a new user message;
- one place for future review UI, receipts, retention controls, and support diagnostics to integrate.

This release does not broaden what proPotsdamMCP can send. It migrates the two already implemented waste workflows and preserves the existing ProPotsdam allowlist.

## 4. Owner Decisions Captured

The following product decisions are fixed for this PRD:

1. Municipal waste moves to conversational approval; visible confirmation ids are removed.
2. A future Approve control may create a normal, visible user-authored approval message. It never sends the action itself and never invokes the commit tool.
3. The product remains unofficial and macOS-only for this milestone.
4. Pending actions and temporary artifacts expire after ten minutes.
5. Diagnostic tracing is off by default and the product adds no default telemetry.
6. The project should prepare for a future ProPotsdam or PROMOS endorsement conversation, but no outreach, branding use, or claim of endorsement occurs without later owner approval.
7. A metadata-only 90-day receipt policy remains the default for a later receipts effort; durable receipts are not implemented here.

## 5. Trust and Safety Model

### 5.1 What the server guarantees

- Staging never issues a state-changing request.
- The reviewed destination, target, values, remote-contract fingerprint, warnings, and attachments cannot change after staging.
- Every pending action expires ten minutes after creation.
- An expired, cancelled, malformed, tampered, already claimed, or legacy record cannot execute.
- Claiming is atomic and occurs before the first state-changing request.
- A claimed action can be attempted only once, including after a process crash.
- Read, prepare, stage, list, and cancel code paths cannot dispatch the external write.
- No state-changing request is automatically retried after it may have reached an external service.
- Every requested batch item receives an explicit result.

### 5.2 What the model or host guarantees

- It shows the exact review before asking for approval.
- It stops after staging and waits for a new user message.
- It treats ambiguous assent, silence, reactions, or an approval in the staging turn as insufficient.
- It stages and displays a new action after any changed instruction.
- It commits only the handles corresponding to the displayed action, named subset, or entire displayed batch that the user explicitly approved.
- It never exposes a handle or asks the user to manage one.

### 5.3 Approval controls

A future review card may include an approval control only under this contract:

1. Activating the control creates a normal, visible user-authored message such as “Yes, submit this exact STEP request.”
2. That message starts a new model turn.
3. The model resolves the message to the already displayed pending action and invokes the generic commit tool.

The control cannot call an MCP commit tool, pass a hidden handle directly to an executor, silently approve a batch, or stage and commit in one turn. A local Cancel control may call the cancellation path directly because cancellation is local and cannot create an external action.

### 5.4 Accepted residual risk

The MCP server cannot inspect the conversation or independently prove that the user approved. The model or host remains the conversational-approval trust boundary. Tool annotations, hidden handles, exact binding, and orchestration evaluations reduce mistakes but do not constitute server-enforced consent.

The approval text is not sent to proPotsdamMCP and is not stored locally by this feature.

## 6. Goals

- Replace both waste confirmation-id flows with conversational staging and generic commit.
- Reuse one versioned, integrity-protected pending-action envelope and persistent key.
- Present all active pending actions in one queue without duplicates.
- Preserve exact external contracts, consent warnings, outcome semantics, origin isolation, and no-retry behavior.
- Preserve existing portal-write behavior and its current live allowlist.
- Make the shared interface usable by a future inline review and pending-work experience.
- Invalidate legacy state safely without contacting any external service.
- Keep normal CI fully synthetic.

## 7. Non-goals

- Adding a new ProPotsdam, STEP, or Potsdam workflow
- Building a visual review or pending-work interface
- Adding direct waste commands to the CLI
- Implementing the durable receipt ledger or the 90-day receipt retention policy
- Adding a purge UI or changing unrelated session, trace, export, or credential retention
- Making approval server-verifiable
- Storing or parsing the user’s approval wording
- Direct MCP elicitation as a second approval interface
- Background, scheduled, or automatic writes
- Automatic retries after possible dispatch
- Atomic rollback across external services
- A hosted or multi-tenant service
- Windows or Linux support
- Public plugin-directory submission
- Contacting ProPotsdam, PROMOS, STEP, or the City of Potsdam
- Using names, logos, or language that implies official endorsement

## 8. User Flows

### 8.1 Existing ProPotsdam portal action

The current flow remains unchanged:

1. The model calls `propotsdam_stage_portal_action`.
2. The server returns the exact diff and a hidden structured handle.
3. The model shows the review and waits.
4. A new user message explicitly approves the action.
5. The model calls `propotsdam_commit_pending_writes` with the hidden handle.

The migration must not expand the portal allowlist or weaken account, action, record, form, field, or attachment binding.

### 8.2 STEP bulky-waste pickup

1. `propotsdam_prepare_bulky_waste_pickup` remains an optional read-only preview.
2. `propotsdam_stage_bulky_waste_pickup` validates the input and current STEP form contract, then stores one immutable pending action without creating a pickup request.
3. The review shows the destination, contact details, pickup and contact addresses, requested items and quantities, earliest pickup date, notes, privacy links, warnings, and ten-minute expiry.
4. The model shows the complete review and waits for a new message.
5. Explicit approval permits the model to call `propotsdam_commit_pending_writes`.
6. The STEP executor revalidates the remote contract and date, atomically claims the action, and attempts it once.
7. A verified receipt becomes `succeeded` with workflow state `request_received`. The summary explains that the actual collection date may follow later.

A date that becomes invalid before dispatch returns `notSent`. A request that may have reached STEP without a verifiable result returns `outcomeUncertain` and states “Do not retry automatically.”

### 8.3 Potsdam abandoned-waste report

1. `propotsdam_prepare_abandoned_waste_report` remains an optional read-only preview.
2. `propotsdam_stage_abandoned_waste_report` requires the existing explicit privacy-consent field, validates the city contract, normalizes one to three supported photos, and stores private hashed copies under the pending handle.
3. The review prominently states that the location, description, and photos may become public. It shows the destination, contact details transmitted, exact location, description, photo filenames and count, privacy links, activation-email requirement, warnings, and ten-minute expiry.
4. The model shows the complete review and waits for a new message.
5. Explicit approval permits the model to call `propotsdam_commit_pending_writes`.
6. The city executor revalidates the remote contract, atomically claims the action, and attempts it once.
7. A verified guest submission becomes `succeeded` with workflow state `awaiting_email_confirmation`. The summary tells the user to use the city’s activation email.

Changing the location, description, contact data, or any photo requires a new staged action and a new approval. An ambiguous response cannot satisfy the public-data warning.

### 8.4 Listing and cancellation

`propotsdam_list_pending_writes` returns each valid staged action exactly once, ordered by creation time. Summaries include destination, workflow, safe review data, warnings, creation time, expiry, and the hidden handle in structured content.

`propotsdam_cancel_pending_writes` accepts one or more hidden handles, deletes only local staged state and artifacts, and never contacts an external service. It reports cancelled and missing handles separately.

### 8.5 Mixed batches and subsets

A single explicit user message may approve one displayed action, a named subset, or an entire displayed batch across destinations.

- The model supplies handles in the displayed execution order.
- Duplicate handles are rejected before any item is dispatched.
- Items execute sequentially and independently.
- A failure, rejection, expiry, or uncertain outcome for one item does not stop later approved items.
- Each item is revalidated when its turn begins; later items may expire and return `notSent`.
- There is no rollback across ProPotsdam, STEP, and Potsdam.
- The final result identifies partial completion and every item’s outcome.

## 9. Public MCP Interface

### 9.1 Tool changes

| Current tool | Release behavior |
|---|---|
| `propotsdam_stage_portal_action` | Retain unchanged |
| `propotsdam_list_pending_writes` | Retain name; generalize across all executors |
| `propotsdam_cancel_pending_writes` | Retain name; generalize across all executors |
| `propotsdam_commit_pending_writes` | Retain name; dispatch by pending-action kind |
| `propotsdam_prepare_bulky_waste_pickup` | Retain unchanged and read-only |
| `propotsdam_request_bulky_waste_pickup_commit` | Replace with `propotsdam_stage_bulky_waste_pickup` |
| `propotsdam_commit_bulky_waste_pickup` | Remove; use generic commit |
| `propotsdam_prepare_abandoned_waste_report` | Retain unchanged and read-only |
| `propotsdam_request_abandoned_waste_report_commit` | Replace with `propotsdam_stage_abandoned_waste_report` |
| `propotsdam_commit_abandoned_waste_report` | Remove; use generic commit |

The four removed tools receive no compatibility aliases. Leaving duplicate commit paths would preserve the confusing approval model and increase the chance that a host selects the wrong tool.

### 9.2 Stage inputs and results

The two new stage tools use the same domain inputs and validation rules as their corresponding prepare tools. The abandoned-waste stage input retains `privacyConsent: true`.

A successful stage result includes in structured content:

- `ok: true`
- `workflow`
- `kind`
- `pendingWriteHandle`
- `createdAt`
- `expiresAt`
- complete `review`
- `warnings`
- `privacyUrls` where applicable

Validation failures return no handle and no executable local state. Human-readable MCP content omits every field whose name contains `handle`.

### 9.3 Shared types

The implementation introduces one discriminated pending-action model:

```ts
type PendingWriteKind =
  | "portal_action"
  | "swp_bulky_waste"
  | "potsdam_abandoned_waste";

type PendingWriteState = "staged" | "claimed";
```

The versioned stored envelope contains:

- schema version;
- hidden handle and state;
- kind and workflow;
- creation, expiry, and optional claim timestamps;
- complete safe review, warnings, and privacy links;
- executor-specific immutable payload;
- remote-contract fingerprint and exact destination binding;
- staged-artifact metadata and hashes;
- HMAC integrity tag covering every executable field.

The executor payload is a discriminated union. Portal-only fields do not become optional fields on unrelated waste actions, and waste clients remain isolated from portal sessions and permits.

### 9.4 Generic commit result

Every item uses this outcome vocabulary:

```ts
type WriteOutcome =
  | "succeeded"
  | "notSent"
  | "rejected"
  | "outcomeUncertain";
```

Each structured item result includes the hidden handle, kind, workflow, outcome, completion time, summary, and available status/reference data. Waste-specific states such as `request_received` and `awaiting_email_confirmation` remain additional details rather than alternate top-level outcomes.

The batch result retains `ok`, `partial`, `attemptedCount`, counts by outcome, and ordered item results. Human-readable content omits handles.

### 9.5 Tool annotations

- Prepare and list tools: read-only and non-destructive.
- Stage tools: not read-only because they create local pending state; non-destructive to the external service; non-idempotent because repeated staging creates distinct records.
- Cancel: not read-only, locally destructive, idempotent, and not open-world.
- Commit: not read-only, destructive, non-idempotent, and open-world.

Annotations are host guidance, not authorization enforcement.

## 10. Shared Storage and Integrity

### 10.1 Layout

All new records use the existing local foundation:

```text
~/Library/Application Support/propotsdam-mcp/
├── pending-write.key
└── pending-writes/
    ├── <handle>.json
    ├── <handle>.claimed.json
    └── <handle>/
        └── staged artifacts
```

The data directory and pending-write directory use mode `0700`; the integrity key, envelopes, and staged artifacts use mode `0600`.

### 10.2 Integrity key

The shared implementation reuses one persistent, locally generated pending-write HMAC key. It never uses a process-random key for executable stored state. A restart can therefore validate an unexpired staged action, while an out-of-band modification makes the record non-executable.

The key is not exported, logged, returned through MCP, or sent to an external service.

### 10.3 Atomic lifecycle

- Saving a staged action is atomic and exclusive.
- Claiming atomically moves it out of the staged namespace before any external write.
- Concurrent claims produce at most one executor attempt.
- A crash after claim never restores the action to staged state.
- Maintenance skips claims that are active in the current process, including claims that outlive the original staging expiry.
- Claimed remnants found after restart are cleanup-only, never executable, and become removable after a separate ten-minute stale-claim window.
- Cancellation cannot remove or interrupt an already claimed action.
- Malformed, unsupported-version, or HMAC-invalid records are non-executable and eligible for local cleanup.

### 10.4 Artifacts

Normalized abandoned-waste photos live beneath the pending handle. Their metadata and hashes are integrity-bound to the envelope. The executor reads only paths proven to remain inside that directory.

Artifacts are removed after:

- successful execution;
- rejection or uncertain execution;
- preflight failure after claim;
- cancellation;
- expiry;
- failed staging;
- cleanup of a malformed or orphaned record.

Original user files are never deleted.

## 11. Executor Contract

The shared service owns storage, listing, cancellation, ordered batch orchestration, and outcome aggregation. It dispatches a claimed action by `kind` to one of three isolated executors.

Each executor must:

1. Accept only its own discriminated payload.
2. Use only its own origin-pinned session and HTTP client.
3. Revalidate time-sensitive values and the remote contract before dispatch.
4. Return `notSent` if no state-changing request occurred.
5. Return `rejected` only when the external service explicitly proves rejection.
6. Return `outcomeUncertain` after possible dispatch without reliable success or rejection evidence.
7. Never retry automatically after possible dispatch.
8. Return a user-actionable summary appropriate to the workflow.

The existing internal ProPotsdam write permit remains portal-specific. STEP and city executors do not receive portal cookies, CSRF values, credentials, headers, or permits.

## 12. Privacy and Data Lifecycle

- Pending action content remains local and expires after ten minutes.
- Staged photos are private, metadata-normalized copies and are deleted with the pending action.
- The abandoned-waste review clearly states which fields and photos are transmitted and may become public.
- Hidden form values, raw external responses, secrets, and integrity material are not logged or returned through MCP.
- Diagnostic tracing remains off unless explicitly requested through the existing diagnostic workflow.
- This feature adds no telemetry and no durable receipt history.
- The later receipts effort will use the selected default of 90-day local retention for metadata-only receipts without message bodies or attachments.
- Exports, sessions, credentials, and unrelated traces are not migrated or deleted by this feature.

## 13. Migration and Compatibility

This is an intentional pre-1.0 breaking change.

On the first startup after upgrade, without contacting an external service:

1. Remove all legacy `waste-confirmations` files, claims, and staged-photo directories.
2. Invalidate and remove unversioned pending-write records that cannot be proven to match the new shared schema.
3. Preserve the persistent pending-write integrity key.
4. Sweep malformed, expired, claimed, and orphaned shared records.

Interrupted actions are not translated into executable new records. The user must prepare and approve them again.

The README, security documentation, MCP tool inventory, examples, and evaluation corpus remove the old confirmation-id terminology. Historical changelog or release-note text may describe the old behavior when clearly labeled as historical.

## 14. Delivery Sequence

### Phase 1: shared kernel with no product-surface change

- Introduce the versioned discriminated envelope and shared storage/service abstractions.
- Adapt existing portal pending writes to the shared model.
- Preserve current portal tools and behavior.
- Add migration and storage tests before routing waste through the kernel.

This phase should be reviewable independently and must not enable or call a waste write.

### Phase 2: waste migration

- Add the two waste stage tools.
- Route both waste executors through generic list/cancel/commit.
- Remove the four confirmation-id tools and separate confirmation storage.
- Expand conversational evaluations, documentation, and safety checks.

### Phase 3: later dependent efforts

After this PRD is implemented and stable:

1. Build the optional read-only review and pending-work interface.
2. Add metadata-only receipts and privacy controls under a separate PRD.
3. Run the read-only release gate for one routine existing-conversation reply.
4. Consider partner-approved integrations or broader platform support only after separate owner decisions.

## 15. Acceptance Criteria

The PRD is implemented when all of the following are true:

- Users encounter zero confirmation ids or pending-write handles in ordinary output.
- Portal, STEP, and Potsdam staged actions appear in one queue, each exactly once.
- All three kinds use the same ten-minute, integrity-protected, atomic single-use lifecycle.
- Existing supported ProPotsdam writes behave unchanged.
- Both waste workflows stage without creating an external request and commit only through the generic commit tool.
- The old waste request/commit tools and confirmation-id schemas are absent.
- A new user message is required between review and commit.
- No UI or rendering tool can call commit directly.
- Abandoned-waste review always includes the public-location, description, and photo warning.
- Mixed batches and named subsets produce a result for every requested item and accurately report partial completion.
- Possible dispatch is never followed by automatic retry.
- Expired, malformed, tampered, duplicate, legacy, and already claimed records cannot execute.
- Temporary copies and orphaned artifacts are cleaned without deleting original user files.
- Documentation matches the final MCP tool surface and storage behavior.
- Normal tests remain fully synthetic and make no real STEP, Potsdam, or ProPotsdam write.

## 16. Test Plan

### 16.1 Storage and migration

- Save, restart, load, and claim each supported kind with the persistent key.
- Reject a changed payload, review, fingerprint, artifact hash, state, or integrity tag.
- Verify `0700` directories and `0600` files.
- Prove one winner under concurrent claims and no second executor attempt.
- Prove maintenance cannot delete an active claim or its artifacts, including during the claim transition.
- Clean expired, cancelled, malformed, unsupported-version, claimed-remnant, and orphan-artifact records.
- Invalidate legacy waste confirmations and unversioned incompatible records without an external request.
- Prove each valid staged record appears exactly once in the list.

### 16.2 MCP interface

- Register both new stage tools with the correct schemas and annotations.
- Remove all four confirmation-id tools and their input schema.
- Preserve both prepare tools and `propotsdam_stage_portal_action`.
- Generalize list, cancel, and commit across all three kinds.
- Confirm handles exist in structured content and nowhere in human-readable content.
- Reject duplicate handles before dispatch.
- Aggregate ordered mixed results and counts accurately.

### 16.3 Workflow behavior

- STEP success, explicit rejection, stale earliest date, changed contract, network failure before dispatch, uncertain response after dispatch, and cleanup failure.
- Potsdam success awaiting activation email, explicit rejection, changed contract, unsupported or oversized normalized photo, public-warning review, uncertain response, and cleanup failure.
- Existing portal success, preflight invalidation, account mismatch, form drift, attachment binding, and uncertain outcome remain unchanged.
- Every prepare, stage, list, and cancel case proves zero state-changing requests through injected clients.
- Every possible-dispatch failure proves no automatic retry.

### 16.4 Conversational orchestration

Extend the evaluation corpus with:

- explicit English and German approval after a new-turn boundary;
- ambiguous assent, emoji, silence, refusal, and expiry;
- “yes, but change…” and changed photo/location instructions;
- named individual and subset approval;
- a mixed ProPotsdam/STEP/Potsdam batch;
- a visible user message created by an approval control;
- attempts to approve in the staging turn;
- attempts to expose or ask for a handle;
- expired UI state requiring a new staged review.

Normal CI validates the corpus and synthetic orchestration. A future host/model runner may execute the cases without live external writes.

### 16.5 Required checks

Before proposing the implementation PRs, run:

```bash
npm run check
npm run build
npm test
npm run release:check
```

Do not run `npm run test:live` under this PRD. Any later live write requires separate approval of the exact displayed action in that task.

## 17. Documentation and Release Notes

Implementation updates must cover:

- README workflow descriptions, prompts, storage inventory, and exact MCP tool list;
- SECURITY.md approval boundary, shared integrity key, external-service isolation, public-data exposure, and cleanup behavior;
- `docs/security-check.md` verification steps and storage paths;
- the conversational-approval evaluation README/corpus;
- release notes calling out the pre-1.0 removal of confirmation-id tools and the need to restage interrupted actions.

No documentation may describe proPotsdamMCP as official, endorsed, or partnered.

## 18. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A host commits without genuine approval | Preserve the explicit new-turn rule, hidden exact binding, destructive annotations, and orchestration evaluations; disclose the trust boundary |
| A review control bypasses conversation | Permit it only to create a visible user message; prohibit direct tool invocation |
| A generic executor leaks portal state to waste services | Keep clients, sessions, origins, payload unions, and permits isolated by action kind |
| An old id remains executable | Remove old tools and schemas; invalidate legacy records on startup |
| A restart permits tampered or duplicate execution | Use one persistent HMAC key, versioned envelopes, atomic claims, and cleanup-only claimed remnants |
| A photo or location becomes public unexpectedly | Require explicit privacy consent and repeat the public-data warning in the exact staged review |
| A mixed batch partially completes | Execute in displayed order, never imply atomicity, and report every item and next step |
| A timeout causes silent disappearance | Show expiry in review and list results; require restaging after expiry |
| Generic result wording overstates success | Preserve workflow state and reference details; use `outcomeUncertain` whenever success cannot be proven |
| Compatibility aliases confuse the model | Remove old commit paths rather than maintaining aliases |

## 19. Success Measures

- 0 user-visible confirmation ids or handles
- 0 state-changing requests from prepare, stage, list, cancel, tests, or migration
- 100% of staged actions integrity-bound to kind, destination, review, contract, payload, and artifacts
- 100% of commit attempts preceded by an atomic claim
- 100% of batch items represented in the final result
- 0 automatic retries after possible dispatch
- 0 stale legacy confirmations executable after upgrade
- 1 shared pending-action queue with no duplicate entries
- Full synthetic regression coverage for all three executors

## Appendix A: Partnership Readiness and Endorsement Track

The project should seek a ProPotsdam or PROMOS endorsement conversation after the shared kernel and one additional resident workflow are demonstrably stable. This appendix prepares for that possibility but authorizes no contact.

### Allocation

- **Development: 5 tokens** for technical and product preparation.
- **Human review: 7 tokens** for positioning, privacy roles, branding, and the eventual ask.

### Deliverables

1. A concise partner brief describing the resident problem, local-first product, supported workflows, and requested form of endorsement or integration discussion.
2. A safety and privacy dossier covering exact review, conversational approval, origin isolation, no-retry behavior, local storage, synthetic tests, and public-data warnings.
3. A supported-integration question list covering official APIs, authentication, stable identifiers, write receipts, status events, rate limits, demo accounts, and contract-change notification.
4. A responsibility matrix for user support, privacy roles, security incidents, accessibility, data retention, and escalation.
5. A branding checklist stating that logos, marks, screenshots, and “official” language require written permission.
6. A draft outreach message and proposed technical-discovery agenda for later owner approval.

### Outreach Gate

No message is sent and no meeting is requested until:

- the shared pending-action kernel and waste migration pass all synthetic release checks;
- at least one repeated resident workflow beyond the existing allowlist passes its read-only evidence gate;
- the owner reviews the exact recipient, wording, requested endorsement, materials, and data disclosures;
- the project has a clear answer for support and incident ownership if distribution expands.

Until written permission exists, proPotsdamMCP remains an unofficial local tool and does not imply endorsement.
