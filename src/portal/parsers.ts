import { DOCUMENT_ALIASES, INBOX_ALIASES } from "../constants.js";
import type {
  AuthResult,
  DocumentItem,
  InboxItem,
  PortalAction,
  PortalActionField,
  PortalActionFieldOption,
  PortalFileItem,
  PortalRecordItem,
  PortalReadDomain,
  PortalSection,
  PortalService,
  StructuredPortalRecord,
  StructuredPortalRecordConfidence
} from "../types.js";
import { collectObjects, firstScalar, flattenScalars, parseXml } from "./xml.js";

const DATE_PATTERN = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/;

export function parseBody(text: string, contentType?: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  if (contentType?.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }
  return parseXml(trimmed);
}

export function parseSessionStatus(text: string, contentType?: string): AuthResult {
  const parsed = parseBody(text, contentType);
  const scalars = flattenScalars(parsed);
  const logged = firstScalar(scalars, ["LOGGED", "logged"]);
  const userId = firstScalar(scalars, ["USER_ID", "@user", "user"]);
  const userFullName = firstScalar(scalars, ["USER_FULLNAME", "userFullName", "name"]);
  const authenticated = Boolean(
    userId ||
      userFullName ||
      (logged && !["false", "0", "", "N"].includes(logged.toUpperCase()))
  );

  return {
    state: authenticated ? "authenticated" : "unauthenticated",
    authenticated,
    userId,
    userFullName
  };
}

export function classifyAuthFailure(status: number, bodyText: string): AuthResult {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 499 || lower.includes("anmeldung fehlgeschlagen")) {
    return {
      state: "action_required",
      authenticated: false,
      action: "login_failed",
      reason: "Portal credentials were rejected."
    };
  }
  if (status === 492 || lower.includes("changepassword") || lower.includes("passwort")) {
    return {
      state: "action_required",
      authenticated: false,
      action: "password_change",
      reason: "The portal requires a password change."
    };
  }
  if (status === 493 || status === 494 || lower.includes("verification")) {
    return {
      state: "action_required",
      authenticated: false,
      action: "verification",
      reason: "The portal requires account verification."
    };
  }
  if (lower.includes("acceptterms") || lower.includes("acceptprivacy")) {
    return {
      state: "action_required",
      authenticated: false,
      action: "accept_terms",
      reason: "The portal requires terms or privacy acceptance."
    };
  }
  if (lower.includes("captcha")) {
    return {
      state: "action_required",
      authenticated: false,
      action: "captcha",
      reason: "The portal requires captcha completion."
    };
  }
  return {
    state: "error",
    authenticated: false,
    action: "unknown",
    reason: `Portal returned HTTP ${status}.`
  };
}

export function extractServices(text: string, contentType?: string): PortalService[] {
  const parsed = parseBody(text, contentType);
  const candidates: PortalService[] = collectObjects(parsed)
    .map((objectValue) => {
      const scalars = immediateScalars(objectValue);
      const title = firstScalar(scalars, [
        "title",
        "name",
        "TEXT",
        "XFTITLE",
        "XFSRVTEXT",
        "XFSRVGRP",
        "SERVICE_NAME"
      ]);
      const serviceUrl = firstScalar(scalars, ["SERVICE", "@service", "serviceUrl", "url"]);
      const xuclass = firstScalar(scalars, ["XUCLASS", "@xuclass", "application"]);
      const id = firstScalar(scalars, ["id", "SERVICEID", "@serviceId", "formid"]);
      if (!title || (!serviceUrl && !xuclass)) {
        return null;
      }
      const service: PortalService = {
        title: title ?? xuclass ?? serviceUrl ?? "Untitled service",
        raw: objectValue
      };
      if (id) {
        service.id = id;
      }
      if (serviceUrl) {
        service.serviceUrl = serviceUrl;
      }
      if (xuclass) {
        service.xuclass = xuclass;
      }
      return service;
    })
    .filter((service): service is PortalService => service !== null);

  return dedupeBy(candidates, (service) => `${service.title}::${service.serviceUrl ?? ""}::${service.xuclass ?? ""}`);
}

export function findSectionServices(services: PortalService[], section: PortalSection): PortalService[] {
  const aliases = section === "inbox" ? INBOX_ALIASES : DOCUMENT_ALIASES;
  return services.filter((service) => {
    const haystack = `${service.title} ${service.xuclass ?? ""} ${JSON.stringify(flattenScalars(service.raw))}`.toLowerCase();
    return aliases.some((alias) => haystack.includes(alias));
  });
}

