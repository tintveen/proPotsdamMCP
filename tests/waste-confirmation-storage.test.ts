import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const CONFIRMATION_ID = "00000000-0000-4000-8000-000000000001";
const FUTURE_ID = "00000000-0000-4000-8000-000000000002";

describe("external waste confirmation storage", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("saves and loads versioned confirmations with private filesystem permissions", async () => {
    const { storage } = await createStorage();
    const stagingDirectory = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    const stagedPath = path.join(stagingDirectory, "photo.jpg");
    await writeFile(stagedPath, "synthetic-photo", { mode: 0o644 });
    const confirmation = storedConfirmation(CONFIRMATION_ID, {
      stagedPhotos: [{
        stagedPath,
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        byteLength: 15
      }]
    });

    await storage.saveWasteConfirmation(confirmation);

    await expect(storage.loadWasteConfirmation(CONFIRMATION_ID)).resolves.toEqual(confirmation);
    if (process.platform !== "win32") {
      const confirmationFile = path.join(storage.wasteConfirmationPaths.confirmationsDir, `${CONFIRMATION_ID}.json`);
      expect((await stat(storage.wasteConfirmationPaths.confirmationsDir)).mode & 0o777).toBe(0o700);
      expect((await stat(storage.wasteConfirmationPaths.stagedPhotosDir)).mode & 0o777).toBe(0o700);
      expect((await stat(stagingDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(confirmationFile)).mode & 0o777).toBe(0o600);
      expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects unsafe ids and cannot delete files outside its storage directory", async () => {
    const { storage, tempDir } = await createStorage();
    const outsidePath = path.join(tempDir, "outside.json");
    await writeFile(outsidePath, "keep", "utf8");

    for (const unsafeId of ["", "abc-123", "../outside", "00000000-0000-4000-8000-000000000001/../outside"]) {
      await expect(storage.loadWasteConfirmation(unsafeId)).rejects.toThrow(/UUID/);
      await expect(storage.claimWasteConfirmation(unsafeId)).rejects.toThrow(/UUID/);
      await expect(storage.deleteWasteConfirmationArtifacts(unsafeId)).rejects.toThrow(/UUID/);
      await expect(storage.ensureWastePhotoStagingDir(unsafeId)).rejects.toThrow(/UUID/);
    }

    await expect(readFile(outsidePath, "utf8")).resolves.toBe("keep");
  });

  it("atomically allows exactly one concurrent claim", async () => {
    const { storage } = await createStorage();
    const stagingDirectory = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    await storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID));

    const results = await Promise.all(
      Array.from({ length: 12 }, () => storage.claimWasteConfirmation(CONFIRMATION_ID))
    );

    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "missing")).toHaveLength(11);
    await expect(storage.loadWasteConfirmation(CONFIRMATION_ID)).resolves.toBeNull();
    await expect(stat(stagingDirectory)).resolves.toBeDefined();

    await storage.deleteWasteConfirmationArtifacts(CONFIRMATION_ID);
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("consumes expired confirmations and removes their staged photos", async () => {
    const { storage } = await createStorage();
    const stagingDirectory = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    await writeFile(path.join(stagingDirectory, "expired.jpg"), "expired", { mode: 0o600 });
    await storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID, {
      createdAt: "2026-08-15T09:00:00.000Z",
      expiresAt: "2026-08-15T09:10:00.000Z"
    }));

    await expect(storage.claimWasteConfirmation(
      CONFIRMATION_ID,
      new Date("2026-08-15T09:10:00.000Z")
    )).resolves.toEqual({ status: "expired" });
    await expect(storage.loadWasteConfirmation(CONFIRMATION_ID)).resolves.toBeNull();
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps photos left by a process that crashed after an atomic claim", async () => {
    const { storage } = await createStorage();
    const stagingDirectory = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    await writeFile(path.join(stagingDirectory, "claimed.jpg"), "claimed", { mode: 0o600 });
    await storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID, {
      createdAt: "2026-08-15T09:00:00.000Z",
      expiresAt: "2026-08-15T09:10:00.000Z"
    }));

    await expect(storage.claimWasteConfirmation(
      CONFIRMATION_ID,
      new Date("2026-08-15T09:05:00.000Z")
    )).resolves.toMatchObject({ status: "claimed" });
    await expect(stat(stagingDirectory)).resolves.toBeDefined();

    await expect(storage.deleteExpiredWasteConfirmations(
      new Date("2026-08-15T09:10:00.000Z")
    )).resolves.toBe(1);
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sweeps only expired valid confirmations and their staged-photo directories", async () => {
    const { storage } = await createStorage();
    const expiredStaging = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    const futureStaging = await storage.ensureWastePhotoStagingDir(FUTURE_ID);
    await storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID, {
      expiresAt: "2026-08-15T09:00:00.000Z"
    }));
    await storage.saveWasteConfirmation(storedConfirmation(FUTURE_ID, {
      expiresAt: "2026-08-15T11:00:00.000Z"
    }));
    const malformedPath = path.join(storage.wasteConfirmationPaths.confirmationsDir, "10000000-0000-4000-8000-000000000003.json");
    await writeFile(malformedPath, "{", { mode: 0o600 });

    await expect(storage.deleteExpiredWasteConfirmations(
      new Date("2026-08-15T10:00:00.000Z")
    )).resolves.toBe(1);

    await expect(storage.loadWasteConfirmation(CONFIRMATION_ID)).resolves.toBeNull();
    await expect(storage.loadWasteConfirmation(FUTURE_ID)).resolves.toMatchObject({ confirmationId: FUTURE_ID });
    await expect(stat(expiredStaging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(futureStaging)).resolves.toBeDefined();
    await expect(readFile(malformedPath, "utf8")).resolves.toBe("{");
  });

  it("deletes pending confirmation and staged-photo artifacts explicitly", async () => {
    const { storage } = await createStorage();
    const stagingDirectory = await storage.ensureWastePhotoStagingDir(CONFIRMATION_ID);
    await writeFile(path.join(stagingDirectory, "photo.png"), "photo", { mode: 0o600 });
    await storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID));

    await storage.deleteWasteConfirmationArtifacts(CONFIRMATION_ID);

    await expect(storage.loadWasteConfirmation(CONFIRMATION_ID)).resolves.toBeNull();
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept unsupported versions or staged paths outside the confirmation directory", async () => {
    const { storage, tempDir } = await createStorage();
    await expect(storage.saveWasteConfirmation({
      ...storedConfirmation(CONFIRMATION_ID),
      version: 2
    } as never)).rejects.toThrow("Invalid stored waste confirmation");

    await expect(storage.saveWasteConfirmation(storedConfirmation(CONFIRMATION_ID, {
      stagedPhotos: [{
        stagedPath: path.join(tempDir, "outside.jpg"),
        filename: "outside.jpg",
        mimeType: "image/jpeg",
        byteLength: 10
      }]
    }))).rejects.toThrow("Invalid stored waste confirmation");
  });
});

async function createStorage() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-waste-confirmations-"));
  tempDirs.push(tempDir);
  process.env.PROPPOTSDAM_DATA_DIR = tempDir;
  vi.resetModules();
  const storage = await import("../src/waste/confirmation-storage.js");
  return { storage, tempDir };
}

function storedConfirmation(
  confirmationId: string,
  overrides: Partial<{
    createdAt: string;
    expiresAt: string;
    stagedPhotos: Array<{
      stagedPath: string;
      filename: string;
      mimeType: string;
      byteLength: number;
      sha256?: string;
    }>;
  }> = {}
) {
  return {
    version: 1 as const,
    confirmationId,
    kind: "swp_bulky_waste" as const,
    createdAt: overrides.createdAt ?? "2026-08-15T09:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2099-08-15T09:10:00.000Z",
    remoteFingerprint: "fixture-form-fingerprint",
    payload: {
      pickupAddress: "Fixture street 1",
      items: ["Fixture mattress"]
    },
    review: ["Pickup: Fixture street 1", "Items: Fixture mattress"],
    ...(overrides.stagedPhotos ? { stagedPhotos: overrides.stagedPhotos } : {})
  };
}
