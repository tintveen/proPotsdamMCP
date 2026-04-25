import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";

describe("MCP server", () => {
  it("registers the v1 ProPotsdam tool surface", () => {
    const server = createServer();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

    expect(Object.keys(tools).sort()).toEqual([
      "propotsdam_auth_login",
      "propotsdam_auth_logout",
      "propotsdam_auth_status",
      "propotsdam_discover_capabilities",
      "propotsdam_download_candidate",
      "propotsdam_download_document",
      "propotsdam_get_inbox_item",
      "propotsdam_get_portal_record",
      "propotsdam_list_download_candidates",
      "propotsdam_list_documents",
      "propotsdam_list_inbox",
      "propotsdam_list_portal_records"
    ].sort());
    const downloadTool = tools.propotsdam_download_document as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(downloadTool.inputSchema.safeParse({ id: "DOC-1" }).success).toBe(true);
    expect(downloadTool.inputSchema.safeParse({ id: "" }).success).toBe(false);

    const listRecordsTool = tools.propotsdam_list_portal_records as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(listRecordsTool.inputSchema.safeParse({ xuclass: "ESQ_TENANT" }).success).toBe(true);
    expect(listRecordsTool.inputSchema.safeParse({ serviceId: "" }).success).toBe(false);
  });
});
