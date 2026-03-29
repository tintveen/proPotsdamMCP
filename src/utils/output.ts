import type { DocumentItem, InboxItem, OutputFormat } from "../types.js";

export function printOutput(payload: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload)) {
    process.stdout.write(`${payload.map(renderUnknown).join("\n\n")}\n`);
    return;
  }

  process.stdout.write(`${renderUnknown(payload)}\n`);
}

function renderUnknown(value: unknown): string {
  if (isInboxItem(value)) {
    return [
      `${value.id}  ${value.subject}`,
      value.sender ? `Absender: ${value.sender}` : undefined,
      value.date ? `Datum: ${value.date}` : undefined,
      `Ungelesen: ${value.unread ? "ja" : "nein"}`,
      value.abstract ? `Vorschau: ${value.abstract}` : undefined,
      value.detailText ? `Detail: ${value.detailText}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (isDocumentItem(value)) {
    return [
      `${value.id}  ${value.title}`,
      value.filename ? `Datei: ${value.filename}` : undefined,
      value.date ? `Datum: ${value.date}` : undefined,
      value.category ? `Kategorie: ${value.category}` : undefined,
      `Download: ${value.downloadable ? "ja" : "nein"}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join("\n");
  }

  return String(value);
}

function isInboxItem(value: unknown): value is InboxItem {
  return typeof value === "object" && value !== null && "subject" in value;
}

function isDocumentItem(value: unknown): value is DocumentItem {
  return typeof value === "object" && value !== null && "downloadable" in value;
}