export function extractInboxItems(text: string, contentType?: string): InboxItem[] {
  const parsed = parseBody(text, contentType);
  return dedupeBy(
    collectObjects(parsed).map(normalizeInboxCandidate).filter((item): item is InboxItem => item !== null),
    (item) => `${item.id}::${item.title}`
  );
}

export function extractDocumentItems(text: string, contentType?: string): DocumentItem[] {
  const parsed = parseBody(text, contentType);
  return dedupeBy(
    collectObjects(parsed).map(normalizeDocumentCandidate).filter((item): item is DocumentItem => item !== null),
    (item) => `${item.id}::${item.title}`
  );
}

export function extractPortalRecordItems(
  text: string,
  contentType: string | undefined,
  service: Pick<PortalService, "id" | "serviceUrl" | "xuclass"> & { title?: string; serviceId?: string; serviceTitle?: string }
): PortalRecordItem[] {
  const parsed = parseBody(text, contentType);
  return dedupeBy(
    collectObjects(parsed)
      .map((candidate) => normalizePortalRecordCandidate(candidate, service))
      .filter((item): item is PortalRecordItem => item !== null),
    (item) => `${item.serviceId ?? ""}::${item.id}::${item.title}`
  );
}

export function extractPortalActions(
  text: string,
  contentType: string | undefined,
  service: Pick<PortalService, "id" | "serviceUrl" | "xuclass"> & { title?: string; serviceId?: string; serviceTitle?: string },
  context: { source?: PortalAction["source"]; recordId?: string; recordTitle?: string } = {}
): PortalAction[] {
  const parsed = parseBody(text, contentType);
  const detailActions = context.source === "detail" ? extractDetailFormActions(parsed, service, context) : [];
  if (detailActions.length > 0) {
    return dedupeBy(detailActions, actionDedupeKey);
  }
  return dedupeBy(
    collectObjects(parsed)
      .map((candidate) => normalizePortalActionCandidate(candidate, service, context))
      .filter((action): action is PortalAction => action !== null),
    actionDedupeKey
  );
}

export function normalizeDetailText(text: string, contentType?: string): string {
  try {
    const parsed = parseBody(text, contentType);
    const scalars = flattenScalars(parsed);
    return Object.values(scalars).filter(Boolean).join("\n").slice(0, 8000);
  } catch {
    return text.replace(/\s+/g, " ").trim().slice(0, 8000);
  }
}

export function extractPortalFileItems(records: PortalRecordItem[]): PortalFileItem[] {
  return dedupeBy(
    records
      .filter(isPortalFileRecord)
      .map((record) => ({
        id: record.id,
        title: record.title,
        sourceRecordId: record.id,
        sourceRecordTitle: record.title,
        serviceId: record.serviceId,
        serviceTitle: record.serviceTitle,
        serviceUrl: record.serviceUrl,
        xuclass: record.xuclass,
        filename: record.filename ?? safeFilename(record.title),
        resourceId: record.resourceId,
        resourceOrigin: record.resourceOrigin,
        mimeType: record.mimeType,
        itemKind: record.itemKind,
        exportable: Boolean(record.serviceUrl && (record.resourceId || record.id) && record.itemKind !== "external_link")
      })),
    (item) => `${item.serviceId ?? ""}::${item.sourceRecordId}::${item.resourceId ?? ""}`
  );
}

export function toStructuredPortalRecord(record: PortalRecordItem): StructuredPortalRecord {
  const domain = classifyReadDomain(record);
  const status = extractStatus(record);
  const period = extractPeriod(record);
  const amount = extractAmount(record);
  const address = extractAddress(record);
  const fields = compactFields({
    serviceTitle: record.serviceTitle,
    xuclass: record.xuclass,
    category: record.category,
    filename: record.filename,
    resourceId: record.resourceId,
    resourceOrigin: record.resourceOrigin,
    mimeType: record.mimeType,
    status,
    period,
    amount,
    address
  });

  const structured: StructuredPortalRecord = {
    id: record.id,
    title: record.title,
    sourceRecordId: record.id,
    sourceRecordTitle: record.title,
    serviceId: record.serviceId,
    serviceTitle: record.serviceTitle,
    serviceUrl: record.serviceUrl,
    xuclass: record.xuclass,
    domain,
    confidence: domainConfidence(record, domain),
    itemKind: record.itemKind,
    readable: record.readable,
    date: record.date,
    category: record.category,
    status,
    period,
    amount,
    address,
    filename: record.filename,
    mimeType: record.mimeType,
    fields
  };
  if (record.detailText) {
    structured.detailText = record.detailText;
  }
  return structured;
}

