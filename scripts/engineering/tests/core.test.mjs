import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS_APP_ID, REPOSITORY, REQUIRED_CHECKS, check, ciChecks, cleanEnvironment, githubSnapshot, isExpectedRemote, prChecks, protectionChecks, receiptCheck, requiresReview, summarize, validateReview } from "../core.mjs";
import { capabilityChecks, doctor } from "../doctor.mjs";
import { reviewerArgs, REVIEW_CAPABILITIES } from "../review.mjs";
import { workflowChecks } from "../validate.mjs";

const state = { base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), clean: true };
const review = { verdict: "PASS", summary: "Inspected the changed call paths; no findings", findings: [], inspected: ["src/portal/parsers.ts"], limitations: ["Candidate tests are executed by CI, separately"] };
const receipt = { version: 1, repository: REPOSITORY, ...state, isolation: "trusted-base-read-only", review };
const good = (stdout = "") => ({ ok: true, stdout, stderr: "", code: 0 });
const absent = { ok: false, stdout: "", stderr: "", code: "ENOENT" };

function snapshot() {
  return {
    repository: { full_name: REPOSITORY, default_branch: "main", security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } },
    branch: { required_status_checks: { strict: true, contexts: REQUIRED_CHECKS, checks: REQUIRED_CHECKS.map((context) => ({ context, app_id: ACTIONS_APP_ID })) }, required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: false, require_last_push_approval: false }, enforce_admins: { enabled: true }, required_linear_history: { enabled: true }, required_conversation_resolution: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
    tags: [{ id: 1, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [] }],
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    environment: { can_admins_bypass: false, protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "tintveen" } }] }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    deployments: { total_count: 1, branch_policies: [{ name: "v*", type: "tag" }] }
  };
}

test("missing evidence cannot become PASS", () => {
  assert.equal(summarize([]).status, "UNVERIFIED");
  assert.equal(summarize([check("one", "PASS", "ok"), check("two", "UNVERIFIED", "missing")]).status, "UNVERIFIED");
  assert.equal(summarize([check("one", "UNVERIFIED", "missing"), check("two", "BLOCK", "failed")]).status, "BLOCK");
  assert.equal(receiptCheck(null, state).status, "UNVERIFIED");
});

test("review must be complete, structured, and internally consistent", () => {
  assert.equal(validateReview(review), true);
  for (const malformed of [null, {}, { ...review, inspected: [] }, { ...review, summary: "" }, { ...review, extra: true }, { ...review, limitations: "unknown" }, { ...review, findings: [{ priority: "P1", file: "x", line: 1, problem: "unsafe", evidence: "repro" }] }]) assert.equal(validateReview(malformed), false);
  const defect = { ...review, verdict: "BLOCK", findings: [{ priority: "P1", file: "x", line: 1, problem: "unsafe", evidence: "repro" }] };
  assert.equal(validateReview(defect), true);
  assert.equal(receiptCheck({ ...receipt, review: defect }, state).status, "BLOCK");
  assert.equal(receiptCheck({ ...receipt, review: { ...review, verdict: "UNVERIFIED" } }, state).status, "UNVERIFIED");
});

test("receipt binds base, candidate, tree and clean working copy", () => {
  assert.equal(receiptCheck(receipt, state).status, "PASS");
  for (const key of ["base", "head", "tree"]) assert.equal(receiptCheck(receipt, { ...state, [key]: "d".repeat(40) }).status, "BLOCK");
  assert.equal(receiptCheck(receipt, { ...state, clean: false }).status, "BLOCK");
  for (const patch of [{ version: 0 }, { repository: "some/other" }, { isolation: "candidate-checkout" }, { review: {} }]) assert.equal(receiptCheck({ ...receipt, ...patch }, state).status, "BLOCK");
});

