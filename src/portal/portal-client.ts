import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  API5_SERVICES_PATH,
  AUTHENTICATE_PATH,
  DEFAULT_APP_VERSION,
  LOGGED_SERVICES_PATH
} from "../constants.js";
import type { CredentialStore } from "../credentials.js";
import { EnvironmentCredentialStore, KeytarCredentialStore } from "../credentials.js";
import { PortalError } from "../errors.js";
import { CookieSession } from "../http/cookie-session.js";
import {
  deleteSession,
  deleteConfirmation,
  loadConfirmation,
  loadConfig,
  loadSession,
  paths,
  saveConfig,
  saveConfirmation,
  saveSession
} from "../storage.js";
import type {
  AuthResult,
  CapabilityMap,
  DocumentItem,
  InboxItem,
  ListResult,
  PortalConfig,
  PortalAction,
  PortalActionField,
  PortalActionCommitRequest,
  PortalActionMap,
  PortalCommitResult,
  PortalRecordItem,
  PortalSection,
  PreparedPortalAction,
  StoredPortalActionConfirmation
} from "../types.js";
import { redactSecrets } from "../utils/redact.js";
import { buildServiceCapability, classifyServiceCapability } from "./capabilities.js";
import { formEncodeSapFfield } from "./encoding.js";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractPortalActions,
  extractPortalRecordItems,
  extractServices,
  findSectionServices,
  normalizeDetailText,
  parseSessionStatus
} from "./parsers.js";

export class PortalClient {
  private static readonly detailActionScanLimit = 250;
  private static readonly confirmationTtlMs = 10 * 60 * 1000;
  private readonly listCache = new Map<PortalSection, ListResult<InboxItem | DocumentItem | PortalRecordItem>>();
  private actionCache?: ListResult<PortalAction>;

