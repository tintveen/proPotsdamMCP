import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingWasteWrite } from "../src/types.js";

const tempDirs: string[] = [];

describe("shared pending-action storage", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists one versioned HMAC-protected waste action with private permissions", async () => {
    const { storage } = await createStorage();
    const pending = await stagedPotsdamWrite(storage, "pending-photo-1");

    await storage.savePendingWrite(pending);
    vi.resetModules();
    const restarted = await import("../src/storage.js");

    await expect(restarted.loadPendingWrite(pending.pendingWriteHandle)).resolves.toMatchObject({
      kind: "potsdam_abandoned_waste",
      workflow: "abandoned_waste_report",
      state: "staged"
    });
    const envelopePath = path.join(restarted.paths.pendingWritesDir, `${pending.pendingWriteHandle}.json`);
    const envelope = JSON.parse(await readFile(envelopePath, "utf8")) as { version: number };
    expect(envelope.version).toBe(1);
    if (process.platform !== "win32") {
      expect((await stat(restarted.paths.dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(restarted.paths.pendingWritesDir)).mode & 0o777).toBe(0o700);
      expect((await stat(envelopePath)).mode & 0o777).toBe(0o600);
      expect((await stat(pending.artifacts![0]!.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(restarted.paths.pendingWriteKeyFile)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects envelope tampering and removes the invalid record and artifacts on maintenance", async () => {
    const { storage } = await createStorage();
    const pending = await stagedPotsdamWrite(storage, "pending-tamper-1");
    await storage.savePendingWrite(pending);
    const envelopePath = path.join(storage.paths.pendingWritesDir, `${pending.pendingWriteHandle}.json`);
    const tampered = (await readFile(envelopePath, "utf8")).replace("Fixture pile", "Changed pile");
    await writeFile(envelopePath, tampered, { mode: 0o600 });

    await expect(storage.loadPendingWrite(pending.pendingWriteHandle)).resolves.toBeNull();
    await expect(storage.deleteExpiredPendingWrites(new Date("2026-08-15T10:01:00.000Z"))).resolves.toBe(1);
    await expect(stat(envelopePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(storage.pendingWriteArtifactsDir(pending.pendingWriteHandle))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("protects an active claim from maintenance and sweeps it only after a stale restart window", async () => {
    const { storage } = await createStorage();
    const pending = await stagedPotsdamWrite(storage, "pending-claim-1", "2026-08-15T10:10:00.000Z");
    await storage.savePendingWrite(pending);

    const claims = await Promise.all(
      Array.from({ length: 12 }, () => storage.claimPendingWrite(pending.pendingWriteHandle, new Date("2026-08-15T10:05:00.000Z")))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(storage.deleteExpiredPendingWrites(new Date("2026-08-15T10:20:00.000Z"))).resolves.toBe(0);
    await expect(stat(storage.pendingWriteArtifactsDir(pending.pendingWriteHandle))).resolves.toBeDefined();

    vi.resetModules();
    const restarted = await import("../src/storage.js");
    await expect(restarted.deleteExpiredPendingWrites(new Date("2026-08-15T10:14:59.999Z"))).resolves.toBe(0);
    await expect(restarted.deleteExpiredPendingWrites(new Date("2026-08-15T10:15:00.000Z"))).resolves.toBe(1);
    await expect(stat(restarted.pendingWriteArtifactsDir(pending.pendingWriteHandle))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists each pending action once and removes only old orphan artifact directories", async () => {
    const { storage } = await createStorage();
    const first = await stagedPotsdamWrite(storage, "pending-list-1");
    const second = bulkyWrite("pending-list-2");
    await storage.savePendingWrite(first);
    await storage.savePendingWrite(second);

    await expect(storage.listPendingWrites()).resolves.toMatchObject([
      { pendingWriteHandle: "pending-list-1" },
      { pendingWriteHandle: "pending-list-2" }
    ]);

    const orphan = storage.pendingWriteArtifactsDir("pending-orphan-1");
    await mkdir(orphan, { recursive: true, mode: 0o700 });
    await writeFile(path.join(orphan, "orphan.jpg"), "orphan", { mode: 0o600 });
    const old = new Date("2026-08-15T09:00:00.000Z");
    await utimes(orphan, old, old);
    await storage.deleteExpiredPendingWrites(new Date("2026-08-15T10:00:01.000Z"));
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates unversioned records and deletes both legacy confirmation stores on upgrade", async () => {
    const { storage, tempDir } = await createStorage(false);
    await mkdir(path.join(tempDir, "confirmations"), { recursive: true });
    await mkdir(path.join(tempDir, "waste-confirmations", "staged-photos"), { recursive: true });
    await storage.ensureStorageDirs();
    const legacyHandle = "legacy-pending-1";
    await writeFile(path.join(storage.paths.pendingWritesDir, `${legacyHandle}.json`), JSON.stringify({
      pendingWrite: bulkyWrite(legacyHandle),
      integrityTag: "0".repeat(64)
    }), { mode: 0o600 });

    await storage.deleteExpiredPendingWrites(new Date("2026-08-15T10:00:00.000Z"));

    await expect(stat(path.join(storage.paths.pendingWritesDir, `${legacyHandle}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(tempDir, "confirmations"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(tempDir, "waste-confirmations"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createStorage(ensure = true) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-pending-actions-"));
  tempDirs.push(tempDir);
  process.env.PROPPOTSDAM_DATA_DIR = tempDir;
  vi.resetModules();
  const storage = await import("../src/storage.js");
  if (ensure) {
    await storage.ensureStorageDirs();
  }
  return { storage, tempDir };
}

async function stagedPotsdamWrite(
  storage: typeof import("../src/storage.js"),
  pendingWriteHandle: string,
  expiresAt = "2099-08-15T10:10:00.000Z"
): Promise<PendingWasteWrite> {
  const artifactDirectory = storage.pendingWriteArtifactsDir(pendingWriteHandle);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(artifactDirectory, "fixture.jpg");
  await writeFile(filePath, "synthetic-photo", { mode: 0o600 });
  return {
    pendingWriteHandle,
    state: "staged",
    kind: "potsdam_abandoned_waste",
    workflow: "abandoned_waste_report",
    destination: "Potsdam abandoned-waste reporting service",
    contractFingerprint: "b".repeat(64),
    review: ["Description: Fixture pile"],
    warnings: ["The report may become public."],
    privacyUrls: ["https://example.test/privacy"],
    payload: { draft: { description: "Fixture pile" }, location: {}, photos: [] },
    artifacts: [{
      filePath,
      filename: "fixture.jpg",
      mimeType: "image/jpeg",
      byteLength: 15,
      sha256: "a".repeat(64)
    }],
    createdAt: "2026-08-15T10:00:00.000Z",
    expiresAt
  };
}

function bulkyWrite(pendingWriteHandle: string): PendingWasteWrite {
  return {
    pendingWriteHandle,
    state: "staged",
    kind: "swp_bulky_waste",
    workflow: "bulky_waste_pickup",
    destination: "STEP bulky-waste pickup service",
    contractFingerprint: "a".repeat(64),
    review: ["Item: Fixture mattress"],
    warnings: [],
    privacyUrls: [],
    payload: { draft: { items: [] } },
    createdAt: "2026-08-15T10:00:01.000Z",
    expiresAt: "2099-08-15T10:10:00.000Z"
  };
}
