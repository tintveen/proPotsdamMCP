import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const REPOSITORY = "tintveen/proPotsdamMCP";
export const REQUIRED_CHECKS = ["Node 26 / macOS", "npm audit", "Engineering safeguards"];
export const ACTIONS_APP_ID = 15368;
export const RELEASE = { node: "26.8.1", npm: "11.19.0" };
export const check = (id, status, detail) => ({ id, status, detail });
export const summarize = (checks) => ({
  status: checks.some((c) => c.status === "BLOCK") ? "BLOCK" : checks.length === 0 || checks.some((c) => c.status === "UNVERIFIED") ? "UNVERIFIED" : "PASS",
  checks
});

// An allowlist avoids forwarding portal credentials, API keys, CI tokens, shell
// startup settings, or user-controlled Git configuration into the reviewer.
export function cleanEnvironment(source = process.env, { auth = false } = {}) {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"];
  if (auth) keys.push("CODEX_HOME");
  const env = Object.fromEntries(keys.filter((key) => source[key]).map((key) => [key, source[key]]));
  return { ...env, PROPPOTSDAM_LIVE_TEST: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

export async function run(command, args, options = {}) {
  try {
    const result = await exec(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000, ...options });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 };
  } catch (error) {
    // Callers deliberately don't print raw stderr: credentials can appear in
    // errors from authentication, remotes, shell profiles, or package commands.
    return { ok: false, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim(), code: error.code, timedOut: Boolean(error.killed) };
  }
}

export async function git(root, args, runner = run) {
  return runner("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env: cleanEnvironment() });
}

export function isExpectedRemote(remote) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)tintveen\/proPotsdamMCP(?:\.git)?$/.test(remote);
}

export async function checkoutState(root, baseRef, runner = run) {
  const resolve = async (ref) => {
    const result = await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], runner);
    if (!result.ok || !/^[a-f0-9]{40}$/.test(result.stdout)) throw new Error("Cannot resolve a commit; fetch the intended base and candidate first.");
    return result.stdout;
  };
  const head = await resolve("HEAD");
  const base = baseRef ? await resolve(baseRef) : null;
  const tree = await git(root, ["rev-parse", `${head}^{tree}`], runner);
  const state = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"], runner);
  if (!tree.ok || !/^[a-f0-9]{40}$/.test(tree.stdout) || !state.ok) throw new Error("Cannot read the candidate tree and checkout state.");
  return { head, base, tree: tree.stdout, clean: state.stdout === "" };
}

export async function githubSnapshot(runner = run) {
  const api = async (path) => {
    const result = await runner("gh", ["api", `repos/${REPOSITORY}${path ? `/${path}` : ""}`]);
    if (!result.ok) throw new Error("GitHub settings unavailable; verify gh login and repository administration access.");
    return JSON.parse(result.stdout);
  };
  const [repository, branch, rulesets, workflow, environment, deployments] = await Promise.all([
    api(""), api("branches/main/protection"), api("rulesets?per_page=100"),
    api("actions/permissions/workflow"), api("environments/npm-release"),
    api("environments/npm-release/deployment-branch-policies?per_page=100")
  ]);
  const tags = await Promise.all(rulesets.filter((rule) => rule.target === "tag").map((rule) => api(`rulesets/${rule.id}`)));
  return { repository, branch, tags, workflow, environment, deployments };
}

export function protectionChecks(snapshot) {
  const { repository: repo, branch: p, tags, workflow, environment: env, deployments } = snapshot;
  const result = [];
  const require = (id, condition, detail) => result.push(check(id, condition ? "PASS" : "BLOCK", detail));
  require("github.repository", repo.full_name === REPOSITORY && repo.default_branch === "main", "Expected repository and default branch");
  require("github.required-checks", p.required_status_checks?.strict === true && REQUIRED_CHECKS.every((name) => p.required_status_checks.checks?.some((c) => c.context === name && c.app_id === ACTIONS_APP_ID)), "All three required GitHub Actions checks; branch must be up to date");
  const reviews = p.required_pull_request_reviews;
  const bypasses = reviews?.bypass_pull_request_allowances ?? {};
  require("github.pull-requests", reviews?.required_approving_review_count === 0 && reviews.require_code_owner_reviews === false && reviews.require_last_push_approval === false && ["users", "teams", "apps"].every((key) => !bypasses[key] || bypasses[key].length === 0) && p.enforce_admins?.enabled === true, "Pull requests enforced for administrators without bypass allowances; zero required human approvals");
  require("github.branch-safety", p.required_linear_history?.enabled === true && p.required_conversation_resolution?.enabled === true && p.allow_force_pushes?.enabled === false && p.allow_deletions?.enabled === false, "Linear history, resolved conversations, no force pushes or deletions");
  require("github.release-tags", tags.some((r) => r.target === "tag" && r.enforcement === "active" && r.conditions?.ref_name?.include?.includes("refs/tags/v*") && r.conditions.ref_name.exclude?.length === 0 && r.bypass_actors?.length === 0 && ["update", "deletion"].every((type) => r.rules?.some((rule) => rule.type === type))), "Immutable v* tags with no bypass actors");
  require("github.secrets", repo.security_and_analysis?.secret_scanning?.status === "enabled" && repo.security_and_analysis?.secret_scanning_push_protection?.status === "enabled", "Secret scanning and push protection enabled");
  require("github.workflow-permissions", workflow.default_workflow_permissions === "read" && workflow.can_approve_pull_request_reviews === false, "Read-only default token; workflows cannot approve PRs");
  const reviewers = env.protection_rules?.find((rule) => rule.type === "required_reviewers")?.reviewers;
  require("github.npm-environment", env.can_admins_bypass === false && reviewers?.length === 1 && reviewers[0].type === "User" && reviewers[0].reviewer?.login === "tintveen" && env.deployment_branch_policy?.protected_branches === false && env.deployment_branch_policy?.custom_branch_policies === true && deployments.total_count === 1 && deployments.branch_policies?.length === 1 && deployments.branch_policies[0].name === "v*" && deployments.branch_policies[0].type === "tag", "npm-release retains its reviewer, v* tag restriction, and no administrator bypass");
  return result;
}

