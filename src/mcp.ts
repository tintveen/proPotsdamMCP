import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PortalError } from "./errors.js";
import { PendingWriteService, type PendingWriteServiceLike } from "./pending-write-service.js";
import { PortalClient } from "./portal/portal-client.js";
import { redactSecrets } from "./utils/redact.js";
import { PACKAGE_VERSION } from "./version.js";
import { WasteService } from "./waste/waste-service.js";
import type { WasteServiceLike } from "./waste/types.js";

const READ_DOMAIN_VALUES = [
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
  "document",
  "attachment",
  "unknown"
] as const;

const WRITE_DOMAIN_VALUES = [
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
] as const;

export function createServer(
  client = new PortalClient(),
  wasteService: WasteServiceLike = new WasteService(client),
  pendingWriteService: PendingWriteServiceLike = new PendingWriteService(client, wasteService)
): McpServer {
  const server = new McpServer({
    name: "proPotsdam MCP",
    version: PACKAGE_VERSION
  });

  registerJsonTool(server, "propotsdam_auth_status", {
    description: "Check whether a stored ProPotsdam portal session is authenticated."
  }, async () => client.status());

  registerJsonTool(server, "propotsdam_auth_login", {
    description: "Login to the ProPotsdam portal using credentials stored in the macOS Keychain."
  }, async () => client.login());

  registerJsonTool(server, "propotsdam_auth_logout", {
    description: "Delete local portal session cookies without deleting Keychain credentials."
  }, async () => client.logout());

  registerJsonTool(server, "propotsdam_discover_capabilities", {
    description: "Discover readable portal data exposed by the authenticated ProPotsdam account."
  }, async () => client.discoverCapabilities());

  registerJsonTool(server, "propotsdam_discover_write_actions", {
    description: "Discover ProPotsdam portal actions as prepare-only draftable metadata."
  }, async () => client.discoverWriteActions());

  registerJsonTool(server, "propotsdam_list_inbox", {
    description: "List ProPotsdam portal inbox messages."
  }, async () => client.listInbox());

  server.registerTool("propotsdam_get_inbox_item", withToolTitle("propotsdam_get_inbox_item", {
    description: "Read one ProPotsdam portal inbox item by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }), async ({ id }) => wrapTool(() => client.getInboxItem(id)));

  server.registerTool("propotsdam_list_portal_records", withToolTitle("propotsdam_list_portal_records", {
    description: "List readable ProPotsdam portal records by service id or xuclass.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional()
    }
  }), async (input) => wrapTool(() => client.listPortalRecords(input)));

  server.registerTool("propotsdam_get_portal_record", withToolTitle("propotsdam_get_portal_record", {
    description: "Read one ProPotsdam portal record by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }), async ({ id }) => wrapTool(() => client.getPortalRecord(id)));

  server.registerTool("propotsdam_list_portal_files", withToolTitle("propotsdam_list_portal_files", {
    description: "List ProPotsdam portal file resources and attachment-like records.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      mimeType: z.string().min(1).optional()
    }
  }), async (input) => wrapTool(() => client.listPortalFiles(input)));

  server.registerTool("propotsdam_export_portal_file", withToolTitle("propotsdam_export_portal_file", {
    description: "Export one ProPotsdam portal file resource to the local export directory and return metadata.",
    inputSchema: {
      id: z.string().min(1)
    }
  }), async ({ id }) => wrapTool(() => client.exportPortalFile(id)));

  server.registerTool("propotsdam_list_structured_portal_records", withToolTitle("propotsdam_list_structured_portal_records", {
    description: "List best-effort structured ProPotsdam portal read models across records.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      domain: z.enum(READ_DOMAIN_VALUES).optional()
    }
  }), async (input) => wrapTool(() => client.listStructuredPortalRecords(input)));

  server.registerTool("propotsdam_get_structured_portal_record", withToolTitle("propotsdam_get_structured_portal_record", {
    description: "Read one ProPotsdam portal record as a best-effort structured model.",
    inputSchema: {
      id: z.string().min(1)
    }
  }), async ({ id }) => wrapTool(() => client.getStructuredPortalRecord(id)));

  server.registerTool("propotsdam_list_portal_actions", withToolTitle("propotsdam_list_portal_actions", {
    description: "List ProPotsdam portal actions that can be inspected or prepared as local drafts.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      actionKind: z.enum(["form", "portal_action", "read_confirmation", "external_link", "navigation", "ambiguous"]).optional(),
      source: z.enum(["boxlist", "detail"]).optional(),
      recordId: z.string().min(1).optional()
    }
  }), async (input) => wrapTool(() => client.listPortalActions(input)));

  server.registerTool("propotsdam_get_portal_action", withToolTitle("propotsdam_get_portal_action", {
    description: "Read one ProPotsdam portal action model by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }), async ({ id }) => wrapTool(() => client.getPortalAction(id)));

  server.registerTool("propotsdam_list_portal_write_capabilities", withToolTitle("propotsdam_list_portal_write_capabilities", {
    description: "List ProPotsdam portal write capabilities and their draft-only or conversational-approval execution policy without sending portal changes.",
    inputSchema: {
      domain: z.enum(WRITE_DOMAIN_VALUES).optional(),
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional()
    }
  }), async (input) => wrapTool(() => client.listPortalWriteCapabilities(input)));

  server.registerTool("propotsdam_prepare_portal_write", withToolTitle("propotsdam_prepare_portal_write", {
    description: "Create a local draft for a ProPotsdam portal write domain without sending portal changes.",
    inputSchema: {
      domain: z.enum(WRITE_DOMAIN_VALUES),
      targetId: z.string().min(1).optional(),
      actionId: z.string().min(1).optional(),
      attachmentFilePath: z.string().min(1).optional(),
      values: z.record(z.string(), z.unknown()).optional()
    },
    annotations: readOnlyAnnotations
  }), async (input) => wrapTool(() => client.preparePortalWrite({
    ...input,
    values: mergeAttachmentFilePath(input.values, input.attachmentFilePath)
  })));

  server.registerTool("propotsdam_prepare_portal_action", withToolTitle("propotsdam_prepare_portal_action", {
    description: "Create a review-only local draft for a ProPotsdam portal action without sending it.",
    inputSchema: {
      id: z.string().min(1),
      attachmentFilePath: z.string().min(1).optional(),
      values: z.record(z.string(), z.unknown()).optional()
    },
    annotations: readOnlyAnnotations
  }), async ({ id, values, attachmentFilePath }) => wrapTool(() =>
    client.preparePortalAction(id, mergeAttachmentFilePath(values, attachmentFilePath))
  ));

  server.registerTool("propotsdam_stage_portal_action", withToolTitle("propotsdam_stage_portal_action", {
    description: "Stage an immutable pending portal write without changing ProPotsdam. Show the exact returned diff, stop, and wait for a new user message. Explicit instructions such as 'yes, send it' or 'ja, abschicken' can approve it. 'Okay', 'looks good', or an emoji is insufficient; 'yes, but change...' requires a newly staged and displayed draft.",
    inputSchema: {
      actionId: z.string().min(1),
      recordId: z.string().min(1).optional(),
      serviceId: z.string().min(1).optional(),
      attachmentFilePath: z.string().min(1).optional(),
      values: z.record(z.string(), z.unknown()).optional()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }), async ({ actionId, recordId, serviceId, values, attachmentFilePath }) => wrapTool(() =>
    client.stagePortalAction(actionId, mergeAttachmentFilePath(values, attachmentFilePath), { recordId, serviceId }),
    { hidePendingWriteHandles: true }
  ));

  registerJsonTool(server, "propotsdam_list_pending_writes", {
    description: "List every active ProPotsdam, STEP, and Potsdam pending action exactly once. Internal handles are structured data and must not be shown to users.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async () => pendingWriteService.listPendingWrites(), { hidePendingWriteHandles: true });

  server.registerTool("propotsdam_cancel_pending_writes", withToolTitle("propotsdam_cancel_pending_writes", {
    description: "Cancel selected pending actions locally and delete their staged artifacts without contacting ProPotsdam, STEP, or Potsdam.",
    inputSchema: {
      pendingWriteHandles: z.array(z.string().min(1)).min(1)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  }), async ({ pendingWriteHandles }) => wrapTool(
    () => pendingWriteService.cancelPendingWrites(pendingWriteHandles),
    { hidePendingWriteHandles: true }
  ));

  server.registerTool("propotsdam_commit_pending_writes", withToolTitle("propotsdam_commit_pending_writes", {
    description: "Perform one or more staged ProPotsdam, STEP, or Potsdam actions only after the user explicitly approved the exact displayed action, named subset, or entire displayed batch in a new natural-language message. The LLM is the approval trust boundary; this server cannot inspect the conversation. A UI control may only create a normal visible user-authored approval message and may never call this tool directly. Every supplied item runs sequentially and independently even after failure and must never be retried automatically after possible dispatch.",
    inputSchema: {
      pendingWriteHandles: z.array(z.string().min(1)).min(1)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }), async ({ pendingWriteHandles }) => wrapTool(
    () => pendingWriteService.commitPendingWrites(pendingWriteHandles),
    { hidePendingWriteHandles: true }
  ));

  server.registerTool("propotsdam_prepare_bulky_waste_pickup", withToolTitle("propotsdam_prepare_bulky_waste_pickup", {
    description: "Preview a STEP bulky-waste pickup request without creating a pickup request.",
    inputSchema: bulkyWasteInputSchema,
    annotations: readOnlyAnnotations
  }), async (input) => wrapTool(() => wasteService.prepareBulkyWastePickup(input)));

  server.registerTool("propotsdam_stage_bulky_waste_pickup", withToolTitle("propotsdam_stage_bulky_waste_pickup", {
    description: "Stage an immutable STEP bulky-waste pickup action without sending it. Show the complete returned review, stop, and wait for explicit approval in a new user message before using the generic commit tool.",
    inputSchema: bulkyWasteInputSchema,
    annotations: stageAnnotations
  }), async (input) => wrapTool(
    () => wasteService.stageBulkyWastePickup(input),
    { hidePendingWriteHandles: true }
  ));

  server.registerTool("propotsdam_prepare_abandoned_waste_report", withToolTitle("propotsdam_prepare_abandoned_waste_report", {
    description: "Preview a Potsdam abandoned-waste report without creating a city report.",
    inputSchema: abandonedWasteInputSchema,
    annotations: readOnlyAnnotations
  }), async (input) => wrapTool(() => wasteService.prepareAbandonedWasteReport(input)));

  server.registerTool("propotsdam_stage_abandoned_waste_report", withToolTitle("propotsdam_stage_abandoned_waste_report", {
    description: "Stage an immutable Potsdam abandoned-waste report without sending it. Prominently show that its location, description, and normalized photos may become public, then stop and wait for explicit approval in a new user message before using the generic commit tool.",
    inputSchema: abandonedWasteInputSchema,
    annotations: stageAnnotations
  }), async (input) => wrapTool(
    () => wasteService.stageAbandonedWasteReport(input),
    { hidePendingWriteHandles: true }
  ));

  return server;
}

const contactSchema = z.object({
  salutation: z.enum(["female", "male", "unspecified"]).optional(),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  email: z.email().optional(),
  phone: z.string().trim().min(1).optional(),
  street: z.string().trim().min(1).optional(),
  houseNumber: z.string().trim().min(1).optional(),
  postalCode: z.string().regex(/^\d{5}$/).optional(),
  city: z.string().trim().min(1).optional()
}).strict();

const addressSchema = z.object({
  street: z.string().trim().min(1),
  houseNumber: z.string().trim().min(1),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().trim().min(1)
}).strict();

const countedItemKinds = [
  "couch_sofa_bed",
  "mattress",
  "cabinet_sideboard_shelf",
  "armchair",
  "chair_stool",
  "table_table_tennis",
  "bicycle",
  "drying_rack",
  "refrigerator_freezer",
  "washer_dryer",
  "dishwasher",
  "cooker",
  "tv_monitor",
  "vacuum_cleaner"
] as const;

const describedItemKinds = [
  "other_bulky",
  "other_metal",
  "large_electrical_over_50cm",
  "other_small_electrical"
] as const;

const bulkyWasteItemSchema = z.union([
  z.object({
    kind: z.enum(countedItemKinds),
    quantity: z.number().int().positive()
  }).strict(),
  z.object({
    kind: z.literal("floor_covering"),
    squareMeters: z.number().positive()
  }).strict(),
  z.object({
    kind: z.enum(describedItemKinds),
    description: z.string().trim().min(1),
    quantity: z.number().int().positive()
  }).strict()
]);

const bulkyWasteInputSchema = {
  contractId: z.string().trim().min(1).optional(),
  contact: contactSchema.optional(),
  pickupAddress: addressSchema.optional(),
  earliestPickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(bulkyWasteItemSchema).min(1),
  placement: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
  allotmentReference: z.string().trim().min(1).optional()
};

const reportLocationSchema = z.union([
  z.object({
    address: z.string().trim().min(4)
  }).strict(),
  z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    label: z.string().trim().min(1).optional()
  }).strict()
]);

const abandonedWasteInputSchema = {
  contractId: z.string().trim().min(1).optional(),
  contact: contactSchema.optional(),
  location: reportLocationSchema.optional(),
  description: z.string().trim().min(1).max(500),
  photoPaths: z.array(z.string().trim().min(1)).min(1).max(3),
  privacyConsent: z.literal(true)
};

function mergeAttachmentFilePath(values: Record<string, unknown> | undefined, attachmentFilePath: string | undefined): Record<string, unknown> {
  return attachmentFilePath ? { ...(values ?? {}), attachmentFilePath } : values ?? {};
}

function registerJsonTool<T>(
  server: McpServer,
  name: string,
  config: { description: string; annotations?: ToolAnnotations },
  handler: () => Promise<T>,
  options: ToolResultOptions = {}
): void {
  server.registerTool(name, withToolTitle(name, config), async () => wrapTool(handler, options));
}

function withToolTitle<T extends { description: string }>(name: string, config: T): T & { title: string } {
  return {
    title: `proPotsdam ${name.replace(/^propotsdam_/, "").replaceAll("_", " ")}`,
    ...config
  };
}

interface ToolResultOptions {
  hidePendingWriteHandles?: boolean;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

const stageAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

async function wrapTool<T>(handler: () => Promise<T>, options: ToolResultOptions = {}) {
  try {
    return jsonToolResult(await handler(), options);
  } catch (error) {
    return toolErrorResult(error);
  }
}

function jsonToolResult(value: unknown, options: ToolResultOptions = {}) {
  const structuredContent = redactSecrets(value) as Record<string, unknown>;
  const humanContent = options.hidePendingWriteHandles
    ? omitPendingWriteHandles(structuredContent)
    : structuredContent;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(humanContent, null, 2)
      }
    ],
    structuredContent
  };
}

function omitPendingWriteHandles(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitPendingWriteHandles);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.toLowerCase().includes("handle"))
        .map(([key, entry]) => [key, omitPendingWriteHandles(entry)])
    );
  }
  return value;
}

export function toolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof PortalError ? error.code : "UNKNOWN";
  const details = error instanceof PortalError ? error.details : undefined;
  const structuredContent = redactSecrets({
    ok: false,
    code,
    message,
    ...(details?.outcomeUncertain ? { outcomeUncertain: true } : {}),
    ...(details?.warnings ? { warnings: details.warnings } : {})
  }) as {
    ok: false;
    code: string;
    message: string;
    outcomeUncertain?: boolean;
    warnings?: string[];
  };
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}
