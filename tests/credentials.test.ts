import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";

const tempDirs: string[] = [];

describe("credential configuration", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("stores only username/baseUrl in config and sends password to the credential store", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const calls: Array<[string, string]> = [];
    const store: CredentialStore = {
      getPassword: async () => null,
      setPassword: async (account, password) => {
        calls.push([account, password]);
      },
      deletePassword: async () => true
    };

    const { configureCredentials } = await import("../src/portal/portal-client.js");
    const { loadConfig } = await import("../src/storage.js");

    await configureCredentials({
      username: "max@example.test",
      password: "super-secret",
      baseUrl: "https://portal.example.test",
      credentialStore: store
    });

    const config = await loadConfig();
    expect(config).toMatchObject({
      username: "max@example.test",
      baseUrl: "https://portal.example.test"
    });
    expect(JSON.stringify(config)).not.toContain("super-secret");
    expect(calls).toEqual([["max@example.test", "super-secret"]]);
  });
});

describe("keytar adapter", () => {
  it("uses the default export when keytar is loaded through ESM", async () => {
    const keytar = await import("keytar");

    expect(typeof keytar.default?.setPassword).toBe("function");
  });
});

describe("config repair", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("repairs invalid baseUrl values to the ProPotsdam default", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { paths, loadConfig } = await import("../src/storage.js");
    const { DEFAULT_BASE_URL } = await import("../src/constants.js");
    await writeFile(paths.configFile, JSON.stringify({
      username: "info@tintveen.com",
      baseUrl: "info@tintveen.com"
    }));

    const config = await loadConfig();
    expect(config).toMatchObject({
      username: "info@tintveen.com",
      baseUrl: DEFAULT_BASE_URL
    });
  });
});