function normalizeInboxCandidate(candidate: Record<string, unknown>): InboxItem | null {
  const scalars = flattenScalars(candidate);
  const title = firstScalar(scalars, ["subject", "title", "subtitle", "TEXT", "name"]);
  const id = firstScalar(scalars, ["id", "formid", "@id", "FORMID", "resourceId"]) ?? title;
  if (!title || !id) {
    return null;
  }

  return {
    id,
    title,
    subject: title,
    date: firstScalar(scalars, ["date", "createdAt", "created", "sentAt", "DATE"]),
    subtitle: firstScalar(scalars, ["subtitle", "SUBTITLE"]),
    sender: firstScalar(scalars, ["sender", "subtitle", "from", "SENDER"]),
    abstract: firstScalar(scalars, ["abstract", "note", "message", "preview", "ABSTRACT"]),
    category: firstScalar(scalars, ["category", "type", "CATEGORY"]),
    detailUrl: firstScalar(scalars, ["detailUrl", "url", "SERVICE"]),
    serviceUrl: firstScalar(scalars, ["SERVICE", "@service", "serviceUrl"]),
    rawSource: "boxlist",
    unread: firstBoolean(scalars, ["unread", "new", "isNew", "@unread"]) ?? false,
    replied: firstBoolean(scalars, ["replied", "@replied"])
  };
}

function normalizeDocumentCandidate(candidate: Record<string, unknown>): DocumentItem | null {
  const scalars = immediateScalars(candidate);
  const title = firstScalar(scalars, ["title", "filename", "name", "subtitle", "TEXT"]);
  const id = firstScalar(scalars, ["id", "formid", "@id", "FORMID", "resourceId"]);
  if (!title || !id) {
    return null;
  }
  const filename = firstScalar(scalars, ["filename", "title", "name", "TEXT"]) ?? safeFilename(title);
  const resourceId = firstScalar(scalars, ["resourceId", "RESOURCEID", "formid", "id"]);

  return {
    id,
    title,
    date: firstScalar(scalars, ["date", "createdAt", "created", "DATE"]),
    subtitle: firstScalar(scalars, ["subtitle", "SUBTITLE"]),
    abstract: firstScalar(scalars, ["abstract", "note", "description", "ABSTRACT"]),
    category: firstScalar(scalars, ["category", "type", "CATEGORY"]),
    detailUrl: firstScalar(scalars, ["detailUrl", "url", "SERVICE"]),
    serviceUrl: firstScalar(scalars, ["SERVICE", "@service", "serviceUrl"]),
    rawSource: "boxlist",
    filename,
    resourceId,
    resourceOrigin: firstScalar(scalars, ["resourceOrigin", "origin"]),
    mimeType: firstScalar(scalars, ["mimeType", "mediaType", "contentType"])
  };
}

function normalizePortalRecordCandidate(
  candidate: Record<string, unknown>,
  service: Pick<PortalService, "id" | "serviceUrl" | "xuclass"> & { title?: string; serviceId?: string; serviceTitle?: string }
): PortalRecordItem | null {
  const scalars = immediateScalars(candidate);
  const title = firstScalar(scalars, ["title", "filename", "name", "subtitle", "TEXT"]);
  const id = firstScalar(scalars, ["id", "formid", "@id", "FORMID", "resourceId"]) ?? title;
  if (!title || !id) {
    return null;
  }

  const resourceId = firstScalar(scalars, ["resourceId", "RESOURCEID"]);
  const resourceOrigin = firstScalar(scalars, ["resourceOrigin", "origin"]);
  const url = firstScalar(scalars, ["downloadUrl", "documentUrl", "url", "URL", "SERVICE"]);
  const mimeType = firstScalar(scalars, ["mimeType", "mediaType", "contentType"]);
  const filename = firstScalar(scalars, ["filename", "title", "name", "TEXT"]) ?? safeFilename(title);
  const classification = classifyPortalRecord({
    id,
    title,
    resourceId,
    url,
    scalars
  });

  return {
    id,
    title,
    date: firstScalar(scalars, ["date", "createdAt", "created", "DATE"]),
    subtitle: firstScalar(scalars, ["subtitle", "SUBTITLE"]),
    abstract: firstScalar(scalars, ["abstract", "note", "description", "ABSTRACT"]),
    category: firstScalar(scalars, ["category", "type", "CATEGORY"]),
    detailUrl: firstScalar(scalars, ["detailUrl", "SERVICE"]),
    serviceUrl: service.serviceUrl,
    rawSource: "boxlist",
    serviceId: service.serviceId ?? service.id,
    serviceTitle: service.serviceTitle ?? service.title ?? service.xuclass ?? "Unknown service",
    xuclass: service.xuclass,
    itemKind: classification.itemKind,
    readable: true,
    filename,
    resourceId,
    resourceOrigin,
    mimeType
  };
}