test("all release and branch protections are inspected", () => {
  assert.equal(summarize(protectionChecks(snapshot())).status, "PASS");
  const drifts = [
    (s) => { s.branch.required_status_checks.strict = false; },
    (s) => { s.branch.required_status_checks.checks.pop(); },
    (s) => { s.branch.required_status_checks.checks[0].app_id = 999; },
    (s) => { s.branch.required_pull_request_reviews = null; },
    (s) => { s.branch.required_pull_request_reviews.required_approving_review_count = 1; },
    (s) => { s.branch.required_pull_request_reviews.bypass_pull_request_allowances = { users: [{ login: "tintveen" }] }; },
    (s) => { s.branch.enforce_admins.enabled = false; },
    (s) => { s.branch.allow_force_pushes.enabled = true; },
    (s) => { s.branch.allow_deletions.enabled = true; },
    (s) => { s.branch.required_linear_history.enabled = false; },
    (s) => { s.branch.required_conversation_resolution.enabled = false; },
    (s) => { s.tags[0].bypass_actors = [{ actor_id: 1 }]; },
    (s) => { s.tags[0].enforcement = "evaluate"; },
    (s) => { s.tags[0].conditions.ref_name.exclude = ["refs/tags/v99*"]; },
    (s) => { s.tags[0].rules = [{ type: "update" }]; },
    (s) => { s.repository.security_and_analysis.secret_scanning.status = "disabled"; },
    (s) => { s.repository.security_and_analysis.secret_scanning_push_protection.status = "disabled"; },
    (s) => { s.workflow.default_workflow_permissions = "write"; },
    (s) => { s.workflow.can_approve_pull_request_reviews = true; },
    (s) => { s.environment.can_admins_bypass = true; },
    (s) => { s.environment.protection_rules = []; },
    (s) => { s.environment.protection_rules[0].prevent_self_review = true; },
    (s) => { delete s.environment.protection_rules[0].prevent_self_review; },
    (s) => { s.environment.protection_rules[0].reviewers[0].reviewer.login = "other"; },
    (s) => { s.deployments.branch_policies[0].type = "branch"; },
    (s) => { s.deployments.branch_policies[0].name = "*"; }
  ];
  for (const drift of drifts) { const s = snapshot(); drift(s); assert.equal(summarize(protectionChecks(s)).status, "BLOCK", drift.toString()); }
});

test("GitHub snapshot uses exact API routes and fails when any setting is unavailable", async () => {
  const s = snapshot();
  const paths = new Map([["", s.repository], ["branches/main/protection", s.branch], ["rulesets?per_page=100", s.tags], ["rulesets/1", s.tags[0]], ["actions/permissions/workflow", s.workflow], ["environments/npm-release", s.environment], ["environments/npm-release/deployment-branch-policies?per_page=100", s.deployments]]);
  const runner = async (command, args) => {
    assert.equal(command, "gh"); assert.equal(args[0], "api");
    const prefix = `repos/${REPOSITORY}`;
    assert.ok(!args[1].endsWith("/"));
    const key = args[1] === prefix ? "" : args[1].slice(prefix.length + 1);
    assert.ok(paths.has(key));
    return good(JSON.stringify(paths.get(key)));
  };
  assert.equal(summarize(protectionChecks(await githubSnapshot(runner))).status, "PASS");
  await assert.rejects(() => githubSnapshot(async () => absent));
});

test("required CI checks need successful latest runs from the expected app", () => {
  const runs = REQUIRED_CHECKS.map((name, i) => ({ id: i + 1, name, app: { id: ACTIONS_APP_ID }, status: "completed", conclusion: "success" }));
  assert.equal(summarize(ciChecks(runs)).status, "PASS");
  assert.equal(summarize(ciChecks(runs.slice(1))).status, "UNVERIFIED");
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", null]) assert.equal(summarize(ciChecks([...runs, { ...runs[0], id: 100, conclusion }])).status, "BLOCK");
  assert.equal(summarize(ciChecks([{ ...runs[0], app: { id: 9 } }])).status, "UNVERIFIED");
  assert.equal(summarize(ciChecks([...runs, { ...runs[0], id: 100, status: "in_progress", conclusion: null }])).status, "UNVERIFIED");
});

