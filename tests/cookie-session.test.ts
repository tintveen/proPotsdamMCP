import { describe, expect, it } from "vitest";
import { CookieSession } from "../src/http/cookie-session.js";
import type { PortalConfig } from "../src/types.js";

describe("CookieSession", () => {
  it("names invalid config.baseUrl values in URL errors", () => {
    const config: PortalConfig = {
      baseUrl: "info@tintveen.com",
      apiVersion: "6.262",
      appVersion: "6.262.8",
      language: "de",
      exportDir: "/tmp/exports",
      clientId: "client-id"
    };
    const session = new CookieSession(config);

    expect(() => session.buildUrl("/propotsdam-kundenportal/api5/authenticate")).toThrow(
      "Invalid config baseUrl"
    );
  });
});
