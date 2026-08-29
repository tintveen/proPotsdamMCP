#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { deleteExpiredPendingWrites, ensureStorageDirs } from "./storage.js";

await ensureStorageDirs();
await deleteExpiredPendingWrites();
const server = createServer();
const transport = new StdioServerTransport();

await server.connect(transport);
