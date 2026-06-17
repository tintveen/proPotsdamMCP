#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { stdin as input, stderr as errorOutput, stdout as output } from "node:process";
import { createInterface as createHiddenInterface } from "node:readline";
import type { Interface as HiddenInterface } from "node:readline";
import { createInterface as createQuestionInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PortalError } from "./errors.js";
import { createDoctorReport } from "./diagnostics.js";
import type { DoctorReport } from "./diagnostics.js";
import { createServer } from "./mcp.js";
import { configureCredentials, PortalClient } from "./portal/portal-client.js";
import { loadConfig, normalizeBaseUrl, paths } from "./storage.js";
import type {
  AuthResult,
  CapabilityMap,
  InboxItem,
  ListResult,
  PortalAction,
  PortalActionCommitRequest,
  PortalActionKind,
  PortalActionMap,
  PortalCommitResult,
  PortalConfig,
  PortalFileExportResult,
  PortalFileItem,
  PortalReadDomain,
  PortalRecordItem,
  PortalWriteCapability,
  PortalWriteDomain,
  PreparedPortalAction,
  PreparedPortalWrite,
  StructuredPortalRecord
} from "./types.js";
import { redactSecrets } from "./utils/redact.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);

export interface CliIo {
  write(text: string): void;
  question(prompt: string): Promise<string>;
  questionHidden(prompt: string): Promise<string>;
  error?(text: string): void;
  isTty?: boolean;
}

export interface CliPortalClient {
  status?(): Promise<AuthResult>;
  login?(): Promise<AuthResult>;
  logout?(): Promise<{ ok: true }>;
  discoverCapabilities?(): Promise<CapabilityMap>;
  discoverWriteActions?(): Promise<PortalActionMap>;
  listInbox?(): Promise<ListResult<InboxItem>>;
  getInboxItem?(id: string): Promise<InboxItem>;
  listStructuredPortalRecords?(filter?: {
    serviceId?: string;
    xuclass?: string;
    domain?: PortalReadDomain;
  }): Promise<ListResult<StructuredPortalRecord>>;
  getStructuredPortalRecord?(id: string): Promise<StructuredPortalRecord>;
  listPortalRecords?(filter?: { serviceId?: string; xuclass?: string }): Promise<ListResult<PortalRecordItem>>;
  getPortalRecord?(id: string): Promise<PortalRecordItem>;
  listPortalFiles?(filter?: { serviceId?: string; xuclass?: string; mimeType?: string }): Promise<ListResult<PortalFileItem>>;
  exportPortalFile?(id: string, options?: { outputDir?: string }): Promise<PortalFileExportResult>;
  listPortalActions?(filter?: {
    serviceId?: string;
    xuclass?: string;
    actionKind?: PortalActionKind;
    source?: PortalAction["source"];
    recordId?: string;
  }): Promise<ListResult<PortalAction>>;
  getPortalAction?(id: string): Promise<PortalAction>;
  listPortalWriteCapabilities?(filter?: {
    domain?: PortalWriteDomain;
    serviceId?: string;
    xuclass?: string;
  }): Promise<ListResult<PortalWriteCapability>>;
  preparePortalWrite?(input: {
    domain: PortalWriteDomain;
    values?: Record<string, unknown>;
    targetId?: string;
    actionId?: string;
  }): Promise<PreparedPortalWrite>;
  preparePortalAction?(id: string, values?: Record<string, unknown>): Promise<PreparedPortalAction>;
  requestPortalActionCommit?(
    actionId: string,
    values?: Record<string, unknown>,
    options?: { recordId?: string; serviceId?: string }
  ): Promise<PortalActionCommitRequest>;
  commitPortalAction?(confirmationId: string): Promise<PortalCommitResult>;
}

export interface CliDeps {
  loadConfig(): Promise<PortalConfig>;
  configureCredentials(options: { username: string; password: string; baseUrl?: string }): Promise<void>;
  configFile: string;
  createDoctorReport?: () => Promise<DoctorReport>;
}

