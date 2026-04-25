import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";

const tempDirs: string[] = [];

describe("PortalClient HTTP flow", () => {
  afterEach(async () => {
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("logs in with Keychain credentials and saves a validated session", async () => {
    const { client, requests } = await createMockClient();

    const result = await client.login();

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("MAX");
    expect(requests[0]?.url).toContain("/propotsdam-kundenportal/api5/authenticate");
    expect(String(requests[0]?.body)).toContain("sap-ffield_b64=");
    expect(String(requests[0]?.body)).not.toContain("super-secret");
  });

  it("validates login through api5 services when the generic status endpoint has no marker", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: "<root />",
      apiServicesBody: `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
        </SERVICE></asx:values></asx:abap>
      `
    });

    const result = await client.login();

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("MAX");
    expect(requests.some((request) => request.url.includes("/propotsdam-kundenportal/api5/services"))).toBe(true);
  });

  it("uses the authenticated api5 services response when logged services only returns a redirect wrapper", async () => {
    const { client } = await createMockClient({
      loggedServicesBody: '{"DATA":{"URL":"/prorex/.../services?api=6.262"}}',
      apiServicesBody: `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
          <FOLDERS>
            <SERVICE_NODE>
              <title>Dokumente</title>
              <SERVICE>/docs-service</SERVICE>
              <XUCLASS>DOCS</XUCLASS>
            </SERVICE_NODE>
          </FOLDERS>
        </SERVICE></asx:values></asx:abap>
      `
    });

    const login = await client.login();
    const status = await client.status();
    const documents = await client.listDocuments();

    expect(login.authenticated).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(documents.items).toHaveLength(1);
  });


  it("classifies successful HTTP auth responses that still contain login failure text", async () => {
    const { client } = await createMockClient({
      authBody: "Anmeldung fehlgeschlagen",
      loggedServicesBody: "<root />",
      apiServicesBody: "<root />"
    });

    const result = await client.login();

    expect(result).toMatchObject({
      state: "action_required",
      authenticated: false,
      action: "login_failed"
    });
  });

  it("lists documents through services and boxlist endpoints", async () => {
    const { client } = await createMockClient();

    const result = await client.listDocuments();

    expect(result.source).toBe("boxlist");
    expect(result.items[0]).toMatchObject({
      id: "DOC-1",
      title: "Mietbescheinigung.pdf",
      downloadable: true
    });
  });

  it("downloads documents into the configured safe folder", async () => {
    const { client, tempDir } = await createMockClient();

    const result = await client.downloadDocument("DOC-1");
    const file = await readFile(result.path, "utf8");

    expect(result.path.startsWith(path.join(tempDir, "downloads"))).toBe(true);
    expect(result.filename).toBe("Mietbescheinigung.pdf");
    expect(file).toBe("PDFDATA");
  });

  it("reuses cached inbox listings when getting item details after listInbox", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
          <FOLDERS>
            <SERVICE_NODE>
              <title>Nachrichten</title>
              <SERVICE>/messages-service</SERVICE>
              <XUCLASS>ESQ_MESSAGES</XUCLASS>
            </SERVICE_NODE>
          </FOLDERS>
        </SERVICE></asx:values></asx:abap>
      `
    });

    const inbox = await client.listInbox();
    const detail = await client.getInboxItem(inbox.items[0]!.id);

    expect(detail.detailText).toContain("Detail for MSG-1");
    expect(requests.filter((request) => request.url.includes("/messages-service") && request.url.includes("name=boxlist"))).toHaveLength(1);
  });

  it("lists and reads generic portal records without folding them into documents", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithGenericSection()
    });

    const records = await client.listPortalRecords({ xuclass: "ESQ_TENANT" });
    const detail = await client.getPortalRecord("REC-1");
    const documents = await client.listDocuments();

    expect(records.items).toHaveLength(3);
    expect(records.items[0]).toMatchObject({
      id: "REC-1",
      serviceTitle: "Verträge",
      itemKind: "resource",
      safeDownload: true
    });
    expect(records.items[1]).toMatchObject({
      itemKind: "read_confirmation",
      safeDownload: false,
      skipReason: "read_confirmation"
    });
    expect(detail.detailText).toContain("Detail for REC-1");
    expect(documents.items).toEqual([]);
    expect(requests.filter((request) => request.url.includes("/tenant-service") && request.url.includes("name=boxlist"))).toHaveLength(1);
  });

  it("lists download candidates and downloads only safe generic resources", async () => {
    const { client, tempDir } = await createMockClient({
      loggedServicesBody: servicesWithGenericSection()
    });

    const candidates = await client.listDownloadCandidates();
    const result = await client.downloadCandidate("REC-1");
    const file = await readFile(result.path, "utf8");

    expect(candidates.safe).toHaveLength(1);
    expect(candidates.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "$BS_READCONFIRMED", skipReason: "read_confirmation" }),
      expect.objectContaining({ id: "AMB-1", skipReason: "not_a_resource" })
    ]));
    expect(result.path.startsWith(path.join(tempDir, "downloads"))).toBe(true);
    expect(result.filename).toBe("Mietvertrag.pdf");
    expect(file).toBe("GENERICPDF");
    await expect(client.downloadCandidate("AMB-1")).rejects.toMatchObject({ code: "NOT_SAFE_DOWNLOAD" });
  });
});

async function createMockClient(options: {
  authBody?: string;
  loggedServicesBody?: string;
  apiServicesBody?: string;
} = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
  tempDirs.push(tempDir);
  process.env.PROPPOTSDAM_DATA_DIR = tempDir;
  vi.resetModules();

  const { configureCredentials, PortalClient } = await import("../src/portal/portal-client.js");
  const { paths } = await import("../src/storage.js");

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

  const requests: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, method: init?.method, body: init?.body });

    if (requestUrl.includes("/authenticate")) {
      return new Response(options.authBody ?? "<ok />", {
        status: 200,
        headers: {
          "set-cookie": "sid=abc; Path=/; HttpOnly",
          "X-CSRF-Token": "csrf-token",
          "content-type": "application/xml"
        }
      });
    }

    if (requestUrl.includes("/prorex/esq/logi/services")) {
      return new Response(options.loggedServicesBody ?? `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
          <FOLDERS>
            <SERVICE_NODE>
              <title>Dokumente</title>
              <SERVICE>/docs-service</SERVICE>
              <XUCLASS>DOCS</XUCLASS>
            </SERVICE_NODE>
          </FOLDERS>
        </SERVICE></asx:values></asx:abap>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/propotsdam-kundenportal/api5/services")) {
      return new Response(options.apiServicesBody ?? `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
        </SERVICE></asx:values></asx:abap>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/docs-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist>
          <box>
            <id>DOC-1</id>
            <title>Mietbescheinigung.pdf</title>
            <resourceId>DOC-1</resourceId>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/tenant-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
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
            <id>AMB-1</id>
            <title>Nur ein Hinweis</title>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/tenant-service") && requestUrl.includes("id=REC-1") && !requestUrl.includes("resourceOrigin")) {
      return new Response("<detail><text>Detail for REC-1</text></detail>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }

    if (requestUrl.includes("/tenant-service") && requestUrl.includes("id=RES-1")) {
      return new Response("GENERICPDF", {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }

    if (requestUrl.includes("/messages-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist>
          <box>
            <id>MSG-1</id>
            <title>Willkommen</title>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/messages-service") && requestUrl.includes("id=MSG-1")) {
      return new Response("<detail><text>Detail for MSG-1</text></detail>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }

    if (requestUrl.includes("/docs-service") && requestUrl.includes("id=DOC-1")) {
      return new Response("PDFDATA", {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return {
    client: new PortalClient(store, fetchMock),
    requests,
    tempDir,
    paths
  };
}

function servicesWithGenericSection(): string {
  return `
    <asx:abap><asx:values><SERVICE>
      <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
      <FOLDERS>
        <SERVICE_NODE>
          <title>Verträge</title>
          <SERVICE>/tenant-service</SERVICE>
          <XUCLASS>ESQ_TENANT</XUCLASS>
        </SERVICE_NODE>
      </FOLDERS>
    </SERVICE></asx:values></asx:abap>
  `;
}
