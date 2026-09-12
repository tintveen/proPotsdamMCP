import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { CookieSession } from "../src/http/cookie-session.js";
import { closePortalWritePermit, issuePortalWritePermit } from "../src/http/write-permit.js";
import type { PendingPortalWrite, PortalConfig } from "../src/types.js";

describe("CookieSession", () => {
  it("checks every native read redirect before a mutating request can leave the process", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      response.writeHead(302, {
        location: requests.length === 1
          ? "/second?command=action&name=get"
          : "/repair?command=action&name=cmdsend"
      }).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const session = new CookieSession(testConfig(baseUrl));
      await expect(session.get("/first?command=action&name=get")).rejects.toThrow(/write permit/);
      expect(requests).toEqual(["/first?command=action&name=get", "/second?command=action&name=get"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["GET", "POST"] as const)("never replays a permitted %s request through a native redirect", async (method) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      request.resume();
      if (request.url === "/unapproved") {
        response.writeHead(200).end("Synthetic replay received");
        return;
      }
      response.writeHead(307, { location: "/unapproved" }).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const permit = issuePortalWritePermit(claimedPendingWrite(), [{ method, url: `${baseUrl}/approved` }]);
    try {
      const session = new CookieSession(testConfig(baseUrl));
      const dispatch = () => method === "GET"
        ? session.writeGet(permit, "/approved", { redirect: "follow" })
        : session.writePost(permit, "/approved", "synthetic-body", { redirect: "follow" });
      let dispatchError: unknown;
      try { await dispatch(); } catch (error) { dispatchError = error; }
      // Assert the externally observable boundary before inspecting the local error.
      expect(requests).toEqual(["/approved"]);
      expect(dispatchError).toMatchObject({ message: expect.stringMatching(/redirect refused/) });
      await expect(dispatch()).rejects.toThrow(/already used/);
      expect(requests).toEqual(["/approved"]);
    } finally {
      closePortalWritePermit(permit);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    "https://external.example.test/read",
    "//external.example.test/read",
    "http://portal.example.test/read",
    "https://portal.example.test:444/read",
    "https://user:secret@portal.example.test/read",
    "file:///tmp/fixture"
  ])("blocks an unpinned URL before exposing headers: %s", async (url) => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    const session = new CookieSession(testConfig(), undefined, fetchMock);
    session.csrfToken = "synthetic-csrf";
    await expect(session.get(url)).rejects.toThrow(/configured origin/);
    await expect(session.getBinary(url)).rejects.toThrow(/configured origin/);
    const permit = issuePortalWritePermit(claimedPendingWrite(), [{ method: "POST", url: new URL(url, testConfig().baseUrl).toString() }]);
    try {
      await expect(session.writePost(permit, url, "synthetic")).rejects.toThrow(/configured origin/);
    } finally {
      closePortalWritePermit(permit);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows a pinned read redirect and carries its session updates to the next hop", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "/next?command=action&name=get", "set-cookie": "sid=synthetic; Path=/", "X-CSRF-Token": "rotated" }
      }))
      .mockResolvedValueOnce(new Response("result"));
    const session = new CookieSession(testConfig(), undefined, fetchMock);
    await expect(session.getBinary("/first", { redirect: "follow" })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://portal.example.test/next?command=action&name=get");
    expect(init.redirect).toBe("manual");
    expect(init.headers.get("cookie")).toBe("sid=synthetic");
    expect(init.headers.get("X-CSRF-Token")).toBe("rotated");
  });

  it("rejects off-origin redirects and bounds safe redirect loops", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "https://external.example.test/read" }
    }));
    const session = new CookieSession(testConfig(), undefined, fetchMock);
    await expect(session.get("/first")).rejects.toThrow(/configured origin/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear().mockImplementation(async () => new Response(null, {
      status: 302, headers: { location: "/read?command=action&name=get" }
    }));
    await expect(session.get("/first")).rejects.toThrow(/redirect refused/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("pins authentication requests and refuses to redirect credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 307, headers: { location: "/other-auth" }
    }));
    const session = new CookieSession(testConfig(), undefined, fetchMock);
    const authPath = "/propotsdam-kundenportal/api5/authenticate";
    await expect(session.post("https://external.example.test" + authPath, "synthetic")).rejects.toThrow(/configured origin/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(session.post(authPath, "synthetic")).rejects.toThrow(/redirect refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["manual", "error"] as const)("honors a caller's %s redirect restriction for reads", async (redirect) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/safe" } }));
    const session = new CookieSession(testConfig(), undefined, fetchMock);
    await expect(session.get("/first", { redirect })).rejects.toThrow(/redirect refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

function testConfig(baseUrl = "https://portal.example.test"): PortalConfig {
  return { baseUrl, apiVersion: "6.262", appVersion: "6.262.8", language: "de", exportDir: "/tmp/exports", clientId: "client-id" };
}

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
