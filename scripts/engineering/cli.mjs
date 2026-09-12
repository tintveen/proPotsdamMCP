#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, cleanEnvironment, run, summarize } from "./core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const command = args.shift();
const json = args.includes("--json");
let result;
try {
  const allowed = command === "doctor" ? ["--release", "--json"] : command === "review" ? ["--base", "--json"] : command === "preflight" ? ["--pr", "--json"] : ["--json"];
  let value;
  for (let i = 0; i < args.length; i++) {
    if (!allowed.includes(args[i])) throw new Error("Invalid arguments");
    if (["--base", "--pr"].includes(args[i])) {
      if (value || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Missing argument");
      value = args[++i];
    }
  }
  if (command === "doctor") result = await (await import("./doctor.mjs")).doctor(root, { release: args.includes("--release") });
  else if (command === "review" && value) result = await (await import("./review.mjs")).review(root, value);
  else if (command === "preflight" && /^[1-9]\d*$/.test(value ?? "")) result = await (await import("./preflight.mjs")).preflight(root, Number(value));
  else if (command === "check") {
    const { validateRepository } = await import("./validate.mjs");
    const checks = [...(await validateRepository(root)).checks];
    const env = cleanEnvironment();
    const helpers = await run(process.execPath, ["--test", "scripts/engineering/tests/*.test.mjs"], { cwd: root, env, timeout: 120_000 });
    checks.push(check("tests.engineering-commands", helpers.ok ? "PASS" : helpers.timedOut || helpers.code === "ENOENT" ? "UNVERIFIED" : "BLOCK", helpers.ok ? "CLI, evidence, workflow and protection regression tests passed" : "Command regression tests failed; run node --test scripts/engineering/tests/*.test.mjs for details"));
    const regressions = await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/cookie-session.test.ts", "tests/parsers.test.ts", "tests/portal-client.test.ts", "tests/potsdam-waste-client.test.ts", "tests/redact.test.ts", "tests/engineering-negative-controls.test.ts"], { cwd: root, env, timeout: 120_000 });
    checks.push(check("tests.audit-regressions", regressions.ok ? "PASS" : regressions.timedOut || regressions.code === "ENOENT" ? "UNVERIFIED" : "BLOCK", regressions.ok ? "Seven audit regression families and generated serialization cases passed" : "Audit regressions failed or unavailable; run npm test for details"));
    checks.push(...(await (await import("./negative-controls.mjs")).runNegativeControls({ root })).checks);
    result = summarize(checks);
  } else throw new Error("Invalid command");
} catch {
  result = summarize([check("command", "UNVERIFIED", "Command could not complete. Usage: doctor [--release], review --base <ref>, check, preflight --pr <number>; all accept --json")]);
}
if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  for (const item of result.checks) process.stdout.write(`${item.status} ${item.id}: ${item.detail}\n`);
  if (result.evidence) process.stdout.write(`Evidence: ${result.evidence}\n`);
  process.stdout.write(`${result.status}\n`);
}
process.exitCode = result.status === "PASS" ? 0 : result.status === "BLOCK" ? 1 : 2;