function classifyPortalRecord(input: {
  id: string;
  title: string;
  resourceId?: string;
  url?: string;
  scalars: Record<string, string>;
}): Pick<PortalRecordItem, "itemKind"> {
  const haystack = `${input.id} ${input.title} ${JSON.stringify(input.scalars)}`.toLowerCase();
  if (haystack.includes("$bs_readconfirmed") || haystack.includes("lesebestätigung")) {
    return { itemKind: "read_confirmation" };
  }
  if (haystack.includes("$bs_call_link") || /^https?:\/\//i.test(input.url ?? "")) {
    return { itemKind: "external_link" };
  }
  if (input.id.startsWith("$BS_") || input.id.startsWith("$") || firstScalar(input.scalars, ["action", "command", "ACTION"])) {
    return { itemKind: "action" };
  }
  if (input.resourceId) {
    return {
      itemKind: "resource"
    };
  }
  return { itemKind: "record" };
}

function normalizePortalActionCandidate(
  candidate: Record<string, unknown>,
  service: Pick<PortalService, "id" | "serviceUrl" | "xuclass"> & { title?: string; serviceId?: string; serviceTitle?: string },
  context: { source?: PortalAction["source"]; recordId?: string; recordTitle?: string } = {}
): PortalAction | null {
  const scalars = immediateScalars(candidate);
  const flatScalars = flattenScalars(candidate);
  const title = firstScalar(scalars, ["title", "filename", "subtitle", "TEXT"]);
  const id = firstScalar(scalars, ["id", "formid", "@id", "FORMID", "resourceId"]) ?? title;
  if (!title || !id) {
    return null;
  }

  const fields = extractActionFields(candidate);
  const command = firstScalar(flatScalars, ["command", "COMMAND", "action", "ACTION", "name"]);
  const explicitEndpoint = firstScalar(scalars, ["endpoint", "actionUrl", "formAction", "SERVICE"]);
  const endpoint = explicitEndpoint ?? service.serviceUrl;
  const url = firstScalar(flatScalars, ["url", "URL", "href", "link", "SERVICE"]);
  const methodValue = firstScalar(flatScalars, ["method", "METHOD"]);
  const hasExplicitActionHint = Boolean(command || methodValue || explicitEndpoint || id.startsWith("$BS_") || id.startsWith("$"));
  if ((context.source ?? "boxlist") === "boxlist" && fields.length > 0 && !hasExplicitActionHint) {
    return null;
  }
  const method = methodValue?.toUpperCase() === "GET" ? "GET" : "POST";
  const classification = classifyPortalAction({
    id,
    title,
    command,
    url,
    endpoint,
    fields
  });
  if (!classification) {
    return null;
  }

  return {
    id,
    serviceId: service.serviceId ?? service.id,
    serviceTitle: service.serviceTitle ?? service.title ?? service.xuclass ?? "Unknown service",
    serviceUrl: service.serviceUrl,
    xuclass: service.xuclass,
    title,
    source: context.source ?? "boxlist",
    recordId: context.recordId,
    recordTitle: context.recordTitle,
    actionKind: classification.actionKind,
    method,
    endpoint,
    fields,
    requiresInput: fields.some((field) => field.required && !field.hidden && !field.value),
    riskLevel: classification.riskLevel,
    preparable: classification.preparable,
    notPreparableReason: classification.notPreparableReason,
    rawHints: compactHints({
      command,
      method: methodValue,
      endpoint,
      id
    })
  };
}

