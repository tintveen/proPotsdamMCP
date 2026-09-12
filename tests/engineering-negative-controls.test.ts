import { describe, expect, it } from "vitest";

const { evaluateControlRun } = await import(new URL("../scripts/engineering/negative-controls.mjs", import.meta.url).href);
const expected = [{ name: "safeguard rejects the synthetic unsafe request", assertion: /expected unsafe to equal safe/ }];

function run(status = "failed", failureMessages = ["AssertionError: expected unsafe to equal safe\n at test.ts:10:1"]) {
  return {
    exitCode: status === "failed" ? 1 : 0,
    signal: null,
    timedOut: false,
    stderr: "",
    completion: { reason: status === "failed" ? "failed" : "passed", unhandledErrors: 0 },
    report: {
      success: status === "passed",
      numPassedTests: status === "passed" ? 1 : 0,
      numFailedTests: status === "failed" ? 1 : 0,
      testResults: [{
        status,
        assertionResults: [{ fullName: expected[0]!.name, status, failureMessages }]
      }]
    }
  };
}

describe("controlled safeguard failure evidence", () => {
  it("requires a passing healthy baseline and the expected failing mutation assertion", () => {
    expect(evaluateControlRun(run("passed", []), expected).status).toBe("PASS");
    expect(evaluateControlRun(run(), expected, true).status).toBe("PASS");
    expect(evaluateControlRun(run(), expected).status).toBe("BLOCK");
    expect(evaluateControlRun(run("passed", []), expected, true).status).toBe("BLOCK");
  });

  it.each([
    { timedOut: true },
    { signal: "SIGKILL" },
    { exitCode: 137 },
    { exitCode: null },
    { error: "ENOENT" },
    { report: undefined },
    { report: { success: false, testResults: [] } },
    { completion: undefined },
    { completion: { reason: "interrupted", unhandledErrors: 0 } },
    { completion: { reason: "failed", unhandledErrors: 1 } },
    { completion: { reason: "passed", unhandledErrors: 0 } },
    { stderr: "Vitest caught 1 unhandled error during the test run." }
  ])("does not count runner failure or absent evidence as detection: %j", (override) => {
    expect(evaluateControlRun({ ...run(), ...override }, expected, true).status).toBe("UNVERIFIED");
  });

  it("rejects missing, skipped, duplicated, and unrelated regression tests", () => {
    const missing = run();
    missing.report.testResults = [];
    const skipped = run("skipped");
    const duplicate = run();
    duplicate.report.testResults[0]!.assertionResults.push({ ...duplicate.report.testResults[0]!.assertionResults[0]! });
    const unrelated = run();
    unrelated.report.testResults[0]!.assertionResults[0]!.fullName = "an unrelated failing test";
    for (const evidence of [missing, skipped, duplicate, unrelated]) {
      expect(evaluateControlRun(evidence, expected, true).status).toBe("UNVERIFIED");
    }
  });

  it.each([
    ["TypeError: cannot read property expected unsafe to equal safe"],
    ["AssertionError: unrelated expectation failed"],
    ["Error: Test timed out in 10000ms"],
    [],
    ["AssertionError: expected unsafe to equal safe", "TypeError: teardown failed"]
  ])("requires the specific assertion instead of any failure: %j", (...messages) => {
    expect(evaluateControlRun(run("failed", messages), expected, true).status).toBe("UNVERIFIED");
  });

  it("rejects inconsistent counts and collection errors", () => {
    const counts = run();
    counts.report.numFailedTests = 2;
    expect(evaluateControlRun(counts, expected, true).status).toBe("UNVERIFIED");
    const collection = run();
    collection.report.testResults.push({ status: "failed", assertionResults: [] });
    expect(evaluateControlRun(collection, expected, true).status).toBe("UNVERIFIED");
  });

  it("requires an explicit nonempty, unique set of expected tests", () => {
    expect(evaluateControlRun(run(), [], true).status).toBe("UNVERIFIED");
    expect(evaluateControlRun(run(), [...expected, ...expected], true).status).toBe("UNVERIFIED");
  });
});
