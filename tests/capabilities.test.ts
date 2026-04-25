import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";
import type { PortalService } from "../src/types.js";

const tempDirs: string[] = [];

describe("capability discovery", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("classifies known read, document, generic, and unknown services", async () => {
    const { classifyServiceCapability } = await import("../src/portal/capabilities.js");
    const services: PortalService[] = [
      { title: "Postfach", serviceUrl: "/msg", xuclass: "ESQ_MESSAGES", raw: {} },
      { title: "Dokumente", serviceUrl: "/docs", xuclass: "ESQ_DOCUMENTS", raw: {} },
      { title: "Verträge", serviceUrl: "/tenant", xuclass: "ESQ_TENANT", raw: {} },
      { title: "Schadensmeldung", serviceUrl: "/repair", xuclass: "REPAIR", raw: {} }
    ];

    expect(services.map((service) => classifyServiceCapability(service).section)).toEqual([
      "inbox",
      "documents",
      "generic",
      "unknown"
    ]);
    expect(classifyServiceCapability(services[1]!).readable).toBe(true);
    expect(classifyServiceCapability(services[2]!).readable).toBe(true);
  });

  it("extracts generic records without exposing download consent wording", async () => {
    const { extractPortalRecordItems } = await import("../src/portal/parsers.js");

    const records = extractPortalRecordItems(`
      <boxlist>
        <box>
          <id>REC-1</id>
          <title>Mietvertrag.pdf</title>
          <resourceId>RES-1</resourceId>
          <resourceOrigin>ARCHIVE</resourceOrigin>
          <mimeType>application/pdf</mimeType>
        </box>
        <box>
          <id>$BS_READCONFIRMED</id>
          <title>Lesebestätigung angefordert</title>
        </box>
        <box>
          <id>$BS_CALL_LINK</id>
          <title>Durch Aufruf dieses Links verlassen Sie Ihre ProPotsdam-KundenApp.</title>
          <url>https://example.test/outside</url>
        </box>
        <box>
          <id>AMB-1</id>
          <title>Nur ein Hinweis</title>
        </box>
      </boxlist>
    `, "application/xml", {
      serviceId: "TENANT",
      serviceTitle: "Verträge",
      serviceUrl: "/tenant-service",
      xuclass: "ESQ_TENANT"
    });

    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      id: "REC-1",
      serviceTitle: "Verträge",
      itemKind: "resource",
      readable: true,
      resourceId: "RES-1"
    });
    expect(records[1]).toMatchObject({
      itemKind: "read_confirmation"
    });
    expect(records[2]).toMatchObject({
      itemKind: "external_link"
    });
    expect(records[3]).toMatchObject({
      itemKind: "record"
    });
    expect(JSON.stringify(records)).not.toMatch(/download|candidate|safeDownload|downloadable/i);
  });

  it("discovers account services, boxlist item counts, and writes a redacted report", async () => {
    const { client, tempDir } = await createMockClient();

    const report = await client.discoverCapabilities();
    const artifact = await readFile(report.artifactPath, "utf8");

    expect(report.services).toHaveLength(3);
    expect(report.totals).toMatchObject({
      serviceCount: 3,
      inboxItems: 1,
      portalRecords: 1
    });
    expect(report.dataPolicy).toContain("ProPotsdam");
    expect(JSON.stringify(report)).not.toMatch(/candidate|downloadable|safeDownload|downloadableDocuments|safeDownloadCandidates|skippedDownloadCandidates/i);
    expect(report.services.map((service) => service.section)).toEqual([
      "inbox",
      "documents",
      "unknown"
    ]);
    expect(report.services[0]).toMatchObject({
      title: "Postfach",
      boxlist: { available: true, itemCount: 1 }
    });
    expect(report.artifactPath.startsWith(path.join(tempDir, "traces"))).toBe(true);
    expect(artifact).toContain("Postfach");
    expect(artifact).not.toContain("super-secret");
    expect(artifact).not.toContain("sid=abc");
    expect(artifact).not.toContain("csrf-token");
  });
});

async function createMockClient() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
  tempDirs.push(tempDir);
  process.env.PROPPOTSDAM_DATA_DIR = tempDir;
  vi.resetModules();

  const { configureCredentials, PortalClient } = await import("../src/portal/portal-client.js");

  const store: CredentialStore = {
    getPassword: async () => "super-secret",
    setPassword: async () => undefined,
    deletePassword: async () => true
  };
  await configureCredentials({
    username: "max",
    password: "super-secret",
    baseUrl: "https://portal.example.test",
    credentialStore: store
  });

  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url);
    void init;

    if (requestUrl.includes("/authenticate")) {
      return new Response("<ok />", {
        status: 200,
        headers: {
          "set-cookie": "sid=abc; Path=/; HttpOnly",
          "X-CSRF-Token": "csrf-token",
          "content-type": "application/xml"
        }
      });
    }

    if (requestUrl.includes("/prorex/esq/logi/services")) {
      return new Response(`
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
          <FOLDERS>
            <SERVICE_NODE>
              <title>Postfach</title>
              <SERVICE>/msg-service</SERVICE>
              <XUCLASS>ESQ_MESSAGES</XUCLASS>
            </SERVICE_NODE>
            <SERVICE_NODE>
              <title>Dokumente</title>
              <SERVICE>/docs-service</SERVICE>
              <XUCLASS>ESQ_DOCUMENTS</XUCLASS>
            </SERVICE_NODE>
            <SERVICE_NODE>
              <title>Schadensmeldung</title>
              <SERVICE>/repair-service</SERVICE>
              <XUCLASS>REPAIR</XUCLASS>
            </SERVICE_NODE>
          </FOLDERS>
        </SERVICE></asx:values></asx:abap>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/msg-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist><box unread="true"><id>MSG-1</id><title>Hallo</title></box></boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/docs-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist><box><id>DOC-1</id><title>Mietbescheinigung.pdf</title><resourceId>DOC-1</resourceId></box></boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/repair-service") && requestUrl.includes("name=boxlist")) {
      return new Response("<boxlist />", { status: 200, headers: { "content-type": "application/xml" } });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return {
    client: new PortalClient(store, fetchMock),
    tempDir
  };
}