interface ParsedArgs {
  binary: string;
  positionals: string[];
  flags: Map<string, string[]>;
  json: boolean;
  help: boolean;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export async function runCli(
  argv = process.argv,
  io = createDefaultIo(),
  client: CliPortalClient = new PortalClient(),
  deps: CliDeps = defaultDeps()
): Promise<number> {
  const parsed = parseArgs(argv);
  try {
    if (parsed.help || parsed.positionals[0] === "help") {
      writeOutput(io, helpFor(parsed));
      return 0;
    }
    if (parsed.positionals.length === 0) {
      writeOutput(io, topLevelHelp(parsed.binary));
      return 0;
    }

    const command = normalizeGroup(parsed.positionals[0]!);
    switch (command) {
      case "serve":
        await createServer().connect(new StdioServerTransport());
        return 0;
      case "auth":
        await handleAuth(parsed, io, client, deps);
        return 0;
      case "config":
        await handleConfig(parsed, io, deps);
        return 0;
      case "doctor":
        await printValue(parsed, io, await (deps.createDoctorReport ?? createDoctorReport)(), "Doctor");
        return 0;
      case "discover":
        await printValue(parsed, io, await requireClientMethod(client.discoverCapabilities, "discover").call(client), "Capabilities");
        return 0;
      case "inbox":
        await handleInbox(parsed, io, client);
        return 0;
      case "records":
        await handleRecords(parsed, io, client);
        return 0;
      case "files":
        await handleFiles(parsed, io, client);
        return 0;
      case "actions":
        await handleActions(parsed, io, client);
        return 0;
      case "writes":
        await handleWrites(parsed, io, client);
        return 0;
      default:
        throw new CliUsageError(`Unknown command '${parsed.positionals[0]}'. Run '${parsed.binary} --help'.`);
    }
  } catch (error) {
    writeError(parsed, io, error);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

function createDefaultIo(): CliIo {
  return {
    write: (text) => output.write(text),
    error: (text) => errorOutput.write(text),
    question: async (prompt) => {
      const rl = createQuestionInterface({ input, output });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    questionHidden: (prompt) => questionHidden(prompt),
    isTty: Boolean(input.isTTY)
  };
}

function defaultDeps(): CliDeps {
  return {
    loadConfig,
    configureCredentials,
    configFile: paths.configFile,
    createDoctorReport
  };
}

async function handleAuth(parsed: ParsedArgs, io: CliIo, client: CliPortalClient, deps: CliDeps): Promise<void> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new CliUsageError(authHelp(parsed.binary));
  }
  if (subcommand === "set") {
    await setCredentials(parsed, io, deps);
    return;
  }
  if (subcommand === "status") {
    await printValue(parsed, io, await requireClientMethod(client.status, "auth status").call(client), "Auth Status");
    return;
  }
  if (subcommand === "login") {
    await printValue(parsed, io, await requireClientMethod(client.login, "auth login").call(client), "Auth Login");
    return;
  }
  if (subcommand === "logout") {
    await printValue(parsed, io, await requireClientMethod(client.logout, "auth logout").call(client), "Auth Logout");
    return;
  }
  throw new CliUsageError(`Unknown auth command '${subcommand}'.\n\n${authHelp(parsed.binary)}`);
}

async function handleConfig(parsed: ParsedArgs, io: CliIo, deps: CliDeps): Promise<void> {
  if (parsed.positionals[1] !== "show") {
    throw new CliUsageError(configHelp(parsed.binary));
  }
  const config = await deps.loadConfig();
  await printValue(parsed, io, { ...config, dataDir: paths.dataDir }, "Config");
}

async function handleInbox(parsed: ParsedArgs, io: CliIo, client: CliPortalClient): Promise<void> {
  const subcommand = parsed.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await requireClientMethod(client.listInbox, "inbox list").call(client);
    await printList(parsed, io, filterList(result, parsed), "Inbox", inboxColumns);
    return;
  }
  if (subcommand === "get" || subcommand === "show") {
    const id = parsed.positionals[2] ?? await chooseListItem(
      parsed,
      io,
      filterList(await requireClientMethod(client.listInbox, "inbox get").call(client), parsed).items,
      "inbox item",
      itemSummary
    );
    const item = await requireClientMethod(client.getInboxItem, "inbox get").call(client, id);
    await printValue(parsed, io, item, "Inbox Item");
    return;
  }
  throw new CliUsageError(`Unknown inbox command '${subcommand}'.\n\n${inboxHelp(parsed.binary)}`);
}

async function handleRecords(parsed: ParsedArgs, io: CliIo, client: CliPortalClient): Promise<void> {
  let subcommand = parsed.positionals[1] ?? "list";
  let raw = false;
  let idIndex = 2;
  if (subcommand === "raw") {
    raw = true;
    subcommand = parsed.positionals[2] ?? "list";
    idIndex = 3;
  }

  if (subcommand === "list") {
    if (raw) {
      const result = await requireClientMethod(client.listPortalRecords, "records raw list").call(client, recordFilter(parsed));
      await printList(parsed, io, filterList(result, parsed), "Raw Portal Records", rawRecordColumns);
      return;
    }
    const result = await requireClientMethod(client.listStructuredPortalRecords, "records list").call(client, structuredRecordFilter(parsed));
    await printList(parsed, io, filterList(result, parsed), "Records", structuredRecordColumns);
    return;
  }

  if (subcommand === "get" || subcommand === "show") {
    if (raw) {
      const id = parsed.positionals[idIndex] ?? await chooseListItem(
        parsed,
        io,
        filterList(await requireClientMethod(client.listPortalRecords, "records raw get").call(client, recordFilter(parsed)), parsed).items,
        "raw portal record",
        itemSummary
      );
      const item = await requireClientMethod(client.getPortalRecord, "records raw get").call(client, id);
      await printValue(parsed, io, item, "Raw Portal Record");
      return;
    }
    const id = parsed.positionals[idIndex] ?? await chooseListItem(
      parsed,
      io,
      filterList(await requireClientMethod(client.listStructuredPortalRecords, "records get").call(client, structuredRecordFilter(parsed)), parsed).items,
      "record",
      itemSummary
    );
    const item = await requireClientMethod(client.getStructuredPortalRecord, "records get").call(client, id);
    await printValue(parsed, io, item, "Record");
    return;
  }

  throw new CliUsageError(`Unknown records command '${subcommand}'.\n\n${recordsHelp(parsed.binary)}`);
}

async function handleFiles(parsed: ParsedArgs, io: CliIo, client: CliPortalClient): Promise<void> {
  const subcommand = parsed.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await requireClientMethod(client.listPortalFiles, "files list").call(client, fileFilter(parsed));
    await printList(parsed, io, filterList(result, parsed), "Files", fileColumns);
    return;
  }
  if (subcommand === "export") {
    const id = parsed.positionals[2] ?? await chooseListItem(
      parsed,
      io,
      filterList(await requireClientMethod(client.listPortalFiles, "files export").call(client, fileFilter(parsed)), parsed).items,
      "file",
      fileSummary
    );
    const exported = await requireClientMethod(client.exportPortalFile, "files export").call(client, id, {
      outputDir: getFlag(parsed, "output-dir")
    });
    await printValue(parsed, io, exported, "File Export");
    return;
  }
  throw new CliUsageError(`Unknown files command '${subcommand}'.\n\n${filesHelp(parsed.binary)}`);
}

