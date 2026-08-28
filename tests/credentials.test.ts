import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";
import type { PendingPortalWrite } from "../src/types.js";

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

describe("pending-write storage hardening", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    delete process.env.PROPPOTSDAM_USERNAME;
    delete process.env.PROPPOTSDAM_PASSWORD;
    delete process.env.PROPPOTSDAM_BASE_URL;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("saves immutable pending writes, atomically claims them once, and deletes claimed state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { claimPendingWrite, deleteClaimedPendingWrite, loadPendingWrite, paths, savePendingWrite } = await import("../src/storage.js");
    const pendingWrite = testPendingWrite("abc-123");

    await savePendingWrite(pendingWrite);
    await expect(loadPendingWrite("abc-123")).resolves.toMatchObject({
      pendingWriteHandle: "abc-123",
      state: "staged",
      actionId: "save_partner",
      values: { phone_ref: "+15550100001" }
    });
    await expect(savePendingWrite(pendingWrite)).rejects.toMatchObject({ code: "EEXIST" });

    const storedPath = path.join(paths.pendingWritesDir, "abc-123.json");
    const tampered = (await readFile(storedPath, "utf8")).replace("+15550100001", "+15550999999");
    await writeFile(storedPath, tampered, "utf8");
    await expect(loadPendingWrite("abc-123")).resolves.toBeNull();

    await savePendingWrite(testPendingWrite("claim-123"));

    await expect(claimPendingWrite("claim-123")).resolves.toMatchObject({
      pendingWriteHandle: "claim-123",
      state: "claimed",
      claimedAt: expect.any(String)
    });
    await expect(claimPendingWrite("claim-123")).resolves.toBeNull();
    await expect(loadPendingWrite("claim-123")).resolves.toBeNull();
    await deleteClaimedPendingWrite("claim-123");
  });

  it("rejects invalid pending-write handles instead of sanitizing them", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { claimPendingWrite, deletePendingWrite, loadPendingWrite, savePendingWrite } = await import("../src/storage.js");
    const invalidIds = ["", "../outside", "abc.def", "abc_def", "abc def", " abc", "abc\n"];

    for (const pendingWriteHandle of invalidIds) {
      await expect(savePendingWrite(testPendingWrite(pendingWriteHandle))).rejects.toThrow(/Pending write handle/);
      await expect(loadPendingWrite(pendingWriteHandle)).rejects.toThrow(/Pending write handle/);
      await expect(claimPendingWrite(pendingWriteHandle)).rejects.toThrow(/Pending write handle/);
      await expect(deletePendingWrite(pendingWriteHandle)).rejects.toThrow(/Pending write handle/);
    }
  });

  it("does not let path traversal delete files outside the pending-writes directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const outsideFile = path.join(tempDir, "outside.json");
    await writeFile(outsideFile, "keep me", "utf8");

    const { deletePendingWrite } = await import("../src/storage.js");

    await expect(deletePendingWrite("../outside")).rejects.toThrow(/Pending write handle/);
    await expect(readdir(tempDir)).resolves.toContain("outside.json");
  });

  it("deletes expired staged writes while preserving future, claimed, and malformed files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const { claimPendingWrite, deleteExpiredPendingWrites, ensureStorageDirs, paths, savePendingWrite } = await import("../src/storage.js");
    await ensureStorageDirs();
    await mkdir(path.join(paths.pendingWritesDir, "nested"));
    await savePendingWrite(testPendingWrite("expired-1", "2099-05-03T09:00:00.000Z"));
    await savePendingWrite(testPendingWrite("future-1", "2099-05-03T11:00:00.000Z"));
    await savePendingWrite(testPendingWrite("claimed-1", "2099-05-03T09:00:00.000Z"));
    await claimPendingWrite("claimed-1", new Date("2099-05-03T08:00:00.000Z"));
    await writeFile(path.join(paths.pendingWritesDir, "malformed.json"), "{", "utf8");
    await writeFile(
      path.join(paths.pendingWritesDir, "bad_id.json"),
      JSON.stringify(testPendingWrite("bad_id", "2099-05-03T09:00:00.000Z")),
      "utf8"
    );

    await expect(deleteExpiredPendingWrites(new Date("2099-05-03T10:00:00.000Z"))).resolves.toBe(2);
    await expect(readdir(paths.pendingWritesDir)).resolves.toEqual(expect.arrayContaining([
      "bad_id.json",
      "claimed-1.claimed.json",
      "future-1.json",
      "nested"
    ]));
    await expect(readdir(paths.pendingWritesDir)).resolves.not.toContain("expired-1.json");
    await expect(readdir(paths.pendingWritesDir)).resolves.not.toContain("malformed.json");
  });

  it("invalidates and removes legacy confirmation records during migration", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    vi.resetModules();

    const legacyDir = path.join(tempDir, "confirmations");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "old-confirmation.json"), "{}", "utf8");
    const { ensureStorageDirs, paths } = await import("../src/storage.js");

    await ensureStorageDirs();
    await expect(readdir(tempDir)).resolves.not.toContain(path.basename(paths.legacyConfirmationsDir));
  });
});

function testPendingWrite(pendingWriteHandle: string, expiresAt = "2099-01-01T00:00:00.000Z"): PendingPortalWrite {
  return {
    pendingWriteHandle,
    state: "staged",
    accountId: "MAX",
    domain: "profile_account_setting",
    actionId: "save_partner",
    actionTitle: "Speichern",
    recordId: "PROFILE-1",
    recordTitle: "Meine Daten",
    xuclass: "ESQ_IA_PART",
    serviceUrl: "/profile-service",
    contractFingerprint: "contract-fingerprint",
    values: { phone_ref: "+15550100001" },
    diff: [{
      name: "phone_ref",
      currentValue: "+15550100000",
      proposedValue: "+15550100001"
    }],
    createdAt: "2026-05-03T09:00:00.000Z",
    expiresAt
  };
}
