import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
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
import type { PortalWritePermit } from "../http/write-permit.js";
import { closePortalWritePermit, issuePortalWritePermit } from "../http/write-permit.js";
import {
  claimPendingWrite,
  deleteClaimedPendingWrite,
  deletePendingWrite,
  deletePendingWriteArtifacts,
  deleteSession,
  listPendingWrites as listStoredPendingWrites,
  loadPendingWrite,
  loadConfig,
  loadSession,
  paths,
  pendingWriteArtifactsDir,
  saveConfig,
  savePendingWrite,
  saveSession
} from "../storage.js";
import type {
  AuthResult,
  CancelPendingWritesResult,
  CapabilityMap,
  DocumentItem,
  InboxItem,
  ListResult,
  PortalFileExportResult,
  PortalFileItem,
  PortalConfig,
  PortalAction,
  PortalActionField,
  PortalActionDiffEntry,
  PortalActionCommitTarget,
  PortalActionMap,
  PreparedPortalAttachment,
  PortalAttachmentReview,
  PortalCommitBatchResult,
  PortalCommitResult,
  PortalRecordItem,
  PortalReadDomain,
  PortalSection,
  PortalWriteCapability,
  PortalWriteDomain,
  PendingPortalWrite,
  PendingPortalWriteList,
  PendingPortalWriteSummary,
  PreparedPortalAction,
  PreparedPortalWrite,
  StagedPortalActionResult,
  StagedPortalAttachment,
  StructuredPortalRecord
} from "../types.js";
import { redactSecrets } from "../utils/redact.js";
import { buildServiceCapability, classifyServiceCapability } from "./capabilities.js";
import { formEncodeSapFfield } from "./encoding.js";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractPortalFileItems,
  extractPortalActions,
  extractPortalRecordItems,
  extractServices,
  findSectionServices,
  normalizeDetailText,
  parseSessionStatus,
  toStructuredPortalRecord
} from "./parsers.js";

const WRITE_DOMAIN_SPECS: Record<PortalWriteDomain, {
  title: string;
  description: string;
  requiredFields: string[];
  targetRequired: boolean;
  uploadSupported?: boolean;
}> = {
  inbox_compose: {
    title: "Compose inbox message",
    description: "Prepare a new portal inbox message draft.",
    requiredFields: ["subject", "message"],
    targetRequired: false
  },
  inbox_reply: {
    title: "Reply to inbox message",
    description: "Prepare an inbox reply draft.",
    requiredFields: ["message"],
    targetRequired: true
  },
  inbox_state: {
    title: "Change inbox message state",
    description: "Prepare a read/unread/archive state-change draft.",
    requiredFields: ["state"],
    targetRequired: true
  },
  workflow_reply: {
    title: "Reply in workflow",
    description: "Prepare a workflow conversation reply draft.",
    requiredFields: ["message"],
    targetRequired: true
  },
  read_confirmation: {
    title: "Confirm read receipt",
    description: "Prepare a portal read-confirmation draft.",
    requiredFields: [],
    targetRequired: true
  },
  repair_report: {
    title: "Submit repair report",
    description: "Prepare a repair or damage report draft.",
    requiredFields: ["description"],
    targetRequired: false
  },
  repair_file_upload: {
    title: "Attach repair file",
    description: "Prepare repair photo or file upload metadata.",
    requiredFields: ["filePath"],
    targetRequired: true,
    uploadSupported: false
  },
  repair_appointment: {
    title: "Schedule repair appointment",
    description: "Prepare a repair appointment selection draft.",
    requiredFields: ["appointment"],
    targetRequired: true
  },
  service_ticket: {
    title: "Submit service ticket",
    description: "Prepare a customer service request draft.",
    requiredFields: ["message"],
    targetRequired: false
  },
  pet_approval: {
    title: "Request pet approval",
    description: "Prepare a pet approval request draft.",
    requiredFields: ["animalType"],
    targetRequired: false
  },
  payment_method: {
    title: "Change payment method",
    description: "Prepare bank or payment method change data.",
    requiredFields: ["iban"],
    targetRequired: false
  },
  meter_reading: {
    title: "Submit meter reading",
    description: "Prepare a consumption or meter reading draft.",
    requiredFields: ["meterReading"],
    targetRequired: true
  },
  house_notice_ack: {
    title: "Acknowledge house notice",
    description: "Prepare a house notice acknowledgement draft.",
    requiredFields: [],
    targetRequired: true
  },
  real_estate_inquiry: {
    title: "Send real-estate inquiry",
    description: "Prepare an apartment inquiry draft.",
    requiredFields: ["message"],
    targetRequired: true
  },
  viewing_booking: {
    title: "Book viewing appointment",
    description: "Prepare a viewing appointment booking draft.",
    requiredFields: ["appointment"],
    targetRequired: true
  },
  rental_application: {
    title: "Submit rental application",
    description: "Prepare a rental application draft.",
    requiredFields: ["message"],
    targetRequired: true
  },
  registration_activation: {
    title: "Complete registration activation",
    description: "Prepare registration or activation-code data.",
    requiredFields: ["username", "activationCode"],
    targetRequired: false
  },
  password_change: {
    title: "Change portal password",
    description: "Prepare password-change data.",
    requiredFields: ["currentPassword", "newPassword"],
    targetRequired: false
  },
  terms_acceptance: {
    title: "Accept portal terms",
    description: "Prepare terms or privacy acceptance data.",
    requiredFields: ["accepted"],
    targetRequired: false
  },
  account_verification: {
    title: "Complete account verification",
    description: "Prepare account verification data.",
    requiredFields: ["verificationCode"],
    targetRequired: false
  },
  captcha_completion: {
    title: "Complete captcha",
    description: "Prepare captcha completion data.",
    requiredFields: ["captchaResponse"],
    targetRequired: false
  },
  profile_account_setting: {
    title: "Change profile/account setting",
    description: "Prepare profile or account setting changes.",
    requiredFields: [],
    targetRequired: false
  },
  external_navigation: {
    title: "Open external/navigation action",
    description: "Prepare an external link or navigation action.",
    requiredFields: [],
    targetRequired: true
  }
};

export class PortalClient {
  private static readonly detailActionScanLimit = 250;
  private static readonly pendingWriteTtlMs = 10 * 60 * 1000;
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

  async listPortalFiles(filter: { serviceId?: string; xuclass?: string; mimeType?: string } = {}): Promise<ListResult<PortalFileItem>> {
    const records = await this.listPortalRecords({
      serviceId: filter.serviceId,
      xuclass: filter.xuclass
    });
    const items = extractPortalFileItems(records.items).filter((item) => {
      if (filter.mimeType && item.mimeType !== filter.mimeType) {
        return false;
      }
      return true;
    });
    return {
      items,
      source: records.source
    };
  }