async function handleActions(parsed: ParsedArgs, io: CliIo, client: CliPortalClient): Promise<void> {
  const subcommand = parsed.positionals[1] ?? "discover";
  if (subcommand === "discover") {
    const report = await requireClientMethod(client.discoverWriteActions, "actions discover").call(client);
    await printValue(parsed, io, report, "Action Discovery");
    return;
  }
  if (subcommand === "list") {
    const result = await requireClientMethod(client.listPortalActions, "actions list").call(client, actionFilter(parsed));
    await printList(parsed, io, filterList(result, parsed), "Actions", actionColumns);
    return;
  }
  if (subcommand === "show" || subcommand === "get") {
    const id = parsed.positionals[2] ?? await chooseListItem(
      parsed,
      io,
      filterList(await requireClientMethod(client.listPortalActions, "actions show").call(client, actionFilter(parsed)), parsed).items,
      "action",
      actionSummary
    );
    const action = await requireClientMethod(client.getPortalAction, "actions show").call(client, id);
    await printValue(parsed, io, action, "Action");
    return;
  }
  if (subcommand === "prepare" || subcommand === "request-commit") {
    const id = parsed.positionals[2] ?? await chooseListItem(
      parsed,
      io,
      filterList(await requireClientMethod(client.listPortalActions, `actions ${subcommand}`).call(client, actionFilter(parsed)), parsed).items,
      "action",
      actionSummary
    );
    const action = await requireClientMethod(client.getPortalAction, `actions ${subcommand}`).call(client, id);
    const values = await collectActionValues(parsed, io, action);
    if (subcommand === "prepare") {
      await printValue(
        parsed,
        io,
        await requireClientMethod(client.preparePortalAction, "actions prepare").call(client, id, values),
        "Prepared Action"
      );
      return;
    }
    await printValue(
      parsed,
      io,
      await requireClientMethod(client.requestPortalActionCommit, "actions request-commit").call(client, id, values, commitTarget(parsed)),
      "Action Commit Request"
    );
    return;
  }
  if (subcommand === "commit") {
    const confirmationId = parsed.positionals[2];
    if (!confirmationId) {
      throw new CliUsageError("Missing confirmation id. Usage: actions commit <confirmation-id>");
    }
    await printValue(
      parsed,
      io,
      await requireClientMethod(client.commitPortalAction, "actions commit").call(client, confirmationId),
      "Action Commit"
    );
    return;
  }
  throw new CliUsageError(`Unknown actions command '${subcommand}'.\n\n${actionsHelp(parsed.binary)}`);
}

