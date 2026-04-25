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
      resourceId: "DOC-1"
    });
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
      itemKind: "resource"
    });
    expect(records.items[1]).toMatchObject({
      itemKind: "read_confirmation"
    });
    expect(detail.detailText).toContain("Detail for REC-1");
    expect(documents.items).toEqual([]);
    expect(requests.filter((request) => request.url.includes("/tenant-service") && request.url.includes("name=boxlist"))).toHaveLength(1);
  });

  it("lists document-like sections as readable portal records", async () => {
    const { client } = await createMockClient();

    const records = await client.listPortalRecords({ xuclass: "DOCS" });

    expect(records.items).toHaveLength(1);
    expect(records.items[0]).toMatchObject({
      id: "DOC-1",
      title: "Mietbescheinigung.pdf",
      serviceTitle: "Dokumente",
      itemKind: "resource",
      readable: true
    });
    expect(JSON.stringify(records)).not.toMatch(/download|candidate|safeDownload|downloadable/i);
  });

  it("discovers and prepares portal actions without sending writes", async () => {
    const { client, requests, tempDir } = await createMockClient({
      loggedServicesBody: servicesWithActions(),
      actionBoxlists: true
    });

    const map = await client.discoverWriteActions();
    const artifact = await readFile(map.artifactPath, "utf8");
    const actions = await client.listPortalActions({ xuclass: "ESQ_TENA_DMG", actionKind: "form" });
    const action = await client.getPortalAction("DMG-NEW");
    const prepared = await client.preparePortalAction("DMG-NEW", {
      description: "Heizung bleibt kalt",
      csrfToken: "must-not-leak"
    });

    expect(map.totals).toMatchObject({
      serviceCount: 7,
      actionCount: 8,
      preparableActions: 7,
      skippedActions: 1
    });
    expect(map.artifactPath.startsWith(path.join(tempDir, "traces"))).toBe(true);
    expect(actions.items).toHaveLength(1);
    expect(action).toMatchObject({
      id: "DMG-NEW",
      actionKind: "form",
      preparable: true,
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "description", required: true })
      ])
    });
    expect(prepared).toMatchObject({
      ok: true,
      preparedOnly: true,
      actionId: "DMG-NEW",
      validationIssues: [],
      draft: {
        method: "POST",
        endpoint: "/repair-service"
      }
    });
    expect(JSON.stringify(prepared)).not.toContain("must-not-leak");
    expect(artifact).not.toContain("csrf-secret");
    expect(artifact).not.toContain("sid=abc");
    expect(artifact).not.toContain("csrf-token");
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);
  });

  it("rejects prepare for non-preparable portal actions", async () => {
    const { client } = await createMockClient({
      loggedServicesBody: servicesWithActions(),
      actionBoxlists: true
    });

    await expect(client.preparePortalAction("$BS_READCONFIRMED", {})).rejects.toMatchObject({
      code: "ACTION_NOT_PREPARABLE"
    });
  });

  it("discovers detail-only profile forms and rejects locked or unknown prepared fields", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });

    const map = await client.discoverWriteActions();
    const profileActions = await client.listPortalActions({ xuclass: "ESQ_IA_PART", source: "detail" });
    const prepared = await client.preparePortalAction("save_partner", {
      phone_ref: "+15550100001",
      mail: "new@example.test",
      unknown_field: "ignored"
    });

    expect(map.partial).toBe(false);
    expect(profileActions.items).toHaveLength(1);
    expect(profileActions.items[0]).toMatchObject({
      id: "save_partner",
      title: "Speichern",
      source: "detail",
      recordId: "PROFILE-1",
      recordTitle: "Meine Daten",
      preparable: true,
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "phone_ref", value: "+15550100000", editable: true }),
        expect.objectContaining({ name: "mail", value: "user@example.test", editable: false })
      ])
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.validationIssues).toEqual(expect.arrayContaining([
      "Field 'mail' is not editable.",
      "Unknown field 'unknown_field'."
    ]));
    expect(prepared.draft.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "phone_ref",
        currentValue: "+15550100000",
        proposedValue: "+15550100001"
      }),
      expect.not.objectContaining({
        name: "mail",
        proposedValue: "new@example.test"
      })
    ]));
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);
  });

  it("creates a confirmation for save_partner without sending writes, then commits it once", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });

    const confirmation = await client.requestPortalActionCommit("save_partner", {
      phone_ref: "+15550100001"
    });

    expect(confirmation).toMatchObject({
      ok: true,
      actionId: "save_partner",
      actionTitle: "Speichern",
      expiresAt: expect.any(String),
      diff: [
        expect.objectContaining({
          name: "phone_ref",
          currentValue: "+15550100000",
          proposedValue: "+15550100001"
        })
      ],
      validationIssues: []
    });
    expect(confirmation.confirmationId).toMatch(/[0-9a-f-]{36}/);
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);

    const result = await client.commitPortalAction(confirmation.confirmationId!);
    const savePosts = requests.filter((request) => request.method === "POST" && request.url.includes("name=save"));
    const actionGets = requests.filter((request) => request.method === "GET" && request.url.includes("name=save_partner"));

    expect(result).toMatchObject({
      ok: true,
      actionId: "save_partner",
      recordId: "FINAL-PROFILE-1",
      status: 200,
      summary: expect.stringContaining("Meine Daten")
    });
    expect(savePosts).toHaveLength(1);
    expect(actionGets).toHaveLength(1);
    expect(savePosts[0]!.url).toContain("name=save");
    expect(savePosts[0]!.url).toContain("resourceOrigin=form");
    expect(actionGets[0]!.url).toContain("name=save_partner");
    expect(String(savePosts[0]!.body)).toContain("+15550100001");
    expect(String(savePosts[0]!.body)).toContain("<textfield id=\"ESQ_CHANGED\"");
    expect(String(savePosts[0]!.body)).toContain(">true</textfield>");
    expect(String(savePosts[0]!.body)).toContain("<history>");
    await expect(client.commitPortalAction(confirmation.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND"
    });
  });

  it("does not create confirmations for locked fields, unknown fields, or blocked actions", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithActions(),
      actionBoxlists: true
    });

    const blocked = await client.requestPortalActionCommit("DMG-NEW", {
      description: "Heizung bleibt kalt"
    });
    expect(blocked).toMatchObject({
      ok: false,
      confirmationId: undefined,
      validationIssues: ["Only Meine Daten/save_partner can be committed in this version."]
    });

    const profileClient = (await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    })).client;
    const invalid = await profileClient.requestPortalActionCommit("save_partner", {
      mail: "blocked@example.test",
      unknown_field: "ignored"
    });
    expect(invalid).toMatchObject({
      ok: false,
      confirmationId: undefined,
      validationIssues: expect.arrayContaining([
        "Field 'mail' is not editable.",
        "Unknown field 'unknown_field'."
      ])
    });
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);
  });
});