  async exportPortalFile(id: string, options: { outputDir?: string } = {}): Promise<PortalFileExportResult> {
    const files = await this.listPortalFiles();
    const match = files.items.find((item) => item.id === id || item.sourceRecordId === id || item.title === id || item.filename === id);
    if (!match) {
      throw new PortalError(`Portal file '${id}' was not found.`, "NOT_FOUND", 404);
    }
    if (!match.exportable) {
      throw new PortalError(`Portal file '${id}' is not exportable.`, "FILE_NOT_EXPORTABLE", 403);
    }

    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const resourceId = match.resourceId ?? match.sourceRecordId;
    const url = this.buildActionUrl(config, match.serviceUrl, resourceId, "get", {
      resourceOrigin: match.resourceOrigin
    });
    if (!url) {
      throw new PortalError(`Portal file '${id}' has no readable endpoint.`, "FILE_NOT_EXPORTABLE", 403);
    }
    const response = await session.getBinary(url);
    await saveSession(session.serialize());
    if (!response.ok) {
      throw new PortalError(`Portal file '${id}' could not be exported.`, "FILE_EXPORT_FAILED", response.status);
    }

    const outputDir = options.outputDir ?? config.exportDir;
    await mkdir(outputDir, { recursive: true });
    const filename = safeExportFilename(match.filename);
    const exportPath = path.join(outputDir, `${safeExportFilename(match.sourceRecordId)}-${filename}`);
    await writeFile(exportPath, response.body);
    return {
      ok: true,
      id: match.id,
      sourceRecordId: match.sourceRecordId,
      sourceRecordTitle: match.sourceRecordTitle,
      filename,
      path: exportPath,
      mimeType: response.contentType ?? match.mimeType,
      byteLength: response.body.byteLength,
      sha256: createHash("sha256").update(response.body).digest("hex"),
      exportedAt: new Date().toISOString()
    };
  }

  async listStructuredPortalRecords(filter: {
    serviceId?: string;
    xuclass?: string;
    domain?: PortalReadDomain;
  } = {}): Promise<ListResult<StructuredPortalRecord>> {
    const records = await this.listPortalRecords({
      serviceId: filter.serviceId,
      xuclass: filter.xuclass
    });
    const inboxRecords = await this.listStructuredInboxRecords(filter);
    const items = [...records.items, ...inboxRecords]
      .map(toStructuredPortalRecord)
      .filter((item) => !filter.domain || item.domain === filter.domain);
    return {
      items,
      source: records.source
    };
  }

  async getStructuredPortalRecord(id: string): Promise<StructuredPortalRecord> {
    try {
      return toStructuredPortalRecord(await this.getPortalRecord(id));
    } catch (error) {
      if (!(error instanceof PortalError) || error.code !== "NOT_FOUND") {
        throw error;
      }
      return toStructuredPortalRecord(inboxItemToPortalRecord(await this.getInboxItem(id)));
    }
  }

  async discoverWriteActions(options: { persistArtifact?: boolean } = {}): Promise<PortalActionMap> {
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
      actionPolicy: "Discovery is read-only. Exact allowlisted actions may be staged, but live commit requires explicit conversational approval of the displayed immutable diff in a new user message.",
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

    let redactedReport: PortalActionMap;
    if (options.persistArtifact === false) {
      redactedReport = redactSecrets(report) as PortalActionMap;
    } else {
      await mkdir(paths.tracesDir, { recursive: true });
      const artifactPath = path.join(paths.tracesDir, `write-actions-${Date.now()}.json`);
      redactedReport = redactSecrets({ ...report, artifactPath }) as PortalActionMap;
      await writeFile(artifactPath, `${JSON.stringify(redactedReport, null, 2)}\n`, "utf8");
    }
    await saveSession(session.serialize());
    this.actionCache = { items: redactedReport.actions, source: "boxlist" };
    return redactedReport;
  }

