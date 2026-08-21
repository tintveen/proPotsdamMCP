import { describe, expect, it } from "vitest";
import { PortalError } from "../src/errors.js";
import { toolErrorResult } from "../src/mcp.js";
import { redactSecrets } from "../src/utils/redact.js";

describe("secret redaction", () => {
  it("removes portal and external-form secret values", () => {
    const redacted = redactSecrets({
      password: "secret",
      formDefinition: "opaque-form-value",
      sessionId: "external-session",
      nonce: "external-nonce",
      headers: {
        cookie: "session=abc",
        "X-CSRF-Token": "csrf"
      },
      body: "sap-ffield_b64=abc123&form-definition=hidden123&safe=true"
    });

    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(JSON.stringify(redacted)).not.toContain("session=abc");
    expect(JSON.stringify(redacted)).not.toContain("csrf");
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(JSON.stringify(redacted)).not.toContain("opaque-form-value");
    expect(JSON.stringify(redacted)).not.toContain("external-session");
    expect(JSON.stringify(redacted)).not.toContain("external-nonce");
    expect(JSON.stringify(redacted)).not.toContain("hidden123");
  });

  it("redacts external hidden values in MCP error results", () => {
    const result = toolErrorResult(new PortalError(
      "Failed with form-definition=opaque123 and sessionId=external456",
      "EXTERNAL_FAILURE"
    ));
    expect(JSON.stringify(result)).not.toContain("opaque123");
    expect(JSON.stringify(result)).not.toContain("external456");
    expect(result.structuredContent.code).toBe("EXTERNAL_FAILURE");
  });

  it("preserves explicit uncertain-outcome guidance in MCP errors", () => {
    const result = toolErrorResult(new PortalError(
      "The final response could not be verified.",
      "SWP_AMBIGUOUS_WRITE",
      undefined,
      {
        outcomeUncertain: true,
        warnings: ["Do not retry automatically."]
      }
    ));

    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: "SWP_AMBIGUOUS_WRITE",
      outcomeUncertain: true,
      warnings: ["Do not retry automatically."]
    });
  });
});