async function createMockClient(options: {
  authBody?: string;
  loggedServicesBody?: string;
  apiServicesBody?: string;
  actionBoxlists?: boolean;
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

    if (options.actionBoxlists && requestUrl.includes("name=boxlist")) {
      const action = actionForService(requestUrl);
      if (action) {
        return new Response(action, { status: 200, headers: { "content-type": "application/xml" } });
      }
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

    if (requestUrl.includes("/profile-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist>
          <box>
            <id>PROFILE-1</id>
            <title>Meine Daten</title>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/profile-service") && requestUrl.includes("name=save_partner")) {
      return new Response("oppc://openform?id=FINAL-PROFILE-1", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }

    if (requestUrl.includes("/profile-service") && requestUrl.includes("name=save")) {
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }

    if (requestUrl.includes("/profile-service") && requestUrl.includes("id=PROFILE-1")) {
      return new Response(profileDetailForm(), {
        status: 200,
        headers: { "content-type": "application/xml" }
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

function servicesWithProfileDetail(): string {
  return `
    <asx:abap><asx:values><SERVICE>
      <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
      <FOLDERS>
        <SERVICE_NODE>
          <title>Meine Daten</title>
          <SERVICE>/profile-service</SERVICE>
          <XUCLASS>ESQ_IA_PART</XUCLASS>
        </SERVICE_NODE>
        <SERVICE_NODE>
          <title>Verträge</title>
          <SERVICE>/tenant-service</SERVICE>
          <XUCLASS>ESQ_TENANT</XUCLASS>
        </SERVICE_NODE>
      </FOLDERS>
    </SERVICE></asx:values></asx:abap>
  `;
}

function profileDetailForm(): string {
  return `
    <form>
      <id>PROFILE-1</id>
      <title>Meine Daten</title>
      <action>
        <id>save_partner</id>
        <name>save_partner</name>
        <text>Speichern</text>
        <method>POST</method>
      </action>
      <textfield id="SO_#NAME_FIRST#_I_CP" refname="name_first_ref" required="true">Tillmann</textfield>
      <textfield id="SO_#PHONE#_I_CP" refname="phone_ref" required="true">+15550100000</textfield>
      <textfield editable="false" id="SO_#SMTP_ADDR#_I_CP" refname="mail" required="true">user@example.test</textfield>
      <choicefield id="SO_#TITLE#_I_CP" meta:saved_value="0002" refname="int_anrede" required="true">
        <choice id="0001" title="Frau"/>
        <choice id="0002" selected="true" title="Herr"/>
      </choicefield>
      <choicefield id="SO_#PREF_CONTACT#_I_EQ" refname="pref_ct">
        <choice id="001" title="Telefon"/>
        <choice id="003" selected="true" title="E-Mail"/>
      </choicefield>
      <choicefield id="SO_#COUNTRY#_I_EQ" refname="adr5">
        <choice id="DE" selected="true" title="Deutschland"/>
      </choicefield>
      <textfield id="ESQ_CHANGED" visibility="hidden">false</textfield>
    </form>
  `;
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

function servicesWithActions(): string {
  const services = [
    ["Verträge", "/tenant-service", "ESQ_TENANT"],
    ["Reparatur", "/repair-service", "ESQ_TENA_DMG"],
    ["Service", "/service-service", "ESQ_TENA_SRV"],
    ["Verbräuche", "/consumption-service", "ESQ_TENA_CSM"],
    ["Meine Hausinfo", "/pinboard-service", "TN_PINBRD"],
    ["Immobiliensuche", "/real-estate-service", "ESQ_IA_REOBJ"],
    ["Meine Daten", "/profile-service", "ESQ_IA_PART"]
  ];
  return `
    <asx:abap><asx:values><SERVICE>
      <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
      <FOLDERS>
        ${services.map(([title, serviceUrl, xuclass]) => `
          <SERVICE_NODE>
            <title>${title}</title>
            <SERVICE>${serviceUrl}</SERVICE>
            <XUCLASS>${xuclass}</XUCLASS>
          </SERVICE_NODE>
        `).join("")}
      </FOLDERS>
    </SERVICE></asx:values></asx:abap>
  `;
}

function actionForService(requestUrl: string): string | undefined {
  if (requestUrl.includes("/tenant-service")) {
    return actionBox("TENANT-CHANGE", "Vertragsanfrage senden", "message");
  }
  if (requestUrl.includes("/repair-service")) {
    return `
      <boxlist>
        <box>
          <id>DMG-NEW</id>
          <title>Schaden melden</title>
          <command>submit</command>
          <method>POST</method>
          <endpoint>/repair-service</endpoint>
          <field>
            <name>description</name>
            <label>Beschreibung</label>
            <required>true</required>
            <type>textarea</type>
          </field>
          <field>
            <name>csrfToken</name>
            <value>csrf-secret</value>
            <hidden>true</hidden>
          </field>
        </box>
        <box>
          <id>$BS_READCONFIRMED</id>
          <title>Lesebestätigung angefordert</title>
        </box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/service-service")) {
    return actionBox("SRV-NEW", "Serviceanfrage senden", "message");
  }
  if (requestUrl.includes("/consumption-service")) {
    return actionBox("CSM-REPORT", "Zählerstand übermitteln", "meterReading");
  }
  if (requestUrl.includes("/pinboard-service")) {
    return actionBox("PIN-ACK", "Hausinfo bestätigen", "confirmation");
  }
  if (requestUrl.includes("/real-estate-service")) {
    return actionBox("REOBJ-INTEREST", "Interesse bekunden", "message");
  }
  if (requestUrl.includes("/profile-service")) {
    return actionBox("PART-CHANGE", "Datenänderung vorbereiten", "message");
  }
  return undefined;
}

function actionBox(id: string, title: string, field: string): string {
  return `
    <boxlist>
      <box>
        <id>${id}</id>
        <title>${title}</title>
        <command>submit</command>
        <method>POST</method>
        <endpoint>/action</endpoint>
        <field>
          <name>${field}</name>
          <label>${field}</label>
          <required>true</required>
        </field>
      </box>
    </boxlist>
  `;
}
