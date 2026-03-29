import { describe, expect, it } from "vitest";
import { extractSectionItemsFromTrace } from "../src/portal/response-parsers.js";
import type { TraceRecord } from "../src/types.js";

describe("response parsers", () => {
  it("extracts inbox items from xml traces", () => {
    const trace: TraceRecord = {
      timestamp: "2026-03-29T18:00:00.000Z",
      url: "https://example.test/api/inbox",
      method: "GET",
      status: 200,
      resourceType: "xhr",
      contentType: "application/xml",
      bodyText: `<?xml version="1.0" encoding="utf-8"?>
<items>
  <head unread="true" replied="false">
    <id>MSG-1</id>
    <title>Wartungshinweis</title>
    <subtitle>ProPotsdam</subtitle>
    <abstract>Der Aufzug wird geprüft.</abstract>
    <date>29.03.2026</date>
    <category>Hinweis</category>
  </head>
</items>`
    };

    const items = extractSectionItemsFromTrace("inbox", trace);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "MSG-1",
      subject: "Wartungshinweis",
      sender: "ProPotsdam",
      unread: true
    });
  });

  it("extracts document items from json traces", () => {
    const trace: TraceRecord = {
      timestamp: "2026-03-29T18:00:00.000Z",
      url: "https://example.test/api/documents",
      method: "GET",
      status: 200,
      resourceType: "fetch",
      contentType: "application/json",
      bodyText: JSON.stringify({
        documents: [
          {
            id: "DOC-9",
            title: "Mietbescheinigung.pdf",
            date: "28.03.2026",
            category: "Bescheinigung",
            resourceId: "abc123"
          }
        ]
      })
    };

    const items = extractSectionItemsFromTrace("documents", trace);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "DOC-9",
      title: "Mietbescheinigung.pdf",
      downloadable: true
    });
  });
});
