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
import type { PortalConfig, StoredSession } from "./types.js";

const defaultDataDir = path.join(process.env.HOME ?? ".", "Library", "Application Support", APP_NAME);
const dataDir = process.env.PROPPOTSDAM_DATA_DIR ?? defaultDataDir;

export const paths = {
  dataDir,
  configFile: path.join(dataDir, "config.json"),
  sessionFile: path.join(dataDir, "session.json"),
  tracesDir: path.join(dataDir, "traces"),
  downloadsDir: path.join(dataDir, "downloads")
};

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.tracesDir, { recursive: true });
  await mkdir(paths.downloadsDir, { recursive: true });
}

export async function loadConfig(): Promise<PortalConfig> {
  await ensureStorageDirs();
  try {
    const raw = await readFile(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PortalConfig>;
    const merged = {
      ...defaultConfig(),
      ...parsed,
      downloadDir: parsed.downloadDir ?? paths.downloadsDir,
      clientId: parsed.clientId ?? randomUUID()
    };
    return {
      ...merged,
      baseUrl: normalizeBaseUrl(merged.baseUrl)
    };
  } catch {
    return defaultConfig();
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

export function defaultConfig(): PortalConfig {
  return {
    baseUrl: DEFAULT_BASE_URL,
    apiVersion: DEFAULT_API_VERSION,
    appVersion: DEFAULT_APP_VERSION,
    language: DEFAULT_LANGUAGE,
    downloadDir: paths.downloadsDir,
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
