import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkoutState, cleanEnvironment, git, githubSnapshot, isExpectedRemote, protectionChecks, RELEASE, run, summarize } from "./core.mjs";
import { REVIEW_CAPABILITIES } from "./review.mjs";

export function capabilityChecks({ node, npm, codexHelp, codexLogin, gh }) {
  const loggedIn = codexLogin.ok && /logged in using chatgpt/i.test(`${codexLogin.stdout}\n${codexLogin.stderr}`);
  return [
    check("tools.node", Number(node.replace(/^v/, "").split(".")[0]) >= 26 ? "PASS" : "BLOCK", `Node ${node}; development requires 26 or newer`),
    check("tools.npm", npm.ok && /^\d+\.\d+\.\d+$/.test(npm.stdout) ? "PASS" : "UNVERIFIED", npm.ok ? `npm ${npm.stdout}` : "npm unavailable"),
    check("tools.codex-capabilities", codexHelp.ok && REVIEW_CAPABILITIES.every((flag) => codexHelp.stdout.includes(flag)) ? "PASS" : "UNVERIFIED", "Codex read-only isolation and structured-output capabilities"),
    check("tools.codex-login", loggedIn ? "PASS" : "UNVERIFIED", loggedIn ? "Existing ChatGPT login; no additional API credential" : "ChatGPT login unavailable; run codex login interactively"),
    check("tools.github", gh.ok ? "PASS" : "UNVERIFIED", gh.ok ? "GitHub CLI available" : "Install/authenticate GitHub CLI")
  ];
}

export async function doctor(root, { release = false, runner = run, snapshot = githubSnapshot } = {}) {
  const env = cleanEnvironment(process.env, { auth: true });
  const [npm, codexHelp, codexLogin, gh] = await Promise.all([
    runner("npm", ["--version"]), runner("codex", ["exec", "--help"], { env }),
    runner("codex", ["login", "status"], { env }), runner("gh", ["--version"])
  ]);
  const checks = capabilityChecks({ node: process.version, npm, codexHelp, codexLogin, gh });
  try {
    const state = await checkoutState(root, null, runner);
    const remote = await git(root, ["remote", "get-url", "origin"], runner);
    checks.push(check("repository.identity", remote.ok && isExpectedRemote(remote.stdout) ? "PASS" : "BLOCK", "Origin must be tintveen/proPotsdamMCP on GitHub"));
    checks.push(check("repository.checkout", state.clean ? "PASS" : "BLOCK", `${state.clean ? "Clean" : "Uncommitted changes in"} candidate ${state.head}`));
  } catch { checks.push(check("repository.checkout", "UNVERIFIED", "Cannot inspect Git checkout")); }
  try { checks.push(...protectionChecks(await snapshot(runner))); }
  catch { checks.push(check("github.protections", "UNVERIFIED", "Cannot read all live settings; verify gh auth and repository administration access")); }
  if (release) {
    if (process.version !== `v${RELEASE.node}` || npm.stdout !== RELEASE.npm) checks.push(check("release.toolchain", "BLOCK", `Release requires official Node ${RELEASE.node} and npm ${RELEASE.npm}`));
    else checks.push(await officialNodeCheck());
  }
  return summarize(checks);
}

async function officialNodeCheck() {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const stem = `node-v${RELEASE.node}-${process.platform}-${process.arch}`;
  const archive = `${stem}.tar.gz`;
  const base = `https://nodejs.org/dist/v${RELEASE.node}/`;
  const scratch = await mkdtemp(join(tmpdir(), "propotsdam-toolchain-"));
  try {
    const get = async (path) => {
      const response = await fetch(new URL(path, base), { redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("Official distribution unavailable");
      return Buffer.from(await response.arrayBuffer());
    };
    const sums = (await get("SHASUMS256.txt")).toString();
    const expected = sums.split("\n").find((line) => line.trim().split(/\s+/)[1] === archive)?.split(/\s+/)[0];
    if (!expected) throw new Error("Unsupported official distribution");
    const bytes = await get(archive);
    if (sha(bytes) !== expected) return check("release.toolchain", "BLOCK", "Official archive checksum mismatch");
    const path = join(scratch, archive);
    await writeFile(path, bytes);
    if (!(await run("tar", ["-xzf", path, "-C", scratch, `${stem}/bin/node`])).ok) throw new Error("Cannot read official binary");
    const equal = sha(await readFile(process.execPath)) === sha(await readFile(join(scratch, stem, "bin/node")));
    return check("release.toolchain", equal ? "PASS" : "BLOCK", equal ? `Node binary matches checksum-verified official ${RELEASE.node} distribution; npm ${RELEASE.npm}` : "Current Node binary differs from official release distribution");
  } catch { return check("release.toolchain", "UNVERIFIED", "Could not verify official Node distribution; exact version alone is insufficient"); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
