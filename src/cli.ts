#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { configureCredentials } from "./portal/portal-client.js";
import { loadConfig, paths } from "./storage.js";

const [, , command, subcommand] = process.argv;

if (!command || command === "serve") {
  const server = createServer();
  await server.connect(new StdioServerTransport());
} else if (command === "auth" && subcommand === "set") {
  await setCredentials();
} else if (command === "config" && subcommand === "show") {
  const config = await loadConfig();
  output.write(`${JSON.stringify({ ...config, dataDir: paths.dataDir }, null, 2)}\n`);
} else {
  output.write(help());
  process.exitCode = 1;
}

async function setCredentials(): Promise<void> {
  const rl = createInterface({ input, output });
  const current = await loadConfig();
  const username = (await rl.question(`Username${current.username ? ` [${current.username}]` : ""}: `)).trim() || current.username;
  if (!username) {
    rl.close();
    throw new Error("Username is required.");
  }
  const baseUrlInput = (await rl.question(`Base URL [${current.baseUrl}]: `)).trim();
  const password = await questionHidden("Password: ");
  rl.close();
  if (!password) {
    throw new Error("Password is required.");
  }

  await configureCredentials({
    username,
    password,
    baseUrl: baseUrlInput || current.baseUrl
  });
  output.write(`Credentials stored in macOS Keychain for ${username}.\n`);
}

async function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    output.write(prompt);
    let value = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          output.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          input.off("data", onData);
          input.setRawMode?.(wasRaw ?? false);
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

function help(): string {
  return `Usage:
  propotsdam-mcp serve
  propotsdam-mcp auth set
  propotsdam-mcp config show
`;
}
