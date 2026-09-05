#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const expectedVersion = packageJson.version;
const scratch = await mkdtemp(join(tmpdir(), "propotsdam-package-verify-"));

try {
  const packDirectory = join(scratch, "pack");
  const publishDirectory = join(scratch, "release-artifacts");
  const installDirectory = join(scratch, "install");
  const dataDirectory = join(scratch, "data");
  await Promise.all([mkdir(packDirectory), mkdir(publishDirectory), mkdir(installDirectory), mkdir(dataDirectory)]);

  const packResult = await run("npm", ["pack", "--json", "--silent", "--pack-destination", packDirectory], {
    cwd: repositoryRoot
  });
  const records = JSON.parse(packResult.stdout);
  assert.equal(records.length, 1, "npm pack must produce exactly one archive");
  const record = records[0];
  assert.equal(record.name, "propotsdam-mcp");
  assert.equal(record.version, expectedVersion);
  assert.match(record.integrity, /^sha512-/);

  const packagedFiles = new Map(record.files.map((entry) => [entry.path, entry]));
  for (const requiredPath of [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "docs/security-check.md",
    "package.json",
    "dist/bin.js",
    "dist/cli.js"
  ]) {
    assert(packagedFiles.has(requiredPath), `package is missing required file: ${requiredPath}`);
  }

  const executable = packagedFiles.get("dist/bin.js");
  assert((executable.mode & 0o111) !== 0, "dist/bin.js must be executable in the package archive");

  const forbiddenPatterns = [
    /^(?:src|tests|\.github|node_modules|coverage|backlog)\//,
    /(?:^|\/)\.env(?:\.|$)/,
    /(?:^|\/)(?:config|session)\.json$/,
    /(?:^|\/)traces\//,
    /(?:^|\/)fixtures?\//
  ];
  for (const packagedPath of packagedFiles.keys()) {
    assert(
      forbiddenPatterns.every((pattern) => !pattern.test(packagedPath)),
      `forbidden path included in package: ${packagedPath}`
    );
  }

  const archivePath = join(packDirectory, record.filename);
  await copyFile(archivePath, join(publishDirectory, record.filename));
  // Exercise npm's local-file parsing without publishing or running lifecycle scripts.
  const publishDryRun = await run(
    "npm",
    ["publish", `./release-artifacts/${record.filename}`, "--dry-run", "--ignore-scripts", "--access", "public", "--json"],
    { cwd: scratch }
  );
  const dryRunRecord = JSON.parse(publishDryRun.stdout)[packageJson.name];
  assert.equal(dryRunRecord?.version, expectedVersion, "publish dry-run must select the packed version");
  assert.equal(dryRunRecord?.integrity, record.integrity, "publish dry-run must preserve archive integrity");

  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "propotsdam-package-smoke", private: true, type: "module" }, null, 2)}\n`
  );
  await run("npm", ["install", "--no-audit", "--no-fund", archivePath], { cwd: installDirectory });

  const installedPackageJsonPath = join(installDirectory, "node_modules", "propotsdam-mcp", "package.json");
  const installedPackage = JSON.parse(await readFile(installedPackageJsonPath, "utf8"));
  assert.equal(installedPackage.version, expectedVersion);
  assert.deepEqual(installedPackage.bin, {
    "propotsdam-mcp": "dist/bin.js",
    "propotsdam-cli": "dist/bin.js"
  });

  const mcpBinary = installedBinary(installDirectory, "propotsdam-mcp");
  const cliBinary = installedBinary(installDirectory, "propotsdam-cli");
  const mcpHelp = await run(mcpBinary, ["--help"], { cwd: installDirectory });
  const cliHelp = await run(cliBinary, ["--help"], { cwd: installDirectory });
  assert.match(mcpHelp.stdout, /propotsdam-mcp serve/);
  assert.match(cliHelp.stdout, /propotsdam-cli serve/);

  for (const binary of [mcpBinary, cliBinary]) {
    assert.equal((await run(binary, ["--version"], { cwd: installDirectory })).stdout, `${expectedVersion}\n`);
  }
  assert.equal((await run(mcpBinary, ["-v"], { cwd: installDirectory })).stdout, `${expectedVersion}\n`);

  const nativeProbe = [
    "const { createRequire } = require('node:module');",
    "const requireFromInstall = createRequire(process.argv[1]);",
    "const keytar = requireFromInstall('keytar');",
    "const sharp = requireFromInstall('sharp');",
    "if (typeof keytar.getPassword !== 'function') throw new Error('keytar did not load');",
    "if (typeof sharp !== 'function') throw new Error('sharp did not load');"
  ].join("");
  await run(process.execPath, ["-e", nativeProbe, join(installDirectory, "package.json")], {
    cwd: installDirectory
  });

  await verifyMcpHandshake(mcpBinary, installDirectory, dataDirectory);

  process.stdout.write(
    `Verified ${record.filename}: ${record.files.length} files, ${record.integrity}, publish dry-run, both binaries, native modules, and MCP handshake.\n`
  );
} finally {
  if (process.env.KEEP_PACKAGE_VERIFY_TEMP === "1") {
    process.stderr.write(`Package verification files kept at ${scratch}\n`);
  } else {
    await rm(scratch, { recursive: true, force: true });
  }
}

function installedBinary(installDirectory, name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(installDirectory, "node_modules", ".bin", `${name}${suffix}`);
}

async function verifyMcpHandshake(command, cwd, dataDirectory) {
  const env = {
    ...getDefaultEnvironment(),
    PROPPOTSDAM_DATA_DIR: dataDirectory
  };
  delete env.PROPPOTSDAM_USERNAME;
  delete env.PROPPOTSDAM_PASSWORD;
  delete env.PROPPOTSDAM_BASE_URL;

  const transport = new StdioClientTransport({ command, args: ["serve"], cwd, env, stderr: "pipe" });
  const client = new Client({ name: "propotsdam-package-verifier", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await withTimeout(client.connect(transport), 15_000, "MCP initialization");
    const result = await withTimeout(client.listTools(), 15_000, "MCP tools/list");
    const toolNames = new Set(result.tools.map((tool) => tool.name));
    assert(toolNames.has("propotsdam_auth_status"), "installed MCP server is missing propotsdam_auth_status");
    assert(
      toolNames.has("propotsdam_commit_pending_writes"),
      "installed MCP server is missing propotsdam_commit_pending_writes"
    );
  } catch (error) {
    if (stderr.trim()) {
      error.message = `${error.message}\nInstalled MCP stderr:\n${stderr.trim()}`;
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function withTimeout(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function run(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    const stdout = error.stdout?.trim();
    const stderr = error.stderr?.trim();
    const details = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
    error.message = `${error.message}${details ? `\n${details}` : ""}`;
    throw error;
  }
}