  async listPortalActionsForDefaults(): Promise<ListResult<PortalAction>> {
    if (this.actionCache) {
      return this.actionCache;
    }
    const report = await this.discoverWriteActions({ persistArtifact: false });
    return { items: report.actions, source: "boxlist" };
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

  private async resolveCommitAction(
    actionId: string,
    target: PortalActionCommitTarget = {}
  ): Promise<{ action?: PortalAction; validationIssues: string[] }> {
    const actions = await this.listPortalActions();
    let candidates = actions.items.filter((action) => action.id === actionId || action.title === actionId);
    if (target.recordId) {
      candidates = candidates.filter((action) => action.recordId === target.recordId);
    }
    if (target.serviceId) {
      candidates = candidates.filter((action) => action.serviceId === target.serviceId);
    }
    if (candidates.length === 0) {
      throw new PortalError(`Portal action '${actionId}' was not found.`, "NOT_FOUND", 404);
    }

    const supported = candidates.filter(isSupportedCommitAction);
    if (supported.length === 1) {
      return { action: supported[0]!, validationIssues: [] };
    }
    if (supported.length > 1 || candidates.length > 1) {
      return {
        validationIssues: [
          `Portal action '${actionId}' is ambiguous. Provide recordId or serviceId to choose one of ${supported.length || candidates.length} matching actions.`
        ]
      };
    }

    return { action: candidates[0]!, validationIssues: [] };
  }

  async listPortalWriteCapabilities(filter: {
    domain?: PortalWriteDomain;
    serviceId?: string;
    xuclass?: string;
  } = {}): Promise<ListResult<PortalWriteCapability>> {
    const actions = await this.listPortalActions({
      serviceId: filter.serviceId,
      xuclass: filter.xuclass
    }).catch(() => ({ items: [] as PortalAction[], source: "boxlist" as const }));
    const portalCapabilities = actions.items.map(actionToWriteCapability);
    const staticCapabilities: PortalWriteCapability[] = Object.entries(WRITE_DOMAIN_SPECS).map(([domain, spec]) => ({
      domain: domain as PortalWriteDomain,
      title: spec.title,
      description: spec.description,
      source: "static" as const,
      requiredFields: spec.requiredFields,
      targetRequired: spec.targetRequired,
      uploadSupported: spec.uploadSupported ?? false,
      liveCommitSupported: false as const,
      executionPolicy: "draft_only_no_live_write" as const
    }));
    const items = [...portalCapabilities, ...staticCapabilities].filter((item) => {
      if (filter.domain && item.domain !== filter.domain) {
        return false;
      }
      if (filter.serviceId && item.serviceId !== filter.serviceId) {
        return false;
      }
      if (filter.xuclass && item.xuclass !== filter.xuclass) {
        return false;
      }
      return true;
    });
    return {
      items: dedupeWriteCapabilities(items),
      source: actions.source
    };
  }

  async preparePortalWrite(input: {
    domain: PortalWriteDomain;
    values?: Record<string, unknown>;
    targetId?: string;
    actionId?: string;
  }): Promise<PreparedPortalWrite> {
    const values = input.values ?? {};
    const capabilities = await this.listPortalWriteCapabilities({ domain: input.domain });
    const capability = input.actionId
      ? capabilities.items.find((item) => item.actionId === input.actionId)
      : capabilities.items.find((item) => item.actionId) ?? capabilities.items[0];
    if (!capability) {
      throw new PortalError(`Portal write domain '${input.domain}' was not found.`, "NOT_FOUND", 404);
    }

    const targetId = input.targetId ?? capability.recordId;
    const validationIssues: string[] = [];
    if (capability.targetRequired && !targetId) {
      validationIssues.push("Missing targetId.");
    }
    for (const field of capability.requiredFields) {
      if (values[field] === undefined || values[field] === "") {
        validationIssues.push(`Missing required field '${field}'.`);
      }
    }

    let draft: PreparedPortalWrite["draft"];
    if (capability.actionId) {
      const action = await this.getPortalAction(capability.actionId);
      if (action.preparable) {
        const preparedAction = await this.preparePortalAction(action.id, values);
        validationIssues.push(...preparedAction.validationIssues);
        draft = preparedAction.draft;
      }
    }

    const prepared = {
      ok: validationIssues.length === 0,
      preparedOnly: true as const,
      willSend: false as const,
      domain: input.domain,
      title: capability.title,
      summary: `Prepared draft-only '${capability.title}'. No request was sent to ProPotsdam.`,
      safetyPolicy: "No portal write request was sent." as const,
      validationIssues,
      targetId,
      actionId: capability.actionId,
      actionTitle: capability.actionTitle,
      requiredFields: capability.requiredFields,
      values: stringifyValues(values),
      draft
    };
    return redactSecrets(prepared) as PreparedPortalWrite;
  }

  async preparePortalAction(id: string, values: Record<string, unknown> = {}): Promise<PreparedPortalAction> {
    const action = await this.getPortalAction(id);
    return this.prepareResolvedPortalAction(action, values);
  }

  private async prepareResolvedPortalAction(action: PortalAction, values: Record<string, unknown> = {}): Promise<PreparedPortalAction> {
    if (!action.preparable) {
      throw new PortalError(`Portal action '${action.id}' is not preparable: ${action.notPreparableReason ?? "unknown"}.`, "ACTION_NOT_PREPARABLE");
    }

    const { attachments, consumedKeys, issues: attachmentIssues } = await this.prepareAttachments(action, values);
    const validationIssues = action.fields
      .filter((field) => field.required && !field.hidden && !field.upload && values[field.name] === undefined && field.value === undefined)
      .map((field) => `Missing required field '${field.name}'.`);
    for (const field of action.fields.filter((field) => field.required && !field.hidden && field.upload)) {
      if (!attachments.some((attachment) => attachment.fieldName === field.name) && field.value === undefined) {
        validationIssues.push(`Missing required file field '${field.name}'.`);
      }
    }
    validationIssues.push(...attachmentIssues);
    for (const key of Object.keys(values)) {
      if (consumedKeys.has(key)) {
        continue;
      }
      const field = action.fields.find((item) => item.name === key || item.portalId === key);
      if (!field) {
        validationIssues.push(`Unknown field '${key}'.`);
        continue;
      }
      if (isSensitiveField(field)) {
        continue;
      }
      if (!field.editable) {
        validationIssues.push(`Field '${field.name}' is not editable.`);
        continue;
      }
      if (field.options?.length) {
        const proposed = values[key];
        if (proposed !== undefined && !field.options.some((option) => option.value === String(proposed))) {
          validationIssues.push(`Field '${field.name}' does not allow the provided value.`);
        }
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
          type: field.type,
          required: field.required,
          hidden: field.hidden,
          editable: field.editable,
          currentValue: field.value,
          proposedValue: field.upload || proposed === undefined ? undefined : String(proposed),
          options: field.options,
          upload: field.upload
        }, field);
      }),
      ...(attachments.length > 0 ? { attachments } : {})
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

