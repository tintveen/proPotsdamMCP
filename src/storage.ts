import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APP_NAME,
  DEFAULT_API_VERSION,
  DEFAULT_APP_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_LANGUAGE
} from "./constants.js";
import type { PendingPortalWrite, PortalConfig, StoredSession } from "./types.js";

const defaultDataDir = path.join(process.env.HOME ?? ".", "Library", "Application Support", APP_NAME);
const dataDir = process.env.PROPPOTSDAM_DATA_DIR ?? defaultDataDir;

export const paths = {
  dataDir,
  configFile: path.join(dataDir, "config.json"),
  sessionFile: path.join(dataDir, "session.json"),
  tracesDir: path.join(dataDir, "traces"),
  exportsDir: path.join(dataDir, "exports"),
  pendingWritesDir: path.join(dataDir, "pending-writes"),
  pendingWriteKeyFile: path.join(dataDir, "pending-write.key"),
  legacyConfirmationsDir: path.join(dataDir, "confirmations")
};

interface StoredPendingWriteEnvelope {
  pendingWrite: PendingPortalWrite;
  integrityTag: string;
}

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.tracesDir, { recursive: true });
  await mkdir(paths.exportsDir, { recursive: true });
  await mkdir(paths.pendingWritesDir, { recursive: true });
  await rm(paths.legacyConfirmationsDir, { recursive: true, force: true });
}

