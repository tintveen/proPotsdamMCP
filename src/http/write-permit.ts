import type { PendingPortalWrite } from "../types.js";

const portalWritePermitBrand = Symbol("portal-write-permit");
const activePortalWritePermits = new WeakMap<PortalWritePermit, Map<string, number>>();

export interface PermittedPortalWriteRequest {
  method: "GET" | "POST";
  url: string;
}

export interface PortalWritePermit {
  readonly [portalWritePermitBrand]: true;
  readonly pendingWriteHandle: string;
}

export function issuePortalWritePermit(
  claimed: PendingPortalWrite,
  permittedRequests: PermittedPortalWriteRequest[]
): PortalWritePermit {
  if (claimed.state !== "claimed") {
    throw new Error("A portal write permit requires an atomically claimed pending write.");
  }
  if (permittedRequests.length === 0) {
    throw new Error("A portal write permit requires at least one exact permitted request.");
  }
  const permit: PortalWritePermit = {
    [portalWritePermitBrand]: true,
    pendingWriteHandle: claimed.pendingWriteHandle
  };
  const requestCounts = new Map<string, number>();
  for (const request of permittedRequests) {
    const key = permittedRequestKey(request.method, request.url);
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  }
  activePortalWritePermits.set(permit, requestCounts);
  return permit;
}

export function closePortalWritePermit(permit: PortalWritePermit): void {
  activePortalWritePermits.delete(permit);
}

export function consumePortalWritePermit(
  permit: PortalWritePermit,
  method: "GET" | "POST",
  url: string
): void {
  const requestCounts = activePortalWritePermits.get(permit);
  if (permit[portalWritePermitBrand] !== true || !requestCounts) {
    throw new Error("A live portal write requires an active internal write permit.");
  }
  const key = permittedRequestKey(method, url);
  const remaining = requestCounts.get(key) ?? 0;
  if (remaining <= 0) {
    throw new Error("The internal write permit is not bound to this exact portal request or was already used for it.");
  }
  if (remaining === 1) {
    requestCounts.delete(key);
  } else {
    requestCounts.set(key, remaining - 1);
  }
}

function permittedRequestKey(method: "GET" | "POST", url: string): string {
  return `${method} ${new URL(url).toString()}`;
}