test("preflight rejects base/head drift, dirty candidates, closed/draft/conflicting PRs", () => {
  const pr = { state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: state.base, headRefOid: state.head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  assert.equal(summarize(prChecks(pr, state, state.base)).status, "PASS");
  for (const patch of [{ headRefOid: "e".repeat(40) }, { baseRefOid: "d".repeat(40) }, { state: "CLOSED" }, { isDraft: true }, { mergeStateStatus: "BEHIND" }, { mergeStateStatus: "BLOCKED" }, { mergeable: "CONFLICTING" }]) assert.equal(summarize(prChecks({ ...pr, ...patch }, state, state.base)).status, "BLOCK");
  assert.equal(summarize(prChecks(pr, { ...state, clean: false }, state.base)).status, "BLOCK");
  assert.equal(summarize(prChecks(pr, state, "d".repeat(40))).status, "BLOCK");
  assert.equal(summarize(prChecks({ ...pr, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, state, state.base)).status, "UNVERIFIED");
});

test("only ordinary documentation receives lighter review", () => {
  assert.equal(requiresReview(["README.md", "docs/usage.md"], "-clinet\n+client"), false);
  assert.equal(requiresReview(["README.md"]), true);
  assert.equal(requiresReview(["README.md"], " Write approval is required.\n-Do not continue.\n+Continue."), true);
  for (const path of ["AGENTS.md", "SECURITY.md", "docs/engineering.md", "docs/releasing.md", "docs/security-check.md", "docs/sdlc.md", "docs/prd-safe-write-coverage.md", "docs/prd-unified-pending-actions.md", ".agents/skills/test/SKILL.md", ".github/workflows/ci.yml", "tests/a.test.ts", "package-lock.json", "src/index.ts"]) assert.equal(requiresReview([path], "-old\n+new"), true, path);
});

test("missing CLI/auth capabilities are UNVERIFIED and never need an API key", async () => {
  const ready = { node: "v26.8.1", npm: good("11.19.0"), codexHelp: good(REVIEW_CAPABILITIES.join("\n")), codexLogin: good("Logged in using ChatGPT"), gh: good("gh version 2") };
  assert.equal(summarize(capabilityChecks(ready)).status, "PASS");
  for (const key of ["npm", "codexHelp", "codexLogin", "gh"]) assert.equal(summarize(capabilityChecks({ ...ready, [key]: absent })).status, "UNVERIFIED");
  assert.equal(summarize(capabilityChecks({ ...ready, codexLogin: good("Logged in using an API key") })).status, "UNVERIFIED");
  assert.equal(summarize(capabilityChecks({ ...ready, node: "v22.1.0" })).status, "BLOCK");
  const result = await doctor("/nonexistent", { runner: async () => absent, snapshot: async () => { throw new Error("No access"); } });
  assert.equal(result.status, "UNVERIFIED");
});

test("reviewer strips credentials and disabling config is per invocation", () => {
  const env = cleanEnvironment({ HOME: "/home/example", PATH: "/usr/bin", CODEX_HOME: "/auth", PROPPOTSDAM_PASSWORD: "synthetic", PROPPOTSDAM_USERNAME: "synthetic", PROPPOTSDAM_BASE_URL: "https://unsafe.invalid", OPENAI_API_KEY: "synthetic", GH_TOKEN: "synthetic", NODE_OPTIONS: "--require unsafe", BASH_ENV: "/unsafe", CODEX_THREAD_ID: "other", PROPPOTSDAM_LIVE_TEST: "1" }, { auth: true });
  assert.equal(env.CODEX_HOME, "/auth"); assert.equal(env.PROPPOTSDAM_LIVE_TEST, "0");
  for (const key of ["PROPPOTSDAM_PASSWORD", "PROPPOTSDAM_USERNAME", "PROPPOTSDAM_BASE_URL", "OPENAI_API_KEY", "GH_TOKEN", "NODE_OPTIONS", "BASH_ENV", "CODEX_THREAD_ID"]) assert.equal(env[key], undefined);
  const args = reviewerArgs("/trusted", "/schema", "/out");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--cd") + 1], "/trusted");
  for (const flag of REVIEW_CAPABILITIES) assert.ok(args.includes(flag));
  assert.ok(args.includes("allow_login_shell=false")); assert.ok(args.includes('approval_policy="never"'));
  for (const feature of ["plugins", "apps", "hooks", "memories", "shell_snapshot"]) assert.ok(args.some((arg, i) => arg === "--disable" && args[i + 1] === feature));
  assert.ok(!args.includes("--model")); assert.ok(!args.includes("-m"));
  assert.equal(isExpectedRemote("https://github.com/tintveen/proPotsdamMCP.git"), true);
  assert.equal(isExpectedRemote("git@github.com:tintveen/proPotsdamMCP.git"), true);
  assert.equal(isExpectedRemote("https://token@github.com/tintveen/proPotsdamMCP.git"), false);
});

test("workflow validation detects skipped gates, permissions and credential use", () => {
  const workflow = { on: { pull_request: null, push: { branches: ["main"] } }, permissions: { contents: "read" }, jobs: { safeguards: { name: "Engineering safeguards", steps: [{ uses: `actions/checkout@${"a".repeat(40)}` }, { run: "npm run engineering:check" }] } } };
  assert.equal(summarize(workflowChecks(workflow)).status, "PASS");
  for (const mutate of [
    (w) => { w.on.pull_request = { paths: ["src/**"] }; },
    (w) => { w.on.push["paths-ignore"] = ["docs/**"]; },
    (w) => { w.permissions.contents = "write"; },
    (w) => { w.jobs.safeguards.if = "false"; },
    (w) => { w.jobs.safeguards.if = false; },
    (w) => { w.jobs.safeguards.steps[1].if = false; },
    (w) => { w.jobs.safeguards["continue-on-error"] = true; },
    (w) => { w.jobs.safeguards.steps[1]["continue-on-error"] = true; },
    (w) => { w.jobs.safeguards.steps[1].run = "codex exec review"; },
    (w) => { w.jobs.safeguards.env = { OPENAI_API_KEY: "secret" }; },
    (w) => { w.jobs.safeguards.steps[0].uses = "actions/checkout@main"; }
  ]) { const changed = structuredClone(workflow); mutate(changed); assert.equal(summarize(workflowChecks(changed)).status, "BLOCK", mutate.toString()); }
});
