import { describe, expect, it } from "vitest";
import { encodeSapFfieldBase64 } from "../src/portal/encoding.js";

describe("sap-ffield_b64 encoding", () => {
  it("matches the Easysquare escaping rules for %, &, and +", () => {
    const encoded = encodeSapFfieldBase64({
      user: "USER%&+",
      password: "pw%&+"
    });

    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "user=USER%25%26%2B&password=pw%25%26%2B"
    );
  });
});
