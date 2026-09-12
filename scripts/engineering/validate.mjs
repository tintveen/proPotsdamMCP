import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { check, RELEASE, summarize } from "./core.mjs";

export const SKILLS = ["propotsdam-implement", "propotsdam-review", "propotsdam-release"];
export function workflowChecks(workflow) {
  const trigger = workflow.on;
  const job = workflow.jobs?.safeguards;
  const steps = job?.steps ?? [];
  const safePermissions = (p) => p && p.contents === "read" && Object.entries(p).every(([key, value]) => key === "contents" || value === "none" || value === "read");
  const unrestricted = (value) => value === null || value && Object.keys(value).length === 0;
  return [
    check("workflow.events", trigger && Object.hasOwn(trigger, "pull_request") && unrestricted(trigger.pull_request) && trigger.push?.branches?.includes("main") && !trigger.push?.paths && !trigger.push?.["paths-ignore"] ? "PASS" : "BLOCK", "Safeguards run on every PR and push to main, without path filters"),
    check("workflow.permissions", safePermissions(workflow.permissions) && !job?.permissions && !Object.hasOwn(trigger ?? {}, "pull_request_target") ? "PASS" : "BLOCK", "Safeguard workflow uses read-only permissions and unprivileged PR events"),
    check("workflow.required-job", job?.name === "Engineering safeguards" && !Object.hasOwn(job, "if") && !job["continue-on-error"] && !job.needs && steps.some((s) => s.run === "npm run engineering:check" && !Object.hasOwn(s, "if") && !s["continue-on-error"]) && steps.every((s) => !s.uses || /@[a-f0-9]{40}$/.test(s.uses)) ? "PASS" : "BLOCK", "Stable required job, mandatory verification, pinned actions"),
    check("workflow.offline", !/codex|OPENAI_API_KEY|PROPPOTSDAM_(?:USERNAME|PASSWORD)|secrets\./i.test(JSON.stringify(workflow)) ? "PASS" : "BLOCK", "Deterministic CI does not require AI login or portal credentials")
  ];
}

export async function validateRepository(root) {
  const checks = [];
  try { checks.push(...workflowChecks(parse(await readFile(join(root, ".github/workflows/engineering.yml"), "utf8")))); }
  catch { checks.push(check("workflow.syntax", "BLOCK", "Cannot parse engineering workflow")); }
  for (const name of SKILLS) {
    try {
      const folder = join(root, ".agents/skills", name);
      const path = join(folder, "SKILL.md");
      const content = await readFile(path, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
      const metadata = frontmatter ? parse(frontmatter[1]) : {};
      const ui = parse(await readFile(join(folder, "agents/openai.yaml"), "utf8"));
      const valid = metadata.name === name && typeof metadata.description === "string" && metadata.description.length > 20 && typeof ui.interface?.display_name === "string" && ui.interface?.short_description?.length >= 25 && ui.interface.short_description.length <= 64 && ui.interface?.default_prompt?.includes(`$${name}`) && ui.policy?.allow_implicit_invocation !== false;
      checks.push(check(`skill.${name}`, valid ? "PASS" : "BLOCK", "Skill discovery metadata and UI defaults"));
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^https?:/.test(target)) continue;
        if (!(await stat(resolve(dirname(path), target))).isFile()) throw new Error("Missing reference");
      }
    } catch { checks.push(check(`skill.${name}.references`, "BLOCK", "Invalid skill metadata or broken local guidance link")); }
  }
  try {
    const release = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));
    const content = JSON.stringify(release);
    checks.push(check("release.pins", content.includes(RELEASE.node) && content.includes(RELEASE.npm) ? "PASS" : "BLOCK", "Doctor release toolchain agrees with protected release workflow"));
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const expected = ["dist/", "docs/security-check.md", "README.md", "LICENSE", "SECURITY.md"];
    checks.push(check("package.allowlist", packageJson.files?.length === expected.length && expected.every((path) => packageJson.files.includes(path)) ? "PASS" : "BLOCK", "Development workflows, skills and local evidence stay outside the package allowlist"));
  } catch { checks.push(check("release.configuration", "BLOCK", "Cannot verify release pins or package allowlist")); }
  return summarize(checks);
}