function extractDetailFormActions(
  parsed: unknown,
  service: Pick<PortalService, "id" | "serviceUrl" | "xuclass"> & { title?: string; serviceId?: string; serviceTitle?: string },
  context: { source?: PortalAction["source"]; recordId?: string; recordTitle?: string }
): PortalAction[] {
  const actionObjects = collectNamedObjects(parsed, "action");
  const fieldTags = ["field", "textfield", "textarea", "choicefield", "checkboxfield", "hiddenfield", "filefield", "uploadfield", "attachmentfield"];
  const fields = dedupeBy(
    fieldTags
      .flatMap((key) => collectNamedObjects(parsed, key).map((field) => ({ field, key })))
      .map(({ field, key }) => normalizeActionField(field, key))
      .filter((field): field is PortalActionField => field !== null),
    (field) => field.name
  );
  const actionObject = actionObjects.find((objectValue) => {
    const scalars = flattenScalars(objectValue);
    const id = firstScalar(scalars, ["@command", "command", "id", "@id", "name", "action"]);
    const text = firstScalar(scalars, ["text", "TEXT", "title", "@title", "label"]);
    return looksWritableAction(`${id ?? ""} ${text ?? ""}`) && fields.length > 0;
  });
  if (!actionObject) {
    return [];
  }

  const actionScalars = flattenScalars(actionObject);
  const command = firstScalar(actionScalars, ["@command", "command", "COMMAND", "action"]);
  const id = command ?? firstScalar(actionScalars, ["id", "@id", "name", "@name"]) ?? "portal_action";
  const title = firstScalar(actionScalars, ["text", "TEXT", "title", "@title", "label", "@label"]) ?? id;
  const methodValue = firstScalar(actionScalars, ["method", "@method", "METHOD"]);
  const endpoint = firstScalar(actionScalars, ["endpoint", "actionUrl", "formAction", "SERVICE"]) ?? service.serviceUrl;
  return [{
    id,
    serviceId: service.serviceId ?? service.id,
    serviceTitle: service.serviceTitle ?? service.title ?? service.xuclass ?? "Unknown service",
    serviceUrl: service.serviceUrl,
    xuclass: service.xuclass,
    title,
    source: "detail",
    recordId: context.recordId,
    recordTitle: context.recordTitle,
    actionKind: "form",
    method: methodValue?.toUpperCase() === "GET" ? "GET" : "POST",
    endpoint,
    fields,
    requiresInput: fields.some((field) => field.required && !field.hidden && field.editable && !field.value),
    riskLevel: "medium",
    preparable: true,
    rawHints: compactHints({
      command: command ?? id,
      method: methodValue,
      endpoint,
      recordId: context.recordId
    })
  }];
}

function classifyPortalAction(input: {
  id: string;
  title: string;
  command?: string;
  url?: string;
  endpoint?: string;
  fields: PortalActionField[];
}): Pick<PortalAction, "actionKind" | "riskLevel" | "preparable" | "notPreparableReason"> | null {
  const haystack = `${input.id} ${input.title} ${input.command ?? ""}`.toLowerCase();
  if (haystack.includes("$bs_readconfirmed") || haystack.includes("lesebestätigung")) {
    return nonPreparableAction("read_confirmation", "read_confirmation", "none");
  }
  if (haystack.includes("$bs_call_link") || /^https?:\/\//i.test(input.url ?? "")) {
    return nonPreparableAction("external_link", "external_link", "none");
  }
  if (haystack.includes("navigate") || haystack.includes("zurück") || haystack.includes("weiter") && input.fields.length === 0) {
    return nonPreparableAction("navigation", "navigation", "none");
  }

  const commandLooksWritable = looksWritableAction(input.command ?? input.title);
  const hasEnoughFormMetadata = input.fields.length > 0 && Boolean(input.endpoint);
  if (hasEnoughFormMetadata && (commandLooksWritable || input.command || input.endpoint)) {
    return {
      actionKind: commandLooksWritable ? "form" : "portal_action",
      riskLevel: "medium",
      preparable: true
    };
  }
  if (input.id.startsWith("$BS_") || input.id.startsWith("$") || input.command) {
    return nonPreparableAction("ambiguous", "ambiguous", "low");
  }
  return null;
}

function nonPreparableAction(
  actionKind: PortalAction["actionKind"],
  notPreparableReason: NonNullable<PortalAction["notPreparableReason"]>,
  riskLevel: PortalAction["riskLevel"]
): Pick<PortalAction, "actionKind" | "riskLevel" | "preparable" | "notPreparableReason"> {
  return {
    actionKind,
    riskLevel,
    preparable: false,
    notPreparableReason
  };
}

function extractActionFields(candidate: Record<string, unknown>): PortalActionField[] {
  const fieldTags = ["field", "textfield", "textarea", "choicefield", "checkboxfield", "hiddenfield", "filefield", "uploadfield", "attachmentfield"];
  const fieldObjects = fieldTags
    .flatMap((key) => collectNamedObjects(candidate, key).map((field) => ({ field, key })));
  if (fieldObjects.length > 0) {
    return dedupeBy(
      fieldObjects.map(({ field, key }) => normalizeActionField(field, key)).filter((field): field is PortalActionField => field !== null),
      (field) => field.name
    );
  }
  return dedupeBy(
    collectObjects(candidate)
      .filter((objectValue) => objectValue !== candidate)
      .map((field) => normalizeActionField(field))
      .filter((field): field is PortalActionField => field !== null),
    (field) => field.name
  );
}

