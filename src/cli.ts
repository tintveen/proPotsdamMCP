#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createInterface as createQuestionInterface } from "node:readline/promises";
import { createInterface as createHiddenInterface } from "node:readline";
import type { Interface as HiddenInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { configureCredentials, PortalClient } from "./portal/portal-client.js";
import { loadConfig, normalizeBaseUrl, paths } from "./storage.js";
import type { CapabilityMap, PortalConfig } from "./types.js";

export interface CliIo {
  write(text: string): void;
  question(prompt: string): Promise<string>;
  questionHidden(prompt: string): Promise<string>;
}

export interface CliPortalClient {
  discoverCapabilities(): Promise<CapabilityMap>;
}

export interface CliDeps {
  loadConfig(): Promise<PortalConfig>;
  configureCredentials(options: { username: string; password: string; baseUrl?: string }): Promise<void>;
  configFile: string;
}

export async function runCli(
  argv = process.argv,
  io = createDefaultIo(),
  client: CliPortalClient = new PortalClient(),
  deps: CliDeps = defaultDeps()
): Promise<number> {
  try {
    const [, , command, subcommand] = argv;

    if (!command || command === "serve") {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      return 0;
    }
    if (command === "auth" && subcommand === "set") {
      await setCredentials(argv, io, deps);
      return 0;
    }
    if (command === "config" && subcommand === "show") {
      const config = await deps.loadConfig();
      io.write(`${JSON.stringify({ ...config, dataDir: paths.dataDir }, null, 2)}\n`);
      return 0;
    }
    if (command === "discover") {
      const report = await client.discoverCapabilities();
      io.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    io.write(help());
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.write(`Error: ${message}\n`);
    return 1;
  }
}

async function setCredentials(argv: string[], io: CliIo, deps: CliDeps): Promise<void> {
  const current = await deps.loadConfig();
  const username = (await io.question(`Username${current.username ? ` [${current.username}]` : ""}: `)).trim() || current.username;
  if (!username) {
    throw new Error("Username is required.");
  }
  const baseUrl = normalizeBaseUrl(parseBaseUrl(argv) ?? current.baseUrl);
  const password = await io.questionHidden("Password: ");
  if (!password) {
    throw new Error("Password is required.");
  }

  await deps.configureCredentials({
    username,
    password,
    baseUrl
  });
  io.write(`Credentials stored in macOS Keychain for ${username}.\nConfig: ${deps.configFile}\n`);
}

function createDefaultIo(): CliIo {
  return {
    write: (text) => output.write(text),
    question: async (prompt) => {
      const rl = createQuestionInterface({ input, output });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    questionHidden: (prompt) => {
      const value = questionHidden(prompt);
      return value;
    }
  };
}

function defaultDeps(): CliDeps {
  return {
    loadConfig,
    configureCredentials,
    configFile: paths.configFile
  };
}

function parseBaseUrl(argv: string[]): string | undefined {
  const separateIndex = argv.indexOf("--base-url");
  if (separateIndex >= 0) {
    return argv[separateIndex + 1];
  }
  const inline = argv.find((arg) => arg.startsWith("--base-url="));
  return inline?.slice("--base-url=".length);
}

async function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createHiddenInterface({ input, output, terminal: true }) as HiddenInterface & {
      stdoutMuted?: boolean;
      _writeToOutput?: (text: string) => void;
    };
    rl.stdoutMuted = true;
    rl._writeToOutput = (text: string) => {
      if (!rl.stdoutMuted) {
        output.write(text);
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

function help(): string {
  return `Usage:
  propotsdam-mcp serve
  propotsdam-mcp auth set
  propotsdam-mcp discover --json
  propotsdam-mcp config show
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
