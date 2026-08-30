import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APP_NAME,
  DEFAULT_API_VERSION,
  DEFAULT_APP_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_LANGUAGE
} from "./constants.js";
import type { PendingWrite, PortalConfig, StoredSession } from "./types.js";

export const PENDING_WRITE_ENVELOPE_VERSION = 1 as const;
export const PENDING_WRITE_TTL_MS = 10 * 60 * 1_000;
export const PENDING_WRITE_CLAIM_STALE_MS = 10 * 60 * 1_000;

const activePendingWriteClaims = new Map<string, symbol>();

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
  legacyConfirmationsDir: path.join(dataDir, "confirmations"),
  legacyWasteConfirmationsDir: path.join(dataDir, "waste-confirmations")
};

interface StoredPendingWriteEnvelope {
  version: typeof PENDING_WRITE_ENVELOPE_VERSION;
  pendingWrite: PendingWrite;
  integrityTag: string;
}

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.tracesDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.exportsDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.pendingWritesDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(paths.dataDir, 0o700),
      chmod(paths.tracesDir, 0o700),
      chmod(paths.exportsDir, 0o700),
      chmod(paths.pendingWritesDir, 0o700)
    ]);
  }
  await Promise.all([
    rm(paths.legacyConfirmationsDir, { recursive: true, force: true }),
    rm(paths.legacyWasteConfirmationsDir, { recursive: true, force: true })
  ]);
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

export async function savePendingWrite(pendingWrite: PendingWrite): Promise<void> {
  await ensureStorageDirs();
  assertValidPendingWriteHandle(pendingWrite.pendingWriteHandle);
  if (!isPendingWrite(pendingWrite, pendingWrite.pendingWriteHandle, "staged")) {
    throw new Error("A new pending write must be saved in the staged state.");
  }
  const filePath = pendingWritePath(pendingWrite.pendingWriteHandle, "staged");
  await deleteExpiredPendingWrites();
  await writePendingWriteEnvelope(filePath, pendingWrite, "wx");
}

export async function loadPendingWrite(pendingWriteHandle: string): Promise<PendingWrite | null> {
  await ensureStorageDirs();
  const filePath = pendingWritePath(pendingWriteHandle, "staged");
  return loadPendingWriteFile(filePath, pendingWriteHandle, "staged");
}