function normalizeActionField(candidate: Record<string, unknown>, tagName?: string): PortalActionField | null {
  const scalars = flattenScalars(candidate);
  const portalId = firstScalar(scalars, ["id", "ID", "@id"]);
  const name = firstScalar(scalars, ["refname", "@refname", "name", "NAME", "field", "FIELD", "@name"]) ?? portalId;
  if (!name) {
    return null;
  }
  const label = firstScalar(scalars, ["label", "LABEL", "title", "@title", "TEXT"]);
  const tagType = uploadFieldTagType(tagName);
  const type = firstScalar(scalars, ["type", "TYPE", "inputType"]) ?? tagType;
  const required = firstBoolean(scalars, ["required", "REQUIRED", "mandatory", "MANDATORY", "@required"]) ?? false;
  const hidden = firstBoolean(scalars, ["hidden", "HIDDEN", "@hidden"]) ?? (type?.toLowerCase() === "hidden" || firstScalar(scalars, ["visibility", "@visibility"]) === "hidden");
  const disabled = firstBoolean(scalars, ["disabled", "DISABLED", "locked", "LOCKED", "readOnly", "readonly"]) ?? false;
  const editable = hidden ? false : (firstBoolean(scalars, ["editable", "EDITABLE", "enabled", "ENABLED", "@editable"]) ?? !disabled);
  const options = choiceOptions(candidate);
  const value = firstScalar(scalars, ["value", "VALUE", "#text", "meta:saved_value", "@meta:saved_value"]) ?? selectedChoiceValue(options);
  const upload = uploadMetadata(scalars, type);
  return {
    name,
    portalId,
    label,
    type,
    required,
    hidden,
    editable,
    value,
    ...(options.length > 0 ? { options } : {}),
    ...(upload ? { upload } : {})
  };
}

function uploadFieldTagType(tagName?: string): string | undefined {
  if (!tagName) {
    return undefined;
  }
  return /^(?:file|upload|attachment)field$/i.test(tagName) ? "file" : undefined;
}

function uploadMetadata(scalars: Record<string, string>, type?: string): PortalActionField["upload"] | undefined {
  const haystack = Object.entries(scalars).map(([key, value]) => `${key}=${value}`).join(" ").toLowerCase();
  const looksLikeUpload = /(?:^|[^a-z])(?:file|upload|attachment|anlage|anhang|foto|photo|bild)(?:[^a-z]|$)/i.test(`${type ?? ""} ${haystack}`);
  if (!looksLikeUpload) {
    return undefined;
  }
  const endpoint = firstScalar(scalars, [
    "uploadUrl",
    "@uploadUrl",
    "uploadEndpoint",
    "@uploadEndpoint",
    "endpoint",
    "@endpoint",
    "SERVICE",
    "url",
    "@url",
    "href",
    "@href"
  ]);
  const acceptMimeTypes = splitMimeList(firstScalar(scalars, ["accept", "@accept", "mimeType", "@mimeType", "mediaType", "@mediaType"]));
  const maxBytes = parsePositiveInteger(firstScalar(scalars, ["maxBytes", "@maxBytes", "maxSize", "@maxSize", "sizeLimit", "@sizeLimit"]));
  if (!endpoint) {
    return {
      supported: false,
      acceptMimeTypes,
      maxBytes,
      reason: "Upload field does not expose an upload endpoint."
    };
  }
  return {
    supported: true,
    mode: "multipart_form_data",
    endpoint,
    acceptMimeTypes,
    maxBytes
  };
}

function splitMimeList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function choiceOptions(candidate: Record<string, unknown>): PortalActionFieldOption[] {
  const choices = collectNamedObjects(candidate, "choice");
  const options: PortalActionFieldOption[] = [];
  for (const choice of choices) {
    const scalars = flattenScalars(choice);
    const value = firstScalar(scalars, ["id", "@id", "value", "@value", "name", "@name", "#text", "title", "@title"]);
    if (!value) {
      continue;
    }
    options.push({
      value,
      label: firstScalar(scalars, ["title", "@title", "label", "@label", "text", "TEXT", "name", "@name"]),
      selected: firstBoolean(scalars, ["selected", "@selected"]) === true
    });
  }
  return dedupeBy(options, (option) => option.value);
}

