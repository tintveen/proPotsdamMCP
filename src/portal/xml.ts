import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true
});

export function parseXml(text: string): unknown {
  return parser.parse(text);
}

export function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => textOf(entry)).find(Boolean);
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return textOf(objectValue["#text"]);
  }
  return undefined;
}

export function flattenScalars(value: unknown, prefix = "", output: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const key = prefix || "value";
    output[key] = String(value);
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenScalars(entry, `${prefix}.${index}`, output));
    return output;
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        output[key] = String(entry);
        output[nextPrefix] = String(entry);
      } else {
        flattenScalars(entry, nextPrefix, output);
      }
    }
  }

  return output;
}

export function collectObjects(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") {
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectObjects(entry, output);
    }
    return output;
  }

  const objectValue = value as Record<string, unknown>;
  output.push(objectValue);
  for (const entry of Object.values(objectValue)) {
    collectObjects(entry, output);
  }
  return output;
}

export function firstScalar(input: Record<string, string>, keys: string[]): string | undefined {
  const lowered = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    lowered.set(key.toLowerCase(), value);
  }

  for (const key of keys) {
    const direct = lowered.get(key.toLowerCase());
    if (direct?.trim()) {
      return direct.trim();
    }
  }

  for (const key of keys) {
    const suffix = `.${key.toLowerCase()}`;
    for (const [candidateKey, value] of lowered.entries()) {
      if ((candidateKey.endsWith(suffix) || candidateKey === key.toLowerCase()) && value.trim()) {
        return value.trim();
      }
    }
  }

  return undefined;
}
