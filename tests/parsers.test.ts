import { describe, expect, it } from "vitest";
import {
  classifyAuthFailure,
  extractDocumentItems,
  extractInboxItems,
  extractServices,
  findSectionServices,
  parseSessionStatus
} from "../src/portal/parsers.js";

describe("portal parsers", () => {
  it("reads authenticated session details from services XML", () => {
    const status = parseSessionStatus(`
      <asx:abap><asx:values><SERVICE><HEAD>
        <LOGGED>X</LOGGED>
        <USER_ID>max@example.test</USER_ID>
        <USER_FULLNAME>Max Test</USER_FULLNAME>
      </HEAD></SERVICE></asx:values></asx:abap>
    `, "application/xml");

    expect(status).toMatchObject({
      state: "authenticated",
      authenticated: true,
      userId: "max@example.test",
      userFullName: "Max Test"
    });
  });

  it("finds inbox and document services by localized portal labels", () => {
    const services = extractServices(`
      <root>
        <service><title>Postfach</title><SERVICE>/msg</SERVICE><XUCLASS>MSG</XUCLASS></service>
        <service><title>Dokumente</title><SERVICE>/docs</SERVICE><XUCLASS>DOC</XUCLASS></service>
      </root>
    `, "application/xml");

    expect(findSectionServices(services, "inbox")).toHaveLength(1);
    expect(findSectionServices(services, "documents")).toHaveLength(1);
  });

  it("normalizes inbox and document boxlist XML", () => {
    const inbox = extractInboxItems(`
      <boxlist><box unread="true"><id>MSG-1</id><title>Wartung</title><subtitle>ProPotsdam</subtitle></box></boxlist>
    `, "application/xml");
    const documents = extractDocumentItems(JSON.stringify({
      documents: [{ id: "DOC-1", title: "Mietbescheinigung.pdf", resourceId: "res-1" }]
    }), "application/json");

    expect(inbox[0]).toMatchObject({ id: "MSG-1", subject: "Wartung", unread: true });
    expect(documents[0]).toMatchObject({
      id: "DOC-1",
      title: "Mietbescheinigung.pdf",
      resourceId: "res-1"
    });
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
