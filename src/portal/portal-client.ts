import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  API5_SERVICES_PATH,
  AUTHENTICATE_PATH,
  DEFAULT_APP_VERSION,
  LOGGED_SERVICES_PATH
} from "../constants.js";
import type { CredentialStore } from "../credentials.js";
import { KeytarCredentialStore } from "../credentials.js";
import { PortalError } from "../errors.js";
import { CookieSession } from "../http/cookie-session.js";
import {
  deleteSession,
  loadConfig,
  loadSession,
  saveConfig,
  saveSession
} from "../storage.js";
import type {
  AuthResult,
  DocumentItem,
  DownloadResult,
  InboxItem,
  ListResult,
  PortalConfig,
  PortalSection
} from "../types.js";
import { formEncodeSapFfield } from "./encoding.js";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractServices,
  findSectionServices,
  normalizeDetailText,
  parseSessionStatus
} from "./parsers.js";

export class PortalClient {
  constructor(
    private readonly credentialStore: CredentialStore = new KeytarCredentialStore(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async status(): Promise<AuthResult> {
    const config = await loadConfig();
    const session = new CookieSession(config, await loadSession(), this.fetchImpl);
    return this.validateSession(config, session);
  }

  async login(): Promise<AuthResult> {
    const config = await loadConfig();
    if (!config.username) {
      return {
        state: "action_required",
        authenticated: false,
        action: "set_credentials",
        reason: "No username is configured. Run `propotsdam-mcp auth set` first."
      };
    }

    const password = await this.credentialStore.getPassword(config.username);
    if (!password) {
      return {
        state: "action_required",
        authenticated: false,
        action: "set_credentials",
        reason: "No password was found in the macOS Keychain. Run `propotsdam-mcp auth set`."
      };
    }

    const session = new CookieSession(config, null, this.fetchImpl);
    const response = await session.post(
      `${AUTHENTICATE_PATH}?api=${encodeURIComponent(config.apiVersion)}&sap-language=${encodeURIComponent(config.language)}`,
      formEncodeSapFfield({
        user: config.username.toUpperCase(),
        password
      }),
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-CSRF-Token": "fetch"
        }
      }
    );

    if (!response.ok) {
      return classifyAuthFailure(response.status, response.body);
    }

    const validated = await this.validateSession(config, session);
    if (validated.authenticated) {
      await saveSession(session.serialize());
      return validated;
    }

    const fallback = parseSessionStatus(response.body, response.contentType);
    if (fallback.authenticated) {
      await saveSession(session.serialize());
      return fallback;
    }

    return {
      state: "error",
      authenticated: false,
      action: "unknown",
      reason: "Login request succeeded, but the portal did not expose an authenticated session marker."
    };
  }

  async logout(): Promise<{ ok: true }> {
    const config = await loadConfig();
    const session = new CookieSession(config, await loadSession(), this.fetchImpl);
    await session.get(`${API5_SERVICES_PATH}/logoff`).catch(() => undefined);
    await deleteSession();
    return { ok: true };
  }

  async listInbox(): Promise<ListResult<InboxItem>> {
    return this.listSection("inbox") as Promise<ListResult<InboxItem>>;
  }

  async getInboxItem(id: string): Promise<InboxItem> {
    const { items } = await this.listInbox();
    const match = items.find((item) => item.id === id || item.title === id);
    if (!match) {
      throw new PortalError(`Inbox item '${id}' was not found.`, "NOT_FOUND", 404);
    }

    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const url = this.buildActionUrl(config, match.serviceUrl ?? match.detailUrl, match.id, "get");
    if (!url) {
      return match;
    }

    const response = await session.get(url);
    return {
      ...match,
      detailText: normalizeDetailText(response.body, response.contentType)
    };
  }

  async listDocuments(): Promise<ListResult<DocumentItem>> {
    return this.listSection("documents") as Promise<ListResult<DocumentItem>>;
  }

  async downloadDocument(id: string): Promise<DownloadResult> {
    const config = await loadConfig();
    const { items } = await this.listDocuments();
    const match = items.find((item) => item.id === id || item.title === id || item.filename === id);
    if (!match) {
      throw new PortalError(`Document '${id}' was not found.`, "NOT_FOUND", 404);
    }
    if (!match.downloadable) {
      throw new PortalError(`Document '${id}' is not marked as downloadable.`, "NOT_DOWNLOADABLE", 410);
    }

    const session = await this.authenticatedSession(config);
    const downloadUrl =
      match.detailUrl && /^https?:\/\//i.test(match.detailUrl)
        ? match.detailUrl
        : this.buildActionUrl(config, match.serviceUrl ?? match.detailUrl, match.resourceId ?? match.id, "get", match.resourceOrigin);
    if (!downloadUrl) {
      throw new PortalError(`No download URL could be built for document '${id}'.`, "DOWNLOAD_URL_MISSING");
    }

    const response = await session.download(downloadUrl);
    if (!response.ok) {
      throw new PortalError(`Download failed with HTTP ${response.status}.`, "DOWNLOAD_FAILED", response.status);
    }

    const filename = safeFilename(match.filename ?? match.title);
    const outputPath = await resolveSafeDownloadPath(config.downloadDir, filename);
    await writeFile(outputPath, response.body);
    await saveSession(session.serialize());

    return {
      ok: true,
      path: outputPath,
      filename,
      mimeType: response.contentType ?? match.mimeType,
      document: match
    };
  }

