import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";

const tempDirs: string[] = [];

describe("credential configuration", () => {
  afterEach(async () => {
    vi.doUnmock("keytar");
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    delete process.env.PROPPOTSDAM_USERNAME;
    delete process.env.PROPPOTSDAM_PASSWORD;
    delete process.env.PROPPOTSDAM_BASE_URL;
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

  it("uses environment credentials before loading keytar", async () => {
    process.env.PROPPOTSDAM_USERNAME = "max@example.test";
    process.env.PROPPOTSDAM_PASSWORD = "cloud-secret";
    vi.doMock("keytar", () => {
      throw new Error("keytar should not be imported for environment credentials");
    });
    vi.resetModules();

    const { EnvironmentCredentialStore } = await import("../src/credentials.js");
    const store = new EnvironmentCredentialStore();

    await expect(store.getPassword("max@example.test")).resolves.toBe("cloud-secret");
  });

  it("falls back to the wrapped credential store when environment credentials are absent", async () => {
    const calls: string[] = [];
    const fallback: CredentialStore = {
      getPassword: async (account) => {
        calls.push(account);
        return "keychain-secret";
      },
      setPassword: async () => undefined,
      deletePassword: async () => true
    };

    const { EnvironmentCredentialStore } = await import("../src/credentials.js");
    const store = new EnvironmentCredentialStore(fallback);

    await expect(store.getPassword("max@example.test")).resolves.toBe("keychain-secret");
    expect(calls).toEqual(["max@example.test"]);
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
    delete process.env.PROPPOTSDAM_USERNAME;
    delete process.env.PROPPOTSDAM_PASSWORD;
    delete process.env.PROPPOTSDAM_BASE_URL;
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
      username: "user@example.test",
      baseUrl: "user@example.test"
    }));

    const config = await loadConfig();
    expect(config).toMatchObject({
      username: "user@example.test",
      baseUrl: DEFAULT_BASE_URL
    });
  });

  it("migrates legacy downloadDir to exportDir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { paths, loadConfig } = await import("../src/storage.js");
    await writeFile(paths.configFile, JSON.stringify({
      username: "user@example.test",
      baseUrl: "https://portal.example.test",
      downloadDir: "/tmp/legacy-downloads"
    }));

    const config = await loadConfig();
    expect(config).toMatchObject({
      username: "user@example.test",
      exportDir: "/tmp/legacy-downloads"
    });
    expect(JSON.stringify(config)).not.toContain("downloadDir");
  });

  it("renames the legacy default local output folder to exports", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { paths, loadConfig } = await import("../src/storage.js");
    await writeFile(paths.configFile, JSON.stringify({
      username: "user@example.test",
      baseUrl: "https://portal.example.test",
      exportDir: path.join(tempDir, "downloads")
    }));

    const config = await loadConfig();
    expect(config.exportDir).toBe(paths.exportsDir);
  });

  it("uses cloud environment username and baseUrl when no local config exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    process.env.PROPPOTSDAM_USERNAME = "cloud-user@example.test";
    process.env.PROPPOTSDAM_BASE_URL = "https://portal.example.test/";
    vi.resetModules();

    const { loadConfig } = await import("../src/storage.js");

    const config = await loadConfig();
    expect(config).toMatchObject({
      username: "cloud-user@example.test",
      baseUrl: "https://portal.example.test"
    });
  });
});