async function handleWrites(parsed: ParsedArgs, io: CliIo, client: CliPortalClient): Promise<void> {
  const subcommand = parsed.positionals[1] ?? "list";
  if (subcommand === "list") {
    const result = await requireClientMethod(client.listPortalWriteCapabilities, "writes list").call(client, writeFilter(parsed));
    await printList(parsed, io, filterList(result, parsed), "Writes", writeColumns);
    return;
  }
  if (subcommand === "prepare") {
    const result = filterList(
      await requireClientMethod(client.listPortalWriteCapabilities, "writes prepare").call(client, writeFilter(parsed)),
      parsed
    );
    const capability = parsed.positionals[2]
      ? result.items.find((item) => item.domain === parsed.positionals[2] || item.actionId === parsed.positionals[2])
      : await chooseCapability(parsed, io, result.items);
    if (!capability) {
      throw new CliUsageError(`Write domain '${parsed.positionals[2]}' was not found.`);
    }
    const values = await collectWriteValues(parsed, io, client, capability);
    await printValue(
      parsed,
      io,
      await requireClientMethod(client.preparePortalWrite, "writes prepare").call(client, {
        domain: capability.domain,
        values,
        targetId: getFlag(parsed, "target-id"),
        actionId: getFlag(parsed, "action-id") ?? capability.actionId
      }),
      "Prepared Write"
    );
    return;
  }
  throw new CliUsageError(`Unknown writes command '${subcommand}'.\n\n${writesHelp(parsed.binary)}`);
}

async function setCredentials(parsed: ParsedArgs, io: CliIo, deps: CliDeps): Promise<void> {
  const current = await deps.loadConfig();
  const username = (await io.question(`Username${current.username ? ` [${current.username}]` : ""}: `)).trim() || current.username;
  if (!username) {
    throw new CliUsageError("Username is required.");
  }
  const baseUrl = normalizeBaseUrl(getFlag(parsed, "base-url") ?? current.baseUrl);
  const password = await io.questionHidden("Password: ");
  if (!password) {
    throw new CliUsageError("Password is required.");
  }

  await deps.configureCredentials({
    username,
    password,
    baseUrl
  });
  writeOutput(io, `Credentials stored in macOS Keychain for ${username}.\nConfig: ${deps.configFile}\n`);
}

async function collectActionValues(parsed: ParsedArgs, io: CliIo, action: PortalAction): Promise<Record<string, unknown>> {
  const values = await readValues(parsed);
  if (!io.isTty) {
    return values;
  }
  for (const field of action.fields) {
    if (!field.required || field.hidden || !field.editable || isSensitiveName(field.name) || values[field.name] !== undefined) {
      continue;
    }
    const answer = await io.question(`${fieldPrompt(field)}: `);
    if (answer !== "") {
      values[field.name] = answer;
    }
  }
  const optionalFields = action.fields.filter((field) =>
    !field.required &&
    !field.hidden &&
    field.editable &&
    !isSensitiveName(field.name) &&
    values[field.name] === undefined
  );
  if (optionalFields.length > 0 && TRUE_VALUES.has((await io.question("Review optional editable fields? [y/N]: ")).trim().toLowerCase())) {
    for (const field of optionalFields) {
      const current = field.value ? ` [${field.value}]` : "";
      const answer = await io.question(`${fieldPrompt(field)}${current}: `);
      if (answer !== "") {
        values[field.name] = answer;
      }
    }
  }
  return values;
}

