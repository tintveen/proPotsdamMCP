# PRD: Conversationally Approved Portal Writes

**Status:** Accepted; shared safety foundation implemented for the existing allowlist

**Date:** 2026-08-28

**Product:** proPotsdamMCP

**Target release:** Next pre-1.0 minor release

**Investment:** Priority 1; 35 of every 100 near-term development-budget tokens

**Implementation note:** Version 0.2 implements the shared safety foundation and migrates the existing profile-change and damage-report allowlist. Messaging, meter-reading, and repair-appointment actions remain draft-only until their exact live contracts pass the release gate; this implementation does not infer or guess those contracts.

## 1. Summary

Expand proPotsdamMCP from two narrowly allowlisted live-write actions to a small set of high-value resident workflows:

1. Inbox replies and service requests
2. Meter-reading submissions
3. Repair-appointment bookings

Users approve writes in ordinary conversation with the LLM. They do not copy, paste, or manage confirmation ids. proPotsdamMCP stages an immutable pending write, the LLM shows its exact human-readable diff, and the LLM waits for a new user message containing explicit approval before invoking the commit tool with an opaque internal handle.

The product continues to fail closed. Discovering, preparing, or staging a portal form does not by itself make the form safely executable. Each workflow becomes commit-capable only after its target, editable fields, account binding, success signal, and failure behavior have been validated and covered by synthetic or fully redacted tests.

## 2. Problem

proPotsdamMCP can discover many portal actions and prepare drafts for broad write domains, but most workflows stop before execution. Today, live commits are restricted to exact `save_partner` profile actions and `cmdsend` damage reports. This protects users, but it leaves common resident jobs incomplete and often sends them back to the browser after they have already provided the required information.

The existing confirmation-id flow also exposes an implementation detail to the user. A resident should be able to review a proposed action and say “yes, send it” or “ja, abschicken,” without handling an opaque id.

Simply enabling every discovered form would remain unsafe. Easysquare actions can be ambiguous, account-specific, multi-step, and subject to schema drift. Conversational approval therefore needs an immutable internal binding, single-use execution, strict target validation, and clear outcomes even though the user no longer sees that binding.

## 3. Product outcome

A resident can complete a supported portal task through Codex while remaining in control of the final write:

1. proPotsdamMCP discovers an eligible action and identifies its exact target.
2. The LLM stages the proposed write without sending a state-changing portal request.
3. proPotsdamMCP stores an immutable pending write for ten minutes and returns an opaque handle to the LLM.
4. The LLM shows the user the complete human-readable diff and stops.
5. The user explicitly approves that exact write in a new natural-language message.
6. The LLM invokes the commit tool with the hidden handle or handles associated with the approved write or batch.
7. proPotsdamMCP revalidates the account, target, and portal contract, atomically claims each pending write, and attempts it once.
8. The result states whether each write succeeded, was not sent, was explicitly rejected, or has an uncertain outcome.

Direct CLI users receive the same review boundary through a local interactive yes/no prompt. They do not use confirmation ids.

## 4. Trust and safety model

### 4.1 What the server guarantees

- The staged values, target, account, attachments, and portal contract cannot change after review.
- An expired, stale, cancelled, or already claimed pending write cannot be executed.
- A pending write is atomically claimed immediately before its first state-changing request and can be attempted only once.
- Read, discovery, preparation, cancellation, and live-read-test paths cannot obtain the internal permit required for a state-changing portal operation.
- A write is never automatically retried after a request may have reached the portal.
- Every attempted item receives an explicit outcome.

### 4.2 What the LLM guarantees

- It shows the exact diff before asking for approval.
- It stops after staging and waits for a new user message.
- It invokes the commit tool only after explicit approval of the displayed write or batch.
- It asks again when the reply is ambiguous.
- It stages and displays a new draft when the user changes any detail.
- It never shows or asks the user to manage a pending-write handle.

### 4.3 Accepted trust boundary

The MCP server cannot see or independently verify the conversation. It therefore cannot prove that the user authored an approval message. The LLM or MCP host is the approval trust boundary.