export const reviewerSchema = {
  type: "object", additionalProperties: false,
  required: ["verdict", "summary", "findings", "inspected", "limitations"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "BLOCK", "UNVERIFIED"] },
    summary: { type: "string", minLength: 1 },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["priority", "file", "line", "problem", "evidence"], properties: {
      priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] }, file: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 }, problem: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 }
    } } },
    inspected: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    limitations: { type: "array", items: { type: "string", minLength: 1 } }
  }
};

// Validate again locally; structured output support alone is not evidence of a
// complete or internally consistent review.
export function validateReview(value) {
  const strings = (list) => Array.isArray(list) && list.every((s) => typeof s === "string" && s.trim());
  const exactKeys = (object, keys) => object && typeof object === "object" && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  if (!exactKeys(value, reviewerSchema.required) || !["PASS", "BLOCK", "UNVERIFIED"].includes(value.verdict) || typeof value.summary !== "string" || !value.summary.trim() || !strings(value.inspected) || value.inspected.length === 0 || !strings(value.limitations) || !Array.isArray(value.findings)) return false;
  if (!value.findings.every((f) => exactKeys(f, ["priority", "file", "line", "problem", "evidence"]) && ["P0", "P1", "P2", "P3"].includes(f.priority) && Number.isInteger(f.line) && f.line >= 1 && [f.file, f.problem, f.evidence].every((s) => typeof s === "string" && s.trim()))) return false;
  return value.verdict !== "PASS" || value.findings.length === 0;
}

export function receiptCheck(receipt, state) {
  if (!receipt) return check("review.receipt", "UNVERIFIED", "No local review receipt; run engineering:review on this committed candidate");
  if (receipt.version !== 1 || receipt.repository !== REPOSITORY || receipt.isolation !== "trusted-base-read-only" || !validateReview(receipt.review)) return check("review.receipt", "BLOCK", "Malformed review receipt");
  if (!state.clean || ["base", "head", "tree"].some((key) => receipt[key] !== state[key])) return check("review.receipt", "BLOCK", "Stale review: base, candidate commit, tree, or checkout changed");
  return check("review.receipt", receipt.review.verdict, receipt.review.summary);
}

export function ciChecks(runs, names = REQUIRED_CHECKS) {
  return names.map((name) => {
    const matches = runs.filter((run) => run.name === name && run.app?.id === ACTIONS_APP_ID).sort((a, b) => b.id - a.id);
    const latest = matches[0];
    if (!latest) return check(`ci.${name}`, "UNVERIFIED", "No run from the expected GitHub Actions app on this PR head");
    if (latest.status !== "completed") return check(`ci.${name}`, "UNVERIFIED", "Required check is still running");
    return check(`ci.${name}`, latest.conclusion === "success" ? "PASS" : "BLOCK", `Latest run concluded ${latest.conclusion}`);
  });
}

export function requiresReview(paths, patch) {
  if (paths.length === 0 || paths.some((path) => path !== "README.md" && !(path.startsWith("docs/") && path.endsWith(".md") && !/(?:engineering|releas|security|sdlc|safety|safe-write|pending-actions|prd-)/i.test(path)))) return true;
  // Documentation can carry policy too. Include surrounding hunk context so
  // changing a small word such as "not" in an approval rule still needs review.
  // Agents must additionally classify semantic risk; this is a conservative aid.
  if (typeof patch !== "string") return true;
  const prose = patch.split("\n").filter((line) => !/^(?:diff |index |--- |\+\+\+ |@@)/.test(line)).join("\n");
  return /\b(?:approv\w*|authoriz\w*|permission\w*|credential\w*|password\w*|token\w*|secret\w*|cookie\w*|csrf|live|retry|retri\w*|uncertain|write\w*|releas\w*|publish\w*|safety|read.only|protect\w*)\b/i.test(prose);
}

export function prChecks(pr, state, mainHead) {
  return [
    check("pr.state", pr.state === "OPEN" && pr.isDraft === false ? "PASS" : "BLOCK", "PR must be open and ready for review"),
    check("pr.commits", pr.baseRefName === "main" && pr.baseRefOid === mainHead && pr.baseRefOid === state.base && pr.headRefOid === state.head && state.clean ? "PASS" : "BLOCK", "Live main, PR base, PR head, and clean local candidate must match"),
    check("pr.mergeability", pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN" ? "UNVERIFIED" : pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN" ? "PASS" : "BLOCK", `GitHub merge state: ${pr.mergeStateStatus}`)
  ];
}
