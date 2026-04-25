import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/utils/redact.js";

describe("secret redaction", () => {
  it("removes password, cookie, csrf, and sap-ffield values", () => {
    const redacted = redactSecrets({
      password: "secret",
      headers: {
        cookie: "session=abc",
        "X-CSRF-Token": "csrf"
      },
      body: "sap-ffield_b64=abc123&safe=true"
    });

    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(JSON.stringify(redacted)).not.toContain("session=abc");
    expect(JSON.stringify(redacted)).not.toContain("csrf");
    expect(JSON.stringify(redacted)).not.toContain("abc123");
  });
});
