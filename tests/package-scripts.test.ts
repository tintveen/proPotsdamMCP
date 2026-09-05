import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes repo-local commands for auth and discovery", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(pkg.bin["propotsdam-mcp"]).toBe("dist/bin.js");
    expect(pkg.bin["propotsdam-cli"]).toBe("dist/bin.js");
    expect(pkg.scripts["auth:set"]).toBe("node dist/bin.js auth set");
    expect(pkg.scripts.discover).toBe("node dist/bin.js discover");
    expect(pkg.scripts.actions).toBe("node dist/bin.js actions");
    expect(pkg.scripts.build).toContain("rmSync('dist'");
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts["package:verify"]).toBe("node scripts/verify-package.mjs");
    expect(pkg.scripts["release:check"]).toContain("npm run package:verify");
  });

  it("publishes an explicit local tarball path, not GitHub shorthand", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const publishCommands = workflow.match(/^\s+npm publish .+$/gm)?.map((line) => line.trim());

    expect(publishCommands).toEqual(['npm publish "./release-artifacts/$ARCHIVE" --access public']);
  });
});
