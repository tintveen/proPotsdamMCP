import { describe, expect, it } from "vitest";
import corpus from "../evals/conversational-approval.json" with { type: "json" };

describe("conversational approval evaluation corpus", () => {
  it("covers every required conservative orchestration decision", () => {
    const categories = new Set(corpus.cases.map((testCase) => testCase.category));

    expect(categories).toEqual(new Set([
      "wait_boundary",
      "explicit_approval",
      "ambiguous",
      "modification",
      "refusal",
      "expiry",
      "individual_selection",
      "subset_selection",
      "unlimited_explicit_batch"
    ]));
  });

  it("commits only displayed handles and never models approval wording as tool input", () => {
    for (const testCase of corpus.cases) {
      expect(testCase.expected.handles.every((handle) => testCase.displayedHandles.includes(handle))).toBe(true);
      expect(testCase.expected).not.toHaveProperty("approvalText");
      if (testCase.expected.decision === "commit") {
        expect(testCase.expected.tool).toBe("propotsdam_commit_pending_writes");
        expect(testCase.expected.handles.length).toBeGreaterThan(0);
      } else {
        expect(testCase.expected.tool).not.toBe("propotsdam_commit_pending_writes");
      }
    }
  });

  it("keeps explicit batches uncapped by the product schema", () => {
    const batch = corpus.cases.find((testCase) => testCase.category === "unlimited_explicit_batch")!;

    expect(batch.displayedHandles.length).toBeGreaterThan(10);
    expect(batch.expected.handles).toEqual(batch.displayedHandles);
  });
});