There is intentionally no global startup flag or persistent master switch for live writes. A mistaken or compromised LLM could technically invoke the commit tool without genuine approval. The product accepts this residual risk and mitigates it through the separate stage/commit tools, immutable pending writes, destructive tool annotations, conservative tool instructions, and conversational orchestration evaluations.

The user’s approval wording is neither passed to proPotsdamMCP nor retained locally.

## 5. Goals

- Make three high-value workflow families safely commit-capable in priority order.
- Replace user-managed confirmation ids with explicit natural-language approval.
- Guarantee that the committed values and target exactly match the displayed draft.
- Prevent duplicate writes from retries, concurrency, stale pending writes, or ambiguous targets.
- Prevent non-commit code paths and live read tests from reaching state-changing portal operations.
- Support explicit approval of one write, a named subset, or a displayed batch.
- Give users a meaningful result for every attempted batch item.
- Keep unsupported and insufficiently validated actions draft-only.
- Provide equivalent review and single-use behavior through MCP and direct CLI use.

## 6. Non-goals

- Server-side parsing or storage of the user’s natural-language approval
- Direct MCP elicitation as a second approval interface
- A global live-write startup flag or persistent master lock
- User-visible confirmation ids or pending-write handles
- Arbitrary execution of every discovered portal form
- Payment-method or bank-account changes
- Password changes, account verification, terms acceptance, or CAPTCHA completion
- Repair cancellation or appointment rescheduling
- Automatic, scheduled, or background portal writes
- Automatic retries after any state-changing request may have been sent
- Atomic transactions across multiple ProPotsdam actions
- A fixed product limit on explicitly approved batch size
- A hosted, multi-tenant proPotsdamMCP service
- External municipal workflows outside the authenticated ProPotsdam portal
- Default product telemetry containing portal or resident data

## 7. Target users and jobs

### Primary user

A ProPotsdam resident using Codex or the CLI to understand and act on their own portal account.

### Jobs to be done

- “Reply to this message or send this service request without finding the right portal form again.”
- “Submit the reading for the correct meter and know which value was sent.”
- “Choose an available repair appointment and avoid booking the wrong slot.”
- “Review several prepared actions and explicitly send all or only some of them.”

## 8. Conversational approval policy

### 8.1 Review requirement

Before requesting approval, the LLM must display for every proposed write:

- The action being performed
- The exact account, service, record, contract, meter, conversation, or repair target needed to distinguish it
- Every value that will be sent, using portal labels rather than raw field names where possible
- Attachment filename, MIME type, and size when applicable
- Warnings, expiry, and known limitations

The LLM must not call a commit tool in the same conversational turn in which it stages or first displays the pending write. It must yield and wait for a new user message.

### 8.2 Explicit approval

Approval must communicate a clear instruction to execute, for example:

- “Yes, send it.”
- “Submit that reading.”
- “Book the appointment.”
- “Ja, abschicken.”
- “Termin buchen.”
- “Send all three.”
- “Send the first and third.”

An ambiguous positive reaction is not approval. Examples include:

- “Okay.”
- “Looks good.”
- “Fine.”
- A thumbs-up or other reaction without an execution instruction

When approval is ambiguous, the LLM must ask a short follow-up question and make no tool call that can write to ProPotsdam.

### 8.3 Changes and refusal

- “Yes, but change the date” is a modification, not approval. The LLM must create and display a new pending write.
- A refusal or cancellation must not commit. The LLM should cancel the corresponding pending write or let it expire.
- Approval applies only to the exact immutable diff that was displayed.
- An expired or invalidated pending write must be staged and shown again before it can be approved.

### 8.4 Batch approval