function fieldPrompt(field: PortalAction["fields"][number]): string {
  const label = field.label ?? field.name;
  if (!field.options?.length) {
    return label;
  }
  const options = field.options
    .map((option) => option.label && option.label !== option.value ? `${option.value}=${option.label}` : option.value)
    .join(", ");
  return `${label} (${options})`;
}

async function collectWriteValues(
  parsed: ParsedArgs,
  io: CliIo,
  client: CliPortalClient,
  capability: PortalWriteCapability
): Promise<Record<string, unknown>> {
  const values = await readValues(parsed);
  if (!io.isTty) {
    return values;
  }
  if (capability.actionId && client.getPortalAction) {
    const action = await client.getPortalAction(capability.actionId);
    return collectActionValues(parsed, io, {
      ...action,
      fields: action.fields.map((field) => ({
        ...field,
        required: field.required || capability.requiredFields.includes(field.name)
      }))
    });
  }
  for (const field of capability.requiredFields) {
    if (values[field] !== undefined || isSensitiveName(field)) {
      continue;
    }
    const answer = await io.question(`${field}: `);
    if (answer !== "") {
      values[field] = answer;
    }
  }
  return values;
}

async function chooseCapability(
  parsed: ParsedArgs,
  io: CliIo,
  items: PortalWriteCapability[]
): Promise<PortalWriteCapability | undefined> {
  const selected = await chooseListItem(
    parsed,
    io,
    items,
    "write capability",
    (item) => `${item.domain}${item.actionId ? ` / ${item.actionId}` : ""} - ${item.title}`,
    (item) => item.actionId ?? item.domain
  );
  return items.find((item) => item.domain === selected || item.actionId === selected);
}

async function chooseListItem<T extends { id?: string; title?: string }>(
  parsed: ParsedArgs,
  io: CliIo,
  items: T[],
  label: string,
  summary: (item: T) => string,
  selectValue: (item: T) => string | undefined = (item) => item.id
): Promise<string> {
  if (!io.isTty) {
    throw new CliUsageError(`Missing ${label} id.`);
  }
  if (items.length === 0) {
    throw new PortalError(`No ${label}s were found.`, "NOT_FOUND", 404);
  }
  writeOutput(io, `Select ${label}:\n`);
  items.forEach((item, index) => {
    writeOutput(io, `  ${index + 1}. ${summary(item)}\n`);
  });
  const answer = (await io.question("> ")).trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= items.length) {
    const selected = items[index - 1];
    const value = selected ? selectValue(selected) : undefined;
    if (value) {
      return value;
    }
  }
  if (answer) {
    return answer;
  }
  throw new CliUsageError(`Missing ${label} id.`);
}

async function readValues(parsed: ParsedArgs): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const file of getFlags(parsed, "values-file")) {
    Object.assign(values, parseValuesObject(JSON.parse(await readFile(file, "utf8")), `--values-file ${file}`));
  }
  for (const raw of getFlags(parsed, "values-json")) {
    Object.assign(values, parseValuesObject(JSON.parse(raw), "--values-json"));
  }
  for (const raw of getFlags(parsed, "value")) {
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex <= 0) {
      throw new CliUsageError(`Invalid --value '${raw}'. Expected key=value.`);
    }
    values[raw.slice(0, equalsIndex)] = raw.slice(equalsIndex + 1);
  }
  const attachmentFilePath = getFlag(parsed, "attachment-file");
  if (attachmentFilePath) {
    values.attachmentFilePath = attachmentFilePath;
  }
  return values;
}

function parseValuesObject(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${source} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function printValue(parsed: ParsedArgs, io: CliIo, value: unknown, title: string): Promise<void> {
  if (parsed.json) {
    writeOutput(io, `${JSON.stringify(redactForCli(value), null, 2)}\n`);
    return;
  }
  writeOutput(io, `${title}\n${formatDetails(redactForCli(value))}`);
}

async function printList<T>(
  parsed: ParsedArgs,
  io: CliIo,
  result: ListResult<T>,
  title: string,
  columns: Array<{ key: string; label: string; value: (item: T) => unknown }>
): Promise<void> {
  if (parsed.json) {
    writeOutput(io, `${JSON.stringify(redactForCli(result), null, 2)}\n`);
    return;
  }
  writeOutput(io, `${title} (${result.items.length})\n`);
  writeOutput(io, result.items.length === 0 ? "No items found.\n" : formatTable(result.items, columns));
}

function filterList<T>(result: ListResult<T>, parsed: ParsedArgs): ListResult<T> {
  const search = getFlag(parsed, "search")?.toLowerCase();
  const limit = parseLimit(parsed);
  const searched = search
    ? result.items.filter((item) => JSON.stringify(redactForCli(item)).toLowerCase().includes(search))
    : result.items;
  return {
    ...result,
    items: limit === undefined ? searched : searched.slice(0, limit)
  };
}

function parseLimit(parsed: ParsedArgs): number | undefined {
  const raw = getFlag(parsed, "limit");
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliUsageError("--limit must be a non-negative integer.");
  }
  return value;
}

