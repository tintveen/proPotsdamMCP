import { request } from "playwright";
import type { APIRequestContext } from "playwright";
import { LOGGED_SERVICES_PATH } from "../constants.js";
import { parseXml } from "../utils/xml.js";
import type { PortalProfile, SessionStatus } from "../types.js";

export async function probeSessionOverHttp(
  profile: PortalProfile,
  storageStatePath: string
): Promise<SessionStatus> {
  const context = await request.newContext({
    storageState: storageStatePath
  });

  try {
    return await probeCandidates(profile, context);
  } catch {
    // Fallback to page validation.
  } finally {
    await context.dispose();
  }

  return {
    valid: false,
    source: "none"
  };
}

export async function probeSessionWithContext(
  profile: PortalProfile,
  context: APIRequestContext
): Promise<SessionStatus> {
  try {
    return await probeCandidates(profile, context);
  } catch {
    return {
      valid: false,
      source: "none"
    };
  }
}

async function probeCandidates(profile: PortalProfile, context: APIRequestContext): Promise<SessionStatus> {
  const candidates = [
    `${profile.baseUrl}${LOGGED_SERVICES_PATH}?api=${profile.apiVersion}`,
    `${profile.baseUrl}${LOGGED_SERVICES_PATH}`
  ];

  for (const candidate of candidates) {
    const response = await context.get(candidate);
    if (!response.ok()) {
      continue;
    }

    const text = await response.text();
    const parsed = parseXml(text);
    const status = extractSessionStatus(parsed);
    if (status.valid) {
      return {
        ...status,
        source: "http"
      };
    }
  }

  return {
    valid: false,
    source: "none"
  };
}

function extractSessionStatus(parsed: unknown): SessionStatus {
  const lookup = (target: unknown, key: string): string | undefined => {
    if (!target || typeof target !== "object") {
      return undefined;
    }
    if (Array.isArray(target)) {
      for (const entry of target) {
        const found = lookup(entry, key);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    const objectTarget = target as Record<string, unknown>;
    for (const [childKey, value] of Object.entries(objectTarget)) {
      if (childKey === key && value !== undefined && value !== null) {
        return String(value);
      }
      const found = lookup(value, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  };

  const userId = lookup(parsed, "USER_ID");
  const userFullName = lookup(parsed, "USER_FULLNAME");
  const logged = lookup(parsed, "LOGGED");

  return {
    valid: Boolean(userId || userFullName || (logged && logged !== "false" && logged !== "0")),
    userId,
    userFullName,
    source: "http"
  };
}