- Multiple pending writes may coexist.
- There is no product-defined maximum batch size; practical MCP payload and runtime limits still apply and must never cause silent truncation.
- Every item included in a batch approval must have been displayed clearly enough for the user to review it.
- The user may approve all displayed items or an unambiguous named or numbered subset.
- The LLM passes only the hidden handles for the approved items.
- Batch items execute sequentially in the displayed order.
- Every approved item is attempted independently, even when an earlier item is rejected, fails, or returns `outcomeUncertain`.
- Batch execution is not atomic. The result must identify every success, non-send, rejection, and uncertain outcome, including partial completion.
- Each item’s ten-minute expiry and preflight are evaluated when that item begins execution. A very large batch can therefore contain later items that expire and return `notSent`.

## 9. Scope and sequencing

### Phase 0: shared safety foundation

This phase is required before adding another live-write allowlist entry.

- Replace user-facing confirmations with immutable pending writes and opaque, LLM-managed handles.
- Bind each pending write to the authenticated portal account, write domain, action, service, record or target, normalized values, attachment hashes when applicable, and a fingerprint of the validated form contract. Protect the stored binding with a local HMAC integrity envelope so out-of-band edits make it non-executable.
- Permit multiple pending writes and expire each one ten minutes after staging.
- Revalidate the account, target, action, and form fingerprint immediately before execution.
- Atomically change a pending write from `staged` to `claimed` immediately before its first state-changing request.
- Require a claimed pending write to mint an internal, single-use write permit. State-changing transport operations must reject calls without that permit.
- Treat portal action endpoints as read or write by semantics rather than HTTP method because some state-changing Easysquare actions use `GET`.
- Introduce explicit outcome semantics:
  - `succeeded`: the portal success signal or read-back verifies the intended effect.
  - `notSent`: no state-changing request was issued for the item.
  - `rejected`: the portal explicitly proves the requested effect was rejected.
  - `outcomeUncertain`: a request may have changed portal state, but the final effect cannot be verified.
- Every `outcomeUncertain` result must say “Do not retry automatically” and direct the user to inspect the relevant portal record.
- A claimed pending write remains consumed after any attempted state-changing request, regardless of its outcome.

### Phase 1: inbox replies and service requests

Priority within this family:

1. Reply to an existing inbox or workflow conversation
2. Submit a service ticket through a validated portal action
3. Compose a new inbox message only if recipient or routing behavior is unambiguous

MVP requirements:

- Bind the write to the exact conversation, record, and service when replying.
- Display the recipient or portal routing label, subject when applicable, and complete message in the review diff.
- Reject empty messages, unknown fields, locked fields, ambiguous targets, and messages outside validated portal limits.
- Preserve Unicode, line breaks, and user-supplied wording exactly after normalization required by the portal.
- Each message is one independently staged and single-use write, including when approved in a batch.
- Do not support attachments until the relevant upload contract has been independently validated.
- Verify success through an explicit portal response or a read-back of the conversation when available.

### Phase 2: meter readings

MVP requirements:

- Bind the write to the exact contract, meter identifier, meter type, unit, and service.
- Show the meter label or identifier, property or contract context, reading date, unit, previous reading when available, and proposed reading in the review diff.
- Accept locale-aware numeric input but display and store the exact normalized value that will be sent.
- Reject missing or ambiguous meter targets and values that violate known portal constraints.
- Warn about a lower-than-previous or otherwise suspicious reading when prior data is available; never silently alter or infer a value.
- Invalidate the pending write if the target, prior reading, unit, or form contract changes before execution.
- Verify the submitted value through a portal success signal or read-back when available.
- Meter photos are outside the MVP unless a validated portal upload field requires them.

### Phase 3: repair appointments

MVP requirements:

- Offer only slots returned for the exact repair record by the live portal action.
- Present the repair context, date, start and end time, timezone, and any portal-provided appointment notes in the review diff.
- Bind the pending write to the portal slot identifier as well as its displayed time.
- Re-fetch availability immediately before the first state-changing request.
- If the slot disappeared or changed, send no write, return `notSent`, and require the user to review and approve a newly staged slot.
- Verify the booked appointment through an explicit response or read-back of the repair record.
- Cancellation and rescheduling remain draft-only until separately specified.

## 10. Functional requirements

