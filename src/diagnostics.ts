import path from "node:path";
import process from "node:process";
import type { CredentialStore } from "./credentials.js";
import { KeytarCredentialStore } from "./credentials.js";
import { SECRET_REDACTION } from "./constants.js";
import { PortalClient } from "./portal/portal-client.js";
import { loadConfig, paths } from "./storage.js";
import type { AuthResult, PortalConfig } from "./types.js";
import { redactSecrets } from "./utils/redact.js";

export type DoctorSource = "env" | "config" | "keychain" | "none";

export interface DoctorReport {
  generatedAt: string;
  runtime: {
    nodeVersion: string;
    nodeSupported: boolean;
    platform: string;
    arch: string;
    command?: string;
  };
  paths: {
    dataDir: string;
    configFile: string;
    tracesDir: string;
    exportsDir: string;
    pendingWritesDir: string;
  };
  config: {
    baseUrl: string;
    apiVersion: string;
    appVersion: string;
    language: string;
    usernameConfigured: boolean;
    usernameSource: Exclude<DoctorSource, "keychain">;
  };
  credentials: {
    passwordConfigured: boolean;
    passwordSource: Exclude<DoctorSource, "config">;
    error?: string;
  };
  session: {
    checked: boolean;
    authenticated: boolean;
    state?: AuthResult["state"];
    action?: AuthResult["action"];
    reason?: string;
    error?: string;
  };
  portalReachability: {
    checked: boolean;
    reachable: boolean;
    method?: "HEAD" | "GET";
    status?: number;
    url: string;
    error?: string;
  };
}

export interface DoctorOptions {
  loadConfig?: () => Promise<PortalConfig>;
  credentialStore?: Pick<CredentialStore, "getPassword">;
  client?: Pick<PortalClient, "status">;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  argv?: string[];
  now?: () => Date;
  timeoutMs?: number;
}

export async function createDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const config = await (options.loadConfig ?? loadConfig)();
  const effectiveUsername = env.PROPPOTSDAM_USERNAME?.trim() || config.username;
  const usernameSource = detectUsernameSource(config, env);
  const credentials = await checkCredentials(effectiveUsername, env, options.credentialStore);
  const report: DoctorReport = {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    runtime: {
      nodeVersion: normalizeNodeVersion(options.nodeVersion ?? process.versions.node),
      nodeSupported: isNodeSupported(options.nodeVersion ?? process.versions.node),
      platform: process.platform,
      arch: process.arch,
      command: commandName(options.argv ?? process.argv)
    },
    paths: {
      dataDir: paths.dataDir,
      configFile: paths.configFile,
      tracesDir: paths.tracesDir,
      exportsDir: paths.exportsDir,
      pendingWritesDir: paths.pendingWritesDir
    },
    config: {
      baseUrl: safeUrl(config.baseUrl),
      apiVersion: config.apiVersion,
      appVersion: config.appVersion,
      language: config.language,
      usernameConfigured: Boolean(effectiveUsername),
      usernameSource
    },
    credentials,
    session: await checkSession(options.client ?? new PortalClient()),
    portalReachability: await checkPortalReachability(config.baseUrl, options.fetchImpl ?? fetch, options.timeoutMs ?? 5_000)
  };
  return report;
}

function detectUsernameSource(config: PortalConfig, env: NodeJS.ProcessEnv): DoctorReport["config"]["usernameSource"] {
  if (env.PROPPOTSDAM_USERNAME?.trim()) {
    return "env";
  }
  return config.username ? "config" : "none";
}

async function checkCredentials(
  username: string | undefined,
  env: NodeJS.ProcessEnv,
  credentialStore: Pick<CredentialStore, "getPassword"> | undefined
): Promise<DoctorReport["credentials"]> {
  const envUsername = env.PROPPOTSDAM_USERNAME?.trim();
  const envPassword = env.PROPPOTSDAM_PASSWORD;
  if (envPassword && (!envUsername || envUsername === username)) {
    return {
      passwordConfigured: true,
      passwordSource: "env"
    };
  }
  if (!username) {
    return {
      passwordConfigured: false,
      passwordSource: "none"
    };
  }

  try {
    const password = await (credentialStore ?? new KeytarCredentialStore()).getPassword(username);
    return {
      passwordConfigured: Boolean(password),
      passwordSource: password ? "keychain" : "none"
    };
  } catch (error) {
    return {
      passwordConfigured: false,
      passwordSource: "none",
      error: errorMessage(error)
    };
  }
}

async function checkSession(client: Pick<PortalClient, "status">): Promise<DoctorReport["session"]> {
  try {
    const status = await client.status();
    return {
      checked: true,
      authenticated: status.authenticated,
      state: status.state,
      action: status.action,
      reason: status.reason ? errorMessage(status.reason) : undefined
    };
  } catch (error) {
    return {
      checked: true,
      authenticated: false,
      error: errorMessage(error)
    };
  }
}

async function checkPortalReachability(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<DoctorReport["portalReachability"]> {
  try {
    const response = await fetchWithTimeout(fetchImpl, baseUrl, "HEAD", timeoutMs);
    return {
      checked: true,
      reachable: true,
      method: "HEAD",
      status: response.status,
      url: safeUrl(baseUrl)
    };
  } catch (headError) {
    if (isAbortError(headError)) {
      return {
        checked: true,
        reachable: false,
        method: "HEAD",
        url: safeUrl(baseUrl),
        error: errorMessage(headError)
      };
    }
    try {
      const response = await fetchWithTimeout(fetchImpl, baseUrl, "GET", timeoutMs);
      return {
        checked: true,
        reachable: true,
        method: "GET",
        status: response.status,
        url: safeUrl(baseUrl)
      };
    } catch (getError) {
      return {
        checked: true,
        reachable: false,
        method: "GET",
        url: safeUrl(baseUrl),
        error: errorMessage(getError)
      };
    }
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, method: "HEAD" | "GET", timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNodeVersion(version: string): string {
  return version.replace(/^v/, "");
}

function isNodeSupported(version: string): boolean {
  const major = Number.parseInt(normalizeNodeVersion(version).split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 26;
}

function commandName(argv: string[]): string | undefined {
  const command = argv[1] ? path.basename(argv[1]) : undefined;
  return command || undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message) as string;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = SECRET_REDACTION;
    }
    if (url.password) {
      url.password = SECRET_REDACTION;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return errorMessage(value);
  }
}
