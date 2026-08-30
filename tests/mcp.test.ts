import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp.js";
import type { PendingWriteServiceLike } from "../src/pending-write-service.js";
import { PortalClient } from "../src/portal/portal-client.js";
import { PACKAGE_VERSION } from "../src/version.js";
import type { WasteServiceLike } from "../src/waste/types.js";

describe("MCP server", () => {
  it("registers the conversational pending-write tool surface", () => {
    const server = createServer();
    const inspected = server as unknown as {
      _registeredTools: Record<string, {
        title?: string;
        description?: string;
        inputSchema?: { safeParse: (value: unknown) => { success: boolean } };
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
      }>;
      server: { _serverInfo: { name: string; version: string } };
    };
    const tools = inspected._registeredTools;

    expect(inspected.server._serverInfo.name).toBe("proPotsdam MCP");
    expect(Object.keys(tools).sort()).toEqual([
      "propotsdam_auth_login",
      "propotsdam_auth_logout",
      "propotsdam_auth_status",
      "propotsdam_cancel_pending_writes",
      "propotsdam_commit_pending_writes",
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
      "propotsdam_list_pending_writes",
      "propotsdam_list_structured_portal_records",
      "propotsdam_prepare_abandoned_waste_report",
      "propotsdam_prepare_bulky_waste_pickup",
      "propotsdam_prepare_portal_action",
      "propotsdam_prepare_portal_write",
      "propotsdam_stage_abandoned_waste_report",
      "propotsdam_stage_bulky_waste_pickup",
      "propotsdam_stage_portal_action",
      "propotsdam_list_portal_records"
    ].sort());
    expect(tools.propotsdam_get_portal_record?.title).toBe("proPotsdam get portal record");
    expect(Object.values(tools).map((tool) => tool.title)).toEqual(
      expect.arrayContaining(["proPotsdam auth status", "proPotsdam list portal records"])
    );
    expect(Object.values(tools).every((tool) => tool.title?.startsWith("proPotsdam "))).toBe(true);
    expect(inspected.server._serverInfo.version).toBe(PACKAGE_VERSION);
    expect(tools.propotsdam_request_portal_action_commit).toBeUndefined();
    expect(tools.propotsdam_commit_portal_action).toBeUndefined();

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
    expect(prepareWriteTool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });

    const prepareTool = tools.propotsdam_prepare_portal_action!;
    expect(prepareTool.inputSchema?.safeParse({ id: "A-1", values: { description: "x" }, attachmentFilePath: "/tmp/photo.jpg" }).success).toBe(true);
    expect(prepareTool.inputSchema?.safeParse({ id: "" }).success).toBe(false);

    const stageTool = tools.propotsdam_stage_portal_action!;
    expect(stageTool.inputSchema?.safeParse({ actionId: "save_partner", values: { phone_ref: "x" } }).success).toBe(true);
    expect(stageTool.inputSchema?.safeParse({ actionId: "cmdsend", recordId: "DMG-1", serviceId: "SRV-1", values: { msg_txt: "x" }, attachmentFilePath: "/tmp/photo.jpg" }).success).toBe(true);
    expect(stageTool.inputSchema?.safeParse({ actionId: "" }).success).toBe(false);

    const listPendingTool = tools.propotsdam_list_pending_writes!;
    expect(listPendingTool).toBeDefined();

    const cancelTool = tools.propotsdam_cancel_pending_writes!;
    expect(cancelTool.inputSchema?.safeParse({ pendingWriteHandles: ["pending-1"] }).success).toBe(true);
    expect(cancelTool.inputSchema?.safeParse({ pendingWriteHandles: [] }).success).toBe(false);

    const commitTool = tools.propotsdam_commit_pending_writes!;
    expect(commitTool.inputSchema?.safeParse({ pendingWriteHandles: ["pending-1", "pending-2"] }).success).toBe(true);
    expect(commitTool.inputSchema?.safeParse({
      pendingWriteHandles: Array.from({ length: 100 }, (_, index) => `pending-${index + 1}`)
    }).success).toBe(true);
    expect(commitTool.inputSchema?.safeParse({ pendingWriteHandles: [] }).success).toBe(false);
    expect(commitTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    });

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

    const stageWasteReportTool = tools.propotsdam_stage_abandoned_waste_report!;
    expect(stageWasteReportTool.inputSchema?.safeParse({
      description: "Abgestelltes Bett neben den Mülltonnen.",
      photoPaths: ["/tmp/pile.jpg"],
      privacyConsent: true,
      location: { latitude: 52.4, longitude: 13.05 }
    }).success).toBe(true);
    expect(stageWasteReportTool.inputSchema?.safeParse({
      description: "x",
      photoPaths: [],
      privacyConsent: false
    }).success).toBe(false);

    expect(tools.propotsdam_request_bulky_waste_pickup_commit).toBeUndefined();
    expect(tools.propotsdam_commit_bulky_waste_pickup).toBeUndefined();
    expect(tools.propotsdam_request_abandoned_waste_report_commit).toBeUndefined();
    expect(tools.propotsdam_commit_abandoned_waste_report).toBeUndefined();
    expect(tools.propotsdam_stage_bulky_waste_pickup?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    expect(tools.propotsdam_cancel_pending_writes?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
  });

  it("delegates waste staging and generic commit to their injected services", async () => {
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
      stageBulkyWastePickup: vi.fn(async () => ({
        ok: true as const,
        workflow: "bulky_waste_pickup" as const,
        kind: "swp_bulky_waste" as const,
        pendingWriteHandle: "opaque-waste-1",
        createdAt: "2026-08-15T10:00:00.000Z",
        expiresAt: "2026-08-15T10:10:00.000Z",
        requiresExplicitApproval: true as const,
        validationIssues: [],
        warnings: [],
        review: ["Bed pickup review"],
        privacyUrls: []
      })),
      prepareAbandonedWasteReport: vi.fn(),
      stageAbandonedWasteReport: vi.fn(),
      commitPendingWrite: vi.fn()
    };
    const pendingWriteService: PendingWriteServiceLike = {
      listPendingWrites: vi.fn(),
      cancelPendingWrites: vi.fn(),
      commitPendingWrites: vi.fn(async (pendingWriteHandles) => ({
        ok: true,
        partial: false,
        attemptedCount: 1,
        counts: { succeeded: 1, notSent: 0, rejected: 0, outcomeUncertain: 0 },
        results: [{
          ok: true,
          outcome: "succeeded" as const,
          pendingWriteHandle: pendingWriteHandles[0]!,
          kind: "swp_bulky_waste" as const,
          workflow: "bulky_waste_pickup" as const,
          completedAt: "2026-08-15T10:01:00.000Z",
          summary: "STEP received the request.",
          state: "request_received" as const
        }]
      }))
    };
    const server = createServer(new PortalClient(), wasteService, pendingWriteService) as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{
        content?: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      }> }>;
    };

    const input = {
      earliestPickupDate: "2026-08-20",
      items: [{ kind: "couch_sofa_bed", quantity: 1 }]
    };
    const prepared = await server._registeredTools.propotsdam_prepare_bulky_waste_pickup!.handler(input);
    expect(wasteService.prepareBulkyWastePickup).toHaveBeenCalledWith(input);
    expect(prepared.structuredContent).toMatchObject({ ok: true, review: ["Bed pickup preview"] });

    const staged = await server._registeredTools.propotsdam_stage_bulky_waste_pickup!.handler(input);
    expect(wasteService.stageBulkyWastePickup).toHaveBeenCalledWith(input);
    expect(staged.structuredContent).toMatchObject({ pendingWriteHandle: "opaque-waste-1" });
    expect(staged.content?.[0]?.text).not.toContain("opaque-waste-1");
    expect(staged.content?.[0]?.text).not.toContain("pendingWriteHandle");

    const committed = await server._registeredTools.propotsdam_commit_pending_writes!.handler({
      pendingWriteHandles: ["opaque-waste-1"]
    });
    expect(pendingWriteService.commitPendingWrites).toHaveBeenCalledWith(["opaque-waste-1"]);
    expect(committed.structuredContent).toMatchObject({
      results: [{ state: "request_received" }]
    });
  });

  it("keeps pending-write handles in structured tool data but out of human text", async () => {
    const client = {
      stagePortalAction: async () => ({
        ok: true,
        actionId: "save_partner",
        actionTitle: "Speichern",
        pendingWriteHandle: "opaque-pending-1",
        expiresAt: "2026-08-28T12:10:00.000Z",
        requiresExplicitApproval: true,
        summary: "Staged.",
        validationIssues: [],
        diff: [{ name: "phone_ref", currentValue: "+491", proposedValue: "+492" }]
      })
    } as unknown as PortalClient;
    const server = createServer(client) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    };

    const result = await server._registeredTools.propotsdam_stage_portal_action!.handler({
      actionId: "save_partner",
      values: { phone_ref: "+492" }
    }, {}) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };

    expect(result.structuredContent.pendingWriteHandle).toBe("opaque-pending-1");
    expect(result.content[0]!.text).not.toContain("opaque-pending-1");
    expect(result.content[0]!.text).not.toContain("pendingWriteHandle");
    expect(result.content[0]!.text).toContain("phone_ref");
  });

  it("documents conservative English/German approval orchestration and the LLM trust boundary", () => {
    const server = createServer() as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    };
    const stageDescription = server._registeredTools.propotsdam_stage_portal_action!.description!;
    const stageWasteDescription = server._registeredTools.propotsdam_stage_bulky_waste_pickup!.description!;
    const stagePublicReportDescription = server._registeredTools.propotsdam_stage_abandoned_waste_report!.description!;
    const commitDescription = server._registeredTools.propotsdam_commit_pending_writes!.description!;

    expect(stageDescription).toMatch(/stop.*wait for a new user message/i);
    expect(stageDescription).toContain("yes, send it");
    expect(stageDescription).toContain("ja, abschicken");
    expect(stageDescription).toMatch(/Okay.*insufficient/i);
    expect(stageDescription).toMatch(/change.*newly staged/i);
    expect(stageWasteDescription).toMatch(/stop.*wait for explicit approval.*new user message/i);
    expect(stagePublicReportDescription).toMatch(/location, description, and normalized photos may become public/i);
    expect(commitDescription).toMatch(/named subset.*entire displayed batch/i);
    expect(commitDescription).toMatch(/LLM is the approval trust boundary/i);
    expect(commitDescription).toMatch(/cannot inspect the conversation/i);
    expect(commitDescription).toMatch(/UI control.*visible user-authored approval message.*never call this tool directly/i);
  });
});
