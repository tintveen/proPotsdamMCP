import type { DocumentItem, InboxItem, PortalSection, TraceRecord } from "../types.js";
import { parseXml } from "../utils/xml.js";

type LooseObject = Record<string, unknown>;

const DATE_PATTERN = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/;

export function extractSectionItemsFromTraces(
  section: PortalSection,
  records: TraceRecord[]
): InboxItem[] | DocumentItem[] {
  const items = records.flatMap((record) =>
    extractSectionItemsFromTrace(section, record) as (InboxItem | DocumentItem)[]
  );
  return dedupeItems(items) as InboxItem[] | DocumentItem[];
}

export function extractSectionItemsFromTrace(
  section: PortalSection,
  record: TraceRecord
): InboxItem[] | DocumentItem[] {
  if (!record.bodyText) {
    return [];
  }

  try {
    if (record.contentType?.includes("json")) {
      const parsed = JSON.parse(record.bodyText) as unknown;
      return normalizeCandidates(section, collectCandidates(parsed, record.url, "network"));
    }

    if (
      record.contentType?.includes("xml") ||
      record.contentType?.includes("html") ||
      record.bodyText.trim().startsWith("<?xml")
    ) {
      const parsed = parseXml(record.bodyText);
      return normalizeCandidates(section, collectCandidates(parsed, record.url, "network"));
    }
  } catch {
    return [];
  }

  return [];
}

function collectCandidates(
  value: unknown,
  sourceUrl: string,
  rawSource: "network" | "ui",
  bucket: LooseObject[] = []
): LooseObject[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCandidates(entry, sourceUrl, rawSource, bucket);
    }
    return bucket;
  }

  if (!value || typeof value !== "object") {
    return bucket;
  }

  const objectValue = value as LooseObject;
  const normalized = flattenScalarFields(objectValue);
  const signals = ["id", "title", "subtitle", "abstract", "date", "category"];
  const signalCount = signals.filter((key) => normalized[key]).length;
  if (normalized.id || signalCount >= 2) {
    bucket.push({
      ...normalized,
      detailUrl: sourceUrl,
      rawSource
    });
  }

  for (const nested of Object.values(objectValue)) {
    collectCandidates(nested, sourceUrl, rawSource, bucket);
  }

  return bucket;
}

function flattenScalarFields(input: LooseObject): LooseObject {
  const output: LooseObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = String(value);
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      const scalars = value.filter(
        (entry) =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
      );
      if (scalars.length > 0) {
        output[key] = scalars.map((entry) => String(entry)).join(" ");
      }
    }
  }

  return output;
}

function normalizeCandidates(
  section: PortalSection,
  candidates: LooseObject[]
): InboxItem[] | DocumentItem[] {
  if (section === "inbox") {
    return candidates
      .map((candidate) => normalizeInboxCandidate(candidate))
      .filter((item): item is InboxItem => item !== null);
  }

  return candidates
    .map((candidate) => normalizeDocumentCandidate(candidate))
    .filter((item): item is DocumentItem => item !== null);
}

function normalizeInboxCandidate(candidate: LooseObject): InboxItem | null {
  const title = firstString(candidate, ["subject", "title", "subtitle"]);
  const id = firstString(candidate, ["id", "formid", "@_id"]) ?? title;
  if (!title || !id) {
    return null;
  }

  return {
    id,
    title,
    subject: title,
    date: firstString(candidate, ["date", "createdAt", "created", "sentAt"]),
    subtitle: firstString(candidate, ["subtitle"]),
    sender: firstString(candidate, ["sender", "subtitle", "from"]),
    abstract: firstString(candidate, ["abstract", "note", "message", "preview"]),
    category: firstString(candidate, ["category", "type"]),
    detailUrl: firstString(candidate, ["detailUrl"]),
    rawSource: "network",
    unread: firstBoolean(candidate, ["unread"]) ?? inferUnread(candidate),
    replied: firstBoolean(candidate, ["replied"])
  };
}

function normalizeDocumentCandidate(candidate: LooseObject): DocumentItem | null {
  const title = firstString(candidate, ["title", "filename", "name", "subtitle"]);
  const id = firstString(candidate, ["id", "formid", "@_id"]) ?? title;
  if (!title || !id) {
    return null;
  }

  const filename = firstString(candidate, ["filename", "title", "name"]);
  return {
    id,
    title,
    date: firstString(candidate, ["date", "createdAt", "created"]),
    subtitle: firstString(candidate, ["subtitle"]),
    abstract: firstString(candidate, ["abstract", "note", "description"]),
    category: firstString(candidate, ["category", "type"]),
    detailUrl: firstString(candidate, ["detailUrl"]),
    rawSource: "network",
    filename,
    downloadable: inferDownloadable(candidate, filename)
  };
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

function firstString(input: LooseObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstBoolean(input: LooseObject, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function inferUnread(candidate: LooseObject): boolean {
  return firstBoolean(candidate, ["new", "isNew", "unread", "errorFlag"]) ?? false;
}

function inferDownloadable(candidate: LooseObject, filename?: string): boolean {
  if (firstString(candidate, ["downloadUrl", "resourceId", "documentUrl"])) {
    return true;
  }
  return Boolean(filename && (filename.includes(".") || DATE_PATTERN.test(filename)));
}