  async stagePortalAction(
    actionId: string,
    values: Record<string, unknown> = {},
    target: PortalActionCommitTarget = {}
  ): Promise<StagedPortalActionResult> {
    const resolved = await this.resolveCommitAction(actionId, target);
    const validationIssues = [...resolved.validationIssues];
    const action = resolved.action;
    if (!action) {
      return {
        ok: false,
        actionId,
        actionTitle: undefined,
        pendingWriteHandle: undefined,
        requiresExplicitApproval: false,
        summary: `Pending write for '${actionId}' was not staged.`,
        validationIssues,
        diff: []
      };
    }

    validationIssues.push(...this.commitScopeIssues(action));
    const prepared = await this.prepareResolvedPortalAction(action, values);
    validationIssues.push(...prepared.validationIssues.filter((issue) => !issue.startsWith("Missing required field ")));
    validationIssues.push(...repairCommitValueIssues(action, prepared.draft.fields));
    const fieldDiff = prepared.draft.fields
      .filter((field) => field.proposedValue !== undefined && field.currentValue !== field.proposedValue)
      .map((field) => ({
        name: field.name,
        label: field.label,
        currentValue: field.currentValue,
        proposedValue: field.proposedValue!
      }));
    const attachments = prepared.draft.attachments ?? [];
    const attachmentDiff = attachments.map((attachment) => ({
      name: attachment.fieldName,
      label: attachment.fieldLabel,
      currentValue: undefined,
      proposedValue: `${attachment.filename} (${attachment.mimeType}, ${attachment.byteLength} bytes)`
    }));
    const diff = [...fieldDiff, ...attachmentDiff];
    if (diff.length === 0 && validationIssues.length === 0) {
      validationIssues.push("No editable field changes were provided.");
    }
    if (validationIssues.length > 0) {
      return {
        ok: false,
        actionId: action.id,
        actionTitle: action.title,
        pendingWriteHandle: undefined,
        requiresExplicitApproval: false,
        summary: `Pending write for '${action.title}' was not staged.`,
        validationIssues,
        diff
      };
    }

    const config = await loadConfig();
    const session = await this.authenticatedSession(config);
    const status = await this.validateSession(config, session);
    const accountId = portalAccountBinding(config, status);
    if (!accountId) {
      return {
        ok: false,
        actionId: action.id,
        actionTitle: action.title,
        requiresExplicitApproval: false,
        summary: `Pending write for '${action.title}' was not staged.`,
        validationIssues: ["The authenticated portal account could not be bound to this draft."],
        diff
      };
    }

    const pendingWriteHandle = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + PortalClient.pendingWriteTtlMs);
    let stagedAttachments: StagedPortalAttachment[] = [];
    try {
      stagedAttachments = await stagePendingAttachments(pendingWriteHandle, attachments);
    } catch (error) {
      await deletePendingWriteArtifacts(pendingWriteHandle);
      throw error;
    }
    const pendingWrite: PendingPortalWrite = {
      pendingWriteHandle,
      state: "staged",
      accountId,
      domain: classifyWriteDomain(action),
      actionId: action.id,
      actionTitle: action.title,
      recordId: action.recordId,
      recordTitle: action.recordTitle,
      serviceId: action.serviceId,
      serviceTitle: action.serviceTitle,
      xuclass: action.xuclass,
      serviceUrl: action.serviceUrl,
      contractFingerprint: actionContractFingerprint(action),
      values: Object.fromEntries(fieldDiff.map((entry) => [entry.name, entry.proposedValue])),
      diff,
      ...(stagedAttachments.length > 0 ? { attachments: stagedAttachments } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    let pendingWriteSaved = false;
    try {
      await savePendingWrite(pendingWrite);
      pendingWriteSaved = true;
      await saveSession(session.serialize());
    } catch (error) {
      if (pendingWriteSaved) {
        await deletePendingWrite(pendingWriteHandle).catch(() => false);
      } else {
        await deletePendingWriteArtifacts(pendingWriteHandle);
      }
      throw error;
    }
    return {
      ok: true,
      actionId: action.id,
      actionTitle: action.title,
      pendingWriteHandle,
      expiresAt: pendingWrite.expiresAt,
      requiresExplicitApproval: true,
      target: pendingWriteTargetReview(pendingWrite),
      summary: `Staged '${action.title}' for ${action.recordTitle ?? action.serviceTitle}. Show the exact diff, stop, and wait for a new message with explicit approval before committing.`,
      validationIssues: [],
      diff,
      ...(stagedAttachments.length > 0 ? { attachments: stagedAttachments.map(attachmentReview) } : {})
    };
  }

  async listPendingWrites(): Promise<PendingPortalWriteList> {
    const items = await listStoredPendingWrites();
    return { items: items.map(pendingWriteSummary) };
  }

  async cancelPendingWrites(pendingWriteHandles: string[]): Promise<CancelPendingWritesResult> {
    const cancelledHandles: string[] = [];
    const missingHandles: string[] = [];
    for (const pendingWriteHandle of [...new Set(pendingWriteHandles)]) {
      if (await deletePendingWrite(pendingWriteHandle).catch(() => false)) {
        cancelledHandles.push(pendingWriteHandle);
      } else {
        missingHandles.push(pendingWriteHandle);
      }
    }
    return {
      ok: missingHandles.length === 0,
      cancelledHandles,
      missingHandles
    };
  }

  async commitPendingWrites(pendingWriteHandles: string[]): Promise<PortalCommitBatchResult> {
    const results: PortalCommitResult[] = [];
    for (const pendingWriteHandle of pendingWriteHandles) {
      try {
        results.push(await this.commitPendingWrite(pendingWriteHandle));
      } catch (error) {
        results.push(notSentCommitResult(
          pendingWriteHandle,
          "unknown",
          `Pending write failed before dispatch: ${error instanceof Error ? error.message : String(error)}`
        ));
      }
    }
    const counts = {
      succeeded: results.filter((result) => result.outcome === "succeeded").length,
      notSent: results.filter((result) => result.outcome === "notSent").length,
      rejected: results.filter((result) => result.outcome === "rejected").length,
      outcomeUncertain: results.filter((result) => result.outcome === "outcomeUncertain").length
    };
    return {
      ok: results.length > 0 && counts.succeeded === results.length,
      partial: counts.succeeded > 0 && counts.succeeded < results.length,
      attemptedCount: results.length,
      counts,
      results
    };
  }

  private async commitPendingWrite(pendingWriteHandle: string): Promise<PortalCommitResult> {
    const pendingWrite = await loadPendingWrite(pendingWriteHandle).catch(() => null);
    if (!pendingWrite) {
      return notSentCommitResult(pendingWriteHandle, "unknown", "Pending write was not found, expired, cancelled, or already used.");
    }
    if (Date.parse(pendingWrite.expiresAt) <= Date.now()) {
      await deletePendingWrite(pendingWriteHandle);
      return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "Pending write expired before it was sent.");
    }

    let session: CookieSession | undefined;
    let action: PortalAction | undefined;
    let config: PortalConfig;
    let sourceForm: Awaited<ReturnType<CookieSession["get"]>>;
    let newRecordId: string;
    let originalId: string;
    let xml: string;
    let saveUrl: string;
    let commitUrl: string;
    let attachmentBytes = new Map<string, Buffer>();
    try {
      this.actionCache = undefined;
      const resolved = await this.resolveCommitAction(pendingWrite.actionId, {
        recordId: pendingWrite.recordId,
        serviceId: pendingWrite.serviceId
      });
      action = resolved.action;
      const scopeIssues = [
        ...resolved.validationIssues,
        ...(action ? this.commitScopeIssues(action) : [])
      ];
      if (!action || scopeIssues.length > 0) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(
          pendingWriteHandle,
          pendingWrite.actionId,
          scopeIssues.join(" ") || "The portal action is no longer available for live commit."
        );
      }
      if (actionContractFingerprint(action) !== pendingWrite.contractFingerprint) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "The portal form changed after review. Stage and approve a new draft.");
      }

      config = await loadConfig();
      session = await this.authenticatedSession(config);
      const status = await this.validateSession(config, session);
      if (portalAccountBinding(config, status) !== pendingWrite.accountId) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "The authenticated portal account changed after review. Stage and approve a new draft.");
      }
      const verifiedAttachments = await loadVerifiedStagedAttachments(pendingWriteHandle, pendingWrite.attachments ?? []);
      if (verifiedAttachments.issue) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, verifiedAttachments.issue);
      }
      attachmentBytes = verifiedAttachments.bytes;

      const sourceRecordId = action.recordId ?? pendingWrite.recordId ?? action.id;
      const sourceFormUrl = this.buildActionUrl(config, action.serviceUrl, sourceRecordId, "get");
      if (!sourceFormUrl) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "Portal action has no readable source form.");
      }
      sourceForm = await session.get(sourceFormUrl);
      if (!sourceForm.ok) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, `Portal form could not be revalidated (HTTP ${sourceForm.status}).`);
      }
      const sourceAction = extractPortalActions(sourceForm.body, sourceForm.contentType, {
        id: action.serviceId,
        title: action.serviceTitle,
        serviceUrl: action.serviceUrl,
        xuclass: action.xuclass
      }, {
        source: "detail",
        recordId: sourceRecordId,
        recordTitle: action.recordTitle
      }).map(sanitizePortalAction).find((candidate) => candidate.id === pendingWrite.actionId);
      if (!sourceAction || actionContractFingerprint(sourceAction) !== pendingWrite.contractFingerprint) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "The portal form changed during preflight. Stage and approve a new draft.");
      }
      action = sourceAction;
      newRecordId = randomUUID().toUpperCase();
      ({ xml, originalId } = this.buildCommitFormXml(
        sourceForm.body,
        action,
        pendingWrite.values,
        newRecordId,
        sourceRecordId,
        config
      ));
      const builtSaveUrl = this.buildActionUrl(config, action.serviceUrl, newRecordId, "save", {
        originalId,
        resourceOrigin: "form"
      });
      const builtCommitUrl = this.buildActionUrl(config, action.serviceUrl, newRecordId, action.id, { originalId });
      if (!builtSaveUrl || !builtCommitUrl) {
        await deletePendingWrite(pendingWriteHandle);
        return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "Portal action has no complete write contract.");
      }
      saveUrl = builtSaveUrl;
      commitUrl = builtCommitUrl;
    } catch (error) {
      await deletePendingWrite(pendingWriteHandle).catch(() => false);
      return notSentCommitResult(
        pendingWriteHandle,
        pendingWrite.actionId,
        `Pending write failed preflight: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let claimed: PendingPortalWrite | null;
    try {
      claimed = await claimPendingWrite(pendingWriteHandle);
    } catch (error) {
      await deletePendingWrite(pendingWriteHandle).catch(() => false);
      await deleteClaimedPendingWrite(pendingWriteHandle).catch(() => undefined);
      return notSentCommitResult(
        pendingWriteHandle,
        pendingWrite.actionId,
        `Pending write could not be claimed before dispatch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!claimed) {
      return notSentCommitResult(pendingWriteHandle, pendingWrite.actionId, "Pending write could not be claimed because it expired or was already used.");
    }
    let permit: PortalWritePermit;
    try {
      permit = issuePortalWritePermit(claimed, [
        { method: "POST", url: saveUrl },
        ...(claimed.attachments ?? []).flatMap((attachment) => attachment.uploadEndpoint
          ? [{
              method: "POST" as const,
              url: this.buildUploadUrl(config, attachment.uploadEndpoint, newRecordId, originalId)
            }]
          : []),
        { method: "GET", url: commitUrl }
      ]);
    } catch (error) {
      await deleteClaimedPendingWrite(pendingWriteHandle).catch(() => undefined);
      return notSentCommitResult(
        pendingWriteHandle,
        pendingWrite.actionId,
        `Internal write permit could not be issued before dispatch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let attachmentUploads: NonNullable<PortalCommitResult["attachmentUploads"]> = [];
    try {
      const saveResponse = await session.writePost(permit, saveUrl, xml, {
        headers: {
          "content-type": "application/xml;charset=UTF-8"
        }
      });
      if (!saveResponse.ok) {
        const portalMessage = portalResponseMessage(saveResponse.body, saveResponse.contentType);
        return dispatchedFailureResult(
          claimed,
          saveResponse.status,
          `Portal returned HTTP ${saveResponse.status} while saving '${claimed.actionTitle}'.`,
          portalMessage
        );
      }

      attachmentUploads = await this.uploadStagedAttachments(
        permit,
        config,
        session,
        claimed.attachments ?? [],
        attachmentBytes,
        newRecordId,
        originalId
      );
      if (attachmentUploads.some((upload) => !upload.ok)) {
        const failed = attachmentUploads.find((upload) => !upload.ok)!;
        return {
          ...dispatchedFailureResult(
            claimed,
            failed.status,
            `Portal returned HTTP ${failed.status} while uploading attachment '${failed.filename}'.`
          ),
          recordId: newRecordId,
          attachmentUploads
        };
      }

      const response = await session.writeGet(permit, commitUrl);
      const portalMessage = portalResponseMessage(response.body, response.contentType);
      const returnedRecordId = extractOpenFormId(response.body);
      if (!response.ok || !returnedRecordId) {
        return {
          ...dispatchedFailureResult(
            claimed,
            response.status,
            response.ok
              ? `Portal response did not prove that '${claimed.actionTitle}' completed.`
              : `Portal returned HTTP ${response.status} for '${claimed.actionTitle}'.`,
            portalMessage
          ),
          recordId: returnedRecordId ?? newRecordId,
          ...(attachmentUploads.length > 0 ? { attachmentUploads } : {})
        };
      }
      return {
        ok: true,
        outcome: "succeeded",
        pendingWriteHandle,
        actionId: claimed.actionId,
        recordId: returnedRecordId,
        completedAt: new Date().toISOString(),
        status: response.status,
        summary: `Committed ${commitSummaryLabel(action)} '${claimed.actionTitle}'.`,
        portalMessage: portalMessage || undefined,
        ...(attachmentUploads.length > 0 ? { attachmentUploads } : {})
      };
    } catch (error) {
      return {
        ok: false,
        outcome: "outcomeUncertain",
        pendingWriteHandle,
        actionId: claimed.actionId,
        recordId: newRecordId,
        completedAt: new Date().toISOString(),
        summary: `The write was dispatched, but its final outcome is uncertain. Do not retry automatically. ${error instanceof Error ? error.message : String(error)}`,
        ...(attachmentUploads.length > 0 ? { attachmentUploads } : {})
      };
    } finally {
      closePortalWritePermit(permit);
      await saveSession(session.serialize()).catch(() => undefined);
      await deleteClaimedPendingWrite(pendingWriteHandle).catch(() => undefined);
    }
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

  private async listStructuredInboxRecords(filter: {
    serviceId?: string;
    xuclass?: string;
    domain?: PortalReadDomain;
  }): Promise<PortalRecordItem[]> {
    if (filter.serviceId || filter.xuclass && filter.xuclass !== "ESQ_MESSAGES" || filter.domain && filter.domain !== "notification" && filter.domain !== "unknown") {
      return [];
    }
    const inbox = await this.listInbox().catch(() => ({ items: [] }));
    return inbox.items.map(inboxItemToPortalRecord);
  }

  private async prepareAttachments(
    action: PortalAction,
    values: Record<string, unknown>
  ): Promise<{ attachments: PreparedPortalAttachment[]; consumedKeys: Set<string>; issues: string[] }> {
    const uploadFields = action.fields.filter((field) => Boolean(field.upload));
    const consumedKeys = new Set<string>();
    const issues: string[] = [];
    const attachments: PreparedPortalAttachment[] = [];
    const aliasKeys = ["attachmentFilePath", "filePath", "photoPath", "imagePath"];
    const providedAliases = aliasKeys.filter((key) => values[key] !== undefined && values[key] !== "");

    if (uploadFields.length === 0) {
      for (const key of providedAliases) {
        consumedKeys.add(key);
      }
      if (providedAliases.length > 0) {
        issues.push(`Portal action '${action.id}' does not expose a supported upload field for attachments.`);
      }
      return { attachments, consumedKeys, issues };
    }

    if (providedAliases.length > 0 && uploadFields.length > 1) {
      for (const key of providedAliases) {
        consumedKeys.add(key);
      }
      issues.push("Attachment file path is ambiguous because the portal action exposes multiple upload fields. Use the specific upload field name instead.");
    }

    for (const field of uploadFields) {
      const input = attachmentInputForField(values, field, uploadFields.length === 1 ? providedAliases : []);
      if (!input) {
        continue;
      }
      consumedKeys.add(input.key);
      if (!field.editable) {
        issues.push(`Field '${field.name}' is not editable.`);
        continue;
      }
      if (!field.upload?.supported || !field.upload.endpoint) {
        issues.push(`Upload field '${field.name}' does not expose a supported upload endpoint.`);
        continue;
      }
      const prepared = await prepareLocalImageAttachment(String(input.value), field);
      if (prepared.issue) {
        issues.push(prepared.issue);
        continue;
      }
      if (prepared.attachment) {
        attachments.push(prepared.attachment);
      }
    }

    return { attachments, consumedKeys, issues };
  }

  private commitScopeIssues(action: PortalAction): string[] {
    if (!isSupportedCommitAction(action)) {
      return ["Only Meine Daten/save_partner and Reparatur/cmdsend damage reports can be committed in this version."];
    }
    if (!action.preparable || action.source !== "detail") {
      return ["Only detail-based preparable portal actions can be committed."];
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

  private async uploadStagedAttachments(
    permit: PortalWritePermit,
    config: PortalConfig,
    session: CookieSession,
    attachments: StagedPortalAttachment[],
    attachmentBytes: Map<string, Buffer>,
    recordId: string,
    originalId: string
  ): Promise<NonNullable<PortalCommitResult["attachmentUploads"]>> {
    const results: NonNullable<PortalCommitResult["attachmentUploads"]> = [];
    for (const attachment of attachments) {
      if (!attachment.uploadEndpoint) {
        results.push({
          fieldName: attachment.fieldName,
          filename: attachment.filename,
          ok: false,
          status: 0
        });
        continue;
      }
      const form = new FormData();
      const bytes = attachmentBytes.get(attachment.filePath);
      if (!bytes) {
        results.push({
          fieldName: attachment.fieldName,
          filename: attachment.filename,
          ok: false,
          status: 0
        });
        continue;
      }
      const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.set("file", new Blob([blobBytes], { type: attachment.mimeType }), attachment.filename);
      form.set("fieldName", attachment.fieldName);
      form.set("recordId", recordId);
      form.set("originalId", originalId);
      const response = await session.writePost(
        permit,
        this.buildUploadUrl(config, attachment.uploadEndpoint, recordId, originalId),
        form
      );
      results.push({
        fieldName: attachment.fieldName,
        filename: attachment.filename,
        ok: response.ok,
        status: response.status
      });
    }
    return results;
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

  private buildUploadUrl(config: PortalConfig, endpoint: string, recordId: string, originalId: string): string {
    const url = new URL(endpoint, config.baseUrl);
    if (!url.searchParams.has("id")) {
      url.searchParams.set("id", recordId);
    }
    if (!url.searchParams.has("originalId")) {
      url.searchParams.set("originalId", originalId);
    }
    if (!url.searchParams.has("api")) {
      url.searchParams.set("api", config.apiVersion);
    }
    if (!url.searchParams.has("head-oppc-version")) {
      url.searchParams.set("head-oppc-version", config.appVersion || DEFAULT_APP_VERSION);
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

async function stagePendingAttachments(
  pendingWriteHandle: string,
  attachments: PreparedPortalAttachment[]
): Promise<StagedPortalAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }
  const artifactDir = pendingWriteArtifactsDir(pendingWriteHandle);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await chmod(artifactDir, 0o700);
  const staged: StagedPortalAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const safeName = path.basename(attachment.filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    const stagedPath = path.join(artifactDir, `${index + 1}-${safeName}`);
    await copyFile(attachment.filePath, stagedPath);
    await chmod(stagedPath, 0o600);
    const bytes = await readFile(stagedPath);
    if (bytes.byteLength !== attachment.byteLength) {
      throw new Error(`Attachment '${attachment.filename}' changed while it was being staged.`);
    }
    if (await detectImageMimeType(stagedPath) !== attachment.mimeType) {
      throw new Error(`Attachment '${attachment.filename}' changed type while it was being staged.`);
    }
    staged.push({
      ...attachment,
      filePath: stagedPath,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  return staged;
}

async function loadVerifiedStagedAttachments(
  pendingWriteHandle: string,
  attachments: StagedPortalAttachment[]
): Promise<{ issue?: string; bytes: Map<string, Buffer> }> {
  const expectedDir = path.resolve(pendingWriteArtifactsDir(pendingWriteHandle));
  const verifiedBytes = new Map<string, Buffer>();
  for (const attachment of attachments) {
    try {
      if (path.dirname(path.resolve(attachment.filePath)) !== expectedDir) {
        return {
          issue: `Staged attachment '${attachment.filename}' is outside its immutable pending-write storage. Stage and approve a new draft.`,
          bytes: verifiedBytes
        };
      }
      const fileStat = await stat(attachment.filePath);
      if (!fileStat.isFile() || fileStat.size !== attachment.byteLength) {
        return {
          issue: `Staged attachment '${attachment.filename}' changed after review. Stage and approve a new draft.`,
          bytes: verifiedBytes
        };
      }
      const bytes = await readFile(attachment.filePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== attachment.sha256) {
        return {
          issue: `Staged attachment '${attachment.filename}' changed after review. Stage and approve a new draft.`,
          bytes: verifiedBytes
        };
      }
      verifiedBytes.set(attachment.filePath, bytes);
    } catch {
      return {
        issue: `Staged attachment '${attachment.filename}' is unavailable. Stage and approve a new draft.`,
        bytes: verifiedBytes
      };
    }
  }
  return { bytes: verifiedBytes };
}

function attachmentReview(attachment: StagedPortalAttachment): PortalAttachmentReview {
  return {
    fieldName: attachment.fieldName,
    fieldLabel: attachment.fieldLabel,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    sha256: attachment.sha256,
    uploadSupported: attachment.uploadSupported
  };
}

function pendingWriteSummary(pendingWrite: PendingPortalWrite): PendingPortalWriteSummary {
  return {
    pendingWriteHandle: pendingWrite.pendingWriteHandle,
    accountId: pendingWrite.accountId,
    domain: pendingWrite.domain,
    actionId: pendingWrite.actionId,
    actionTitle: pendingWrite.actionTitle,
    serviceId: pendingWrite.serviceId,
    serviceTitle: pendingWrite.serviceTitle,
    recordId: pendingWrite.recordId,
    recordTitle: pendingWrite.recordTitle,
    diff: pendingWrite.diff,
    ...(pendingWrite.attachments?.length
      ? { attachments: pendingWrite.attachments.map(attachmentReview) }
      : {}),
    createdAt: pendingWrite.createdAt,
    expiresAt: pendingWrite.expiresAt,
    requiresExplicitApproval: true
  };
}

function pendingWriteTargetReview(pendingWrite: PendingPortalWrite): StagedPortalActionResult["target"] {
  return {
    accountId: pendingWrite.accountId,
    domain: pendingWrite.domain,
    serviceId: pendingWrite.serviceId,
    serviceTitle: pendingWrite.serviceTitle,
    recordId: pendingWrite.recordId,
    recordTitle: pendingWrite.recordTitle
  };
}

function actionContractFingerprint(action: PortalAction): string {
  const contract = {
    id: action.id,
    serviceId: action.serviceId,
    serviceUrl: action.serviceUrl,
    xuclass: action.xuclass,
    recordId: action.recordId,
    actionKind: action.actionKind,
    method: action.method,
    endpoint: action.endpoint,
    fields: action.fields.map((field) => ({
      name: field.name,
      portalId: field.portalId,
      label: field.label,
      type: field.type,
      required: field.required,
      hidden: field.hidden,
      editable: field.editable,
      value: field.value,
      options: field.options?.map((option) => ({
        value: option.value,
        label: option.label,
        selected: option.selected
      })),
      upload: field.upload && {
        supported: field.upload.supported,
        mode: field.upload.mode,
        endpoint: field.upload.endpoint,
        acceptMimeTypes: field.upload.acceptMimeTypes,
        maxBytes: field.upload.maxBytes
      }
    }))
  };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function portalAccountBinding(config: PortalConfig, status: AuthResult): string | undefined {
  const accountId = status.userId ?? config.username;
  return accountId?.trim().toUpperCase() || undefined;
}

function notSentCommitResult(
  pendingWriteHandle: string,
  actionId: string,
  summary: string
): PortalCommitResult {
  return {
    ok: false,
    outcome: "notSent",
    pendingWriteHandle,
    actionId,
    completedAt: new Date().toISOString(),
    summary
  };
}

function dispatchedFailureResult(
  pendingWrite: PendingPortalWrite,
  status: number,
  summary: string,
  portalMessage = ""
): PortalCommitResult {
  const rejected = isDefinitivePortalRejection(status, portalMessage);
  return {
    ok: false,
    outcome: rejected ? "rejected" : "outcomeUncertain",
    pendingWriteHandle: pendingWrite.pendingWriteHandle,
    actionId: pendingWrite.actionId,
    completedAt: new Date().toISOString(),
    status,
    summary: rejected
      ? `${summary} The portal definitively rejected the request.`
      : `${summary} The final outcome is uncertain. Do not retry automatically.`,
    portalMessage: portalMessage || undefined
  };
}

function isDefinitivePortalRejection(status: number, portalMessage: string): boolean {
  if (status < 400 || status >= 500 || status === 408 || status === 425 || status === 429) {
    return false;
  }
  return /reject|abgelehnt|forbidden|ung[uü]ltig|invalid|nicht (?:m[oö]glich|erlaubt|zul[aä]ssig)/i.test(portalMessage);
}

function portalResponseMessage(body: string, contentType?: string): string {
  const normalized = normalizeDetailText(body, contentType);
  if (normalized) {
    return normalized;
  }
  return contentType?.toLowerCase().includes("text/plain")
    ? body.replace(/\s+/g, " ").trim().slice(0, 8000)
    : "";
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

function actionToWriteCapability(action: PortalAction): PortalWriteCapability {
  const domain = classifyWriteDomain(action);
  const spec = WRITE_DOMAIN_SPECS[domain];
  const liveCommitSupported = isSupportedCommitAction(action);
  const uploadSupported = action.fields.some((field) => field.upload?.supported === true);
  return {
    domain,
    title: action.title || spec.title,
    description: spec.description,
    source: "portal_action",
    serviceId: action.serviceId,
    serviceTitle: action.serviceTitle,
    xuclass: action.xuclass,
    actionId: action.id,
    actionTitle: action.title,
    actionKind: action.actionKind,
    recordId: action.recordId,
    recordTitle: action.recordTitle,
    requiredFields: mergeRequiredFields(spec.requiredFields, action.fields.filter((field) => field.required && !field.hidden).map((field) => field.name)),
    targetRequired: spec.targetRequired,
    uploadSupported,
    liveCommitSupported,
    executionPolicy: liveCommitSupported ? "conversational_approval_required_live_commit" : "draft_only_no_live_write"
  };
}

function classifyWriteDomain(action: PortalAction): PortalWriteDomain {
  const haystack = [
    action.id,
    action.title,
    action.serviceTitle,
    action.xuclass,
    action.recordTitle,
    ...action.fields.flatMap((field) => [field.name, field.label, field.type])
  ].filter(Boolean).join(" ").toLowerCase();
  if (action.actionKind === "read_confirmation") {
    return /hausinfo|pinbrd/.test(haystack) ? "house_notice_ack" : "read_confirmation";
  }
  if (action.actionKind === "external_link" || action.actionKind === "navigation") {
    return "external_navigation";
  }
  if (/esq_tena_dmg|reparatur|schaden|mangel|defekt/.test(haystack)) {
    return /termin|appointment/.test(haystack) ? "repair_appointment" : "repair_report";
  }
  if (/esq_tena_csm|verbr[aä]uch|verbrauch|z[aä]hler|zaehler|meter/.test(haystack)) {
    return "meter_reading";
  }
  if (/esq_ia_reobj|immobiliensuche|wohnung|objekt/.test(haystack)) {
    if (/besichtigung|termin|viewing/.test(haystack)) {
      return "viewing_booking";
    }
    if (/bewerbung|application/.test(haystack)) {
      return "rental_application";
    }
    return "real_estate_inquiry";
  }
  if (/esq_ia_part|meine daten|profil|profile|partner/.test(haystack)) {
    return "profile_account_setting";
  }
  if (/tier|hund|haustier/.test(haystack)) {
    return "pet_approval";
  }
  if (/iban|bic|sepa|bank|zahlung|konto/.test(haystack)) {
    return "payment_method";
  }
  if (/message|nachricht|reply|antwort|chat/.test(haystack)) {
    return "workflow_reply";
  }
  return "service_ticket";
}

function dedupeWriteCapabilities(items: PortalWriteCapability[]): PortalWriteCapability[] {
  const seen = new Map<string, PortalWriteCapability>();
  for (const item of items) {
    const key = `${item.domain}::${item.actionId ?? item.source}::${item.recordId ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

function mergeRequiredFields(primary: string[], secondary: string[]): string[] {
  return [...new Set([...primary, ...secondary])];
}

function stringifyValues(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === undefined ? "" : String(value)]));
}

function attachmentInputForField(
  values: Record<string, unknown>,
  field: PortalActionField,
  aliasKeys: string[]
): { key: string; value: unknown } | undefined {
  for (const key of [field.name, field.portalId, ...aliasKeys].filter((item): item is string => Boolean(item))) {
    const value = values[key];
    if (value !== undefined && value !== "") {
      return { key, value };
    }
  }
  return undefined;
}

async function prepareLocalImageAttachment(
  filePath: string,
  field: PortalActionField
): Promise<{ attachment?: PreparedPortalAttachment; issue?: string }> {
  const resolvedPath = path.resolve(filePath);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    return { issue: `Attachment file '${filePath}' was not found or is not readable.` };
  }
  if (!fileStat.isFile()) {
    return { issue: `Attachment path '${filePath}' is not a file.` };
  }
  if (field.upload?.maxBytes && fileStat.size > field.upload.maxBytes) {
    return { issue: `Attachment file '${filePath}' exceeds the portal upload size limit.` };
  }
  const mimeType = await detectImageMimeType(resolvedPath);
  if (!mimeType) {
    return { issue: `Attachment file '${filePath}' must be a JPEG or PNG image.` };
  }
  if (!acceptsMimeType(field.upload?.acceptMimeTypes, mimeType, resolvedPath)) {
    return { issue: `Upload field '${field.name}' does not accept ${mimeType} attachments.` };
  }
  return {
    attachment: {
      fieldName: field.name,
      fieldLabel: field.label,
      filePath: resolvedPath,
      filename: path.basename(resolvedPath),
      mimeType,
      byteLength: fileStat.size,
      uploadSupported: Boolean(field.upload?.supported && field.upload.endpoint),
      uploadEndpoint: field.upload?.endpoint
    }
  };
}

