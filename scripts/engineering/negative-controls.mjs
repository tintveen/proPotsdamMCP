import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const markerNames = ["false", "FALSE", "False", "0", "", "N", "no", "unknown"];
const controls = [
  {
    id: "redirect-replay",
    file: "src/http/cookie-session.ts",
    before: 'const response = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });',
    after: 'const response = await this.fetchImpl(url, { ...init, headers, redirect: "follow" });',
    testFile: "tests/cookie-session.test.ts",
    tests: ["GET", "POST"].map((method) => ({
      name: `CookieSession never replays a permitted ${method} request through a native redirect`,
      assertion: /expected \[.*\/unapproved.*to deeply equal \[.*\/approved/s
    }))
  },
  {
    id: "secret-leakage",
    file: "src/portal/parsers.ts",
    before: "const scalars = flattenScalars(redactSecrets(safeDetailValues(parsed)));",
    after: "const scalars = flattenScalars(parsed);",
    testFile: "tests/parsers.test.ts",
    tests: [{
      name: "portal parsers removes secret keys and hidden or sensitive form values before flattening XML",
      assertion: /not to contain ['"]SECRET_['"]/
    }]
  },
  {
    id: "negative-authentication",
    file: "src/portal/parsers.ts",
    before: 'const authenticated = loggedEntry\n    ? ["X", "TRUE", "1", "Y", "YES"].includes(loggedEntry[1].trim().toUpperCase())\n    : Boolean(userId);',
    after: "const authenticated = Boolean(loggedEntry || userId);",
    testFile: "tests/parsers.test.ts",
    tests: markerNames.map((marker) => ({
      name: `portal parsers respects the explicit negative or unknown login marker '${marker}'`,
      assertion: /to match object.*authenticated: false/s
    }))
  }
];

function outcome(status, detail) {
  return { status, detail };
}

/** Evaluate the actual test report, not merely the runner's nonzero exit code. */
export function evaluateControlRun(run, expectedTests, mutated = false) {
  if (run.timedOut || run.signal || run.error || ![0, 1].includes(run.exitCode)) {
    return outcome("UNVERIFIED", "The test process failed to finish normally; a crash or timeout is not detection.");
  }
  const report = run.report;
  if (!report || !Array.isArray(report.testResults) || typeof report.success !== "boolean" ||
      !Number.isInteger(report.numPassedTests) || !Number.isInteger(report.numFailedTests)) {
    return outcome("UNVERIFIED", "The test runner did not produce a complete structured report.");
  }
  if (!run.completion || !["passed", "failed"].includes(run.completion.reason) || !Number.isInteger(run.completion.unhandledErrors)) {
    return outcome("UNVERIFIED", "The test runner did not confirm normal completion.");
  }
  if (run.completion.unhandledErrors !== 0 || /Unhandled (?:Error|Rejection|Exception)|Vitest caught .* unhandled/i.test(run.stderr ?? "")) {
    return outcome("UNVERIFIED", "An unhandled runtime error is not an expected assertion failure.");
  }
  if ((run.completion.reason === "passed") !== report.success) {
    return outcome("UNVERIFIED", "Completion status disagrees with the assertion report.");
  }
  const assertions = [];
  for (const suite of report.testResults) {
    if (!Array.isArray(suite.assertionResults) || (suite.status === "failed" && suite.assertionResults.length === 0)) {
      return outcome("UNVERIFIED", "A test suite failed before producing assertion evidence.");
    }
    assertions.push(...suite.assertionResults);
  }
  const names = new Set(expectedTests.map((test) => test.name));
  if (names.size !== expectedTests.length || expectedTests.length === 0) {
    return outcome("UNVERIFIED", "Expected test identities must be nonempty and unique.");
  }
  const executed = assertions.filter((test) => !["skipped", "todo", "pending"].includes(test.status));
  if (executed.length !== expectedTests.length || executed.some((test) => !names.has(test.fullName)) ||
      expectedTests.some((expected) => executed.filter((test) => test.fullName === expected.name).length !== 1)) {
    return outcome("UNVERIFIED", "Expected regression tests are missing, duplicated, or replaced by unrelated tests.");
  }
  if (report.numPassedTests !== executed.filter((test) => test.status === "passed").length ||
      report.numFailedTests !== executed.filter((test) => test.status === "failed").length) {
    return outcome("UNVERIFIED", "Test totals disagree with the assertion evidence.");
  }
  if (!mutated) {
    return run.exitCode === 0 && report.success && executed.every((test) => test.status === "passed")
      ? outcome("PASS", `${expectedTests.length} healthy regression assertions passed.`)
      : outcome("BLOCK", "The healthy baseline does not pass; mutation detection cannot be trusted.");
  }
  if (executed.some((test) => test.status === "passed") || run.exitCode === 0 || report.success) {
    return outcome("BLOCK", "At least one deliberately weakened safeguard escaped its regression assertion.");
  }
  for (const expected of expectedTests) {
    const actual = executed.find((test) => test.fullName === expected.name);
    const messages = actual.failureMessages;
    if (actual.status !== "failed" || !Array.isArray(messages) || messages.length !== 1 ||
        typeof messages[0] !== "string" || !/^AssertionError:/m.test(messages[0]) ||
        !(expected.assertion instanceof RegExp) || !expected.assertion.test(messages[0])) {
      return outcome("UNVERIFIED", "A selected test failed for a different reason than its expected safeguard assertion.");
    }
  }
  return outcome("PASS", `${expectedTests.length} expected safeguard assertion failures detected the temporary weakening.`);
}

function testEnvironment() {
  // Only OS process essentials are inherited; no portal, cloud, Codex, or npm credentials.
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "WINDIR"];
  return {
    ...Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    CI: "true",
    NO_COLOR: "1",
    PROPPOTSDAM_LIVE_TEST: "0"
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runTests(directory, selected, timeoutMs) {
  const reportPath = path.join(directory, "test-report.json");
  const completionPath = path.join(directory, "test-completion.json");
  for (const file of [reportPath, completionPath]) await rm(file, { force: true });
  const expectedTests = selected.flatMap((control) => control.tests);
  const args = [
    path.join(directory, "node_modules/vitest/vitest.mjs"), "run",
    ...new Set(selected.map((control) => control.testFile)),
    "--config", path.join(directory, "negative-controls.config.mjs"),
    "--reporter=json", "--reporter", path.join(directory, "completion-reporter.mjs"), "--outputFile", reportPath,
    "--testNamePattern", `^(?:${expectedTests.map((test) => escapeRegex(test.name)).join("|")})$`
  ];
  const execution = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: directory, env: testEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let error;
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.on("error", (cause) => { error = cause.code ?? "SPAWN_FAILED"; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, error, stderr });
    });
  });
  let report;
  let completion;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); } catch { /* Missing or malformed is UNVERIFIED. */ }
  try { completion = JSON.parse(await readFile(completionPath, "utf8")); } catch { /* Missing or malformed is UNVERIFIED. */ }
  return { ...execution, report, completion };
}

