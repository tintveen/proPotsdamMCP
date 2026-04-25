import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PortalError } from "./errors.js";
import { PortalClient } from "./portal/portal-client.js";
import { redactSecrets } from "./utils/redact.js";

export function createServer(client = new PortalClient()): McpServer {
  const server = new McpServer({
    name: "propotsdam-mcp",
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

  registerJsonTool(server, "propotsdam_list_inbox", {
    description: "List ProPotsdam portal inbox messages."
  }, async () => client.listInbox());

  server.registerTool("propotsdam_get_inbox_item", {
    description: "Read one ProPotsdam portal inbox item by id.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.getInboxItem(id)));

  registerJsonTool(server, "propotsdam_list_documents", {
    description: "List ProPotsdam portal documents."
  }, async () => client.listDocuments());

  server.registerTool("propotsdam_download_document", {
    description: "Download one ProPotsdam portal document by id into the configured local safe folder.",
    inputSchema: {
      id: z.string().min(1)
    }
  }, async ({ id }) => wrapTool(() => client.downloadDocument(id)));

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
