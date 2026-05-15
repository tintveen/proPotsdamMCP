import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PortalError } from "./errors.js";
import { PortalClient } from "./portal/portal-client.js";
import { redactSecrets } from "./utils/redact.js";

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

export function createServer(client = new PortalClient()): McpServer {
  const server = new McpServer({
    name: "ProPotsdam MCP",
    version: "0.1.0"
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

  server.registerTool("propotsdam_get_inbox_item", {
    description: "Read one ProPotsdam portal inbox item by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.getInboxItem(id)));

  server.registerTool("propotsdam_list_portal_records", {
    description: "List readable ProPotsdam portal records by service id or xuclass.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional()
    }
  }, async (input) => wrapTool(() => client.listPortalRecords(input)));

  server.registerTool("propotsdam_get_portal_record", {
    description: "Read one ProPotsdam portal record by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.getPortalRecord(id)));

  server.registerTool("propotsdam_list_portal_files", {
    description: "List ProPotsdam portal file resources and attachment-like records.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      mimeType: z.string().min(1).optional()
    }
  }, async (input) => wrapTool(() => client.listPortalFiles(input)));

  server.registerTool("propotsdam_export_portal_file", {
    description: "Export one ProPotsdam portal file resource to the local export directory and return metadata.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.exportPortalFile(id)));

  server.registerTool("propotsdam_list_structured_portal_records", {
    description: "List best-effort structured ProPotsdam portal read models across records.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      domain: z.enum(READ_DOMAIN_VALUES).optional()
    }
  }, async (input) => wrapTool(() => client.listStructuredPortalRecords(input)));

  server.registerTool("propotsdam_get_structured_portal_record", {
    description: "Read one ProPotsdam portal record as a best-effort structured model.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.getStructuredPortalRecord(id)));

  server.registerTool("propotsdam_list_portal_actions", {
    description: "List ProPotsdam portal actions that can be inspected or prepared as local drafts.",
    inputSchema: {
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional(),
      actionKind: z.enum(["form", "portal_action", "read_confirmation", "external_link", "navigation", "ambiguous"]).optional(),
      source: z.enum(["boxlist", "detail"]).optional(),
      recordId: z.string().min(1).optional()
    }
  }, async (input) => wrapTool(() => client.listPortalActions(input)));

  server.registerTool("propotsdam_get_portal_action", {
    description: "Read one ProPotsdam portal action model by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.getPortalAction(id)));

  server.registerTool("propotsdam_list_portal_write_capabilities", {
    description: "List draft-only ProPotsdam portal write capabilities without sending portal changes.",
    inputSchema: {
      domain: z.enum(WRITE_DOMAIN_VALUES).optional(),
      serviceId: z.string().min(1).optional(),
      xuclass: z.string().min(1).optional()
    }
  }, async (input) => wrapTool(() => client.listPortalWriteCapabilities(input)));

  server.registerTool("propotsdam_prepare_portal_write", {
    description: "Create a local draft for a ProPotsdam portal write domain without sending portal changes.",
    inputSchema: {
      domain: z.enum(WRITE_DOMAIN_VALUES),
      targetId: z.string().min(1).optional(),
      actionId: z.string().min(1).optional(),
      values: z.record(z.string(), z.unknown()).optional()
    }
  }, async (input) => wrapTool(() => client.preparePortalWrite(input)));

  server.registerTool("propotsdam_prepare_portal_action", {
    description: "Create a review-only local draft for a ProPotsdam portal action without sending it.",
    inputSchema: {
      id: z.string().min(1),
      values: z.record(z.string(), z.unknown()).optional()
    }
  }, async ({ id, values }) => wrapTool(() => client.preparePortalAction(id, values ?? {})));

  server.registerTool("propotsdam_request_portal_action_commit", {
    description: "Create a short-lived confirmation for committing a supported ProPotsdam portal action.",
    inputSchema: {
      actionId: z.string().min(1),
      values: z.record(z.string(), z.unknown()).optional()
    }
  }, async ({ actionId, values }) => wrapTool(() => client.requestPortalActionCommit(actionId, values ?? {})));

  server.registerTool("propotsdam_commit_portal_action", {
    description: "Commit a previously confirmed ProPotsdam portal action by confirmation id.",
    inputSchema: {
      confirmationId: z.string().min(1)
    }
  }, async ({ confirmationId }) => wrapTool(() => client.commitPortalAction(confirmationId)));

  return server;
}

function registerJsonTool<T>(
  server: McpServer,
  name: string,
  config: { description: string },
  handler: () => Promise<T>
): void {
  server.registerTool(name, config, async () => wrapTool(handler));
}

async function wrapTool<T>(handler: () => Promise<T>) {
  try {
    return jsonToolResult(await handler());
  } catch (error) {
    return toolErrorResult(error);
  }
}

function jsonToolResult(value: unknown) {
  const structuredContent = redactSecrets(value) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

export function toolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof PortalError ? error.code : "UNKNOWN";
  const structuredContent = { ok: false, code, message };
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
