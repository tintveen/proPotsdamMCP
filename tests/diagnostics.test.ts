import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";
import { createDoctorReport } from "../src/diagnostics.js";
import type { PortalConfig } from "../src/types.js";

const baseConfig: PortalConfig = {
  baseUrl: "https://portal.example.test",
  apiVersion: "6.262",
  appVersion: "6.262.8",
  language: "de",
  exportDir: "/tmp/exports",
  clientId: "client-id"
};

describe("doctor diagnostics", () => {
  it("marks Node 26.0.0 as supported", async () => {
    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl: reachableFetch(),
      nodeVersion: "26.0.0"
    });

    expect(report.runtime.nodeVersion).toBe("26.0.0");
    expect(report.runtime.nodeSupported).toBe(true);
  });

  it("marks Node 25.x as unsupported", async () => {
    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl: reachableFetch(),
      nodeVersion: "25.11.1"
    });

    expect(report.runtime.nodeSupported).toBe(false);
  });

  it("reports environment credentials without consulting keychain", async () => {
    const getPassword = vi.fn(async () => {
      throw new Error("keychain should not be checked");
    });

    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig, username: "env-user@example.test" }),
      credentialStore: { getPassword },
      client: unauthenticatedClient(),
      fetchImpl: reachableFetch(),
      env: {
        PROPPOTSDAM_USERNAME: "env-user@example.test",
        PROPPOTSDAM_PASSWORD: "super-secret"
      }
    });

    expect(report.config.usernameConfigured).toBe(true);
    expect(report.config.usernameSource).toBe("env");
    expect(report.credentials).toMatchObject({
      passwordConfigured: true,
      passwordSource: "env"
    });
    expect(getPassword).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("super-secret");
    expect(JSON.stringify(report)).not.toContain("env-user@example.test");
  });

  it("reports keychain-backed credentials through the injected credential store", async () => {
    const getPassword = vi.fn(async () => "keychain-secret");

    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig, username: "config-user@example.test" }),
      credentialStore: { getPassword },
      client: unauthenticatedClient(),
      fetchImpl: reachableFetch(),
      env: {}
    });

    expect(report.config.usernameConfigured).toBe(true);
    expect(report.config.usernameSource).toBe("config");
    expect(report.credentials).toMatchObject({
      passwordConfigured: true,
      passwordSource: "keychain"
    });
    expect(getPassword).toHaveBeenCalledWith("config-user@example.test");
    expect(JSON.stringify(report)).not.toContain("keychain-secret");
    expect(JSON.stringify(report)).not.toContain("config-user@example.test");
  });

  it("reports missing username and password", async () => {
    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl: reachableFetch(),
      env: {}
    });

    expect(report.config).toMatchObject({
      usernameConfigured: false,
      usernameSource: "none"
    });
    expect(report.credentials).toMatchObject({
      passwordConfigured: false,
      passwordSource: "none"
    });
  });

  it("treats any HTTP response as reachable", async () => {
    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl: async () => new Response("", { status: 503 }),
      env: {}
    });

    expect(report.portalReachability).toMatchObject({
      reachable: true,
      method: "HEAD",
      status: 503
    });
  });

  it("falls back to GET when HEAD throws", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "");
      if (init?.method === "HEAD") {
        throw new TypeError("HEAD unavailable");
      }
      return new Response(null, { status: 204 });
    });

    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl,
      env: {}
    });

    expect(calls).toEqual(["HEAD", "GET"]);
    expect(report.portalReachability).toMatchObject({
      reachable: true,
      method: "GET",
      status: 204
    });
  });

  it("reports redacted reachability failures", async () => {
    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: unauthenticatedClient(),
      fetchImpl: async () => {
        throw new Error("network failed password=secret");
      },
      env: {}
    });

    expect(report.portalReachability).toMatchObject({
      reachable: false,
      method: "GET"
    });
    expect(report.portalReachability.error).toContain("password=[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("password=secret");
  });

  it("checks session status without exposing portal identity fields", async () => {
    const status = vi.fn(async () => ({
      state: "authenticated" as const,
      authenticated: true,
      userId: "portal-user-id",
      userFullName: "Portal User"
    }));

    const report = await createDoctorReport({
      loadConfig: async () => ({ ...baseConfig }),
      credentialStore: missingCredentialStore(),
      client: { status },
      fetchImpl: reachableFetch(),
      env: {}
    });

    expect(status).toHaveBeenCalledOnce();
    expect(report.session).toMatchObject({
      checked: true,
      authenticated: true,
      state: "authenticated"
    });
    expect(JSON.stringify(report)).not.toContain("portal-user-id");
    expect(JSON.stringify(report)).not.toContain("Portal User");
  });
});

function missingCredentialStore(): Pick<CredentialStore, "getPassword"> {
  return {
    getPassword: async () => null
  };
}

function unauthenticatedClient() {
  return {
    status: async () => ({
      state: "unauthenticated" as const,
      authenticated: false
    })
  };
}

function reachableFetch(): typeof fetch {
  return (async () => new Response("", { status: 200 })) as typeof fetch;
}
