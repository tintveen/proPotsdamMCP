import { SECRET_REDACTION } from "../constants.js";

const SECRET_PATTERNS = [
  /(sap-ffield_b64=)[^&\s"]+/gi,
  /(password=)[^&\s"]+/gi,
  /(X-CSRF-Token["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(Cookie["']?\s*[:=]\s*["']?)[^"',]+/gi,
  /(Set-Cookie["']?\s*[:=]\s*["']?)[^"',]+/gi
];

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, `$1${SECRET_REDACTION}`), value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? SECRET_REDACTION : redactSecrets(entry);
    }
    return result;
  }

  return value;
}

function isSecretKey(key: string): boolean {
  return /password|cookie|csrf|token|sap-ffield/i.test(key);
}