function recordFilter(parsed: ParsedArgs): { serviceId?: string; xuclass?: string } {
  return {
    serviceId: getFlag(parsed, "service-id"),
    xuclass: getFlag(parsed, "xuclass")
  };
}

function structuredRecordFilter(parsed: ParsedArgs): { serviceId?: string; xuclass?: string; domain?: PortalReadDomain } {
  return {
    ...recordFilter(parsed),
    domain: getFlag(parsed, "domain") as PortalReadDomain | undefined
  };
}

function fileFilter(parsed: ParsedArgs): { serviceId?: string; xuclass?: string; mimeType?: string } {
  return {
    ...recordFilter(parsed),
    mimeType: getFlag(parsed, "mime-type")
  };
}

function actionFilter(parsed: ParsedArgs): {
  serviceId?: string;
  xuclass?: string;
  actionKind?: PortalActionKind;
  source?: PortalAction["source"];
  recordId?: string;
} {
  return {
    ...recordFilter(parsed),
    actionKind: getFlag(parsed, "kind") as PortalActionKind | undefined,
    source: getFlag(parsed, "source") as PortalAction["source"] | undefined,
    recordId: getFlag(parsed, "record-id")
  };
}

function commitTarget(parsed: ParsedArgs): { recordId?: string; serviceId?: string } {
  return {
    recordId: getFlag(parsed, "record-id"),
    serviceId: getFlag(parsed, "service-id")
  };
}

function writeFilter(parsed: ParsedArgs): { domain?: PortalWriteDomain; serviceId?: string; xuclass?: string } {
  return {
    ...recordFilter(parsed),
    domain: getFlag(parsed, "domain") as PortalWriteDomain | undefined
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const binary = basename(argv[1] ?? "propotsdam-cli");
  const args = argv.slice(2);
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-h") {
      addFlag(flags, "help", "true");
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equalsIndex = body.indexOf("=");
      if (equalsIndex >= 0) {
        addFlag(flags, body.slice(0, equalsIndex), body.slice(equalsIndex + 1));
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        addFlag(flags, body, next);
        index += 1;
      } else {
        addFlag(flags, body, "true");
      }
      continue;
    }
    positionals.push(arg);
  }
  return {
    binary,
    positionals,
    flags,
    json: hasFlag(flags, "json"),
    help: hasFlag(flags, "help")
  };
}

function addFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const normalized = name.trim();
  flags.set(normalized, [...(flags.get(normalized) ?? []), value]);
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.flags.get(name);
  return values?.[values.length - 1];
}

