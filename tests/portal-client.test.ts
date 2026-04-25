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
});

async function createMockClient() {
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
              <title>Dokumente</title>
              <SERVICE>/docs-service</SERVICE>
              <XUCLASS>DOCS</XUCLASS>
            </SERVICE_NODE>
          </FOLDERS>
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