### FR1: eligibility and allowlisting

- Live support must be based on an exact allowlist predicate, not only a domain classifier, title match, HTTP method, or the presence of editable fields.
- An allowlist entry must constrain at least the action identifier, service or `xuclass`, action kind, source, target requirements, and validated form fingerprint or compatible contract version.
- A discovered action that does not match all constraints remains `draft_only_no_live_write`.
- One workflow family must be released per focused pull request.

### FR2: prepare-only behavior

- Preparation must not create a pending write or issue any portal request known to mutate state.
- The draft must include every editable proposed value and omit or redact secrets and hidden transport fields.
- Portal defaults must not be represented as user choices unless the user explicitly changed them.
- Missing, ambiguous, locked, unsupported, or unknown fields must prevent staging.
- Existing prepare-only MCP tools and CLI commands remain backward compatible.

### FR3: staging a pending write

- A pending write may be staged only for a fully validated draft with a unique action and target.
- Staging may perform necessary read-only portal requests but no state-changing request.
- The result must contain a concise review diff, expiry time, target context, warnings, and `requiresExplicitApproval: true`.
- An opaque, unguessable `pendingWriteHandle` must be available in structured MCP output for LLM/tool coordination.
- The handle must be omitted from normal assistant prose and CLI human output.
- Values are immutable after staging; later caller input cannot modify the pending write.
- Attachments must be bound by exact filename, MIME type, byte length, and content hash.
- Staging a new write does not cancel other pending writes.

### FR4: pending-write lifecycle

- Pending writes use `staged` and `claimed` states.
- Each pending write expires ten minutes after staging.
- Multiple processes sharing the data directory must be able to atomically claim a handle at most once.
- Listing pending writes must return safe review summaries and handles without contacting a state-changing portal endpoint.
- Cancellation removes the selected staged records and any temporary attachments without contacting a state-changing portal endpoint.
- Expiry removes the staged record and temporary attachments.
- Claimed, expired, cancelled, missing, wrong-account, or stale handles cannot be executed.

### FR5: LLM approval behavior

- The staging tool description must direct the LLM to show the exact diff, stop, and wait for a new user message.
- The commit tool description must prohibit invocation without explicit natural-language approval of every supplied handle.
- The LLM must conservatively interpret English and German approval language according to Section 8.
- Approval text is not an MCP input and is not stored.
- The server does not claim that it independently verified conversational approval.

### FR6: commit preflight and internal write permit

- Confirm that the active session belongs to the same portal account for which each pending write was staged.
- Resolve the exact action and target again; ambiguous or missing targets fail before a write.
- Re-fetch the source form and verify that the validated contract and editable fields still match.
- Re-run workflow-specific checks, including meter context or slot availability.
- If preflight fails, invalidate that pending write and return `notSent`; do not silently adapt it.
- After successful preflight, atomically claim the pending write and create a single-use internal write permit.
- Only the dedicated write executor may accept the permit and call known state-changing save, upload, or action endpoints.
- Read, discovery, prepare, stage, list, cancel, and live-read-test code paths must not possess a write permit.

### FR7: single and batch execution

- `propotsdam_commit_pending_writes` accepts one or more opaque handles supplied by the LLM.
- It processes handles sequentially in the provided order and returns one result per handle.
- There is no fixed product cap and no silent truncation of the provided handle list.
- A failure, rejection, or uncertain outcome for one item does not stop later items.
- Each item is revalidated and claimed independently immediately before its own execution.
- Reusing a claimed handle fails without another write.
- A timeout or network error after dispatch never triggers an automatic retry.

### FR8: result contract

- Every item returns exactly one of `succeeded`, `notSent`, `rejected`, or `outcomeUncertain`.
- `succeeded` requires a validated success contract; a generic 2xx response alone is insufficient when the portal can return an error page with status 200.
- `rejected` requires an explicit, understood portal rejection signal.
- Any ambiguous redirect, unreadable or oversized body, partial multi-step operation, unknown response contract, or network failure after dispatch returns `outcomeUncertain`.
- Batch output contains ordered item results, outcome counts, and a `partial` indicator.
- Results may include redacted portal messages and safe target labels but never cookies, CSRF tokens, credentials, hidden form values, raw XML, user approval text, or unredacted traces.

