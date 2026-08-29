import { describe, expect, it, vi } from "vitest";
import { CookieSession } from "../src/http/cookie-session.js";
import { closePortalWritePermit, issuePortalWritePermit } from "../src/http/write-permit.js";
import type { PendingPortalWrite, PortalConfig } from "../src/types.js";

describe("CookieSession", () => {
  it("names invalid config.baseUrl values in URL errors", () => {
    const config: PortalConfig = {
      baseUrl: "user@example.test",
      apiVersion: "6.262",
      appVersion: "6.262.8",
      language: "de",
      exportDir: "/tmp/exports",
      clientId: "client-id"
    };
    const session = new CookieSession(config);

    expect(() => session.buildUrl("/propotsdam-kundenportal/api5/authenticate")).toThrow(
      "Invalid config baseUrl"
    );
  });

  it("rejects portal writes at the transport boundary without an active permit", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const session = new CookieSession({
      baseUrl: "https://portal.example.test",
      apiVersion: "6.262",
      appVersion: "6.262.8",
      language: "de",
      exportDir: "/tmp/exports",
      clientId: "client-id"
    }, null, fetchMock);

    await expect(session.post("/repair-upload", "data")).rejects.toThrow(/internal write permit/);
    await expect(session.get("/repair-service?command=action&name=cmdsend")).rejects.toThrow(/internal write permit/);
    await expect(session.getBinary("/profile-service?command=action&name=save_partner")).rejects.toThrow(/internal write permit/);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(session.get("/repair-service?command=action&name=get")).resolves.toMatchObject({ ok: true });
    const uploadUrl = "https://portal.example.test/repair-upload";
    const commitUrl = "https://portal.example.test/repair-service?command=action&name=cmdsend";
    const permit = issuePortalWritePermit(claimedPendingWrite(), [
      { method: "POST", url: uploadUrl },
      { method: "GET", url: commitUrl }
    ]);
    await expect(session.writePost(permit, "/different-upload", "data")).rejects.toThrow(/not bound to this exact portal request/);
    await expect(session.writePost(permit, "/repair-upload", "data")).resolves.toMatchObject({ ok: true });
    await expect(session.writeGet(permit, "/repair-service?command=action&name=cmdsend")).resolves.toMatchObject({ ok: true });
    await expect(session.writeGet(permit, "/repair-service?command=action&name=cmdsend")).rejects.toThrow(/already used/);
    closePortalWritePermit(permit);
    await expect(session.writeGet(permit, "/repair-service?command=action&name=cmdsend")).rejects.toThrow(/active internal write permit/);
  });
});

function claimedPendingWrite(): PendingPortalWrite {
  return {
    pendingWriteHandle: "pending-1",
    state: "claimed",
    kind: "portal_action",
    workflow: "portal_action",
    destination: "ProPotsdam customer portal",
    accountId: "MAX",
    domain: "repair_report",
    actionId: "cmdsend",
    actionTitle: "Schaden melden",
    contractFingerprint: "contract",
    values: { msg_txt: "Synthetic repair" },
    diff: [{ name: "msg_txt", proposedValue: "Synthetic repair" }],
    review: ["Synthetic repair"],
    warnings: [],
    privacyUrls: [],
    createdAt: "2026-08-28T12:00:00.000Z",
    expiresAt: "2026-08-28T12:10:00.000Z",
    claimedAt: "2026-08-28T12:01:00.000Z"
  };
}