  private async listSection(section: PortalSection): Promise<ListResult<InboxItem | DocumentItem>> {
    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const servicesResponse = await this.fetchServices(config, session);
    const services = extractServices(servicesResponse.body, servicesResponse.contentType);
    const sectionServices = findSectionServices(services, section);
    const collected: (InboxItem | DocumentItem)[] = [];

    for (const service of sectionServices) {
      if (!service.serviceUrl) {
        continue;
      }
      const boxlistUrl = this.buildBoxlistUrl(config, service.serviceUrl, service.xuclass);
      const response = await session.get(boxlistUrl);
      const items = section === "inbox"
        ? extractInboxItems(response.body, response.contentType)
        : extractDocumentItems(response.body, response.contentType);
      collected.push(...items.map((item) => ({ ...item, serviceUrl: service.serviceUrl })));
    }

    if (collected.length > 0) {
      await saveSession(session.serialize());
      return { items: dedupeItems(collected), source: "boxlist" };
    }

    const fallbackItems = section === "inbox"
      ? extractInboxItems(servicesResponse.body, servicesResponse.contentType)
      : extractDocumentItems(servicesResponse.body, servicesResponse.contentType);
    await saveSession(session.serialize());
    return { items: fallbackItems, source: "services" };
  }

  private async authenticatedSession(config: PortalConfig): Promise<CookieSession> {
    const session = new CookieSession(config, await loadSession(), this.fetchImpl);
    const status = await this.validateSession(config, session);
    if (status.authenticated) {
      return session;
    }

    const login = await this.login();
    if (!login.authenticated) {
      throw new PortalError(login.reason ?? "Authentication required.", login.action ?? "AUTH_REQUIRED");
    }
    return new CookieSession(config, await loadSession(), this.fetchImpl);
  }

  private async validateSession(config: PortalConfig, session: CookieSession): Promise<AuthResult> {
    const response = await this.fetchServices(config, session).catch(() => null);
    if (!response?.ok) {
      return { state: "unauthenticated", authenticated: false };
    }
    return parseSessionStatus(response.body, response.contentType);
  }

  private async fetchServices(config: PortalConfig, session: CookieSession) {
    const candidates = [
      `${LOGGED_SERVICES_PATH}?api=${encodeURIComponent(config.apiVersion)}`,
      `${API5_SERVICES_PATH}?api=${encodeURIComponent(config.apiVersion)}`
    ];

    let lastResponse: Awaited<ReturnType<CookieSession["get"]>> | null = null;
    for (const candidate of candidates) {
      const response = await session.get(candidate);
      lastResponse = response;
      if (response.ok) {
        return response;
      }
    }

    return lastResponse ?? session.get(candidates[0] ?? LOGGED_SERVICES_PATH);
  }

  private buildBoxlistUrl(config: PortalConfig, serviceUrl: string, xuclass?: string): string {
    const url = new URL(serviceUrl, config.baseUrl);
    url.searchParams.set("command", "action");
    url.searchParams.set("name", "boxlist");
    url.searchParams.set("api", config.apiVersion);
    url.searchParams.set("head-oppc-version", config.appVersion || DEFAULT_APP_VERSION);
    if (xuclass && !url.searchParams.has("application")) {
      url.searchParams.set("application", xuclass);
    }
    return url.toString();
  }

  private buildActionUrl(
    config: PortalConfig,
    serviceUrl: string | undefined,
    id: string,
    name: string,
    resourceOrigin?: string
  ): string | undefined {
    if (!serviceUrl) {
      return undefined;
    }
    const url = new URL(serviceUrl, config.baseUrl);
    url.searchParams.set("command", "action");
    url.searchParams.set("id", id);
    url.searchParams.set("name", name);
    url.searchParams.set("api", config.apiVersion);
    url.searchParams.set("head-oppc-version", config.appVersion || DEFAULT_APP_VERSION);
    if (resourceOrigin) {
      url.searchParams.set("resourceOrigin", resourceOrigin);
    }
    return url.toString();
  }
}

export async function configureCredentials(options: {
  username: string;
  password: string;
  baseUrl?: string;
  credentialStore?: CredentialStore;
}): Promise<void> {
  const config = await loadConfig();
  const nextConfig = {
    ...config,
    username: options.username,
    baseUrl: options.baseUrl ?? config.baseUrl
  };
  await saveConfig(nextConfig);
  await (options.credentialStore ?? new KeytarCredentialStore()).setPassword(options.username, options.password);
}

async function resolveSafeDownloadPath(downloadDir: string, filename: string): Promise<string> {
  await mkdir(downloadDir, { recursive: true });
  const resolvedDir = path.resolve(downloadDir);
  const resolvedFile = path.resolve(resolvedDir, filename);
  if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new PortalError("Download path escapes the configured download directory.", "INVALID_DOWNLOAD_PATH");
  }
  return resolvedFile;
}

function safeFilename(input: string): string {
  const cleaned = input.replace(/[/:\\?%*"<>|]/g, "_").trim() || "document";
  return path.extname(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function dedupeItems<T extends { id: string; title: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = `${item.id}::${item.title}`;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}