async function detectImageMimeType(filePath: string): Promise<"image/jpeg" | "image/png" | undefined> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytesRead >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return "image/png";
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function acceptsMimeType(accepted: string[] | undefined, mimeType: "image/jpeg" | "image/png", filePath: string): boolean {
  if (!accepted || accepted.length === 0) {
    return true;
  }
  const extension = path.extname(filePath).toLowerCase();
  return accepted.some((entry) => {
    const normalized = entry.toLowerCase();
    return normalized === mimeType ||
      normalized === "image/*" ||
      normalized === extension ||
      normalized === ".jpeg" && mimeType === "image/jpeg" ||
      normalized === ".jpg" && mimeType === "image/jpeg" ||
      normalized === ".png" && mimeType === "image/png";
  });
}

function inboxItemToPortalRecord(item: InboxItem): PortalRecordItem {
  return {
    id: item.id,
    title: item.title,
    date: item.date,
    category: item.category,
    subtitle: item.subtitle,
    abstract: item.abstract,
    detailUrl: item.detailUrl,
    serviceUrl: item.serviceUrl,
    rawSource: item.rawSource,
    serviceTitle: "Nachrichten",
    xuclass: "ESQ_MESSAGES",
    itemKind: "record",
    readable: true,
    detailText: item.detailText
  };
}

