import { REPOSITORY, REQUIRED_CHECKS, check, checkoutState, ciChecks, git, githubSnapshot, isExpectedRemote, prChecks, protectionChecks, receiptCheck, requiresReview, run, summarize } from "./core.mjs";
import { readReceipt } from "./review.mjs";

export async function preflight(root, number) {
  const checks = [];
  const query = async (command, args) => {
    const result = await run(command, args);
    if (!result.ok) throw new Error("GitHub evidence unavailable");
    return JSON.parse(result.stdout);
  };
  try {
    const pr = await query("gh", ["pr", "view", String(number), "--repo", REPOSITORY, "--json", "number,state,isDraft,baseRefName,baseRefOid,headRefOid,mergeable,mergeStateStatus,url"]);
    const main = await query("gh", ["api", `repos/${REPOSITORY}/commits/main`]);
    const state = await checkoutState(root, main.sha);
    const remote = await git(root, ["remote", "get-url", "origin"]);
    checks.push(check("repository.identity", remote.ok && isExpectedRemote(remote.stdout) ? "PASS" : "BLOCK", "Expected GitHub origin"));
    checks.push(...prChecks(pr, state, main.sha));
    const ancestor = await git(root, ["merge-base", "--is-ancestor", state.base, state.head]);
    checks.push(check("pr.up-to-date", ancestor.ok ? "PASS" : "BLOCK", "Candidate contains the current main commit"));
    const diff = await git(root, ["diff", "--name-only", "-z", state.base, state.head]);
    if (!diff.ok) throw new Error("Cannot classify change");
    const paths = diff.stdout.split("\0").filter(Boolean);
    const patch = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", state.base, state.head]);
    if (!patch.ok) throw new Error("Cannot inspect documentation scope");
    checks.push(requiresReview(paths, patch.stdout) ? receiptCheck(await readReceipt(root, state), state) : check("review.scope", "PASS", "Ordinary documentation only; independent AI review not required"));
    const settings = await githubSnapshot();
    checks.push(...protectionChecks(settings));
    const pages = await query("gh", ["api", `repos/${REPOSITORY}/commits/${pr.headRefOid}/check-runs?per_page=100`, "--paginate", "--slurp"]);
    const runs = pages.flatMap((page) => page.check_runs);
    const names = [...new Set([...REQUIRED_CHECKS, ...(settings.branch.required_status_checks?.contexts ?? [])])];
    checks.push(...ciChecks(runs, names));
    // Read again after all slower checks. This is still a point-in-time gate;
    // the actual merger must also supply --match-head-commit.
    const latest = await query("gh", ["pr", "view", String(number), "--repo", REPOSITORY, "--json", "headRefOid,baseRefOid"]);
    const latestState = await checkoutState(root, "HEAD");
    const latestMain = await query("gh", ["api", `repos/${REPOSITORY}/commits/main`]);
    checks.push(check("pr.final-freshness", latest.headRefOid === state.head && latest.baseRefOid === state.base && latestMain.sha === state.base && latestState.head === state.head && latestState.tree === state.tree && latestState.clean ? "PASS" : "BLOCK", "Rechecked main, PR head, and local candidate after verification"));
    return { ...summarize(checks), pr: pr.url, base: state.base, head: state.head, tree: state.tree };
  } catch { return summarize([...checks, check("preflight.evidence", "UNVERIFIED", "Cannot retrieve complete evidence; fetch main, verify gh access, and rerun")]); }
}
