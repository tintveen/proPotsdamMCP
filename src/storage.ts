import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APP_NAME,
  DEFAULT_API_VERSION,
  DEFAULT_APP_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_LANGUAGE
} from "./constants.js";
import type { PortalConfig, StoredPortalActionConfirmation, StoredSession } from "./types.js";

const defaultDataDir = path.join(process.env.HOME ?? ".", "Library", "Application Support", APP_NAME);
const dataDir = process.env.PROPPOTSDAM_DATA_DIR ?? defaultDataDir;

export const paths = {
  dataDir,
  configFile: path.join(dataDir, "config.json"),
  sessionFile: path.join(dataDir, "session.json"),
  tracesDir: path.join(dataDir, "traces"),
  exportsDir: path.join(dataDir, "exports"),
  confirmationsDir: path.join(dataDir, "confirmations")
};

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.tracesDir, { recursive: true });
  await mkdir(paths.exportsDir, { recursive: true });
  await mkdir(paths.confirmationsDir, { recursive: true });
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

export async function saveConfirmation(confirmation: StoredPortalActionConfirmation): Promise<void> {
  await ensureStorageDirs();
  const filePath = confirmationPath(confirmation.confirmationId);
  await deleteExpiredConfirmations();
  await writeFile(filePath, `${JSON.stringify(confirmation, null, 2)}\n`, "utf8");
}

export async function loadConfirmation(confirmationId: string): Promise<StoredPortalActionConfirmation | null> {
  await ensureStorageDirs();
  const filePath = confirmationPath(confirmationId);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as StoredPortalActionConfirmation;
  } catch {
    return null;
  }
}

export async function deleteConfirmation(confirmationId: string): Promise<void> {
  await rm(confirmationPath(confirmationId), { force: true });
}

export async function deleteExpiredConfirmations(now = new Date()): Promise<number> {
  await ensureStorageDirs();
  const confirmationDir = path.resolve(paths.confirmationsDir);
  const entries = await readdir(confirmationDir, { withFileTypes: true });
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const confirmationId = entry.name.slice(0, -".json".length);
    if (!isValidConfirmationId(confirmationId)) {
      continue;
    }

    const filePath = confirmationPath(confirmationId);
    if (path.dirname(path.resolve(filePath)) !== confirmationDir) {
      continue;
    }

    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StoredPortalActionConfirmation>;
      if (parsed.confirmationId !== confirmationId || typeof parsed.expiresAt !== "string") {
        continue;
      }
      const expiresAt = Date.parse(parsed.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now.getTime()) {
        continue;
      }
      await rm(filePath, { force: true });
      deleted += 1;
    } catch {
      continue;
    }
  }
  return deleted;
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

function confirmationPath(confirmationId: string): string {
  if (!isValidConfirmationId(confirmationId)) {
    throw new Error("Confirmation id must be non-empty and contain only letters, numbers, and hyphens.");
  }
  const filePath = path.resolve(paths.confirmationsDir, `${confirmationId}.json`);
  if (path.dirname(filePath) !== path.resolve(paths.confirmationsDir)) {
    throw new Error("Confirmation id resolved outside the confirmations directory.");
  }
  return filePath;
}

function isValidConfirmationId(confirmationId: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(confirmationId);
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
