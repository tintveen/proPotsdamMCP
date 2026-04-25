import { DOCUMENT_ALIASES, INBOX_ALIASES } from "../constants.js";
import type { AuthResult, DocumentItem, DownloadSkipReason, InboxItem, PortalRecordItem, PortalSection, PortalService } from "../types.js";
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

export function normalizeDetailText(text: string, contentType?: string): string {
  try {
    const parsed = parseBody(text, contentType);
    const scalars = flattenScalars(parsed);
    return Object.values(scalars).filter(Boolean).join("\n").slice(0, 8000);
  } catch {
    return text.replace(/\s+/g, " ").trim().slice(0, 8000);
  }
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
    downloadable: Boolean(resourceId || firstScalar(scalars, ["downloadUrl", "documentUrl"]) || DATE_PATTERN.test(filename)),
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
    safeDownload: classification.safeDownload,
    skipReason: classification.skipReason,
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
}): Pick<PortalRecordItem, "itemKind" | "safeDownload" | "skipReason"> {
  const haystack = `${input.id} ${input.title} ${JSON.stringify(input.scalars)}`.toLowerCase();
  if (haystack.includes("$bs_readconfirmed") || haystack.includes("lesebestätigung")) {
    return unsafeRecord("read_confirmation", "read_confirmation");
  }
  if (haystack.includes("$bs_call_link") || /^https?:\/\//i.test(input.url ?? "")) {
    return unsafeRecord("external_link", "external_link");
  }
  if (input.id.startsWith("$BS_") || input.id.startsWith("$") || firstScalar(input.scalars, ["action", "command", "ACTION"])) {
    return unsafeRecord("action", "portal_action");
  }
  if (input.resourceId) {
    return {
      itemKind: "resource",
      safeDownload: true
    };
  }
  return unsafeRecord("record", "not_a_resource");
}

function unsafeRecord(
  itemKind: PortalRecordItem["itemKind"],
  skipReason: DownloadSkipReason
): Pick<PortalRecordItem, "itemKind" | "safeDownload" | "skipReason"> {
  return {
    itemKind,
    safeDownload: false,
    skipReason
  };
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
