import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PortalError } from "./errors.js";
import { PortalClient } from "./portal/portal-client.js";
import { redactSecrets } from "./utils/redact.js";

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