### FR9: MCP annotations and user-facing output

- The commit tool is annotated with `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, and `openWorldHint: true`.
- Documentation must state that MCP annotations are advisory hints, not an authorization mechanism.
- Human output favors portal labels and meaningful target context over internal field names.
- JSON output exposes the same review and outcome information in a stable machine-readable shape.
- Handles are excluded from human-facing summaries but remain available in structured MCP data needed for subsequent tool calls.

### FR10: privacy and local artifacts

- Pending writes, traces, fixtures, and errors follow the existing local-data and redaction policy.
- New fixtures contain synthetic identifiers and values, not transformed real personal data that remains identifying.
- No production telemetry is added by default.
- Temporary attachments are deleted on cancellation, expiry, or after an attempted write.
- Natural-language approval messages are never persisted by proPotsdamMCP.

## 11. Public interfaces and migration

### 11.1 MCP tools

Remove these tools completely:

- `propotsdam_request_portal_action_commit`
- `propotsdam_commit_portal_action`

Add these tools:

| Tool | Portal effect | Contract |
|---|---|---|
| `propotsdam_stage_portal_action` | Read-only | Accepts action, target, values, and optional attachment input; returns the immutable review, expiry, and structured-only pending handle |
| `propotsdam_list_pending_writes` | None | Returns active safe summaries and handles for LLM coordination |
| `propotsdam_cancel_pending_writes` | None | Accepts one or more handles and removes their local staged data and attachments |
| `propotsdam_commit_pending_writes` | State-changing | Accepts one or more handles, processes all in order, and returns per-item outcomes plus aggregate counts |

Keep the existing action discovery and prepare-only tools unchanged.

### 11.2 Types and policies

- Replace `PortalActionCommitRequest` with a staged-write result containing the review, expiry, `requiresExplicitApproval`, and structured handle.
- Replace `StoredPortalActionConfirmation` with `PendingPortalWrite` containing its handle, `staged` or `claimed` state, immutable diff, account and target binding, contract fingerprint, attachment metadata, and timestamps.
- Add a stable portal outcome type with `succeeded`, `notSent`, `rejected`, and `outcomeUncertain`.
- Add a batch result containing ordered item results, counts, and partial-completion status.
- Replace `confirmation_required_live_commit` with `conversational_approval_required_live_commit`.
- Eliminate `confirmationId` from public schemas and results.

### 11.3 CLI

Remove:

- `actions request-commit`
- `actions commit <confirmation-id>`

Add `actions send [id]`:

1. Require an interactive TTY before staging.
2. Collect or validate the target and values using existing CLI behavior.
3. Stage the action and print the exact human-readable diff.
4. Prompt `Send this change to ProPotsdam? [y/N]`.
5. On yes, commit the internal handle immediately and print the result.
6. On no or EOF, cancel the pending write and send nothing.

The direct CLI does not support a non-interactive `--yes` bypass or confirmation ids. CLI batch sending is outside this PRD; direct CLI sends one reviewed action per prompt. Prepare-only commands remain available in non-interactive environments.

### 11.4 Legacy data

- The next pre-1.0 release is intentionally incompatible with the old confirmation-id workflow.
- Legacy confirmation records are never executable after upgrade.
- On first startup, legacy confirmation files are invalidated and removed without contacting the portal.
- The local storage name and documentation change from confirmations to pending writes.

## 12. Workflow release gate

A workflow may move from draft-only to conversationally approved live commit only when all of the following are true:

1. The action is observed through authorized, read-only portal discovery.
2. Its target resolution, editable fields, request sequence, and success or rejection signals are understood.
3. Its contract is stable across at least two discovery observations or form instances.
4. A synthetic or fully redacted fixture covers the complete form and response contract.
5. Unit and integration tests cover preparation, staging, listing, cancellation, expiry, account changes, drift, atomic claiming, reuse, batch continuation, and uncertain outcomes.
6. Conversational evaluations cover explicit approval, ambiguity, modification, refusal, individual selection, subset selection, unlimited explicit batches, and expired pending writes.
7. Synthetic tests prove that non-commit paths cannot obtain a write permit or call a state-changing endpoint.
8. A prepare-only live check succeeds without exposing account data.
9. An explicitly approved live commit is completed and verified separately through the natural-language flow; it is never run as part of normal CI.
10. User-facing documentation states what is supported, experimental, and not safe to retry.
11. `npm run check`, `npm run build`, and `npm test` pass.

If the success contract cannot be proven, the action remains draft-only even when a request can technically be sent.

## 13. Acceptance criteria

### Cross-cutting

- No user has to copy, paste, read, or manage a confirmation id or pending-write handle.
- The LLM shows the exact diff and waits for a new message before every conversational commit.
- Ambiguous approval causes a follow-up question and no commit call.
- A changed instruction creates a new pending write and requires a new review.
- The values and target sent to ProPotsdam match the immutable displayed draft exactly.
- Two simultaneous uses of one handle produce at most one state-changing request sequence.
- An account switch, form drift, or target ambiguity is rejected before a write.
- Read, discovery, prepare, stage, list, cancel, and live-read-test paths cannot access the write executor without a claimed permit.
- No post-dispatch failure is retried automatically.
- Every attempted batch item receives a defined outcome and safe next action.
- Batches continue after failures and accurately report partial completion.
- Existing profile-change and damage-report behavior is migrated to the conversational flow without weakening its allowlist.

### Messaging release

- A user can stage, review, explicitly approve, and send a reply or validated service request without raw form manipulation.
- The committed message and target match the displayed diff exactly.
- Reusing one hidden handle cannot create a duplicate message.

### Meter-reading release

- A user can select a unique meter, review its context and normalized value, explicitly approve, and submit the reading.
- A changed meter context or form contract invalidates the pending write before execution.
- Suspicious values produce a visible warning and are never silently corrected.

### Repair-appointment release

- A user can choose, review, and explicitly approve a currently offered slot for a unique repair record.
- A slot that becomes unavailable is not booked and requires a newly staged review.
- The returned success result matches a verified appointment read-back or success signal.

## 14. Success metrics

Safety metrics are release blockers. Usage metrics are directional and must be measured without default telemetry.

### Safety and reliability

- 0 real writes in automated tests and normal CI
- 0 state-changing requests from read, discovery, prepare, stage, list, cancel, or live-read-test paths
- 100% of orchestration evaluations wait for a new user message after staging
- 100% of ambiguous-approval evaluations result in no commit tool call
- 0 duplicate writes from handle reuse or concurrent claims
- 100% of attempted items classified into a defined outcome
- 100% of post-dispatch ambiguous failures instruct “Do not retry automatically”
- 100% of supported workflows covered by synthetic or redacted success, rejection, drift, and uncertain-outcome fixtures

### User value

- 0 user-managed confirmation ids
- At least 90% of valid, explicitly approved pilot attempts reach `succeeded` once a workflow is released
- At least 80% of pilot tasks can be completed without opening the browser
- One natural-language approval after the draft is complete; no repeated approval for unchanged data
- Fewer than 10% of supported attempts fail because the product selected an ambiguous action or target

## 15. Rollout plan

1. Implement pending-write storage, atomic claiming, outcome types, and the write-permit boundary without expanding the allowlist.
2. Replace the existing profile-change and damage-report confirmation-id paths with conversational staging and verify no legacy record can execute.
3. Keep each new candidate in draft-only mode while collecting authorized, redacted contract evidence.
4. Release the first validated messaging action as experimental.
5. Review failures and portal drift before enabling the next messaging action.
6. Repeat the release gate for meter readings.
7. Repeat the release gate for repair appointments.
8. Mark a workflow stable only after successful use across multiple portal sessions without a contract-related failure.

Normal CI remains fully synthetic. Live discovery is opt-in and read-only. A real commit verification requires the LLM to display the exact write, wait for a new user message, and receive explicit natural-language approval in that task.

## 16. Token allocation within this investment

The 35-token portfolio allocation remains:

| Workstream | Tokens | Rationale |
|---|---:|---|
| Shared safety foundation | 10 | Required leverage and risk control for every new workflow |
| Messaging and service requests | 11 | Highest-frequency, broadly useful first workflow |
| Meter readings | 8 | Structured, valuable workflow with manageable validation |
| Repair appointments | 6 | High value but greater availability and race-condition complexity |

For each workflow, use the first 20% of its allocation to prove availability and a verifiable success contract. If that evidence is absent, stop implementation, leave the workflow draft-only, and move the remaining tokens to the next candidate. Do not spend the full allocation reverse-engineering a form that is unavailable to the authorized test account or cannot fail safely.

## 17. Risks and mitigations

| Risk | Mitigation or accepted decision |
|---|---|
| The LLM calls commit without genuine user approval | Accepted trust boundary; separate stage and commit calls, mandatory wait instructions, destructive annotations, immutable bindings, and orchestration evaluations |
| The server cannot independently verify conversational approval | State this limitation plainly; do not claim server-enforced consent and do not store approval text |
| A non-commit code path accidentally calls a write endpoint | Require a claimed pending write to mint the internal permit accepted by the dedicated write executor; classify mutating `GET` actions by semantics |
| Easysquare changes form identifiers or fields | Exact contract allowlists, pre-commit fingerprint checks, redacted drift fixtures, and fail-closed behavior |
| Multiple records expose the same action id | Bind service and record targets; require explicit selection when ambiguous |
| A network failure occurs after dispatch | Consume the handle, return `outcomeUncertain`, and prohibit automatic retry |
| Two callers commit the same pending write | Atomic transition from `staged` to `claimed` before the first write |
| User changes accounts between review and execution | Bind and revalidate portal account identity |
| A batch partially succeeds | Continue all approved items as selected, return ordered per-item outcomes, and state that the batch is not atomic |
| A large batch outlives the ten-minute window | Evaluate expiry per item; return `notSent` for expired later items and never silently omit them |
| Hidden handles leak into normal output | Keep handles out of human summaries and apply existing redaction rules to traces and errors |
| Meter input is attached to the wrong device | Show and bind contract, meter, type, unit, and prior reading context |
| Appointment availability changes | Refresh the exact slot immediately before write and require a newly staged review on change |
| Legacy confirmation files remain usable | Invalidate and delete them during migration without making portal requests |
| Product overgeneralizes from one observed account | One-action-at-a-time allowlisting and an evidence gate for every workflow |

## 18. Dependencies

- Existing portal action discovery and parsing
- Existing prepare, session, attachment, and redaction infrastructure
- A local pending-write store with atomic cross-process claiming
- A dedicated write executor that requires an internal permit
- MCP structured tool output for LLM-managed handles
- Authorized portal accounts that expose candidate workflows
- Explicit natural-language approval for any live commit verification

No hosted storage, external queue, global write switch, or unrestricted internet access is required.

## 19. Open questions

- Which messaging action is consistently available in the authorized portal account: inbox reply, workflow reply, service ticket, or compose?
- What portal response or read-back reliably proves each message was sent exactly once?
- Does the portal expose meter rollover or replacement metadata needed to interpret lower readings?
- Is a meter-reading photo required for any account type?
- Does appointment selection reserve a slot during save, or only during the final action?
- Which safe, aggregate pilot metrics can be collected manually without retaining resident data?

## 20. Launch decision

Approve implementation when Phase 0 is accepted and at least one candidate messaging action has passed the read-only evidence portions of the workflow release gate. Approval to build does not authorize a live portal commit. Each live verification still requires an exact displayed review followed by explicit natural-language approval in a new user message.