export async function listPendingWrites(now = new Date()): Promise<PendingWrite[]> {
  await deleteExpiredPendingWrites(now);
  const entries = await readdir(paths.pendingWritesDir, { withFileTypes: true });
  const writes: PendingWrite[] = [];
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

export async function claimPendingWrite(pendingWriteHandle: string, now = new Date()): Promise<PendingWrite | null> {
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
  const claimToken = Symbol(pendingWriteHandle);
  if (activePendingWriteClaims.has(pendingWriteHandle)) {
    return null;
  }
  activePendingWriteClaims.set(pendingWriteHandle, claimToken);
  try {
    await rename(stagedPath, claimedPath);
  } catch (error) {
    releaseActivePendingWriteClaim(pendingWriteHandle, claimToken);
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
  const claimed: PendingWrite = {
    ...staged,
    state: "claimed",
    claimedAt: now.toISOString()
  };
  try {
    await writePendingWriteEnvelope(claimedPath, claimed);
    return claimed;
  } catch (error) {
    releaseActivePendingWriteClaim(pendingWriteHandle, claimToken);
    await rm(claimedPath, { force: true }).catch(() => undefined);
    await deletePendingWriteArtifacts(pendingWriteHandle).catch(() => undefined);
    throw error;
  }
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
  try {
    await ensureStorageDirs();
    await rm(pendingWritePath(pendingWriteHandle, "claimed"), { force: true });
    await deletePendingWriteArtifacts(pendingWriteHandle);
  } finally {
    activePendingWriteClaims.delete(pendingWriteHandle);
  }
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
    const claimed = entry.name.endsWith(".claimed.json");
    const suffix = claimed ? ".claimed.json" : ".json";
    const handle = entry.name.slice(0, -suffix.length);
    if (!isValidPendingWriteHandle(handle)) {
      continue;
    }
    const state = claimed ? "claimed" : "staged";
    const filePath = pendingWritePath(handle, state);
    if (path.dirname(path.resolve(filePath)) !== pendingWritesDir) {
      continue;
    }
    try {
      if (claimed && activePendingWriteClaims.has(handle)) {
        continue;
      }
      const parsed = await loadPendingWriteFile(filePath, handle, state);
      const cleanupAt = parsed
        ? claimed
          ? Date.parse(parsed.claimedAt!) + PENDING_WRITE_CLAIM_STALE_MS
          : Date.parse(parsed.expiresAt)
        : Number.NaN;
      if (parsed && !Number.isNaN(cleanupAt) && cleanupAt > now.getTime()) {
        continue;
      }
      if (!parsed && claimed) {
        const metadata = await stat(filePath).catch(() => null);
        const lastTransitionAt = metadata ? Math.max(metadata.ctimeMs, metadata.mtimeMs) : Number.NaN;
        if (!Number.isNaN(lastTransitionAt) && lastTransitionAt + PENDING_WRITE_CLAIM_STALE_MS > now.getTime()) {
          continue;
        }
      }
      if (await removePendingWriteFileAndArtifacts(filePath, handle)) {
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  const afterFiles = await readdir(pendingWritesDir, { withFileTypes: true });
  for (const entry of afterFiles) {
    if (!entry.isDirectory() || !isValidPendingWriteHandle(entry.name)) {
      continue;
    }
    const handle = entry.name;
    const [staged, claimed] = await Promise.all([
      stat(pendingWritePath(handle, "staged")).then(() => true).catch(() => false),
      stat(pendingWritePath(handle, "claimed")).then(() => true).catch(() => false)
    ]);
    if (staged || claimed) {
      continue;
    }
    const metadata = await stat(pendingWriteArtifactsDir(handle)).catch(() => null);
    if (metadata && metadata.mtimeMs <= now.getTime() - PENDING_WRITE_TTL_MS) {
      await deletePendingWriteArtifacts(handle);
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

async function removePendingWriteFileAndArtifacts(filePath: string, pendingWriteHandle: string): Promise<boolean> {
  try {
    await rm(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
  await deletePendingWriteArtifacts(pendingWriteHandle);
  return true;
}

function releaseActivePendingWriteClaim(pendingWriteHandle: string, claimToken: symbol): void {
  if (activePendingWriteClaims.get(pendingWriteHandle) === claimToken) {
    activePendingWriteClaims.delete(pendingWriteHandle);
  }
}

async function loadPendingWriteFile(
  filePath: string,
  expectedHandle: string,
  expectedState: "staged" | "claimed"
): Promise<PendingWrite | null> {
  try {
    const envelope = JSON.parse(await readFile(filePath, "utf8")) as StoredPendingWriteEnvelope;
    if (!await verifyPendingWriteEnvelope(envelope)) {
      return null;
    }
    return isPendingWrite(envelope.pendingWrite, expectedHandle, expectedState)
      ? envelope.pendingWrite
      : null;
  } catch {
    return null;
  }
}

function isPendingWrite(
  value: unknown,
  expectedHandle: string,
  expectedState: "staged" | "claimed"
): value is PendingWrite {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PendingWrite> & Record<string, unknown>;
  if (
    candidate.pendingWriteHandle !== expectedHandle
    || !isValidPendingWriteHandle(expectedHandle)
    || candidate.state !== expectedState
    || typeof candidate.destination !== "string"
    || candidate.destination.length === 0
    || typeof candidate.contractFingerprint !== "string"
    || candidate.contractFingerprint.length === 0
    || !isStringArray(candidate.review)
    || !isStringArray(candidate.warnings)
    || !isStringArray(candidate.privacyUrls)
    || !isIsoDate(candidate.createdAt)
    || !isIsoDate(candidate.expiresAt)
    || (expectedState === "claimed" && !isIsoDate(candidate.claimedAt))
  ) {
    return false;
  }

  if (candidate.kind === "portal_action" && candidate.workflow === "portal_action") {
    return typeof candidate.accountId === "string"
      && typeof candidate.domain === "string"
      && typeof candidate.actionId === "string"
      && typeof candidate.actionTitle === "string"
      && Boolean(candidate.values && typeof candidate.values === "object" && !Array.isArray(candidate.values))
      && Array.isArray(candidate.diff);
  }

  const validWasteKind = candidate.kind === "swp_bulky_waste" || candidate.kind === "potsdam_abandoned_waste";
  const matchingWorkflow = (candidate.kind === "swp_bulky_waste" && candidate.workflow === "bulky_waste_pickup")
    || (candidate.kind === "potsdam_abandoned_waste" && candidate.workflow === "abandoned_waste_report");
  if (!validWasteKind || !matchingWorkflow || !("payload" in candidate)) {
    return false;
  }
  if (candidate.artifacts === undefined) {
    return true;
  }
  if (!Array.isArray(candidate.artifacts)) {
    return false;
  }
  const artifactsDirectory = pendingWriteArtifactsDir(expectedHandle);
  return candidate.artifacts.every((artifact) => {
    if (!artifact || typeof artifact !== "object") {
      return false;
    }
    const item = artifact as unknown as Record<string, unknown>;
    return typeof item.filePath === "string"
      && path.dirname(path.resolve(item.filePath)) === artifactsDirectory
      && typeof item.filename === "string"
      && path.basename(item.filePath) === item.filename
      && typeof item.mimeType === "string"
      && Number.isSafeInteger(item.byteLength)
      && Number(item.byteLength) >= 0
      && typeof item.sha256 === "string"
      && /^[0-9a-f]{64}$/.test(item.sha256);
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function writePendingWriteEnvelope(
  filePath: string,
  pendingWrite: PendingWrite,
  flag?: "wx"
): Promise<void> {
  const key = await loadPendingWriteIntegrityKey();
  const envelope: StoredPendingWriteEnvelope = {
    version: PENDING_WRITE_ENVELOPE_VERSION,
    pendingWrite,
    integrityTag: pendingWriteIntegrityTag(PENDING_WRITE_ENVELOPE_VERSION, pendingWrite, key)
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (flag === "wx") {
    await writeFileAtomicallyExclusive(filePath, serialized);
  } else {
    await writeFileAtomically(filePath, serialized);
  }
}

async function verifyPendingWriteEnvelope(envelope: StoredPendingWriteEnvelope): Promise<boolean> {
  if (envelope?.version !== PENDING_WRITE_ENVELOPE_VERSION || !envelope.pendingWrite || typeof envelope.integrityTag !== "string") {
    return false;
  }
  const actual = Buffer.from(envelope.integrityTag, "hex");
  if (actual.byteLength !== 32) {
    return false;
  }
  const key = await loadPendingWriteIntegrityKey();
  const expected = Buffer.from(pendingWriteIntegrityTag(envelope.version, envelope.pendingWrite, key), "hex");
  return timingSafeEqual(actual, expected);
}

function pendingWriteIntegrityTag(version: number, pendingWrite: PendingWrite, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify({ version, pendingWrite })).digest("hex");
}

async function loadPendingWriteIntegrityKey(): Promise<Buffer> {
  try {
    const key = decodePendingWriteIntegrityKey(await readFile(paths.pendingWriteKeyFile, "utf8"));
    if (process.platform !== "win32") {
      await chmod(paths.pendingWriteKeyFile, 0o600);
    }
    return key;
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
