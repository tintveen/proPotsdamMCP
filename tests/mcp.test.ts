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
      "propotsdam_download_document",
      "propotsdam_get_inbox_item",
      "propotsdam_list_documents",
      "propotsdam_list_inbox"
    ].sort());
    const downloadTool = tools.propotsdam_download_document as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(downloadTool.inputSchema.safeParse({ id: "DOC-1" }).success).toBe(true);
    expect(downloadTool.inputSchema.safeParse({ id: "" }).success).toBe(false);
  });
});
