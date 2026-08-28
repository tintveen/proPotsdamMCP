import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/credentials.js";
import type { PortalCommitBatchResult, PortalCommitResult } from "../src/types.js";

const tempDirs: string[] = [];

describe("PortalClient HTTP flow", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.doUnmock("keytar");
    vi.resetModules();
    delete process.env.PROPPOTSDAM_DATA_DIR;
    delete process.env.PROPPOTSDAM_USERNAME;
    delete process.env.PROPPOTSDAM_PASSWORD;
    delete process.env.PROPPOTSDAM_BASE_URL;
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

  it("logs in with environment credentials without importing keytar", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-mcp-"));
    tempDirs.push(tempDir);
    process.env.PROPPOTSDAM_DATA_DIR = tempDir;
    process.env.PROPPOTSDAM_USERNAME = "cloud-user";
    process.env.PROPPOTSDAM_PASSWORD = "cloud-secret";
    process.env.PROPPOTSDAM_BASE_URL = "https://portal.example.test";
    vi.doMock("keytar", () => {
      throw new Error("keytar should not be imported for environment credentials");
    });
    vi.resetModules();

    const { PortalClient } = await import("../src/portal/portal-client.js");
    const requests: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      requests.push({ url: requestUrl, method: init?.method, body: init?.body });
      if (requestUrl.includes("/authenticate")) {
        return new Response("<ok />", {
          status: 200,
          headers: {
            "set-cookie": "sid=abc; Path=/; HttpOnly",
            "content-type": "application/xml"
          }
        });
      }
      return new Response(`
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>CLOUD</USER_ID></HEAD>
        </SERVICE></asx:values></asx:abap>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    });

    const client = new PortalClient(undefined, fetchMock);
    const result = await client.login();

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("CLOUD");
    expect(requests[0]?.url).toContain("/propotsdam-kundenportal/api5/authenticate");
    expect(String(requests[0]?.body)).toContain("sap-ffield_b64=");
    expect(String(requests[0]?.body)).not.toContain("cloud-secret");
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
    const { client, requests } = await createMockClient({
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

  it("lists and exports portal file resources without returning bytes inline", async () => {
    const { client, requests, paths: storagePaths } = await createMockClient({
      loggedServicesBody: servicesWithGenericSection()
    });

    const files = await client.listPortalFiles({ xuclass: "ESQ_TENANT" });
    const exported = await client.exportPortalFile("REC-1");
    const exportedBody = await readFile(exported.path, "utf8");

    expect(files.items).toEqual([
      expect.objectContaining({
        id: "REC-1",
        sourceRecordId: "REC-1",
        filename: "Mietvertrag.pdf",
        resourceId: "RES-1",
        resourceOrigin: "ARCHIVE",
        mimeType: "application/pdf",
        exportable: true
      })
    ]);
    expect(exported).toMatchObject({
      ok: true,
      id: "REC-1",
      sourceRecordId: "REC-1",
      filename: "Mietvertrag.pdf",
      mimeType: "application/pdf",
      byteLength: 10,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(exported.path.startsWith(storagePaths.exportsDir)).toBe(true);
    expect(exportedBody).toBe("GENERICPDF");
    expect(JSON.stringify(exported)).not.toContain("GENERICPDF");
    expect(requests.some((request) => request.url.includes("id=RES-1") && request.url.includes("resourceOrigin=ARCHIVE"))).toBe(true);
  });

  it("lists broad structured read models including Meine Anfragen", async () => {
    const { client } = await createMockClient({
      loggedServicesBody: servicesWithReadGaps(),
      readGapBoxlists: true
    });

    const structured = await client.listStructuredPortalRecords();
    const domains = structured.items.map((item) => item.domain);
    const inquiry = await client.getStructuredPortalRecord("INQ-1");
    const repairs = await client.listStructuredPortalRecords({ domain: "repair_status" });

    expect(domains).toEqual(expect.arrayContaining([
      "rent_account",
      "contract",
      "statement",
      "repair_status",
      "service_request",
      "consumption",
      "real_estate_listing",
      "viewing_appointment",
      "application_status",
      "inquiry",
      "house_notice",
      "profile_setting",
      "notification",
      "external_link",
      "attachment"
    ]));
    expect(inquiry).toMatchObject({
      id: "INQ-1",
      domain: "inquiry",
      serviceTitle: "Meine Anfragen",
      detailText: expect.stringContaining("Detail for INQ-1")
    });
    expect(repairs.items).toEqual([
      expect.objectContaining({
        id: "DMG-1",
        domain: "repair_status",
        status: "in Bearbeitung"
      })
    ]);
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
    expect(JSON.stringify(action)).not.toContain("csrf-secret-option");
    expect(JSON.stringify(prepared)).not.toContain("csrf-secret-option");
    expect(artifact).not.toContain("csrf-secret");
    expect(artifact).not.toContain("csrf-secret-option");
    expect(artifact).not.toContain("sid=abc");
    expect(artifact).not.toContain("csrf-token");
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);
  });

  it("resolves portal actions for contact defaults without persisting a PII-bearing trace", async () => {
    const { client, tempDir } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });

    const actions = await client.listPortalActionsForDefaults();

    expect(actions.items.some((action) => action.id === "save_partner")).toBe(true);
    expect(await readdir(path.join(tempDir, "traces"))).toEqual([]);
  });

  it("lists every missing write capability as draft-only and prepares without live writes", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithActions(),
      actionBoxlists: true
    });

    const capabilities = await client.listPortalWriteCapabilities();
    const domains = new Set(capabilities.items.map((item) => item.domain));
    const repair = await client.preparePortalWrite({
      domain: "repair_report",
      actionId: "DMG-NEW",
      values: {
        description: "Heizung bleibt kalt"
      }
    });
    const passwordChange = await client.preparePortalWrite({
      domain: "password_change",
      values: {
        currentPassword: "old-secret",
        newPassword: "new-secret"
      }
    });

    expect([...domains]).toEqual(expect.arrayContaining([
      "inbox_compose",
      "inbox_reply",
      "inbox_state",
      "workflow_reply",
      "read_confirmation",
      "repair_report",
      "repair_file_upload",
      "repair_appointment",
      "service_ticket",
      "pet_approval",
      "payment_method",
      "meter_reading",
      "house_notice_ack",
      "real_estate_inquiry",
      "viewing_booking",
      "rental_application",
      "registration_activation",
      "password_change",
      "terms_acceptance",
      "account_verification",
      "captcha_completion",
      "profile_account_setting",
      "external_navigation"
    ]));
    expect(capabilities.items.every((item) => item.liveCommitSupported === false)).toBe(true);
    expect(repair).toMatchObject({
      ok: true,
      preparedOnly: true,
      willSend: false,
      domain: "repair_report",
      actionId: "DMG-NEW",
      draft: {
        endpoint: "/repair-service"
      }
    });
    expect(passwordChange).toMatchObject({
      ok: true,
      preparedOnly: true,
      willSend: false,
      domain: "password_change"
    });
    expect(JSON.stringify(passwordChange)).not.toContain("old-secret");
    expect(JSON.stringify(passwordChange)).not.toContain("new-secret");
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

  it("stages save_partner without sending writes, then atomically commits it once", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });

    const staged = await client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });

    expect(staged).toMatchObject({
      ok: true,
      actionId: "save_partner",
      actionTitle: "Speichern",
      expiresAt: expect.any(String),
      target: {
        accountId: "MAX",
        domain: "profile_account_setting",
        serviceId: undefined,
        serviceTitle: "Meine Daten",
        recordId: "PROFILE-1",
        recordTitle: "Meine Daten"
      },
      diff: [
        expect.objectContaining({
          name: "phone_ref",
          currentValue: "+15550100000",
          proposedValue: "+15550100001"
        })
      ],
      validationIssues: []
    });
    expect(staged.pendingWriteHandle).toMatch(/[0-9a-f-]{36}/);
    expect(staged.requiresExplicitApproval).toBe(true);
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);

    const result = await commitOne(client, staged.pendingWriteHandle!);
    const savePosts = requests.filter((request) => request.method === "POST" && request.url.includes("name=save"));
    const actionGets = requests.filter((request) => request.method === "GET" && request.url.includes("name=save_partner"));

    expect(result).toMatchObject({
      ok: true,
      outcome: "succeeded",
      actionId: "save_partner",
      recordId: "FINAL-PROFILE-1",
      status: 200,
      summary: expect.stringContaining("profile action")
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
    await expect(commitOne(client, staged.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent"
    });
  });

  it("stages and commits detail-based repair reports", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairDetailForm: true
    });
    const description = "An der Hintertür des Hauses lässt sich die Tür nicht mehr mit dem elektronischen Schalter öffnen. Der Elektromotor bzw. elektronische Türöffner scheint defekt. Bitte veranlassen Sie die Reparatur.";

    const capabilities = await client.listPortalWriteCapabilities({ domain: "repair_report" });
    expect(capabilities.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: "cmdsend",
        uploadSupported: false,
        liveCommitSupported: true,
        executionPolicy: "conversational_approval_required_live_commit"
      })
    ]));

    const missingTopic = await client.stagePortalAction("cmdsend", {
      msg_txt: description
    });
    expect(missingTopic).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: ["Repair reports require a proposed Schadensart/TOPIC field."]
    });

    const unsupportedAttachment = await client.stagePortalAction("cmdsend", {
      msg_txt: description,
      TOPIC_IB_DOOR_1: "TUEROEFFNER",
      attachmentFilePath: "/tmp/damage.jpg"
    });
    expect(unsupportedAttachment).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: ["Portal action 'cmdsend' does not expose a supported upload field for attachments."]
    });

    const staged = await client.stagePortalAction("cmdsend", {
      msg_txt: description,
      TOPIC_IB_DOOR_1: "TUEROEFFNER"
    });

    expect(staged).toMatchObject({
      ok: true,
      actionId: "cmdsend",
      actionTitle: "Schaden melden",
      expiresAt: expect.any(String),
      validationIssues: [],
      diff: expect.arrayContaining([
        expect.objectContaining({ name: "msg_txt", proposedValue: description }),
        expect.objectContaining({ name: "TOPIC_IB_DOOR_1", proposedValue: "TUEROEFFNER" })
      ])
    });
    expect(staged.pendingWriteHandle).toMatch(/[0-9a-f-]{36}/);
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);

    const result = await commitOne(client, staged.pendingWriteHandle!);
    const savePosts = requests.filter((request) => request.method === "POST" && request.url.includes("name=save"));
    const actionGets = requests.filter((request) => request.method === "GET" && request.url.includes("name=cmdsend"));

    expect(result).toMatchObject({
      ok: true,
      outcome: "succeeded",
      actionId: "cmdsend",
      recordId: "FINAL-REPAIR-1",
      status: 200,
      summary: expect.stringContaining("repair action")
    });
    expect(savePosts).toHaveLength(1);
    expect(actionGets).toHaveLength(1);
    expect(savePosts[0]!.url).toContain("name=save");
    expect(savePosts[0]!.url).toContain("resourceOrigin=form");
    expect(actionGets[0]!.url).toContain("name=cmdsend");
    expect(String(savePosts[0]!.body)).toContain("Hintertür");
    expect(String(savePosts[0]!.body)).toContain("<choice id=\"TUEROEFFNER\" title=\"Türöffner\" selected=\"true\"/>");
    expect(String(savePosts[0]!.body)).toContain("<textfield id=\"ESQ_CHANGED\"");
    expect(String(savePosts[0]!.body)).toContain(">true</textfield>");
    await expect(commitOne(client, staged.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent"
    });
  });

  it("commits namespaced repair XML with escaped values, number/date fields, and stable metadata", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      namespacedRepairDetailForm: true
    });
    const description = "Tür <klemmt> & \"summt\"";

    const staged = await client.stagePortalAction("cmdsend", {
      msg_txt: description,
      TOPIC_IB_DOOR_1: "TUEROEFFNER",
      ROOMS_CHO_IB_1: "Wohnung",
      repair_cost: "120",
      preferred_date: "17.06.2026"
    });
    expect(staged).toMatchObject({
      ok: true,
      validationIssues: []
    });

    await commitOne(client, staged.pendingWriteHandle!);
    const savePost = requests.find((request) => request.method === "POST" && request.url.includes("name=save"))!;
    const saveUrl = new URL(savePost.url);
    const newId = saveUrl.searchParams.get("id");
    const body = String(savePost.body);

    expect(newId).toMatch(/[0-9A-F-]{36}/);
    expect(body).toContain(`<form id="${newId}"`);
    expect(body).toContain(`<head><id>${newId}</id></head>`);
    expect(body).not.toContain("<oppc:form");
    expect(body).not.toContain("xmlns:oppc");
    expect(body).toContain("Tür &lt;klemmt&gt; &amp; \"summt\"");
    expect(body).toContain('<choice id="Wohnung" title="Wohnung" selected="true"/>');
    expect(body).not.toContain('<choice id="Aufgang" selected="true"');
    expect(body).toContain('<numberfield id="COST_FIELD" refname="repair_cost">120</numberfield>');
    expect(body).toContain('<datefield id="DATE_FIELD" refname="preferred_date">17.06.2026</datefield>');
    expect(body).toContain("<history><save oldId=\"OLD\"");
    expect(body).toContain(`oldId="REPAIR-FORM" newId="${newId}"`);
    expect(body).not.toContain("old-client");
    expect(body).toContain("webapp-professional");
  });

  it("creates and commits repair reports with a supported image upload field", async () => {
    const { client, requests, tempDir } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairUploadDetailForm: true
    });
    const photoPath = path.join(tempDir, "damage.jpg");
    await writeFile(photoPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]));

    const capabilities = await client.listPortalWriteCapabilities({ domain: "repair_report" });
    expect(capabilities.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: "cmdsend",
        uploadSupported: true,
        liveCommitSupported: true
      })
    ]));

    const textPath = path.join(tempDir, "damage.txt");
    await writeFile(textPath, "not an image", "utf8");
    const invalidAttachment = await client.stagePortalAction("cmdsend", {
      msg_txt: "Der Deckel ist defekt.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER",
      attachmentFilePath: textPath
    });
    expect(invalidAttachment).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: [expect.stringContaining("must be a JPEG or PNG image")]
    });

    const staged = await client.stagePortalAction("cmdsend", {
      msg_txt: "Der Deckel der Bio-Muelltonne ist an einer Seite aus der Aufhaengung gebrochen.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER",
      attachmentFilePath: photoPath
    });

    expect(staged).toMatchObject({
      ok: true,
      actionId: "cmdsend",
      validationIssues: [],
      diff: expect.arrayContaining([
        expect.objectContaining({
          name: "damage_photo",
          proposedValue: expect.stringContaining("damage.jpg (image/jpeg")
        })
      ]),
      attachments: [
        expect.objectContaining({
          fieldName: "damage_photo",
          filename: "damage.jpg",
          mimeType: "image/jpeg",
          uploadSupported: true,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
        })
      ]
    });
    expect(JSON.stringify(staged)).not.toContain("JFIF");
    expect(JSON.stringify(staged)).not.toContain(photoPath);
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);

    const result = await commitOne(client, staged.pendingWriteHandle!);
    const uploadPosts = requests.filter((request) => request.method === "POST" && request.url.includes("/repair-upload"));
    const actionGets = requests.filter((request) => request.method === "GET" && request.url.includes("name=cmdsend"));

    expect(result).toMatchObject({
      ok: true,
      actionId: "cmdsend",
      attachmentUploads: [
        {
          fieldName: "damage_photo",
          filename: "damage.jpg",
          ok: true,
          status: 200
        }
      ]
    });
    expect(uploadPosts).toHaveLength(1);
    expect(uploadPosts[0]!.url).toContain("id=");
    expect(uploadPosts[0]!.url).toContain("originalId=REPAIR-FORM");
    expect(uploadPosts[0]!.body).toBeInstanceOf(FormData);
    expect(actionGets).toHaveLength(1);
  });

  it("returns failed commit results for save, upload, and final action failures", async () => {
    const values = {
      msg_txt: "Die Haustür schließt nicht.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER"
    };

    const saveFailure = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairDetailForm: true,
      failRepairSave: true
    });
    const savePending = await saveFailure.client.stagePortalAction("cmdsend", values);
    const saveResult = await commitOne(saveFailure.client, savePending.pendingWriteHandle!);
    expect(saveResult).toMatchObject({
      ok: false,
      outcome: "outcomeUncertain",
      actionId: "cmdsend",
      status: 500,
      summary: expect.stringContaining("while saving")
    });
    await expect(commitOne(saveFailure.client, savePending.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent"
    });

    const uploadFailure = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairUploadDetailForm: true,
      failRepairUpload: true
    });
    const photoPath = path.join(uploadFailure.tempDir, "damage.png");
    await writeFile(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const uploadPending = await uploadFailure.client.stagePortalAction("cmdsend", {
      ...values,
      attachmentFilePath: photoPath
    });
    const uploadResult = await commitOne(uploadFailure.client, uploadPending.pendingWriteHandle!);
    expect(uploadResult).toMatchObject({
      ok: false,
      outcome: "outcomeUncertain",
      actionId: "cmdsend",
      status: 502,
      summary: expect.stringContaining("while uploading attachment"),
      attachmentUploads: [
        {
          fieldName: "damage_photo",
          filename: "damage.png",
          ok: false,
          status: 502
        }
      ]
    });
    expect(uploadFailure.requests.filter((request) => request.method === "GET" && request.url.includes("name=cmdsend"))).toHaveLength(0);

    const actionFailure = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairDetailForm: true,
      failRepairCommit: true
    });
    const actionPending = await actionFailure.client.stagePortalAction("cmdsend", values);
    const actionResult = await commitOne(actionFailure.client, actionPending.pendingWriteHandle!);
    expect(actionResult).toMatchObject({
      ok: false,
      outcome: "rejected",
      actionId: "cmdsend",
      status: 409,
      summary: expect.stringContaining("Portal returned HTTP 409")
    });
    await expect(commitOne(actionFailure.client, actionPending.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent"
    });
  });

  it("requires a unique target for repeated detail-based repair commits", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      dualRepairDetailForms: true
    });
    const values = {
      msg_txt: "Der Türöffner im zweiten Aufgang reagiert nicht.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER"
    };

    const ambiguous = await client.stagePortalAction("cmdsend", values);
    expect(ambiguous).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: [expect.stringContaining("ambiguous")]
    });

    const staged = await client.stagePortalAction("cmdsend", values, {
      recordId: "REPAIR-FORM-B"
    });
    expect(staged).toMatchObject({
      ok: true,
      actionId: "cmdsend",
      validationIssues: [],
      diff: expect.arrayContaining([
        expect.objectContaining({ name: "msg_txt", proposedValue: values.msg_txt })
      ])
    });

    const result = await commitOne(client, staged.pendingWriteHandle!);
    const savePost = requests.filter((request) => request.method === "POST" && request.url.includes("name=save")).at(-1)!;
    const actionGet = requests.filter((request) => request.method === "GET" && request.url.includes("name=cmdsend")).at(-1)!;

    expect(result).toMatchObject({
      ok: true,
      actionId: "cmdsend",
      recordId: "FINAL-REPAIR-B"
    });
    expect(savePost.url).toContain("originalId=REPAIR-FORM-B");
    expect(actionGet.url).toContain("originalId=REPAIR-FORM-B");
  });

  it("supports multiple pending writes and local cancellation without portal writes", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });
    const first = await client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });
    const second = await client.stagePortalAction("save_partner", {
      phone_ref: "+15550100002"
    });

    await expect(client.listPendingWrites()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ pendingWriteHandle: first.pendingWriteHandle }),
        expect.objectContaining({ pendingWriteHandle: second.pendingWriteHandle })
      ]
    });
    await expect(client.cancelPendingWrites([first.pendingWriteHandle!])).resolves.toMatchObject({
      ok: true,
      cancelledHandles: [first.pendingWriteHandle]
    });
    await expect(client.listPendingWrites()).resolves.toMatchObject({
      items: [expect.objectContaining({ pendingWriteHandle: second.pendingWriteHandle })]
    });
    const remaining = (await client.listPendingWrites()).items[0]!;
    expect(Date.parse(remaining.expiresAt) - Date.parse(remaining.createdAt)).toBe(10 * 60 * 1000);
    expect(requests.filter((request) =>
      request.url.includes("name=save") ||
      request.url.includes("name=save_partner") ||
      request.url.includes("name=cmdsend") ||
      request.url.includes("/repair-upload")
    )).toEqual([]);
  });

  it("allows only one concurrent commit sequence for the same pending write", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });
    const staged = await client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });

    const results = await Promise.all([
      commitOne(client, staged.pendingWriteHandle!),
      commitOne(client, staged.pendingWriteHandle!)
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["notSent", "succeeded"]);
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("name=save"))).toHaveLength(1);
    expect(requests.filter((request) => request.method === "GET" && request.url.includes("name=save_partner"))).toHaveLength(1);
  });

  it("continues an approved batch after rejection and reports partial completion", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairDetailForm: true,
      failRepairCommitOnce: true
    });
    const first = await client.stagePortalAction("cmdsend", {
      msg_txt: "Die Haustür schließt nicht.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER"
    });
    const second = await client.stagePortalAction("cmdsend", {
      msg_txt: "Der Türöffner reagiert nicht.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER"
    });

    const batch = await client.commitPendingWrites([
      first.pendingWriteHandle!,
      second.pendingWriteHandle!
    ]);

    expect(batch).toMatchObject({
      ok: false,
      partial: true,
      attemptedCount: 2,
      counts: { succeeded: 1, notSent: 0, rejected: 1, outcomeUncertain: 0 },
      results: [
        expect.objectContaining({ pendingWriteHandle: first.pendingWriteHandle, outcome: "rejected" }),
        expect.objectContaining({ pendingWriteHandle: second.pendingWriteHandle, outcome: "succeeded" })
      ]
    });
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("name=save"))).toHaveLength(2);
    expect(requests.filter((request) => request.method === "GET" && request.url.includes("name=cmdsend"))).toHaveLength(2);
  });

  it("invalidates account-mismatched and form-drifted pending writes before dispatch", async () => {
    const accountCase = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });
    const accountPending = await accountCase.client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });
    accountCase.setPortalUserId("OTHER");

    await expect(commitOne(accountCase.client, accountPending.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent",
      summary: expect.stringContaining("account changed")
    });
    expect(accountCase.requests.filter((request) => request.method === "POST" && request.url.includes("name=save"))).toHaveLength(0);

    const driftCase = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });
    const driftPending = await driftCase.client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });
    driftCase.setProfilePhone("+15550999999");

    await expect(commitOne(driftCase.client, driftPending.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent",
      summary: expect.stringContaining("form changed")
    });
    expect(driftCase.requests.filter((request) => request.method === "POST" && request.url.includes("name=save"))).toHaveLength(0);
  });

  it("invalidates a staged attachment whose content hash changes", async () => {
    const { client, requests, tempDir } = await createMockClient({
      loggedServicesBody: servicesWithRepairDetail(),
      repairUploadDetailForm: true
    });
    const photoPath = path.join(tempDir, "damage.png");
    await writeFile(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const staged = await client.stagePortalAction("cmdsend", {
      msg_txt: "Der Türöffner reagiert nicht.",
      TOPIC_IB_DOOR_1: "TUEROEFFNER",
      attachmentFilePath: photoPath
    });
    const { loadPendingWrite } = await import("../src/storage.js");
    const stored = await loadPendingWrite(staged.pendingWriteHandle!);
    await writeFile(stored!.attachments![0]!.filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]));

    await expect(commitOne(client, staged.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent",
      summary: expect.stringContaining("attachment")
    });
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("name=save"))).toHaveLength(0);
  });

  it("does not send an expired pending write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const { client } = await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    });
    const { loadPendingWrite } = await import("../src/storage.js");
    const staged = await client.stagePortalAction("save_partner", {
      phone_ref: "+15550100001"
    });
    vi.setSystemTime(new Date("2026-08-28T12:11:00.000Z"));

    await expect(commitOne(client, staged.pendingWriteHandle!)).resolves.toMatchObject({
      outcome: "notSent",
      summary: expect.stringContaining("expired")
    });
    await expect(loadPendingWrite(staged.pendingWriteHandle!)).resolves.toBeNull();
  });

  it("does not stage pending writes for locked fields, unknown fields, or blocked actions", async () => {
    const { client, requests } = await createMockClient({
      loggedServicesBody: servicesWithActions(),
      actionBoxlists: true
    });

    const blocked = await client.stagePortalAction("DMG-NEW", {
      description: "Heizung bleibt kalt"
    });
    expect(blocked).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: ["Only Meine Daten/save_partner and Reparatur/cmdsend damage reports can be committed in this version."]
    });

    const profileClient = (await createMockClient({
      loggedServicesBody: servicesWithProfileDetail()
    })).client;
    const invalid = await profileClient.stagePortalAction("save_partner", {
      mail: "blocked@example.test",
      unknown_field: "ignored"
    });
    expect(invalid).toMatchObject({
      ok: false,
      pendingWriteHandle: undefined,
      validationIssues: expect.arrayContaining([
        "Field 'mail' is not editable.",
        "Unknown field 'unknown_field'."
      ])
    });
    expect(requests.filter((request) => request.method === "POST" && !request.url.includes("/authenticate"))).toEqual([]);
  });
});

async function commitOne(
  client: { commitPendingWrites(handles: string[]): Promise<PortalCommitBatchResult> },
  pendingWriteHandle: string
): Promise<PortalCommitResult> {
  const batch = await client.commitPendingWrites([pendingWriteHandle]);
  return batch.results[0]!;
}

async function createMockClient(options: {
  authBody?: string;
  loggedServicesBody?: string;
  apiServicesBody?: string;
  actionBoxlists?: boolean;
  readGapBoxlists?: boolean;
  repairDetailForm?: boolean;
  repairUploadDetailForm?: boolean;
  dualRepairDetailForms?: boolean;
  namespacedRepairDetailForm?: boolean;
  failRepairSave?: boolean;
  failRepairUpload?: boolean;
  failRepairCommit?: boolean;
  failRepairCommitOnce?: boolean;
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
  let activeUserId = "MAX";
  let activeProfilePhone = "+15550100000";
  let repairCommitCalls = 0;
  const hasRepairDetail = Boolean(
    options.repairDetailForm ||
      options.repairUploadDetailForm ||
      options.dualRepairDetailForms ||
      options.namespacedRepairDetailForm ||
      options.failRepairSave ||
      options.failRepairUpload ||
      options.failRepairCommit ||
      options.failRepairCommitOnce
  );
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
      const body = options.loggedServicesBody ?? `
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
      `;
      return new Response(withPortalUser(body, activeUserId), { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (requestUrl.includes("/propotsdam-kundenportal/api5/services")) {
      return new Response(options.apiServicesBody ?? `
        <asx:abap><asx:values><SERVICE>
          <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
        </SERVICE></asx:values></asx:abap>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (options.readGapBoxlists && requestUrl.includes("name=boxlist")) {
      const records = recordsForReadGapService(requestUrl);
      if (records) {
        return new Response(records, { status: 200, headers: { "content-type": "application/xml" } });
      }
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

    if (requestUrl.includes("/inquiry-service") && requestUrl.includes("id=INQ-1")) {
      return new Response("<detail><text>Detail for INQ-1</text></detail>", {
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

    if (hasRepairDetail && requestUrl.includes("/repair-service") && requestUrl.includes("name=cmdsend")) {
      repairCommitCalls += 1;
      const finalId = options.dualRepairDetailForms
        ? (requestUrl.includes("originalId=REPAIR-FORM-B") ? "FINAL-REPAIR-B" : "FINAL-REPAIR-A")
        : "FINAL-REPAIR-1";
      const reject = Boolean(options.failRepairCommit || options.failRepairCommitOnce && repairCommitCalls === 1);
      return new Response(reject ? "Commit rejected" : `oppc://openform?id=${finalId}`, {
        status: reject ? 409 : 200,
        headers: { "content-type": "text/plain" }
      });
    }

    if (hasRepairDetail && requestUrl.includes("/repair-service") && requestUrl.includes("name=save")) {
      return new Response(options.failRepairSave ? "Save failed" : "", {
        status: options.failRepairSave ? 500 : 200,
        headers: { "content-type": "text/html" }
      });
    }

    if (options.repairUploadDetailForm && requestUrl.includes("/repair-upload")) {
      return new Response(options.failRepairUpload ? "Upload failed" : "", {
        status: options.failRepairUpload ? 502 : 200,
        headers: { "content-type": "text/html" }
      });
    }

    if (options.dualRepairDetailForms && requestUrl.includes("/repair-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist>
          <box>
            <id>REPAIR-FORM-A</id>
            <title>Schaden melden</title>
          </box>
          <box>
            <id>REPAIR-FORM-B</id>
            <title>Schaden melden</title>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (options.dualRepairDetailForms && requestUrl.includes("/repair-service") && requestUrl.includes("id=REPAIR-FORM-A")) {
      return new Response(repairDetailForm("REPAIR-FORM-A"), {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }

    if (options.dualRepairDetailForms && requestUrl.includes("/repair-service") && requestUrl.includes("id=REPAIR-FORM-B")) {
      return new Response(repairDetailForm("REPAIR-FORM-B"), {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }

    if ((hasRepairDetail && !options.dualRepairDetailForms) && requestUrl.includes("/repair-service") && requestUrl.includes("name=boxlist")) {
      return new Response(`
        <boxlist>
          <box>
            <id>REPAIR-FORM</id>
            <title>Schaden melden</title>
          </box>
        </boxlist>
      `, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if ((hasRepairDetail && !options.dualRepairDetailForms) && requestUrl.includes("/repair-service") && requestUrl.includes("id=REPAIR-FORM")) {
      return new Response(repairDetailForm("REPAIR-FORM", {
        upload: options.repairUploadDetailForm,
        namespaced: options.namespacedRepairDetailForm,
        numberDate: options.namespacedRepairDetailForm,
        existingHistory: options.namespacedRepairDetailForm,
        existingClient: options.namespacedRepairDetailForm
      }), {
        status: 200,
        headers: { "content-type": "application/xml" }
      });
    }

    if (requestUrl.includes("/profile-service") && requestUrl.includes("id=PROFILE-1")) {
      return new Response(profileDetailForm(activeProfilePhone), {
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
    paths,
    setPortalUserId: (userId: string) => {
      activeUserId = userId;
    },
    setProfilePhone: (phone: string) => {
      activeProfilePhone = phone;
    }
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

function withPortalUser(body: string, userId: string): string {
  return body.replace(/<USER_ID>[^<]*<\/USER_ID>/g, `<USER_ID>${userId}</USER_ID>`);
}

function servicesWithRepairDetail(): string {
  return `
    <asx:abap><asx:values><SERVICE>
      <HEAD><LOGGED>X</LOGGED><USER_ID>MAX</USER_ID></HEAD>
      <FOLDERS>
        <SERVICE_NODE>
          <title>Reparatur</title>
          <SERVICE>/repair-service</SERVICE>
          <XUCLASS>ESQ_TENA_DMG</XUCLASS>
        </SERVICE_NODE>
      </FOLDERS>
    </SERVICE></asx:values></asx:abap>
  `;
}

function profileDetailForm(phone = "+15550100000"): string {
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
      <textfield id="SO_#PHONE#_I_CP" refname="phone_ref" required="true">${phone}</textfield>
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

function repairDetailForm(id = "REPAIR-FORM", options: {
  upload?: boolean;
  namespaced?: boolean;
  numberDate?: boolean;
  existingHistory?: boolean;
  existingClient?: boolean;
} = {}): string {
  const formTag = options.namespaced ? "oppc:form" : "form";
  const namespace = options.namespaced ? ' xmlns:oppc="urn:oppc" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:oppc schema.xsd"' : "";
  return `
    <${formTag} id="${id}"${namespace}>
      <head><id>${id}</id></head>
      ${options.existingClient ? '<client><editor name="old-client" version="0"/></client>' : ""}
      ${options.existingHistory ? '<history><save oldId="OLD" newId="OLDER" userName="fixture" timestamp="2026-05-03T00:00:00Z"/></history>' : ""}
      <title>Schaden melden</title>
      <action>
        <id>cmdsend</id>
        <name>cmdsend</name>
        <text>Schaden melden</text>
        <method>POST</method>
      </action>
      <textarea id="msg_txt" refname="msg_txt" required="true" title="Beschreibung*"></textarea>
      <choicefield id="ROOMS_CHO_IB_1" refname="ROOMS_CHO_IB_1" required="true" title="Welcher Teil der Wohnung ist betroffen?*">
        <choice id="Wohnung" title="Wohnung"/>
        <choice id="Aufgang" selected="true" title="Aufgang"/>
      </choicefield>
      <choicefield id="TOPIC_IB_DOOR_1" refname="TOPIC_IB_DOOR_1" required="true" title="Schadensart*">
        <choice id="TUEROEFFNER" title="Türöffner"/>
        <choice id="TUER" title="Tür"/>
        <choice id="SCHLOSS" title="Schloss"/>
      </choicefield>
      ${options.numberDate ? '<numberfield id="COST_FIELD" refname="repair_cost">0</numberfield>' : ""}
      ${options.numberDate ? '<datefield id="DATE_FIELD" refname="preferred_date">01.06.2026</datefield>' : ""}
      ${options.upload ? '<filefield id="ATTACH_PHOTO" refname="damage_photo" title="Foto" uploadUrl="/repair-upload" accept="image/jpeg,image/png"/>' : ""}
      <textfield id="ESQ_CHANGED" visibility="hidden">false</textfield>
    </${formTag}>
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

function servicesWithReadGaps(): string {
  const services = [
    ["Nachrichten", "/messages-service", "ESQ_MESSAGES"],
    ["Dokumente", "/docs-service", "ESQ_DOCUMENTS"],
    ["Verträge", "/tenant-service", "ESQ_TENANT"],
    ["Reparatur", "/repair-service", "ESQ_TENA_DMG"],
    ["Service", "/service-service", "ESQ_TENA_SRV"],
    ["Verbräuche", "/consumption-service", "ESQ_TENA_CSM"],
    ["Meine Hausinfo", "/pinboard-service", "TN_PINBRD"],
    ["Immobiliensuche", "/real-estate-service", "ESQ_IA_REOBJ"],
    ["Meine Anfragen", "/inquiry-service", "ESQ_IA_APPO"],
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

function recordsForReadGapService(requestUrl: string): string | undefined {
  if (requestUrl.includes("/messages-service")) {
    return `
      <boxlist>
        <box><id>NOTE-1</id><title>Push Benachrichtigung aktiviert</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/docs-service")) {
    return `
      <boxlist>
        <box><id>STMT-1</id><title>Betriebskostenabrechnung 2025.pdf</title><resourceId>STMT-PDF</resourceId><mimeType>application/pdf</mimeType></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/tenant-service")) {
    return `
      <boxlist>
        <box><id>RENT-1</id><title>Mietkonto Kontostand offen 120,50 EUR Zeitraum 01.2026</title></box>
        <box><id>CONTRACT-1</id><title>Mietvertrag.pdf</title><resourceId>CONTRACT-PDF</resourceId><mimeType>application/pdf</mimeType></box>
        <box><id>$BS_CALL_LINK</id><title>Externer Link zum Mietportal</title><url>https://example.test/tenant</url></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/repair-service")) {
    return `
      <boxlist>
        <box><id>DMG-1</id><title>Schaden Heizung in Bearbeitung</title></box>
        <box><id>ATT-1</id><title>Anlage Foto Schaden.jpg</title><resourceId>ATT-PHOTO</resourceId><mimeType>image/jpeg</mimeType></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/service-service")) {
    return `
      <boxlist>
        <box><id>SRV-1</id><title>Tierhaltung Hund beantragt</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/consumption-service")) {
    return `
      <boxlist>
        <box><id>CSM-1</id><title>Zählerstand Wasser 2026</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/pinboard-service")) {
    return `
      <boxlist>
        <box><id>PIN-1</id><title>Hausinfo Treppenhaus</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/real-estate-service")) {
    return `
      <boxlist>
        <box><id>REOBJ-1</id><title>Wohnung 3 Zimmer Potsdam</title></box>
        <box><id>VIEW-1</id><title>Besichtigungstermin verfügbar</title></box>
        <box><id>APP-1</id><title>Bewerbung Status eingegangen</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/inquiry-service")) {
    return `
      <boxlist>
        <box><id>INQ-1</id><title>Meine Anfrage offen</title></box>
      </boxlist>
    `;
  }
  if (requestUrl.includes("/profile-service")) {
    return `
      <boxlist>
        <box><id>PROFILE-1</id><title>Meine Daten</title></box>
      </boxlist>
    `;
  }
  return undefined;
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
            <choice>
              <value>csrf-secret-option</value>
              <selected>true</selected>
            </choice>
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