export async function loadConfig(): Promise<PortalConfig> {
  await ensureStorageDirs();
  const envConfig = environmentConfig();
  try {
    const raw = await readFile(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PortalConfig> & { downloadDir?: string };
    const merged = {
      ...defaultConfig(),
      ...parsed,
      exportDir: normalizeExportDir(parsed.exportDir ?? parsed.downloadDir),
      clientId: parsed.clientId ?? randomUUID()
    };
    delete (merged as { downloadDir?: string }).downloadDir;
    return {
      ...merged,
      ...envConfig,
      baseUrl: normalizeBaseUrl(envConfig.baseUrl ?? merged.baseUrl)
    };
  } catch {
    const config = defaultConfig();
    return {
      ...config,
      ...envConfig,
      baseUrl: normalizeBaseUrl(envConfig.baseUrl ?? config.baseUrl)
    };
  }
}

export async function saveConfig(config: PortalConfig): Promise<void> {
  await ensureStorageDirs();
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadSession(): Promise<StoredSession | null> {
  await ensureStorageDirs();
  try {
    return JSON.parse(await readFile(paths.sessionFile, "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await ensureStorageDirs();
  await writeFile(paths.sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function deleteSession(): Promise<void> {
  await rm(paths.sessionFile, { force: true });
}

export async function savePendingWrite(pendingWrite: PendingPortalWrite): Promise<void> {
  await ensureStorageDirs();
  if (pendingWrite.state !== "staged") {
    throw new Error("A new pending write must be saved in the staged state.");
  }
  const filePath = pendingWritePath(pendingWrite.pendingWriteHandle, "staged");
  await deleteExpiredPendingWrites();
  await writePendingWriteEnvelope(filePath, pendingWrite, "wx");
}

export async function loadPendingWrite(pendingWriteHandle: string): Promise<PendingPortalWrite | null> {
  await ensureStorageDirs();
  const filePath = pendingWritePath(pendingWriteHandle, "staged");
  try {
    const envelope = JSON.parse(await readFile(filePath, "utf8")) as StoredPendingWriteEnvelope;
    if (!await verifyPendingWriteEnvelope(envelope)) {
      return null;
    }
    const parsed = envelope.pendingWrite;
    return parsed.pendingWriteHandle === pendingWriteHandle && parsed.state === "staged" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listPendingWrites(now = new Date()): Promise<PendingPortalWrite[]> {
  await deleteExpiredPendingWrites(now);
  const entries = await readdir(paths.pendingWritesDir, { withFileTypes: true });
  const writes: PendingPortalWrite[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".claimed.json")) {
      continue;
    }
    const handle = entry.name.slice(0, -".json".length);
    if (!isValidPendingWriteHandle(handle)) {
      continue;
    }
    const pendingWrite = await loadPendingWrite(handle);
    if (pendingWrite) {
      writes.push(pendingWrite);
    }
  }
  return writes.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function claimPendingWrite(pendingWriteHandle: string, now = new Date()): Promise<PendingPortalWrite | null> {
  await ensureStorageDirs();
  const staged = await loadPendingWrite(pendingWriteHandle);
  if (!staged) {
    return null;
  }
  if (Date.parse(staged.expiresAt) <= now.getTime()) {
    await deletePendingWrite(pendingWriteHandle);
    return null;
  }
  const stagedPath = pendingWritePath(pendingWriteHandle, "staged");
  const claimedPath = pendingWritePath(pendingWriteHandle, "claimed");
  try {
    await rename(stagedPath, claimedPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
  const claimed: PendingPortalWrite = {
    ...staged,
    state: "claimed",
    claimedAt: now.toISOString()
  };
  await writePendingWriteEnvelope(claimedPath, claimed);
  return claimed;
}

export async function deletePendingWrite(pendingWriteHandle: string): Promise<boolean> {
  await ensureStorageDirs();
  const stagedPath = pendingWritePath(pendingWriteHandle, "staged");
  const cancelledPath = pendingWritePath(pendingWriteHandle, "cancelled");
  try {
    await rename(stagedPath, cancelledPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
  await rm(cancelledPath, { force: true });
  await deletePendingWriteArtifacts(pendingWriteHandle);
  return true;
}

export async function deleteClaimedPendingWrite(pendingWriteHandle: string): Promise<void> {
  await ensureStorageDirs();
  await rm(pendingWritePath(pendingWriteHandle, "claimed"), { force: true });
  await deletePendingWriteArtifacts(pendingWriteHandle);
}

export async function deleteExpiredPendingWrites(now = new Date()): Promise<number> {
  await ensureStorageDirs();
  const pendingWritesDir = path.resolve(paths.pendingWritesDir);
  const entries = await readdir(pendingWritesDir, { withFileTypes: true });
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    if (entry.name.endsWith(".claimed.json")) {
      continue;
    }
    const handle = entry.name.slice(0, -".json".length);
    if (!isValidPendingWriteHandle(handle)) {
      continue;
    }
    const filePath = pendingWritePath(handle, "staged");
    if (path.dirname(path.resolve(filePath)) !== pendingWritesDir) {
      continue;
    }
    try {
      const parsed = await loadPendingWrite(handle);
      if (!parsed) {
        if (await deletePendingWrite(handle)) {
          deleted += 1;
        }
        continue;
      }
      if (typeof parsed.expiresAt !== "string") {
        continue;
      }
      const expiresAt = Date.parse(parsed.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now.getTime()) {
        continue;
      }
      await rm(filePath, { force: true });
      await deletePendingWriteArtifacts(handle);
      deleted += 1;
    } catch {
      continue;
    }
  }
  return deleted;
}

export function pendingWriteArtifactsDir(pendingWriteHandle: string): string {
  assertValidPendingWriteHandle(pendingWriteHandle);
  const artifactPath = path.resolve(paths.pendingWritesDir, pendingWriteHandle);
  if (path.dirname(artifactPath) !== path.resolve(paths.pendingWritesDir)) {
    throw new Error("Pending write handle resolved outside the pending-writes directory.");
  }
  return artifactPath;
}

export function defaultConfig(): PortalConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    apiVersion: DEFAULT_API_VERSION,
    appVersion: DEFAULT_APP_VERSION,
    language: DEFAULT_LANGUAGE,
    exportDir: paths.exportsDir,
    clientId: randomUUID()
  };
}

export function normalizeBaseUrl(value: string | undefined): string {
  if (!value) {
    return DEFAULT_BASE_URL;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_BASE_URL;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function normalizeExportDir(value: string | undefined): string {
  if (!value) {
    return paths.exportsDir;
  }
  const legacyDefaultDir = path.join(paths.dataDir, "downloads");
  return path.normalize(value) === path.normalize(legacyDefaultDir) ? paths.exportsDir : value;
}

function pendingWritePath(pendingWriteHandle: string, state: "staged" | "claimed" | "cancelled"): string {
  assertValidPendingWriteHandle(pendingWriteHandle);
  const suffix = state === "staged" ? ".json" : `.${state}.json`;
  const filePath = path.resolve(paths.pendingWritesDir, `${pendingWriteHandle}${suffix}`);
  if (path.dirname(filePath) !== path.resolve(paths.pendingWritesDir)) {
    throw new Error("Pending write handle resolved outside the pending-writes directory.");
  }
  return filePath;
}

function assertValidPendingWriteHandle(pendingWriteHandle: string): void {
  if (!isValidPendingWriteHandle(pendingWriteHandle)) {
    throw new Error("Pending write handle must be non-empty and contain only letters, numbers, and hyphens.");
  }
}

function isValidPendingWriteHandle(pendingWriteHandle: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(pendingWriteHandle);
}

export async function deletePendingWriteArtifacts(pendingWriteHandle: string): Promise<void> {
  await rm(pendingWriteArtifactsDir(pendingWriteHandle), { recursive: true, force: true });
}

async function writePendingWriteEnvelope(
  filePath: string,
  pendingWrite: PendingPortalWrite,
  flag?: "wx"
): Promise<void> {
  const key = await loadPendingWriteIntegrityKey();
  const envelope: StoredPendingWriteEnvelope = {
    pendingWrite,
    integrityTag: pendingWriteIntegrityTag(pendingWrite, key)
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (flag === "wx") {
    await writeFileAtomicallyExclusive(filePath, serialized);
  } else {
    await writeFileAtomically(filePath, serialized);
  }
}

async function verifyPendingWriteEnvelope(envelope: StoredPendingWriteEnvelope): Promise<boolean> {
  if (!envelope?.pendingWrite || typeof envelope.integrityTag !== "string") {
    return false;
  }
  const actual = Buffer.from(envelope.integrityTag, "hex");
  if (actual.byteLength !== 32) {
    return false;
  }
  const key = await loadPendingWriteIntegrityKey();
  const expected = Buffer.from(pendingWriteIntegrityTag(envelope.pendingWrite, key), "hex");
  return timingSafeEqual(actual, expected);
}

function pendingWriteIntegrityTag(pendingWrite: PendingPortalWrite, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(pendingWrite)).digest("hex");
}

async function loadPendingWriteIntegrityKey(): Promise<Buffer> {
  try {
    return decodePendingWriteIntegrityKey(await readFile(paths.pendingWriteKeyFile, "utf8"));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  const generated = randomBytes(32);
  try {
    await writeFileAtomicallyExclusive(paths.pendingWriteKeyFile, `${generated.toString("base64")}\n`);
    return generated;
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    return decodePendingWriteIntegrityKey(await readFile(paths.pendingWriteKeyFile, "utf8"));
  }
}

async function writeFileAtomicallyExclusive(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function decodePendingWriteIntegrityKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.byteLength !== 32) {
    throw new Error("Pending-write integrity key is invalid.");
  }
  return key;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function environmentConfig(): Partial<PortalConfig> {
  const config: Partial<PortalConfig> = {};
  const username = process.env.PROPPOTSDAM_USERNAME?.trim();
  const baseUrl = process.env.PROPPOTSDAM_BASE_URL?.trim();
  if (username) {
    config.username = username;
  }
  if (baseUrl) {
    config.baseUrl = baseUrl;
  }
  return config;
}