function selectedChoiceValue(options: PortalActionFieldOption[]): string | undefined {
  return options.find((option) => option.selected)?.value;
}

function looksWritableAction(value: string): boolean {
  return /(submit|save|save_|send|create|update|change|melden|senden|speichern|ändern|bestaetigen|bestätigen)/i.test(value);
}

function actionDedupeKey(action: PortalAction): string {
  return `${action.serviceId ?? ""}::${action.recordId ?? ""}::${action.id}::${action.title}`;
}

function collectNamedObjects(value: unknown, keyName: string, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNamedObjects(entry, keyName, output);
    }
    return output;
  }
  if (!value || typeof value !== "object") {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === keyName.toLowerCase()) {
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            output.push(item as Record<string, unknown>);
          }
        }
      } else if (entry && typeof entry === "object") {
        output.push(entry as Record<string, unknown>);
      }
    }
    collectNamedObjects(entry, keyName, output);
  }
  return output;
}

function compactHints(input: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value) {
      output[key] = value;
    }
  }
  return output;
}

function firstBoolean(input: Record<string, string>, keys: string[]): boolean | undefined {
  const value = firstScalar(input, keys);
  if (value === undefined) {
    return undefined;
  }
  if (["true", "x", "1", "yes", "ja"].includes(value.toLowerCase())) {
    return true;
  }
  if (["false", "0", "no", "nein"].includes(value.toLowerCase())) {
    return false;
  }
  return undefined;
}

