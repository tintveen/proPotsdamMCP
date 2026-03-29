import envPaths from "env-paths";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_NAME, DEFAULT_ALIASES, DEFAULT_API_VERSION, DEFAULT_APP_URL, DEFAULT_BASE_URL } from "./constants.js";
import type { PortalProfile } from "./types.js";

const paths = envPaths(APP_NAME, { suffix: "" });

export const storagePaths = {
  dataDir: paths.data,
  profileFile: path.join(paths.data, "profile.json"),
  storageStateFile: path.join(paths.data, "storage-state.json"),
  tracesDir: path.join(paths.data, "traces")
};

export function createDefaultProfile(): PortalProfile {
  return {
    baseUrl: DEFAULT_BASE_URL,
    appUrl: DEFAULT_APP_URL,
    apiVersion: DEFAULT_API_VERSION,
    aliases: {
      inbox: [...DEFAULT_ALIASES.inbox],
      documents: [...DEFAULT_ALIASES.documents]
    },
    discoveredEndpoints: []
  };
}

export async function ensureStorageDirs(): Promise<void> {
  await mkdir(storagePaths.dataDir, { recursive: true });
  await mkdir(storagePaths.tracesDir, { recursive: true });
}

export async function loadProfile(): Promise<PortalProfile> {
  await ensureStorageDirs();
  try {
    const raw = await readFile(storagePaths.profileFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PortalProfile>;
    return {
      ...createDefaultProfile(),
      ...parsed,
      aliases: {
        inbox: parsed.aliases?.inbox ?? [...DEFAULT_ALIASES.inbox],
        documents: parsed.aliases?.documents ?? [...DEFAULT_ALIASES.documents]
      },
      discoveredEndpoints: parsed.discoveredEndpoints ?? []
    };
  } catch {
    return createDefaultProfile();
  }
}

export async function saveProfile(profile: PortalProfile): Promise<void> {
  await ensureStorageDirs();
  await writeFile(storagePaths.profileFile, JSON.stringify(profile, null, 2));
}

export async function hasStoredSession(): Promise<boolean> {
  try {
    await readFile(storagePaths.storageStateFile, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredSession(): Promise<void> {
  await rm(storagePaths.storageStateFile, { force: true });
}
