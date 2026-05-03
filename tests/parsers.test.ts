import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractPortalActions,
  extractPortalRecordItems,
  extractServices,
  findSectionServices,
  parseSessionStatus
} from "../src/portal/parsers.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/redacted/${name}`, import.meta.url), "utf8");
}

describe("portal parsers", () => {
  it("reads authenticated session details from services XML", () => {
    const status = parseSessionStatus(`
      <asx:abap><asx:values><SERVICE><HEAD>
        <LOGGED>X</LOGGED>
        <USER_ID>fixture-user</USER_ID>
        <USER_FULLNAME>Fixture User</USER_FULLNAME>
      </HEAD></SERVICE></asx:values></asx:abap>
    `, "application/xml");

    expect(status).toMatchObject({
      state: "authenticated",
      authenticated: true,
      userId: "fixture-user",
      userFullName: "Fixture User"
    });
  });

  it("normalizes service fixtures and finds sections by localized portal labels", () => {
    const services = extractServices(fixture("services.xml"), "application/xml");

    expect(services).toEqual([
      expect.objectContaining({
        id: "fixture-service-inbox",
        title: "Postfach",
        serviceUrl: "/synthetic/inbox",
        xuclass: "SYNTHETIC_INBOX"
      }),
      expect.objectContaining({
        id: "fixture-service-documents",
        title: "Dokumente",
        serviceUrl: "/synthetic/documents",
        xuclass: "SYNTHETIC_DOCUMENTS"
      }),
      expect.objectContaining({
        id: "fixture-service-generic",
        title: "Allgemeine Vorgänge",
        serviceUrl: "/synthetic/records",
        xuclass: "SYNTHETIC_RECORDS"
      })
    ]);
    expect(findSectionServices(services, "inbox")).toHaveLength(1);
    expect(findSectionServices(services, "documents")).toHaveLength(1);
  });

  it("normalizes inbox and document fixtures", () => {
    const inbox = extractInboxItems(fixture("inbox.xml"), "application/xml");
    const documents = extractDocumentItems(fixture("documents.json"), "application/json");

    expect(inbox).toEqual([
      expect.objectContaining({
        id: "fixture-message-001",
        title: "Synthetic inbox notice",
        subject: "Synthetic inbox notice",
        sender: "Fixture sender",
        unread: true,
        replied: false,
        detailUrl: "/synthetic/inbox/detail/fixture-message-001"
      })
    ]);
    expect(documents[0]).toMatchObject({
      id: "fixture-document-001",
      title: "synthetic-document.pdf",
      filename: "synthetic-document.pdf",
      resourceId: "fixture-resource-document-001",
      mimeType: "application/pdf"
    });
  });

  it("normalizes generic record fixtures", () => {
    const records = extractPortalRecordItems(fixture("generic-records.json"), "application/json", {
      id: "fixture-service-generic",
      title: "Allgemeine Vorgänge",
      serviceUrl: "/synthetic/records",
      xuclass: "SYNTHETIC_RECORDS"
    });

    expect(records).toEqual([
      expect.objectContaining({
        id: "fixture-record-001",
        title: "Synthetic generic record",
        itemKind: "record",
        serviceId: "fixture-service-generic",
        serviceTitle: "Allgemeine Vorgänge"
      }),
      expect.objectContaining({
        id: "fixture-resource-001",
        title: "Synthetic downloadable record",
        itemKind: "resource",
        filename: "synthetic-record.pdf",
        resourceId: "fixture-resource-record-001"
      }),
      expect.objectContaining({
        id: "$BS_CALL_LINK_FIXTURE",
        title: "Synthetic external reference",
        itemKind: "external_link"
      })
    ]);
  });

  it("normalizes detail action form fixtures", () => {
    const actions = extractPortalActions(fixture("action-form.xml"), "application/xml", {
      id: "fixture-service-generic",
      title: "Allgemeine Vorgänge",
      serviceUrl: "/synthetic/actions",
      xuclass: "SYNTHETIC_RECORDS"
    }, {
      source: "detail",
      recordId: "fixture-record-001",
      recordTitle: "Synthetic generic record"
    });

    expect(actions).toEqual([
      expect.objectContaining({
        id: "save_fixture_request",
        title: "Save fixture request",
        source: "detail",
        recordId: "fixture-record-001",
        actionKind: "form",
        method: "POST",
        endpoint: "/synthetic/actions/save",
        requiresInput: true,
        riskLevel: "medium",
        preparable: true
      })
    ]);
    expect(actions[0]?.fields).toEqual([
      expect.objectContaining({
        name: "subject",
        portalId: "field-subject",
        label: "Subject",
        required: true,
        hidden: false,
        editable: true
      }),
      expect.objectContaining({
        name: "topic",
        portalId: "field-topic",
        label: "Topic",
        required: true,
        hidden: false,
        editable: true,
        value: "topic-fixture"
      }),
      expect.objectContaining({
        name: "recordMarker",
        portalId: "field-record",
        hidden: true,
        editable: false
      })
    ]);
  });

  it("maps portal login blockers to action_required results", () => {
    expect(classifyAuthFailure(492, "changepassword")).toMatchObject({
      state: "action_required",
      action: "password_change"
    });
    expect(classifyAuthFailure(493, "verification needed")).toMatchObject({
      state: "action_required",
      action: "verification"
    });
    expect(classifyAuthFailure(403, "<acceptterms>true</acceptterms>")).toMatchObject({
      state: "action_required",
      action: "accept_terms"
    });
  });
});