function getFlags(parsed: ParsedArgs, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

function hasFlag(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function normalizeGroup(input: string): string {
  if (input === "posteingang") {
    return "inbox";
  }
  if (input === "dateien") {
    return "files";
  }
  if (input === "aktionen") {
    return "actions";
  }
  return input;
}

function requireClientMethod<T extends (...args: any[]) => Promise<unknown>>(method: T | undefined, command: string): T {
  if (!method) {
    throw new Error(`Client method for '${command}' is unavailable.`);
  }
  return method;
}

function writeOutput(io: CliIo, text: string): void {
  io.write(text);
}

function writeError(parsed: ParsedArgs, io: CliIo, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (parsed.json) {
    const code = error instanceof PortalError ? error.code : error instanceof CliUsageError ? "USAGE" : "UNKNOWN";
    const payload = redactForCli({ ok: false, code, message });
    (io.error ?? io.write)(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  (io.error ?? io.write)(message.startsWith("Usage:") || message.includes("\n") ? `${message}\n` : `Error: ${message}\n`);
}

function formatTable<T>(
  items: T[],
  columns: Array<{ key: string; label: string; value: (item: T) => unknown }>
): string {
  const rows = items.map((item) => columns.map((column) => truncate(formatCell(column.value(item)), 42)));
  const headers = columns.map((column) => column.label);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  const renderRow = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return `${renderRow(headers)}\n${renderRow(widths.map((width) => "-".repeat(width)))}\n${rows.map(renderRow).join("\n")}\n`;
}

function formatDetails(value: unknown, indent = ""): string {
  if (!value || typeof value !== "object") {
    return `${indent}${formatCell(value)}\n`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}[]\n`;
    }
    return value.map((entry) => `${indent}- ${formatInline(entry)}\n`).join("");
  }
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (entry && typeof entry === "object") {
      lines.push(`${indent}${key}:\n${formatDetails(entry, `${indent}  `)}`);
    } else {
      lines.push(`${indent}${key}: ${formatCell(entry)}\n`);
    }
  }
  return lines.join("");
}

function formatInline(value: unknown): string {
  if (!value || typeof value !== "object") {
    return formatCell(value);
  }
  return JSON.stringify(value);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (Array.isArray(value)) {
    return value.map(formatCell).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isSensitiveName(name: string): boolean {
  return /password|cookie|csrf|token|sap-ffield|secret/i.test(name);
}

function redactForCli(value: unknown): unknown {
  return redactSecrets(redactNamedSensitiveFields(value));
}

function redactNamedSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactNamedSensitiveFields(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const object = value as Record<string, unknown>;
  const sensitiveFieldName = [object.name, object.portalId, object.label]
    .filter((entry): entry is string => typeof entry === "string")
    .some(isSensitiveName);
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (sensitiveFieldName && /value|currentValue|proposedValue/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactNamedSensitiveFields(entry);
    }
  }
  return redacted;
}

function itemSummary(item: { id?: string; title?: string; date?: string; serviceTitle?: string }): string {
  return [item.id, item.date, item.serviceTitle, item.title].filter(Boolean).join(" | ");
}

function fileSummary(item: PortalFileItem): string {
  return [item.id, item.filename, item.serviceTitle, item.mimeType].filter(Boolean).join(" | ");
}

function actionSummary(item: PortalAction): string {
  return [item.id, item.actionKind, item.serviceTitle, item.title].filter(Boolean).join(" | ");
}

const inboxColumns = [
  { key: "id", label: "ID", value: (item: InboxItem) => item.id },
  { key: "date", label: "Date", value: (item: InboxItem) => item.date },
  { key: "unread", label: "Unread", value: (item: InboxItem) => item.unread },
  { key: "sender", label: "Sender", value: (item: InboxItem) => item.sender },
  { key: "subject", label: "Subject", value: (item: InboxItem) => item.subject ?? item.title }
];

const structuredRecordColumns = [
  { key: "id", label: "ID", value: (item: StructuredPortalRecord) => item.id },
  { key: "domain", label: "Domain", value: (item: StructuredPortalRecord) => item.domain },
  { key: "date", label: "Date", value: (item: StructuredPortalRecord) => item.date ?? item.period },
  { key: "status", label: "Status", value: (item: StructuredPortalRecord) => item.status ?? item.amount },
  { key: "title", label: "Title", value: (item: StructuredPortalRecord) => item.title }
];

const rawRecordColumns = [
  { key: "id", label: "ID", value: (item: PortalRecordItem) => item.id },
  { key: "service", label: "Service", value: (item: PortalRecordItem) => item.serviceTitle },
  { key: "kind", label: "Kind", value: (item: PortalRecordItem) => item.itemKind },
  { key: "date", label: "Date", value: (item: PortalRecordItem) => item.date },
  { key: "title", label: "Title", value: (item: PortalRecordItem) => item.title }
];

const fileColumns = [
  { key: "id", label: "ID", value: (item: PortalFileItem) => item.id },
  { key: "filename", label: "Filename", value: (item: PortalFileItem) => item.filename },
  { key: "service", label: "Service", value: (item: PortalFileItem) => item.serviceTitle },
  { key: "mime", label: "MIME", value: (item: PortalFileItem) => item.mimeType },
  { key: "exportable", label: "Export", value: (item: PortalFileItem) => item.exportable }
];

const actionColumns = [
  { key: "id", label: "ID", value: (item: PortalAction) => item.id },
  { key: "kind", label: "Kind", value: (item: PortalAction) => item.actionKind },
  { key: "risk", label: "Risk", value: (item: PortalAction) => item.riskLevel },
  { key: "prep", label: "Prep", value: (item: PortalAction) => item.preparable },
  { key: "title", label: "Title", value: (item: PortalAction) => item.title }
];

const writeColumns = [
  { key: "domain", label: "Domain", value: (item: PortalWriteCapability) => item.domain },
  { key: "source", label: "Source", value: (item: PortalWriteCapability) => item.source },
  { key: "action", label: "Action", value: (item: PortalWriteCapability) => item.actionId },
  { key: "target", label: "Target", value: (item: PortalWriteCapability) => item.targetRequired },
  { key: "title", label: "Title", value: (item: PortalWriteCapability) => item.title }
];

function helpFor(parsed: ParsedArgs): string {
  const group = parsed.positionals[1] ?? parsed.positionals[0];
  switch (normalizeGroup(group ?? "")) {
    case "auth":
      return authHelp(parsed.binary);
    case "config":
      return configHelp(parsed.binary);
    case "inbox":
      return inboxHelp(parsed.binary);
    case "records":
      return recordsHelp(parsed.binary);
    case "files":
      return filesHelp(parsed.binary);
    case "actions":
      return actionsHelp(parsed.binary);
    case "writes":
      return writesHelp(parsed.binary);
    default:
      return topLevelHelp(parsed.binary);
  }
}

function topLevelHelp(binary: string): string {
  return `Usage:
  ${binary} serve
  ${binary} auth <set|status|login|logout>
  ${binary} doctor
  ${binary} config show
  ${binary} discover [--json]
  ${binary} inbox <list|get> [options]
  ${binary} records <list|get|raw> [options]
  ${binary} files <list|export> [options]
  ${binary} actions <discover|list|show|prepare|request-commit|commit> [options]
  ${binary} writes <list|prepare> [options]

Aliases:
  posteingang -> inbox
  dateien     -> files
  aktionen    -> actions

Global options:
  --json       Print redacted machine-readable JSON.
  --search     Filter list results client-side.
  --limit      Limit displayed list results.
`;
}

function authHelp(binary: string): string {
  return `Usage:
  ${binary} auth set [--base-url <url>]
  ${binary} auth status [--json]
  ${binary} auth login [--json]
  ${binary} auth logout [--json]
`;
}

function configHelp(binary: string): string {
  return `Usage:
  ${binary} config show [--json]
`;
}

function inboxHelp(binary: string): string {
  return `Usage:
  ${binary} inbox list [--search <text>] [--limit <n>] [--json]
  ${binary} inbox get [id] [--json]

Alias: ${binary} posteingang ...
`;
}

function recordsHelp(binary: string): string {
  return `Usage:
  ${binary} records list [--domain <domain>] [--service-id <id>] [--xuclass <class>] [--search <text>] [--json]
  ${binary} records get [id] [--domain <domain>] [--json]
  ${binary} records raw list [--service-id <id>] [--xuclass <class>] [--json]
  ${binary} records raw get [id] [--json]
`;
}

function filesHelp(binary: string): string {
  return `Usage:
  ${binary} files list [--service-id <id>] [--xuclass <class>] [--mime-type <type>] [--search <text>] [--json]
  ${binary} files export [id] [--output-dir <path>] [--json]

Alias: ${binary} dateien ...
`;
}

function actionsHelp(binary: string): string {
  return `Usage:
  ${binary} actions discover [--json]
  ${binary} actions list [--kind <kind>] [--source <boxlist|detail>] [--record-id <id>] [--json]
  ${binary} actions show [id] [--json]
  ${binary} actions prepare [id] [--attachment-file <path>] [--value key=value] [--values-json <json>] [--values-file <path>] [--json]
  ${binary} actions request-commit [id] [--record-id <id>] [--service-id <id>] [--attachment-file <path>] [--value key=value] [--values-json <json>] [--values-file <path>] [--json]
  ${binary} actions commit <confirmation-id> [--json]

Alias: ${binary} aktionen ...
`;
}

function writesHelp(binary: string): string {
  return `Usage:
  ${binary} writes list [--domain <domain>] [--service-id <id>] [--xuclass <class>] [--json]
  ${binary} writes prepare [domain] [--target-id <id>] [--action-id <id>] [--attachment-file <path>] [--value key=value] [--values-json <json>] [--values-file <path>] [--json]
`;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
