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
  paths,
  saveConfig,
  saveSession
} from "../storage.js";
import type {
  AuthResult,
  CapabilityMap,
  DocumentItem,
  DownloadCandidate,
  DownloadCandidateList,
  DownloadResult,
  InboxItem,
  ListResult,
  PortalConfig,
  PortalRecordItem,
  PortalSection
} from "../types.js";
import { redactSecrets } from "../utils/redact.js";
import { buildServiceCapability, classifyServiceCapability } from "./capabilities.js";
import { formEncodeSapFfield } from "./encoding.js";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractPortalRecordItems,
  extractServices,
  findSectionServices,
  normalizeDetailText,
  parseSessionStatus
} from "./parsers.js";

export class PortalClient {
  private readonly listCache = new Map<PortalSection, ListResult<InboxItem | DocumentItem | PortalRecordItem>>();

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

    const refreshed = await this.refreshSessionServices(config, session);
    if (refreshed.authenticated) {
      await saveSession(session.serialize());
      return refreshed;
    }

    const fallback = parseSessionStatus(response.body, response.contentType);
    if (fallback.authenticated) {
      await saveSession(session.serialize());
      return fallback;
    }

    const actionRequired = classifyAuthFailure(response.status, response.body);
    if (actionRequired.state === "action_required") {
      return actionRequired;
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
    const cachedInbox = this.listCache.get("inbox") as ListResult<InboxItem> | undefined;
    const { items } = cachedInbox ?? await this.listInbox();
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

  async listPortalRecords(filter: { serviceId?: string; xuclass?: string } = {}): Promise<ListResult<PortalRecordItem>> {
    const cachedRecords = this.listCache.get("generic") as ListResult<PortalRecordItem> | undefined;
    const result = cachedRecords ?? await this.listGenericRecords();
    const items = result.items.filter((item) => {
      if (filter.serviceId && item.serviceId !== filter.serviceId) {
        return false;
      }
      if (filter.xuclass && item.xuclass !== filter.xuclass) {
        return false;
      }
      return true;
    });
    return {
      items,
      source: result.source
    };
  }

  async getPortalRecord(id: string): Promise<PortalRecordItem> {
    const cachedRecords = this.listCache.get("generic") as ListResult<PortalRecordItem> | undefined;
    const { items } = cachedRecords ?? await this.listPortalRecords();
    const match = items.find((item) => item.id === id || item.title === id);
    if (!match) {
      throw new PortalError(`Portal record '${id}' was not found.`, "NOT_FOUND", 404);
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

  async listDownloadCandidates(): Promise<DownloadCandidateList> {
    const documents = await this.listDocuments();
    const records = await this.listPortalRecords();
    const candidates = [
      ...documents.items.map(documentToCandidate),
      ...records.items.map(recordToCandidate)
    ];
    return {
      safe: dedupeCandidates(candidates.filter((candidate) => candidate.safeDownload)),
      skipped: dedupeCandidates(candidates.filter((candidate) => !candidate.safeDownload))
    };
  }

  async downloadCandidate(id: string): Promise<DownloadResult> {
    const config = await loadConfig();
    const candidates = await this.listDownloadCandidates();
    const match = [...candidates.safe, ...candidates.skipped].find((candidate) =>
      candidate.id === id ||
      candidate.title === id ||
      candidate.filename === id ||
      candidate.resourceId === id
    );
    if (!match) {
      throw new PortalError(`Download candidate '${id}' was not found.`, "NOT_FOUND", 404);
    }
    if (!match.safeDownload || !match.resourceId) {
      throw new PortalError(`Download candidate '${id}' is not safe to download.`, "NOT_SAFE_DOWNLOAD", 410);
    }

    const session = await this.authenticatedSession(config);
    const downloadUrl = this.buildActionUrl(config, match.serviceUrl, match.resourceId, "get", match.resourceOrigin);
    if (!downloadUrl) {
      throw new PortalError(`No download URL could be built for candidate '${id}'.`, "DOWNLOAD_URL_MISSING");
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
      candidate: match
    };
  }

  async discoverCapabilities(): Promise<CapabilityMap> {
    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const status = await this.validateSession(config, session);
    const servicesResponse = await this.fetchServices(config, session);
    const services = extractServices(servicesResponse.body, servicesResponse.contentType);
    const serviceCapabilities = [];
    let inboxItems = 0;
    let documentItems = 0;
    let downloadableDocuments = 0;
    let genericRecords = 0;
    let safeDownloadCandidates = 0;
    let skippedDownloadCandidates = 0;
    let unknownItems = 0;

    for (const service of services) {
      if (!service.serviceUrl) {
        const capability = buildServiceCapability({
          service,
          available: false,
          error: "Service has no serviceUrl."
        });
        serviceCapabilities.push(capability);
        continue;
      }

      const classified = classifyServiceCapability(service);
      const boxlistUrl = this.buildBoxlistUrl(config, service.serviceUrl, service.xuclass);
      try {
        const response = await session.get(boxlistUrl);
        const parsedInboxItems = classified.section === "inbox"
          ? extractInboxItems(response.body, response.contentType)
          : [];
        const parsedDocumentItems = classified.section === "documents"
          ? extractDocumentItems(response.body, response.contentType)
          : [];
        const parsedPortalRecords = classified.section === "inbox" || classified.section === "documents"
          ? []
          : extractPortalRecordItems(response.body, response.contentType, service);
        const unknownItemCount = classified.section === "unknown" && parsedInboxItems.length === 0 && parsedDocumentItems.length === 0 && parsedPortalRecords.length === 0
          ? 0
          : undefined;
        const capability = buildServiceCapability({
          service,
          status: response.status,
          available: response.ok,
          inboxItems: parsedInboxItems,
          documentItems: parsedDocumentItems,
          portalRecords: parsedPortalRecords,
          unknownItemCount,
          error: response.ok ? undefined : `HTTP ${response.status}`
        });
        serviceCapabilities.push(capability);
        if (classified.section === "inbox") {
          inboxItems += parsedInboxItems.length;
        } else if (classified.section === "documents") {
          documentItems += parsedDocumentItems.length;
          downloadableDocuments += parsedDocumentItems.filter((item) => item.downloadable).length;
          safeDownloadCandidates += parsedDocumentItems.filter((item) => item.downloadable).length;
          skippedDownloadCandidates += parsedDocumentItems.filter((item) => !item.downloadable).length;
        } else if (classified.section === "generic") {
          genericRecords += parsedPortalRecords.length;
          safeDownloadCandidates += parsedPortalRecords.filter((item) => item.safeDownload).length;
          skippedDownloadCandidates += parsedPortalRecords.filter((item) => !item.safeDownload).length;
        } else {
          unknownItems += capability.boxlist.itemCount;
        }
      } catch (error) {
        serviceCapabilities.push(buildServiceCapability({
          service,
          available: false,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }

    const safety = {
      maxDocumentsBeforeConfirmation: 100,
      maxDownloadBytesBeforeConfirmation: 1_000_000_000,
      needsConfirmation: downloadableDocuments > 100,
      reason: downloadableDocuments > 100 ? "More than 100 downloadable documents detected." : undefined
    };
    const report: CapabilityMap = {
      generatedAt: new Date().toISOString(),
      authenticated: status.authenticated,
      userId: status.userId,
      userFullName: status.userFullName,
      services: serviceCapabilities,
      totals: {
        services: serviceCapabilities.length,
        inboxItems,
        documentItems,
        downloadableDocuments,
        genericRecords,
        safeDownloadCandidates,
        skippedDownloadCandidates,
        unknownItems
      },
      safety,
      artifactPath: ""
    };

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `capabilities-${Date.now()}.json`);
    const redactedReport = redactSecrets({ ...report, artifactPath });
    await writeFile(artifactPath, `${JSON.stringify(redactedReport, null, 2)}\n`, "utf8");
    await saveSession(session.serialize());
    return redactedReport as CapabilityMap;
  }

  async downloadDocument(id: string): Promise<DownloadResult> {
    const config = await loadConfig();
    const cachedDocuments = this.listCache.get("documents") as ListResult<DocumentItem> | undefined;
    const { items } = cachedDocuments ?? await this.listDocuments();
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
      const result = { items: dedupeItems(collected), source: "boxlist" as const };
      this.listCache.set(section, result);
      return result;
    }

    const fallbackItems = section === "inbox"
      ? extractInboxItems(servicesResponse.body, servicesResponse.contentType)
      : extractDocumentItems(servicesResponse.body, servicesResponse.contentType);
    await saveSession(session.serialize());
    const result = { items: fallbackItems, source: "services" as const };
    this.listCache.set(section, result);
    return result;
  }

  private async listGenericRecords(): Promise<ListResult<PortalRecordItem>> {
    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const servicesResponse = await this.fetchServices(config, session);
    const services = extractServices(servicesResponse.body, servicesResponse.contentType);
    const genericServices = services.filter((service) => {
      const section = classifyServiceCapability(service).section;
      return Boolean(service.serviceUrl) && section !== "inbox" && section !== "documents";
    });
    const collected: PortalRecordItem[] = [];

    for (const service of genericServices) {
      if (!service.serviceUrl) {
        continue;
      }
      const boxlistUrl = this.buildBoxlistUrl(config, service.serviceUrl, service.xuclass);
      const response = await session.get(boxlistUrl);
      if (!response.ok) {
        continue;
      }
      const records = extractPortalRecordItems(response.body, response.contentType, service);
      collected.push(...records.map((item) => ({ ...item, serviceUrl: service.serviceUrl })));
    }

    await saveSession(session.serialize());
    const result = { items: dedupeItems(collected), source: "boxlist" as const };
    this.listCache.set("generic", result);
    return result;
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
    let firstOkResponse: Awaited<ReturnType<CookieSession["get"]>> | null = null;
    for (const candidate of candidates) {
      const response = await session.get(candidate);
      lastResponse = response;
      if (response.ok) {
        firstOkResponse ??= response;
        const status = parseSessionStatus(response.body, response.contentType);
        if (status.authenticated) {
          return response;
        }
      }
    }

    return firstOkResponse ?? lastResponse ?? session.get(candidates[0] ?? LOGGED_SERVICES_PATH);
  }

  private async refreshSessionServices(config: PortalConfig, session: CookieSession): Promise<AuthResult> {
    if (!config.username) {
      return { state: "unauthenticated", authenticated: false };
    }
    const response = await session.get(
      `${API5_SERVICES_PATH}?api=${encodeURIComponent(config.apiVersion)}&${encodeURIComponent(config.username.toUpperCase())}`
    );
    if (!response.ok) {
      return classifyAuthFailure(response.status, response.body);
    }
    return parseSessionStatus(response.body, response.contentType);
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

function documentToCandidate(document: DocumentItem): DownloadCandidate {
  const safeDownload = Boolean(document.downloadable && document.resourceId);
  return {
    id: document.id,
    title: document.title,
    filename: document.filename,
    source: "documents",
    serviceUrl: document.serviceUrl ?? document.detailUrl,
    safeDownload,
    skipReason: safeDownload ? undefined : document.downloadable ? "missing_resource_id" : "not_a_resource",
    resourceId: document.resourceId,
    resourceOrigin: document.resourceOrigin,
    mimeType: document.mimeType
  };
}

function recordToCandidate(record: PortalRecordItem): DownloadCandidate {
  const safeDownload = Boolean(record.safeDownload && record.resourceId);
  return {
    id: record.id,
    title: record.title,
    filename: record.filename,
    source: "generic",
    serviceId: record.serviceId,
    serviceTitle: record.serviceTitle,
    serviceUrl: record.serviceUrl,
    xuclass: record.xuclass,
    safeDownload,
    skipReason: safeDownload ? undefined : record.skipReason ?? "missing_resource_id",
    resourceId: record.resourceId,
    resourceOrigin: record.resourceOrigin,
    mimeType: record.mimeType
  };
}

function dedupeCandidates(candidates: DownloadCandidate[]): DownloadCandidate[] {
  const seen = new Map<string, DownloadCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.source}::${candidate.serviceId ?? ""}::${candidate.id}::${candidate.resourceId ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
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
