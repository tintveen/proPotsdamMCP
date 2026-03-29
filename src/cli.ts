#!/usr/bin/env node
import { Command } from "commander";
import { ZodError, z } from "zod";
import { AuthService } from "./auth/auth-service.js";
import { EXIT_CODES } from "./constants.js";
import { CliError } from "./errors.js";
import { PortalClient } from "./portal/portal-client.js";
import { printOutput } from "./utils/output.js";

const formatSchema = z.enum(["text", "json"]).default("text");
const secondsSchema = z.coerce.number().int().positive().max(600).default(30);

const authService = new AuthService();
const portalClient = new PortalClient();

const program = new Command();

program
  .name("propotsdam")
  .description("CLI for the ProPotsdam customer portal")
  .option("--json", "Render the result as JSON");

program
  .command("auth")
  .description("Authentication commands")
  .addCommand(
    new Command("login")
      .option("--base-url <url>", "Override the ProPotsdam portal base URL")
      .option("--timeout <seconds>", "Login timeout in seconds", "300")
      .action(async (options) => {
        const timeoutMs = z.coerce.number().int().positive().parse(options.timeout) * 1_000;
        const result = await authService.login(options.baseUrl, timeoutMs);
        printOutput(result, "text");
      })
  )
  .addCommand(
    new Command("status").action(async () => {
      const result = await authService.status();
      printOutput(result, getFormat(program.opts()));
      if (!result.valid) {
        process.exitCode = EXIT_CODES.AUTH_INVALID;
      }
    })
  )
  .addCommand(
    new Command("logout").action(async () => {
      await authService.logout();
      printOutput({ ok: true }, getFormat(program.opts()));
    })
  );

program
  .command("inbox")
  .description("Read portal inbox entries")
  .addCommand(
    new Command("list").action(async () => {
      const result = await portalClient.listInbox();
      printOutput(result.items, getFormat(program.opts()));
    })
  )
  .addCommand(
    new Command("get")
      .argument("<id>", "Inbox item ID")
      .action(async (id: string) => {
        const result = await portalClient.getInboxItem(id);
        printOutput(result, getFormat(program.opts()));
      })
  );

program
  .command("documents")
  .description("Read and download portal documents")
  .addCommand(
    new Command("list").action(async () => {
      const result = await portalClient.listDocuments();
      printOutput(result.items, getFormat(program.opts()));
    })
  )
  .addCommand(
    new Command("download")
      .argument("<id>", "Document ID")
      .requiredOption("--out <path>", "Output file path")
      .action(async (id: string, options) => {
        const savedPath = await portalClient.downloadDocument(id, options.out);
        printOutput({ ok: true, path: savedPath }, getFormat(program.opts()));
      })
  );

program.command("debug").description("Internal diagnostics").addCommand(
  new Command("trace")
    .option("--seconds <seconds>", "How long to record the browser session", "30")
    .action(async (options) => {
      const seconds = secondsSchema.parse(options.seconds);
      const traceFile = await portalClient.debugTrace(seconds);
      printOutput({ ok: true, traceFile }, getFormat(program.opts()));
    })
);

program.exitOverride();

run().catch((error: unknown) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }

  if (error instanceof ZodError) {
    process.stderr.write(`${error.issues[0]?.message ?? "Invalid input"}\n`);
    process.exit(EXIT_CODES.UNKNOWN);
  }

  if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") {
    process.exit(0);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_CODES.UNKNOWN);
});

async function run(): Promise<void> {
  await program.parseAsync(process.argv);
}

function getFormat(options: { json?: boolean }) {
  return formatSchema.parse(options.json ? "json" : "text");
}