function sanitizePortalAction(action: PortalAction): PortalAction {
  return {
    ...action,
    fields: action.fields.map((field) => {
      if (isSensitiveField(field)) {
        const { value: _value, options: _options, ...rest } = field;
        void _value;
        void _options;
        return rest;
      }
      return field;
    }),
    rawHints: redactSecrets(action.rawHints) as Record<string, string>
  };
}

function sanitizePreparedField(
  field: PreparedPortalAction["draft"]["fields"][number],
  sourceField?: Pick<PortalActionField, "hidden" | "name" | "portalId">
): PreparedPortalAction["draft"]["fields"][number] {
  if (isSensitiveField(sourceField ?? field)) {
    const { currentValue: _currentValue, proposedValue: _proposedValue, options: _options, ...rest } = field;
    void _currentValue;
    void _proposedValue;
    void _options;
    return rest;
  }
  return field;
}

function isSensitiveField(field: Pick<PortalActionField, "hidden" | "name" | "portalId">): boolean {
  return field.hidden || isSensitiveName(field.name) || Boolean(field.portalId && isSensitiveName(field.portalId));
}

function isSensitiveName(name: string): boolean {
  return /csrf|token|cookie|session|password|sap-ffield/i.test(name);
}

function isChangedFlagField(field: PortalActionField): boolean {
  return field.name === "ESQ_CHANGED" || field.portalId === "ESQ_CHANGED";
}

