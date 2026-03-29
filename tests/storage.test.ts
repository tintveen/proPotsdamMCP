import { describe, expect, it } from "vitest";
import { createDefaultProfile } from "../src/storage.js";

describe("storage defaults", () => {
  it("creates a default profile with the expected portal URLs", () => {
    const profile = createDefaultProfile();
    expect(profile.baseUrl).toContain("easysquare.com");
    expect(profile.appUrl).toContain("/propotsdam-kundenportal/index.html#");
    expect(profile.aliases.inbox.length).toBeGreaterThan(0);
    expect(profile.aliases.documents.length).toBeGreaterThan(0);
  });
});