function safeFilename(input: string): string {
  return input.replace(/[/:\\?%*"<>|]/g, "_").trim() || "document";
}

function isPortalFileRecord(record: PortalRecordItem): boolean {
  if (record.itemKind === "external_link") {
    return false;
  }
  const haystack = recordHaystack(record);
  return Boolean(
    record.resourceId ||
      record.mimeType ||
      record.filename && /\.[a-z0-9]{2,8}$/i.test(record.filename) ||
      /\.(pdf|png|jpe?g|gif|tiff?|docx?|xlsx?|csv|txt)$/i.test(record.title) ||
      /\b(anhang|anlage|attachment|datei|dokument|foto|photo|bild)\b/i.test(haystack)
  );
}

function classifyReadDomain(record: PortalRecordItem): PortalReadDomain {
  const haystack = recordHaystack(record);
  if (record.itemKind === "external_link") {
    return "external_link";
  }
  if (/\b(betriebskosten\w*|nebenkosten\w*|abrechnung\w*|jahresabrechnung\w*|statement)\b/i.test(haystack)) {
    return "statement";
  }
  if (/\b(mietkonto|kontostand|saldo|buchung|zahlung|forderung|mietzahlung)\b/i.test(haystack)) {
    return "rent_account";
  }
  if (/\b(mietvertrag|stellplatzvertrag|vertrag|vertragsunterlagen|lease|contract)\b/i.test(haystack)) {
    return "contract";
  }
  if (isPortalFileRecord(record) && /\b(anhang|anlage|attachment|foto|photo|bild)\b/i.test(haystack)) {
    return "attachment";
  }
  if (/\b(besichtigung\w*|termin\w*|viewing|appointment)\b/i.test(haystack)) {
    return "viewing_appointment";
  }
  if (/\b(bewerbung\w*|application status|antragsstatus|status eingegangen)\b/i.test(haystack) || record.xuclass === "ESQ_IA_APPO" && /\b(status|bewerbung|antrag)\b/i.test(haystack)) {
    return "application_status";
  }
  if (/\b(immobiliensuche|wohnung|immobilie|objekt|expos[eé]|reobj|zimmer)\b/i.test(haystack)) {
    return "real_estate_listing";
  }
  if (/\b(meine anfragen|anfrage|anfragen|inquiry|ticket)\b/i.test(haystack) || record.xuclass === "ESQ_IA_APPO") {
    return "inquiry";
  }
  if (/\b(reparatur|schaden|schadensmeldung|mangel|defekt|heizung|dmg)\b/i.test(haystack)) {
    return "repair_status";
  }
  if (/\b(service|kundenservice|tierhaltung|haustier|hund|schlüssel|schluessel|untermieter|sepa|iban)\b/i.test(haystack)) {
    return "service_request";
  }
  if (/\b(verbr[aä]uch|verbrauch|z[aä]hler|zaehler|meter|csm|wasser|strom|heizung)\b/i.test(haystack)) {
    return "consumption";
  }
  if (/\b(hausinfo|pinbrd|treppenhaus|aushang|notice)\b/i.test(haystack)) {
    return "house_notice";
  }
  if (/\b(meine daten|profil|profile|partner|kontaktweg|e-mail|telefon)\b/i.test(haystack) || record.xuclass === "ESQ_IA_PART") {
    return "profile_setting";
  }
  if (/\b(push|benachrichtigung|notification|mitteilung)\b/i.test(haystack)) {
    return "notification";
  }
  if (record.itemKind === "resource" || isPortalFileRecord(record)) {
    return "document";
  }
  return "unknown";
}

function domainConfidence(record: PortalRecordItem, domain: PortalReadDomain): StructuredPortalRecordConfidence {
  if (domain === "unknown") {
    return "low";
  }
  const serviceHaystack = `${record.serviceTitle} ${record.xuclass ?? ""}`.toLowerCase();
  const domainPrefix = domain.split("_")[0] ?? domain;
  if (
    domain === "external_link" ||
    domain === "attachment" ||
    domain === "document" ||
    serviceHaystack.includes(domainPrefix) ||
    serviceDomainHint(record) === domain
  ) {
    return "high";
  }
  return "medium";
}

function serviceDomainHint(record: PortalRecordItem): PortalReadDomain | undefined {
  const haystack = `${record.serviceTitle} ${record.xuclass ?? ""}`.toLowerCase();
  if (/mietkonto|esq_tenant/.test(haystack) && /konto|saldo|zahlung/.test(recordHaystack(record))) {
    return "rent_account";
  }
  if (/verträge|vertraege|vertrag|esq_tenant/.test(haystack)) {
    return "contract";
  }
  if (/reparatur|dmg/.test(haystack)) {
    return "repair_status";
  }
  if (/service|srv/.test(haystack)) {
    return "service_request";
  }
  if (/verbr|csm/.test(haystack)) {
    return "consumption";
  }
  if (/immobiliensuche|reobj/.test(haystack)) {
    return "real_estate_listing";
  }
  if (/anfragen|appo/.test(haystack)) {
    return "inquiry";
  }
  if (/hausinfo|pinbrd/.test(haystack)) {
    return "house_notice";
  }
  if (/meine daten|part/.test(haystack)) {
    return "profile_setting";
  }
  if (/nachrichten|messages/.test(haystack)) {
    return "notification";
  }
  if (/dokument|documents|docs/.test(haystack)) {
    return "document";
  }
  return undefined;
}

function extractStatus(record: PortalRecordItem): string | undefined {
  return firstMatch(recordHaystack(record), [
    /\bin Bearbeitung\b/i,
    /\beingegangen\b/i,
    /\boffen\b/i,
    /\bgeschlossen\b/i,
    /\berledigt\b/i,
    /\bbeantragt\b/i,
    /\baktiviert\b/i,
    /\bverfügbar\b/i,
    /\bverfuegbar\b/i
  ]);
}

function extractPeriod(record: PortalRecordItem): string | undefined {
  return firstMatch(recordHaystack(record), [
    /\b\d{2}\.\d{4}\b/,
    /\b20\d{2}\b/
  ]);
}

function extractAmount(record: PortalRecordItem): string | undefined {
  return firstMatch(recordHaystack(record), [
    /\b\d{1,3}(?:\.\d{3})*,\d{2}\s*(?:EUR|€)\b/i,
    /(?:EUR|€)\s*\d{1,3}(?:\.\d{3})*,\d{2}\b/i
  ]);
}

function extractAddress(record: PortalRecordItem): string | undefined {
  const match = /\b(?:adresse|anschrift)\s+([^,\n]+?(?:\s+\d+[a-z]?)?)(?:\s{2,}|$)/i.exec(recordHaystack(record));
  return match?.[1]?.trim();
}

function firstMatch(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[0]) {
      return match[0].trim();
    }
  }
  return undefined;
}

function recordHaystack(record: PortalRecordItem): string {
  return [
    record.title,
    record.serviceTitle,
    record.xuclass,
    record.category,
    record.subtitle,
    record.abstract,
    record.filename,
    record.mimeType,
    record.detailText
  ].filter(Boolean).join(" ");
}

function compactFields(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

function immediateScalars(value: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      output[key] = String(entry);
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const text = (entry as Record<string, unknown>)["#text"];
      if (typeof text === "string" || typeof text === "number" || typeof text === "boolean") {
        output[key] = String(text);
      }
    }
  }
  return output;
}