  constructor(
    private readonly credentialStore: CredentialStore = new EnvironmentCredentialStore(),
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
        reason: "No password was found in PROPPOTSDAM_PASSWORD or the macOS Keychain. Run `propotsdam-mcp auth set` or set cloud environment credentials."
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

  async discoverWriteActions(): Promise<PortalActionMap> {
    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const status = await this.validateSession(config, session);
    const servicesResponse = await this.fetchServices(config, session);
    const services = extractServices(servicesResponse.body, servicesResponse.contentType);
    const serviceSummaries: PortalActionMap["services"] = [];
    const actions: PortalAction[] = [];
    let scannedDetailRecords = 0;
    let partial = false;

    for (const service of services) {
      if (!service.serviceUrl) {
        serviceSummaries.push({
          serviceId: service.id,
          title: service.title,
          xuclass: service.xuclass,
          actionCount: 0,
          preparableActions: 0,
          skippedActions: 0,
          actionIds: [],
          error: "Service has no serviceUrl."
        });
        continue;
      }
      try {
        const classified = classifyServiceCapability(service);
        const response = await session.get(this.buildBoxlistUrl(config, service.serviceUrl, service.xuclass));
        const boxlistActions = response.ok
          ? extractPortalActions(response.body, response.contentType, service).map(sanitizePortalAction)
          : [];
        const detailActions: PortalAction[] = [];
        if (response.ok && classified.section !== "inbox") {
          const records = extractPortalRecordItems(response.body, response.contentType, service);
          for (const record of records) {
            if (scannedDetailRecords >= PortalClient.detailActionScanLimit) {
              partial = true;
              break;
            }
            scannedDetailRecords += 1;
            const detailUrl = this.buildActionUrl(config, record.serviceUrl ?? service.serviceUrl, record.id, "get");
            if (!detailUrl) {
              continue;
            }
            const detailResponse = await session.get(detailUrl);
            if (!detailResponse.ok) {
              continue;
            }
            detailActions.push(
              ...extractPortalActions(detailResponse.body, detailResponse.contentType, service, {
                source: "detail",
                recordId: record.id,
                recordTitle: record.title
              }).map(sanitizePortalAction)
            );
          }
        }
        const serviceActions = [...boxlistActions, ...detailActions];
        actions.push(...serviceActions);
        serviceSummaries.push({
          serviceId: service.id,
          title: service.title,
          xuclass: service.xuclass,
          actionCount: serviceActions.length,
          preparableActions: serviceActions.filter((action) => action.preparable).length,
          skippedActions: serviceActions.filter((action) => !action.preparable).length,
          actionIds: serviceActions.map((action) => action.id).slice(0, 20),
          error: response.ok ? undefined : `HTTP ${response.status}`
        });
      } catch (error) {
        serviceSummaries.push({
          serviceId: service.id,
          title: service.title,
          xuclass: service.xuclass,
          actionCount: 0,
          preparableActions: 0,
          skippedActions: 0,
          actionIds: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const dedupedActions = dedupeActions(actions);
    const report: PortalActionMap = {
      generatedAt: new Date().toISOString(),
      authenticated: status.authenticated,
      actionPolicy: "Prepare-only. This MCP maps ProPotsdam portal actions and builds reviewable drafts, but does not send state-changing requests.",
      userId: status.userId,
      userFullName: status.userFullName,
      services: serviceSummaries,
      actions: dedupedActions,
      partial,
      detailScanLimit: PortalClient.detailActionScanLimit,
      totals: {
        serviceCount: serviceSummaries.length,
        actionCount: dedupedActions.length,
        preparableActions: dedupedActions.filter((action) => action.preparable).length,
        skippedActions: dedupedActions.filter((action) => !action.preparable).length
      },
      artifactPath: ""
    };

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `write-actions-${Date.now()}.json`);
    const redactedReport = redactSecrets({ ...report, artifactPath }) as PortalActionMap;
    await writeFile(artifactPath, `${JSON.stringify(redactedReport, null, 2)}\n`, "utf8");
    await saveSession(session.serialize());
    this.actionCache = { items: redactedReport.actions, source: "boxlist" };
    return redactedReport;
  }

  async listPortalActions(filter: {
    serviceId?: string;
    xuclass?: string;
    actionKind?: PortalAction["actionKind"];
    source?: PortalAction["source"];
    recordId?: string;
  } = {}): Promise<ListResult<PortalAction>> {
    const cached = this.actionCache ?? await this.listAllPortalActions();
    const items = cached.items.filter((action) => {
      if (filter.serviceId && action.serviceId !== filter.serviceId) {
        return false;
      }
      if (filter.xuclass && action.xuclass !== filter.xuclass) {
        return false;
      }
      if (filter.actionKind && action.actionKind !== filter.actionKind) {
        return false;
      }
      if (filter.source && action.source !== filter.source) {
        return false;
      }
      if (filter.recordId && action.recordId !== filter.recordId) {
        return false;
      }
      return true;
    });
    return {
      items,
      source: cached.source
    };
  }

  async getPortalAction(id: string): Promise<PortalAction> {
    const actions = await this.listPortalActions();
    const match = actions.items.find((action) => action.id === id || action.title === id);
    if (!match) {
      throw new PortalError(`Portal action '${id}' was not found.`, "NOT_FOUND", 404);
    }
    return match;
  }

  async preparePortalAction(id: string, values: Record<string, unknown> = {}): Promise<PreparedPortalAction> {
    const action = await this.getPortalAction(id);
    if (!action.preparable) {
      throw new PortalError(`Portal action '${id}' is not preparable: ${action.notPreparableReason ?? "unknown"}.`, "ACTION_NOT_PREPARABLE");
    }

    const validationIssues = action.fields
      .filter((field) => field.required && !field.hidden && values[field.name] === undefined && field.value === undefined)
      .map((field) => `Missing required field '${field.name}'.`);
    for (const key of Object.keys(values)) {
      const field = action.fields.find((item) => item.name === key || item.portalId === key);
      if (!field) {
        validationIssues.push(`Unknown field '${key}'.`);
        continue;
      }
      if (field.hidden || isSensitiveName(field.name) || field.portalId && isSensitiveName(field.portalId)) {
        continue;
      }
      if (!field.editable) {
        validationIssues.push(`Field '${field.name}' is not editable.`);
      }
    }
    const draft: PreparedPortalAction["draft"] = {
      method: action.method,
      endpoint: action.endpoint,
      fields: action.fields.map((field) => {
        const proposed = field.editable ? values[field.name] ?? values[field.portalId ?? ""] : undefined;
        return sanitizePreparedField({
          name: field.name,
          label: field.label,
          required: field.required,
          hidden: field.hidden,
          editable: field.editable,
          currentValue: field.value,
          proposedValue: proposed === undefined ? undefined : String(proposed)
        });
      })
    };

    return redactSecrets({
      ok: validationIssues.length === 0,
      preparedOnly: true,
      actionId: action.id,
      title: action.title,
      summary: `Prepared review-only draft for '${action.title}'. No request was sent to ProPotsdam.`,
      validationIssues,
      draft
    }) as PreparedPortalAction;
  }

  async requestPortalActionCommit(actionId: string, values: Record<string, unknown> = {}): Promise<PortalActionCommitRequest> {
    const action = await this.getPortalAction(actionId);
    const validationIssues = this.commitScopeIssues(action);
    const prepared = await this.preparePortalAction(actionId, values);
    validationIssues.push(...prepared.validationIssues.filter((issue) => !issue.startsWith("Missing required field ")));
    const diff = prepared.draft.fields
      .filter((field) => field.proposedValue !== undefined && field.currentValue !== field.proposedValue)
      .map((field) => ({
        name: field.name,
        label: field.label,
        currentValue: field.currentValue,
        proposedValue: field.proposedValue!
      }));
    if (diff.length === 0 && validationIssues.length === 0) {
      validationIssues.push("No editable field changes were provided.");
    }
    if (validationIssues.length > 0) {
      return {
        ok: false,
        actionId: action.id,
        actionTitle: action.title,
        confirmationId: undefined,
        summary: `Commit request for '${action.title}' was not created.`,
        validationIssues,
        diff
      };
    }

    const confirmationId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + PortalClient.confirmationTtlMs);
    const confirmation: StoredPortalActionConfirmation = {
      confirmationId,
      actionId: action.id,
      actionTitle: action.title,
      recordId: action.recordId,
      recordTitle: action.recordTitle,
      xuclass: action.xuclass,
      serviceUrl: action.serviceUrl,
      values: Object.fromEntries(diff.map((entry) => [entry.name, entry.proposedValue])),
      diff,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await saveConfirmation(confirmation);
    return {
      ok: true,
      actionId: action.id,
      actionTitle: action.title,
      confirmationId,
      expiresAt: confirmation.expiresAt,
      summary: `Ready to commit '${action.title}' for ${action.recordTitle ?? action.serviceTitle}. Ask the user to confirm this exact diff before committing.`,
      validationIssues: [],
      diff
    };
  }

  async commitPortalAction(confirmationId: string): Promise<PortalCommitResult> {
    const confirmation = await loadConfirmation(confirmationId);
    if (!confirmation) {
      throw new PortalError(`Confirmation '${confirmationId}' was not found.`, "CONFIRMATION_NOT_FOUND", 404);
    }
    if (Date.parse(confirmation.expiresAt) <= Date.now()) {
      await deleteConfirmation(confirmationId);
      throw new PortalError(`Confirmation '${confirmationId}' has expired.`, "CONFIRMATION_EXPIRED", 410);
    }
    if (confirmation.actionId !== "save_partner" || confirmation.xuclass !== "ESQ_IA_PART") {
      await deleteConfirmation(confirmationId);
      throw new PortalError("Only Meine Daten/save_partner can be committed in this version.", "ACTION_COMMIT_NOT_ALLOWED", 403);
    }

    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const action = await this.getPortalAction(confirmation.actionId);
    const scopeIssues = this.commitScopeIssues(action);
    if (scopeIssues.length > 0) {
      throw new PortalError(scopeIssues.join(" "), "ACTION_COMMIT_NOT_ALLOWED", 403);
    }

    const sourceRecordId = action.recordId ?? confirmation.recordId ?? action.id;
    const sourceFormUrl = this.buildActionUrl(config, action.serviceUrl, sourceRecordId, "get");
    if (!sourceFormUrl) {
      throw new PortalError("Portal action has no commit endpoint.", "ACTION_COMMIT_NOT_ALLOWED", 403);
    }
    const sourceForm = await session.get(sourceFormUrl);
    if (!sourceForm.ok) {
      throw new PortalError(`Portal form '${sourceRecordId}' could not be loaded for commit.`, "ACTION_COMMIT_NOT_ALLOWED", sourceForm.status);
    }

    const newRecordId = randomUUID().toUpperCase();
    const { xml, originalId } = this.buildCommitFormXml(sourceForm.body, action, confirmation.values, newRecordId, sourceRecordId, config);
    const saveUrl = this.buildActionUrl(config, action.serviceUrl, newRecordId, "save", {
      originalId,
      resourceOrigin: "form"
    });
    if (!saveUrl) {
      throw new PortalError("Portal action has no save endpoint.", "ACTION_COMMIT_NOT_ALLOWED", 403);
    }
    const saveResponse = await session.post(saveUrl, xml, {
      headers: {
        "content-type": "application/xml;charset=UTF-8"
      }
    });
    if (!saveResponse.ok) {
      await saveSession(session.serialize());
      await deleteConfirmation(confirmationId);
      return {
        ok: false,
        actionId: confirmation.actionId,
        committedAt: new Date().toISOString(),
        status: saveResponse.status,
        summary: `Portal returned HTTP ${saveResponse.status} while saving '${confirmation.actionTitle}'.`,
        portalMessage: normalizeDetailText(saveResponse.body, saveResponse.contentType) || undefined
      };
    }

    const commitUrl = this.buildActionUrl(config, action.serviceUrl, newRecordId, action.id, { originalId });
    if (!commitUrl) {
      throw new PortalError("Portal action has no commit endpoint.", "ACTION_COMMIT_NOT_ALLOWED", 403);
    }
    const response = await session.get(commitUrl);
    await saveSession(session.serialize());
    await deleteConfirmation(confirmationId);
    const portalMessage = normalizeDetailText(response.body, response.contentType);
    const returnedRecordId = extractOpenFormId(response.body) ?? newRecordId;
    return {
      ok: response.ok,
      actionId: confirmation.actionId,
      recordId: returnedRecordId,
      committedAt: new Date().toISOString(),
      status: response.status,
      summary: response.ok
        ? `Committed Meine Daten action '${confirmation.actionTitle}'.`
        : `Portal returned HTTP ${response.status} for '${confirmation.actionTitle}'.`,
      portalMessage: portalMessage || undefined
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
    let portalRecords = 0;
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
          portalRecords += parsedDocumentItems.length;
        } else if (classified.section === "generic") {
          portalRecords += parsedPortalRecords.length;
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

    const report: CapabilityMap = {
      generatedAt: new Date().toISOString(),
      authenticated: status.authenticated,
      dataPolicy: "ProPotsdam exposes readable portal data. Local files created by this MCP are exports from readable records, not portal-provided files.",
      userId: status.userId,
      userFullName: status.userFullName,
      services: serviceCapabilities,
      totals: {
        serviceCount: serviceCapabilities.length,
        inboxItems,
        portalRecords,
        unknownItems
      },
      artifactPath: ""
    };

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `capabilities-${Date.now()}.json`);
    const redactedReport = redactSecrets({ ...report, artifactPath });
    await writeFile(artifactPath, `${JSON.stringify(redactedReport, null, 2)}\n`, "utf8");
    await saveSession(session.serialize());
    return redactedReport as CapabilityMap;
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
      return Boolean(service.serviceUrl) && section !== "inbox";
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

  private async listAllPortalActions(): Promise<ListResult<PortalAction>> {
    const report = await this.discoverWriteActions();
    const result = { items: report.actions, source: "boxlist" as const };
    this.actionCache = result;
    return result;
  }

  private commitScopeIssues(action: PortalAction): string[] {
    if (action.id !== "save_partner" || action.xuclass !== "ESQ_IA_PART") {
      return ["Only Meine Daten/save_partner can be committed in this version."];
    }
    if (!action.preparable || action.source !== "detail") {
      return ["Only detail-based preparable Meine Daten actions can be committed."];
    }
    return [];
  }

  private buildCommitFormXml(
    sourceXml: string,
    action: PortalAction,
    values: Record<string, string>,
    newRecordId: string,
    previousRecordId: string,
    config: PortalConfig
  ): { xml: string; originalId: string } {
    let xml = sourceXml;
    const originalId = extractXmlAttribute(xml, "originalId") ?? extractXmlElementText(xml, "originalId") ?? previousRecordId;
    for (const [name, value] of Object.entries(values)) {
      const field = action.fields.find((item) => item.name === name || item.portalId === name);
      if (field) {
        xml = replaceXmlFieldValue(xml, field, value);
      }
    }
    const changedField = action.fields.find(isChangedFlagField);
    if (changedField) {
      xml = replaceXmlFieldValue(xml, changedField, "true");
    }
    xml = replaceRootFormId(xml, newRecordId);
    xml = upsertHeadId(xml, newRecordId);
    xml = upsertSaveHistory(xml, previousRecordId, newRecordId, config.username);
    xml = upsertClientXml(xml, config.appVersion || DEFAULT_APP_VERSION);
    return {
      originalId,
      xml: xml
        .replace(/\sxmlns:xsi="[^"]*"/g, "")
        .replace(/\sxsi:schemaLocation="[^"]*"/g, "")
        .replace(/xmlns:oppc="[^"]*"/g, "")
        .replace(/<oppc:form/g, "<form")
        .replace(/<\/oppc:form/g, "</form")
        .replace(/xmlns=""/g, "")
    };
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
    const serviceUrls = [
      `${LOGGED_SERVICES_PATH}?api=${encodeURIComponent(config.apiVersion)}`,
      `${API5_SERVICES_PATH}?api=${encodeURIComponent(config.apiVersion)}`
    ];

    let lastResponse: Awaited<ReturnType<CookieSession["get"]>> | null = null;
    let firstOkResponse: Awaited<ReturnType<CookieSession["get"]>> | null = null;
    for (const serviceUrl of serviceUrls) {
      const response = await session.get(serviceUrl);
      lastResponse = response;
      if (response.ok) {
        firstOkResponse ??= response;
        const status = parseSessionStatus(response.body, response.contentType);
        if (status.authenticated) {
          return response;
        }
      }
    }

    return firstOkResponse ?? lastResponse ?? session.get(serviceUrls[0] ?? LOGGED_SERVICES_PATH);
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
    options: { originalId?: string; resourceOrigin?: string } = {}
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
    if (options.originalId) {
      url.searchParams.set("originalId", options.originalId);
    }
    if (options.resourceOrigin) {
      url.searchParams.set("resourceOrigin", options.resourceOrigin);
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

function dedupeActions(actions: PortalAction[]): PortalAction[] {
  const seen = new Map<string, PortalAction>();
  for (const action of actions) {
    const key = `${action.serviceId ?? ""}::${action.recordId ?? ""}::${action.id}::${action.title}`;
    if (!seen.has(key)) {
      seen.set(key, action);
    }
  }
  return [...seen.values()];
}

function sanitizePortalAction(action: PortalAction): PortalAction {
  return {
    ...action,
    fields: action.fields.map((field) => {
      if (field.hidden || isSensitiveName(field.name)) {
        const { value: _value, ...rest } = field;
        void _value;
        return rest;
      }
      return field;
    }),
    rawHints: redactSecrets(action.rawHints) as Record<string, string>
  };
}

function sanitizePreparedField(field: PreparedPortalAction["draft"]["fields"][number]): PreparedPortalAction["draft"]["fields"][number] {
  if (field.hidden || isSensitiveName(field.name)) {
    const { currentValue: _currentValue, proposedValue: _proposedValue, ...rest } = field;
    void _currentValue;
    void _proposedValue;
    return rest;
  }
  return field;
}

function isSensitiveName(name: string): boolean {
  return /csrf|token|cookie|session|password|sap-ffield/i.test(name);
}

function isChangedFlagField(field: PortalActionField): boolean {
  return field.name === "ESQ_CHANGED" || field.portalId === "ESQ_CHANGED";
}

function replaceXmlFieldValue(xml: string, field: PortalActionField, value: string): string {
  const selectors = [field.portalId, field.name].filter((item): item is string => Boolean(item));
  for (const selector of selectors) {
    const textPattern = new RegExp(`(<(?:textfield|numberfield|datefield)\\b(?=[^>]*(?:id|refname|name)="${escapeRegExp(selector)}")[^>]*>)([\\s\\S]*?)(<\\/(?:textfield|numberfield|datefield)>)`);
    if (textPattern.test(xml)) {
      return xml.replace(textPattern, `$1${escapeXmlText(value)}$3`);
    }
    const choicePattern = new RegExp(`(<choicefield\\b(?=[^>]*(?:id|refname|name)="${escapeRegExp(selector)}")[^>]*>)([\\s\\S]*?)(<\\/choicefield>)`);
    const choiceMatch = choicePattern.exec(xml);
    if (choiceMatch) {
      const nextChoices = (choiceMatch[2] ?? "")
        .replace(/\sselected="true"/g, "")
        .replace(new RegExp(`(<choice\\b(?=[^>]*(?:id|value)="${escapeRegExp(value)}")[^>]*)(\\/?>)`), "$1 selected=\"true\"$2");
      return xml.replace(choicePattern, `$1${nextChoices}$3`);
    }
  }
  return xml;
}

function replaceRootFormId(xml: string, newRecordId: string): string {
  return xml.replace(/(<form\b[^>]*\bid=")[^"]+(")/, `$1${escapeXmlAttribute(newRecordId)}$2`);
}

function upsertHeadId(xml: string, newRecordId: string): string {
  if (/<head>[\s\S]*?<id>[\s\S]*?<\/id>/.test(xml)) {
    return xml.replace(/(<head>[\s\S]*?<id>)([\s\S]*?)(<\/id>)/, `$1${escapeXmlText(newRecordId)}$3`);
  }
  return xml.replace(/<head>/, `<head><id>${escapeXmlText(newRecordId)}</id>`);
}

function upsertSaveHistory(xml: string, previousRecordId: string, newRecordId: string, username = ""): string {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const save = `<save oldId="${escapeXmlAttribute(previousRecordId)}" newId="${escapeXmlAttribute(newRecordId)}" userName="${escapeXmlAttribute(username)}" timestamp="${escapeXmlAttribute(timestamp)}"/>`;
  if (/<history\b[^>]*>/.test(xml)) {
    return xml.replace(/<\/history>/, `${save}</history>`);
  }
  const history = `<history>${save}</history>`;
  if (/<actions\b/.test(xml)) {
    return xml.replace(/<actions\b/, `${history}<actions`);
  }
  if (/<sheet\b/.test(xml)) {
    return xml.replace(/<sheet\b/, `${history}<sheet`);
  }
  return xml.replace(/<\/form>/, `${history}</form>`);
}

function upsertClientXml(xml: string, appVersion: string): string {
  const client = `<client><editor name="webapp-professional" version="${escapeXmlAttribute(appVersion)}"/><device identifier="propotsdam-mcp" name="propotsdam-mcp" osName="node"/></client>`;
  xml = xml.replace(/<client\b[\s\S]*?<\/client>/, "");
  return xml.replace(/<\/head>/, `</head>${client}`);
}

function extractXmlAttribute(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`).exec(xml)?.[1];
}

function extractXmlElementText(xml: string, name: string): string | undefined {
  return new RegExp(`<${escapeRegExp(name)}>([\\s\\S]*?)<\\/${escapeRegExp(name)}>`).exec(xml)?.[1];
}

function extractOpenFormId(text: string): string | undefined {
  return /oppc:\/\/openform\?id=([^&\s]+)/i.exec(text)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