function isSupportedCommitAction(action: PortalAction): boolean {
  return isProfileCommitAction(action) || isRepairSubmitCommitAction(action);
}

function isProfileCommitAction(action: PortalAction): boolean {
  return action.id === "save_partner" &&
    action.xuclass === "ESQ_IA_PART" &&
    action.source === "detail" &&
    action.preparable;
}

function isRepairSubmitCommitAction(action: PortalAction): boolean {
  const title = `${action.title} ${action.recordTitle ?? ""}`.toLowerCase();
  return action.id === "cmdsend" &&
    action.xuclass === "ESQ_TENA_DMG" &&
    action.source === "detail" &&
    action.actionKind === "form" &&
    action.preparable &&
    title.includes("schaden melden");
}

function commitSummaryLabel(action: PortalAction): string {
  if (isProfileCommitAction(action)) {
    return "profile action";
  }
  if (isRepairSubmitCommitAction(action)) {
    return "repair action";
  }
  return "portal action";
}

function repairCommitValueIssues(
  action: PortalAction,
  fields: PreparedPortalAction["draft"]["fields"]
): string[] {
  if (!isRepairSubmitCommitAction(action)) {
    return [];
  }
  const proposed = fields.filter((field) => field.proposedValue !== undefined && field.proposedValue !== "");
  const hasDescription = proposed.some((field) =>
    field.name === "msg_txt" ||
      field.name === "description" ||
      /beschreibung/i.test(field.label ?? "")
  );
  const hasDamageTopic = proposed.some((field) => field.name.startsWith("TOPIC_"));
  const issues: string[] = [];
  if (!hasDescription) {
    issues.push("Repair reports require a proposed description field.");
  }
  if (!hasDamageTopic) {
    issues.push("Repair reports require a proposed Schadensart/TOPIC field.");
  }
  return issues;
}

