import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../storage.js";

export const WASTE_CONFIRMATION_VERSION = 1 as const;
export const WASTE_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

export type WasteConfirmationKind = "swp_bulky_waste" | "potsdam_abandoned_waste";

export interface StagedWastePhotoMetadata {
  stagedPath: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  sha256?: string;
}

export interface StoredWasteConfirmation {
  version: typeof WASTE_CONFIRMATION_VERSION;
  confirmationId: string;
  kind: WasteConfirmationKind;
  createdAt: string;
  expiresAt: string;
  remoteFingerprint: string;
  payload: unknown;
  review: string[];
  stagedPhotos?: StagedWastePhotoMetadata[];
}

export type WasteConfirmationClaimResult =
  | { status: "claimed"; confirmation: StoredWasteConfirmation }
  | { status: "missing" }
  | { status: "expired" };

const confirmationsDir = path.resolve(paths.dataDir, "waste-confirmations");
const stagedPhotosDir = path.resolve(confirmationsDir, "staged-photos");

export const wasteConfirmationPaths = {
  confirmationsDir,
  stagedPhotosDir
} as const;

export async function saveWasteConfirmation(confirmation: StoredWasteConfirmation): Promise<void> {
  assertStoredWasteConfirmation(confirmation, confirmation.confirmationId);
  await ensureWasteConfirmationDirs();
  await hardenStagedPhotoFiles(confirmation);

  const filePath = confirmationPath(confirmation.confirmationId);
  const temporaryPath = containedFilePath(
    confirmationsDir,
    `.${confirmation.confirmationId}.${randomUUID()}.tmp`
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(confirmation, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadWasteConfirmation(confirmationId: string): Promise<StoredWasteConfirmation | null> {
  assertConfirmationId(confirmationId);
  await ensureWasteConfirmationDirs();
  try {
    const parsed = JSON.parse(await readFile(confirmationPath(confirmationId), "utf8")) as unknown;
    return isStoredWasteConfirmation(parsed, confirmationId) ? parsed : null;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * Atomically consumes a confirmation before any external write begins.
 *
 * A successful claim intentionally leaves staged photos in place so the caller
 * can use them for the external request. The caller must remove them in a
 * `finally` block with `deleteWasteConfirmationArtifacts` after the attempt.
 */
export async function claimWasteConfirmation(
  confirmationId: string,
  now = new Date()
): Promise<WasteConfirmationClaimResult> {
  assertConfirmationId(confirmationId);
  assertValidDate(now, "now");
  await ensureWasteConfirmationDirs();

  const sourcePath = confirmationPath(confirmationId);
  const claimedPath = claimedConfirmationPath(confirmationId);
  let retainClaim = false;
  try {
    await rename(sourcePath, claimedPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { status: "missing" };
    }
    throw error;
  }

  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(claimedPath, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        await removeStagedPhotoDirectory(confirmationId);
        return { status: "missing" };
      }
      throw error;
    }

    if (!isStoredWasteConfirmation(parsed, confirmationId)) {
      await removeStagedPhotoDirectory(confirmationId);
      return { status: "missing" };
    }
    if (Date.parse(parsed.expiresAt) <= now.getTime()) {
      await removeStagedPhotoDirectory(confirmationId);
      return { status: "expired" };
    }
    retainClaim = true;
    return { status: "claimed", confirmation: parsed };
  } finally {
    if (!retainClaim) {
      await rm(claimedPath, { force: true });
    }
  }
}

export async function deleteExpiredWasteConfirmations(now = new Date()): Promise<number> {
  assertValidDate(now, "now");
  await ensureWasteConfirmationDirs();

  const entries = await readdir(confirmationsDir, { withFileTypes: true });
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const confirmationId = entry.name.slice(0, -".json".length);
    if (!isValidConfirmationId(confirmationId)) {
      continue;
    }

    let confirmation: StoredWasteConfirmation | null;
    try {
      confirmation = await loadWasteConfirmation(confirmationId);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
    if (!confirmation) {
      const metadata = await stat(confirmationPath(confirmationId)).catch(() => null);
      if (metadata && metadata.mtimeMs <= now.getTime() - WASTE_CONFIRMATION_TTL_MS) {
        await Promise.all([
          rm(confirmationPath(confirmationId), { force: true }),
          removeStagedPhotoDirectory(confirmationId)
        ]);
        deleted += 1;
      }
      continue;
    }
    if (Date.parse(confirmation.expiresAt) > now.getTime()) {
      continue;
    }

    const result = await claimWasteConfirmation(confirmationId, now);
    if (result.status === "expired") {
      deleted += 1;
    }
  }

  const afterConfirmations = await readdir(confirmationsDir, { withFileTypes: true });
  for (const entry of afterConfirmations) {
    if (!entry.isFile() || !entry.name.endsWith(".claim")) {
      continue;
    }
    const confirmationId = entry.name.slice(0, -".claim".length);
    if (!isValidConfirmationId(confirmationId)) {
      continue;
    }
    const claimPath = claimedConfirmationPath(confirmationId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
    } catch {
      parsed = null;
    }
    const metadata = await stat(claimPath).catch(() => null);
    const expired = isStoredWasteConfirmation(parsed, confirmationId)
      ? Date.parse(parsed.expiresAt) <= now.getTime()
      : Boolean(metadata && metadata.mtimeMs <= now.getTime() - WASTE_CONFIRMATION_TTL_MS);
    if (expired) {
      await Promise.all([
        rm(claimPath, { force: true }),
        removeStagedPhotoDirectory(confirmationId)
      ]);
      deleted += 1;
    }
  }

  const stagedEntries = await readdir(stagedPhotosDir, { withFileTypes: true });
  for (const entry of stagedEntries) {
    if (!entry.isDirectory() || !isValidConfirmationId(entry.name)) {
      continue;
    }
    const confirmationId = entry.name;
    const [pending, claimed] = await Promise.all([
      stat(confirmationPath(confirmationId)).then(() => true).catch(() => false),
      stat(claimedConfirmationPath(confirmationId)).then(() => true).catch(() => false)
    ]);
    if (pending || claimed) {
      continue;
    }
    const metadata = await stat(stagedPhotoDirectory(confirmationId)).catch(() => null);
    if (metadata && metadata.mtimeMs <= now.getTime() - WASTE_CONFIRMATION_TTL_MS) {
      await removeStagedPhotoDirectory(confirmationId);
    }
  }
  return deleted;
}

export async function deleteWasteConfirmationArtifacts(confirmationId: string): Promise<void> {
  assertConfirmationId(confirmationId);
  await ensureWasteConfirmationDirs();
  await Promise.all([
    rm(confirmationPath(confirmationId), { force: true }),
    rm(claimedConfirmationPath(confirmationId), { force: true }),
    removeStagedPhotoDirectory(confirmationId)
  ]);
}

export async function ensureWastePhotoStagingDir(confirmationId: string): Promise<string> {
  assertConfirmationId(confirmationId);
  await ensureWasteConfirmationDirs();
  const directory = stagedPhotoDirectory(confirmationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function ensureWasteConfirmationDirs(): Promise<void> {
  await mkdir(confirmationsDir, { recursive: true, mode: 0o700 });
  await chmod(confirmationsDir, 0o700);
  await mkdir(stagedPhotosDir, { recursive: true, mode: 0o700 });
  await chmod(stagedPhotosDir, 0o700);
}

async function removeStagedPhotoDirectory(confirmationId: string): Promise<void> {
  await rm(stagedPhotoDirectory(confirmationId), { recursive: true, force: true });
}

async function hardenStagedPhotoFiles(confirmation: StoredWasteConfirmation): Promise<void> {
  if (!confirmation.stagedPhotos?.length) {
    return;
  }
  const directory = await ensureWastePhotoStagingDir(confirmation.confirmationId);
  const resolvedDirectory = await realpath(directory);
  for (const photo of confirmation.stagedPhotos) {
    const metadata = await lstat(photo.stagedPath);
    if (!metadata.isFile()) {
      throw new Error(`Staged waste photo '${photo.filename}' must be a regular file.`);
    }
    const resolvedPhotoPath = await realpath(photo.stagedPath);
    if (path.dirname(resolvedPhotoPath) !== resolvedDirectory) {
      throw new Error(`Staged waste photo '${photo.filename}' resolved outside its confirmation directory.`);
    }
    await chmod(resolvedPhotoPath, 0o600);
  }
}

function confirmationPath(confirmationId: string): string {
  assertConfirmationId(confirmationId);
  return containedFilePath(confirmationsDir, `${confirmationId}.json`);
}

function claimedConfirmationPath(confirmationId: string): string {
  assertConfirmationId(confirmationId);
  return containedFilePath(confirmationsDir, `${confirmationId}.claim`);
}

function stagedPhotoDirectory(confirmationId: string): string {
  assertConfirmationId(confirmationId);
  const directory = path.resolve(stagedPhotosDir, confirmationId);
  if (path.dirname(directory) !== stagedPhotosDir) {
    throw new Error("Waste confirmation id resolved outside the staged-photo directory.");
  }
  return directory;
}

function containedFilePath(directory: string, filename: string): string {
  const filePath = path.resolve(directory, filename);
  if (path.dirname(filePath) !== directory) {
    throw new Error("Waste confirmation path resolved outside its storage directory.");
  }
  return filePath;
}

function assertStoredWasteConfirmation(value: unknown, expectedId: string): asserts value is StoredWasteConfirmation {
  if (!isStoredWasteConfirmation(value, expectedId)) {
    throw new Error("Invalid stored waste confirmation.");
  }
}

function isStoredWasteConfirmation(value: unknown, expectedId: string): value is StoredWasteConfirmation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<StoredWasteConfirmation>;
  return candidate.version === WASTE_CONFIRMATION_VERSION &&
    candidate.confirmationId === expectedId &&
    isValidConfirmationId(candidate.confirmationId) &&
    isWasteConfirmationKind(candidate.kind) &&
    isIsoDate(candidate.createdAt) &&
    isIsoDate(candidate.expiresAt) &&
    typeof candidate.remoteFingerprint === "string" &&
    candidate.remoteFingerprint.length > 0 &&
    "payload" in candidate &&
    Array.isArray(candidate.review) &&
    candidate.review.every((line) => typeof line === "string") &&
    (candidate.stagedPhotos === undefined || (
      Array.isArray(candidate.stagedPhotos) &&
      candidate.stagedPhotos.every((photo) => isStagedWastePhotoMetadata(photo, expectedId))
    ));
}

function isStagedWastePhotoMetadata(value: unknown, confirmationId: string): value is StagedWastePhotoMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const photo = value as Partial<StagedWastePhotoMetadata>;
  if (typeof photo.stagedPath !== "string" ||
    typeof photo.filename !== "string" ||
    typeof photo.mimeType !== "string" ||
    typeof photo.byteLength !== "number" ||
    !Number.isSafeInteger(photo.byteLength) ||
    photo.byteLength < 0 ||
    (photo.sha256 !== undefined && typeof photo.sha256 !== "string")) {
    return false;
  }
  const resolved = path.resolve(photo.stagedPath);
  return path.dirname(resolved) === stagedPhotoDirectory(confirmationId);
}

function isWasteConfirmationKind(value: unknown): value is WasteConfirmationKind {
  return value === "swp_bulky_waste" || value === "potsdam_abandoned_waste";
}

function assertConfirmationId(confirmationId: string): void {
  if (!isValidConfirmationId(confirmationId)) {
    throw new Error("Waste confirmation id must be a UUID and contain only hexadecimal characters and hyphens.");
  }
}

function isValidConfirmationId(confirmationId: unknown): confirmationId is string {
  return typeof confirmationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(confirmationId);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertValidDate(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
