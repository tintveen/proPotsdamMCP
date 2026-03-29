import { describe, expect, it, vi } from "vitest";
import { printOutput } from "../src/utils/output.js";

describe("output rendering", () => {
  it("renders json output", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    printOutput({ ok: true }, "json");
    expect(write).toHaveBeenCalledWith('{\n  "ok": true\n}\n');
    write.mockRestore();
  });
});