function replaceXmlFieldValue(xml: string, field: PortalActionField, value: string): string {
  const selectors = [field.portalId, field.name].filter((item): item is string => Boolean(item));
  for (const selector of selectors) {
    const textPattern = new RegExp(`(<(?:textfield|numberfield|datefield|textarea)\\b(?=[^>]*(?:id|refname|name)="${escapeRegExp(selector)}")[^>]*>)([\\s\\S]*?)(<\\/(?:textfield|numberfield|datefield|textarea)>)`);
    if (textPattern.test(xml)) {
      return xml.replace(textPattern, `$1${escapeXmlText(value)}$3`);
    }
    const choicePattern = new RegExp(`(<choicefield\\b(?=[^>]*(?:id|refname|name)="${escapeRegExp(selector)}")[^>]*>)([\\s\\S]*?)(<\\/choicefield>)`);
    const choiceMatch = choicePattern.exec(xml);
    if (choiceMatch) {
      const choices = choiceMatch[2] ?? "";
      const nextChoices = choices
        .replace(/\sselected="true"/g, "")
        .replace(new RegExp(`(<choice\\b(?=[^>]*(?:id|value)="${escapeRegExp(value)}")[^>]*?)(\\s*\\/?>)`), "$1 selected=\"true\"$2");
      if (nextChoices === choices.replace(/\sselected="true"/g, "")) {
        continue;
      }
      return xml.replace(choicePattern, `$1${nextChoices}$3`);
    }
  }
  return xml;
}

function replaceRootFormId(xml: string, newRecordId: string): string {
  return xml.replace(/(<(?:[A-Za-z_][\w.-]*:)?form\b[^>]*\bid=")[^"]+(")/, `$1${escapeXmlAttribute(newRecordId)}$2`);
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

function safeExportFilename(input: string): string {
  const basename = path.basename(input).replace(/[/:\\?%*"<>|]/g, "_").trim();
  return basename || "portal-file";
}
