import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes repo-local commands for auth and discovery", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(pkg.bin["propotsdam-mcp"]).toBe("dist/cli.js");
    expect(pkg.scripts["auth:set"]).toBe("node dist/cli.js auth set");
    expect(pkg.scripts.discover).toBe("node dist/cli.js discover");
    expect(pkg.scripts.actions).toBe("node dist/cli.js actions");
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts["release:check"]).toContain("npm pack --dry-run");
  });
});
