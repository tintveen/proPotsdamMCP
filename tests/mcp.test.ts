import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp.js";
import { PortalClient } from "../src/portal/portal-client.js";
import type { WasteServiceLike } from "../src/waste/types.js";

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
      "propotsdam_commit_abandoned_waste_report",
      "propotsdam_commit_bulky_waste_pickup",
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
      "propotsdam_prepare_abandoned_waste_report",
      "propotsdam_prepare_bulky_waste_pickup",
      "propotsdam_request_abandoned_waste_report_commit",
      "propotsdam_request_bulky_waste_pickup_commit",
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
    expect(prepareWriteTool.inputSchema?.safeParse({ domain: "repair_report", attachmentFilePath: "/tmp/photo.jpg" }).success).toBe(true);
    expect(prepareWriteTool.inputSchema?.safeParse({ domain: "" }).success).toBe(false);

    const prepareTool = tools.propotsdam_prepare_portal_action!;
    expect(prepareTool.inputSchema?.safeParse({ id: "A-1", values: { description: "x" }, attachmentFilePath: "/tmp/photo.jpg" }).success).toBe(true);
    expect(prepareTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const requestCommitTool = tools.propotsdam_request_portal_action_commit!;
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "save_partner", values: { phone_ref: "x" } }).success).toBe(true);
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "cmdsend", recordId: "DMG-1", serviceId: "SRV-1", values: { msg_txt: "x" }, attachmentFilePath: "/tmp/photo.jpg" }).success).toBe(true);
    expect(requestCommitTool.inputSchema?.safeParse({ actionId: "" }).success).toBe(false);

    const commitTool = tools.propotsdam_commit_portal_action!;
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "confirmation-id" }).success).toBe(true);
    expect(commitTool.inputSchema?.safeParse({ confirmationId: "" }).success).toBe(false);

    const prepareBulkyWasteTool = tools.propotsdam_prepare_bulky_waste_pickup!;
    expect(prepareBulkyWasteTool.inputSchema?.safeParse({
      earliestPickupDate: "2026-08-20",
      items: [{ kind: "couch_sofa_bed", quantity: 1 }],
      contact: { salutation: "unspecified", email: "person@example.test" }
    }).success).toBe(true);
    expect(prepareBulkyWasteTool.inputSchema?.safeParse({
      earliestPickupDate: "20.08.2026",
      items: [{ kind: "not-supported", quantity: 1 }]
    }).success).toBe(false);

    const requestWasteReportTool = tools.propotsdam_request_abandoned_waste_report_commit!;
    expect(requestWasteReportTool.inputSchema?.safeParse({
      description: "Abgestelltes Bett neben den Mülltonnen.",
      photoPaths: ["/tmp/pile.jpg"],
      privacyConsent: true,
      location: { latitude: 52.4, longitude: 13.05 }
    }).success).toBe(true);
    expect(requestWasteReportTool.inputSchema?.safeParse({
      description: "x",
      photoPaths: [],
      privacyConsent: false
    }).success).toBe(false);

    expect(tools.propotsdam_commit_bulky_waste_pickup?.inputSchema?.safeParse({
      confirmationId: "11111111-1111-4111-8111-111111111111"
    }).success).toBe(true);
    expect(tools.propotsdam_commit_abandoned_waste_report?.inputSchema?.safeParse({ confirmationId: "" }).success).toBe(false);
  });

  it("delegates waste tools to the separately injected waste service", async () => {
    const wasteService: WasteServiceLike = {
      prepareBulkyWastePickup: vi.fn(async () => ({
        ok: true as const,
        preparedOnly: true as const,
        willSend: false as const,
        workflow: "bulky_waste_pickup" as const,
        fieldSources: {},
        missingFields: [],
        validationIssues: [],
        warnings: [],
        review: ["Bed pickup preview"],
        privacyUrls: []
      })),
      requestBulkyWastePickupCommit: vi.fn(),
      commitBulkyWastePickup: vi.fn(),
      prepareAbandonedWasteReport: vi.fn(),
      requestAbandonedWasteReportCommit: vi.fn(),
      commitAbandonedWasteReport: vi.fn(async (confirmationId) => ({
        ok: true as const,
        workflow: "abandoned_waste_report" as const,
        state: "awaiting_email_confirmation" as const,
        committedAt: "2026-08-15T10:00:00.000Z",
        status: 200,
        summary: `Committed ${confirmationId}`
      }))
    };
    const server = createServer(new PortalClient(), wasteService) as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }> }>;
    };

    const input = {
      earliestPickupDate: "2026-08-20",
      items: [{ kind: "couch_sofa_bed", quantity: 1 }]
    };
    const prepared = await server._registeredTools.propotsdam_prepare_bulky_waste_pickup!.handler(input);
    expect(wasteService.prepareBulkyWastePickup).toHaveBeenCalledWith(input);
    expect(prepared.structuredContent).toMatchObject({ ok: true, review: ["Bed pickup preview"] });

    const committed = await server._registeredTools.propotsdam_commit_abandoned_waste_report!.handler({ confirmationId: "confirmation-1" });
    expect(wasteService.commitAbandonedWasteReport).toHaveBeenCalledWith("confirmation-1");
    expect(committed.structuredContent).toMatchObject({ state: "awaiting_email_confirmation" });
  });
});
