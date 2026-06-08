import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.js";

describe("MCP server", () => {
  it("registers the data-only ProPotsdam tool surface", () => {
    const server = createServer();
    const inspected = server as unknown as {
      _registeredTools: Record<string, { title?: string; description?: string; inputSchema?: { safeParse: (value: unknown) => { success: boolean } } }>;
      server: { _serverInfo: { name: string } };
    };
    const tools = inspected._registeredTools;

    expect(inspected.server._serverInfo.name).toBe("proPotsdam MCP");
    expect(Object.keys(tools).sort()).toEqual([
      "propotsdam_auth_login",
      "propotsdam_auth_logout",
      "propotsdam_auth_status",
      "propotsdam_commit_portal_action",
      "propotsdam_discover_capabilities",
      "propotsdam_discover_write_actions",
      "propotsdam_export_portal_file",
      "propotsdam_get_inbox_item",
      "propotsdam_get_portal_action",
      "propotsdam_get_portal_record",
      "propotsdam_get_structured_portal_record",
      "propotsdam_list_inbox",
      "propotsdam_list_portal_files",
      "propotsdam_list_portal_actions",
      "propotsdam_list_portal_write_capabilities",
      "propotsdam_list_structured_portal_records",
      "propotsdam_prepare_portal_action",
      "propotsdam_prepare_portal_write",
      "propotsdam_request_portal_action_commit",
      "propotsdam_list_portal_records"
    ].sort());
    expect(tools.propotsdam_get_portal_record?.title).toBe("proPotsdam get portal record");
    expect(Object.values(tools).map((tool) => tool.title)).toEqual(
      expect.arrayContaining(["proPotsdam auth status", "proPotsdam list portal records"])
    );
    expect(Object.values(tools).every((tool) => tool.title?.startsWith("proPotsdam "))).toBe(true);
    expect(Object.keys(tools).join(" ")).not.toMatch(/submit|reply|acknowledge/i);
    expect(Object.values(tools).map((tool) => tool.description ?? "").join(" ")).not.toMatch(/submit|reply|acknowledge/i);

    const listRecordsTool = tools.propotsdam_list_portal_records!;
    expect(listRecordsTool).toBeDefined();
    expect(listRecordsTool.inputSchema?.safeParse({ xuclass: "ESQ_TENANT" }).success).toBe(true);
    expect(listRecordsTool.inputSchema?.safeParse({ serviceId: "" }).success).toBe(false);

    const listFilesTool = tools.propotsdam_list_portal_files!;
    expect(listFilesTool.inputSchema?.safeParse({ xuclass: "ESQ_TENANT", mimeType: "application/pdf" }).success).toBe(true);
    expect(listFilesTool.inputSchema?.safeParse({ serviceId: "" }).success).toBe(false);

    const exportFileTool = tools.propotsdam_export_portal_file!;
    expect(exportFileTool.inputSchema?.safeParse({ id: "DOC-1" }).success).toBe(true);
    expect(exportFileTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const listStructuredTool = tools.propotsdam_list_structured_portal_records!;
    expect(listStructuredTool.inputSchema?.safeParse({ domain: "repair_status", xuclass: "ESQ_TENA_DMG" }).success).toBe(true);
    expect(listStructuredTool.inputSchema?.safeParse({ domain: "not-real" }).success).toBe(false);

    const getStructuredTool = tools.propotsdam_get_structured_portal_record!;
    expect(getStructuredTool.inputSchema?.safeParse({ id: "REC-1" }).success).toBe(true);
    expect(getStructuredTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const listActionsTool = tools.propotsdam_list_portal_actions!;
    expect(listActionsTool.inputSchema?.safeParse({ actionKind: "form", source: "detail", recordId: "PROFILE-1" }).success).toBe(true);
    expect(listActionsTool.inputSchema?.safeParse({ actionKind: "definitely-not-real" }).success).toBe(false);

    const listWritesTool = tools.propotsdam_list_portal_write_capabilities!;
    expect(listWritesTool.inputSchema?.safeParse({ domain: "repair_report", xuclass: "ESQ_TENA_DMG" }).success).toBe(true);
    expect(listWritesTool.inputSchema?.safeParse({ domain: "definitely-not-real" }).success).toBe(false);

    const prepareWriteTool = tools.propotsdam_prepare_portal_write!;
    expect(prepareWriteTool.inputSchema?.safeParse({ domain: "password_change", values: { currentPassword: "x", newPassword: "y" } }).success).toBe(true);
    expect(prepareWriteTool.inputSchema?.safeParse({ domain: "" }).success).toBe(false);

    const prepareTool = tools.propotsdam_prepare_portal_action!;
    expect(prepareTool.inputSchema?.safeParse({ id: "A-1", values: { description: "x" } }).success).toBe(true);
    expect(prepareTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const requestCommitTool = tools.propotsdam_request_portal_action_commit!;
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "save_partner", values: { phone_ref: "x" } }).success).toBe(true);
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "cmdsend", recordId: "DMG-1", serviceId: "SRV-1", values: { msg_txt: "x" } }).success).toBe(true);
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "" }).success).toBe(false);

    const commitTool = tools.propotsdam_commit_portal_action!;
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "confirmation-id" }).success).toBe(true);
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "" }).success).toBe(false);
  });
});
