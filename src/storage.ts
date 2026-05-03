import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  await writeFile(confirmationPath(confirmation.confirmationId), `${JSON.stringify(confirmation, null, 2)}\n`, "utf8");
}

export async function loadConfirmation(confirmationId: string): Promise<StoredPortalActionConfirmation | null> {
  await ensureStorageDirs();
  try {
    return JSON.parse(await readFile(confirmationPath(confirmationId), "utf8")) as StoredPortalActionConfirmation;
  } catch {
    return null;
  }
}

export async function deleteConfirmation(confirmationId: string): Promise<void> {
  await rm(confirmationPath(confirmationId), { force: true });
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
  const safeId = confirmationId.replace(/[^a-zA-Z0-9-]/g, "");
  return path.join(paths.confirmationsDir, `${safeId}.json`);
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
