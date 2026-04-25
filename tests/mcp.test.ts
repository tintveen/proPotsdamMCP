import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";

describe("MCP server", () => {
  it("registers the data-only ProPotsdam tool surface", () => {
    const server = createServer();
    const inspected = server as unknown as {
      _registeredTools: Record<string, { description?: string; inputSchema?: { safeParse: (value: unknown) => { success: boolean } } }>;
      server: { _serverInfo: { name: string } };
    };
    const tools = inspected._registeredTools;

    expect(inspected.server._serverInfo.name).toBe("ProPotsdam MCP");
    expect(Object.keys(tools).sort()).toEqual([
      "propotsdam_auth_login",
      "propotsdam_auth_logout",
      "propotsdam_auth_status",
      "propotsdam_commit_portal_action",
      "propotsdam_discover_capabilities",
      "propotsdam_discover_write_actions",
      "propotsdam_get_inbox_item",
      "propotsdam_get_portal_action",
      "propotsdam_get_portal_record",
      "propotsdam_list_inbox",
      "propotsdam_list_portal_actions",
      "propotsdam_prepare_portal_action",
      "propotsdam_request_portal_action_commit",
      "propotsdam_list_portal_records"
    ].sort());
    expect(Object.keys(tools).join(" ")).not.toMatch(/download|candidate|documents|submit/i);
    expect(Object.values(tools).map((tool) => tool.description ?? "").join(" ")).not.toMatch(/download|candidate|downloadable|safe download/i);

    const listRecordsTool = tools.propotsdam_list_portal_records!;
    expect(listRecordsTool).toBeDefined();
    expect(listRecordsTool.inputSchema?.safeParse({ xuclass: "ESQ_TENANT" }).success).toBe(true);
    expect(listRecordsTool.inputSchema?.safeParse({ serviceId: "" }).success).toBe(false);

    const listActionsTool = tools.propotsdam_list_portal_actions!;
    expect(listActionsTool.inputSchema?.safeParse({ actionKind: "form", source: "detail", recordId: "PROFILE-1" }).success).toBe(true);
    expect(listActionsTool.inputSchema?.safeParse({ actionKind: "definitely-not-real" }).success).toBe(false);

    const prepareTool = tools.propotsdam_prepare_portal_action!;
    expect(prepareTool.inputSchema?.safeParse({ id: "A-1", values: { description: "x" } }).success).toBe(true);
    expect(prepareTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const requestCommitTool = tools.propotsdam_request_portal_action_commit!;
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "save_partner", values: { phone_ref: "x" } }).success).toBe(true);
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "" }).success).toBe(false);

    const commitTool = tools.propotsdam_commit_portal_action!;
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "confirmation-id" }).success).toBe(true);
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "" }).success).toBe(false);
  });
});