/** Run only synthetic tests; all deliberate weakening stays in disposable source copies. */
export async function runNegativeControls({ root, timeoutMs = 30000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    return { status: "UNVERIFIED", checks: [{ id: "negative-controls", ...outcome("UNVERIFIED", "Invalid test timeout.") }] };
  }
  const checks = [];
  let scratch;
  try {
    const sourceRoot = await realpath(root);
    const nodeModules = await realpath(path.join(sourceRoot, "node_modules"));
    scratch = await mkdtemp(path.join(os.tmpdir(), "propotsdam-safeguards-"));
    const originalSources = new Map();
    for (const control of controls) {
      if (!originalSources.has(control.file)) originalSources.set(control.file, await readFile(path.join(sourceRoot, control.file), "utf8"));
      if (originalSources.get(control.file).split(control.before).length !== 2) {
        checks.push({ id: control.id, ...outcome("BLOCK", "The controlled mutation no longer matches exactly once; review and update this safeguard control.") });
      }
    }
    if (checks.length === 0) {
      for (const directory of ["src", "tests"]) await cp(path.join(sourceRoot, directory), path.join(scratch, directory), { recursive: true, dereference: true });
      for (const file of ["package.json", "tsconfig.json"]) await cp(path.join(sourceRoot, file), path.join(scratch, file), { dereference: true });
      await symlink(nodeModules, path.join(scratch, "node_modules"), "dir");
      await writeFile(path.join(scratch, "negative-controls.config.mjs"), 'export default { cacheDir: "./.test-cache", test: { include: ["tests/**/*.test.ts"], fileParallelism: false, pool: "threads", testTimeout: 10000 } };\n');
      await writeFile(path.join(scratch, "completion-reporter.mjs"), 'import { writeFileSync } from "node:fs";\nexport default class { onTestRunEnd(_modules, errors, reason) { writeFileSync(new URL("./test-completion.json", import.meta.url), JSON.stringify({ reason, unhandledErrors: errors.length })); } }\n');
      checks.push({ id: "negative-controls-baseline", ...evaluateControlRun(await runTests(scratch, controls, timeoutMs), controls.flatMap((control) => control.tests)) });
      if (checks[0].status === "PASS") {
        for (const control of controls) {
          const target = path.join(scratch, control.file);
          const original = originalSources.get(control.file);
          try {
            await writeFile(target, original.replace(control.before, control.after));
            checks.push({ id: control.id, ...evaluateControlRun(await runTests(scratch, [control], timeoutMs), control.tests, true) });
          } finally {
            await writeFile(target, original);
          }
        }
      }
    }
    for (const [file, original] of originalSources) {
      if (await readFile(path.join(sourceRoot, file), "utf8") !== original) {
        checks.push({ id: "negative-controls-source-stability", ...outcome("UNVERIFIED", "Source changed during verification; repeat against a stable checkout.") });
      }
    }
  } catch (error) {
    checks.push({ id: "negative-controls", ...outcome("UNVERIFIED", `Could not complete synthetic safeguard controls (${error.code ?? "runner error"}).`) });
  } finally {
    if (scratch) {
      try { await rm(scratch, { recursive: true, force: true }); }
      catch { checks.push({ id: "negative-controls-cleanup", ...outcome("UNVERIFIED", "Temporary test copies could not be removed.") }); }
    }
  }
  const status = checks.some((check) => check.status === "BLOCK") ? "BLOCK" : checks.some((check) => check.status === "UNVERIFIED") ? "UNVERIFIED" : "PASS";
  return { status, checks };
}
