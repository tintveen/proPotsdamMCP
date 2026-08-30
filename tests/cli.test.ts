import { describe, expect, it, vi } from "vitest";
import type { CliIo, CliPortalClient } from "../src/cli.js";
import type {
  AuthResult,
  CapabilityMap,
  InboxItem,
  PortalAction,
  PortalActionMap,
  PortalFileItem,
  PortalRecordItem,
  PortalWriteCapability,
  StructuredPortalRecord
} from "../src/types.js";

describe("CLI", () => {
  it("prints help with no args for both published binaries", async () => {
    const { runCli } = await import("../src/cli.js");

    for (const binary of ["propotsdam-mcp", "propotsdam-cli"]) {
      const harness = createIo();
      const exitCode = await runCli(["node", binary], harness.io, minimalClient());

      expect(exitCode).toBe(0);
      expect(harness.stdout()).toContain(`${binary} serve`);
      expect(harness.stdout()).toContain(`${binary} inbox <list|get>`);
      expect(harness.stdout()).toContain("posteingang -> inbox");
    }
  });

  it("prints the package version for both global version flags", async () => {
    const { runCli } = await import("../src/cli.js");

    for (const binary of ["propotsdam-mcp", "propotsdam-cli"]) {
      for (const flag of ["--version", "-v"]) {
        const harness = createIo();
        const exitCode = await runCli(["node", binary, flag], harness.io, minimalClient());

        expect(exitCode).toBe(0);
        expect(harness.stdout()).toBe("0.3.0\n");
      }
    }
  });

  it("prints nested help for German aliases", async () => {
    const { runCli } = await import("../src/cli.js");
    const harness = createIo();

    const exitCode = await runCli(["node", "propotsdam-cli", "dateien", "--help"], harness.io, minimalClient());

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toContain("files export");
    expect(harness.stdout()).toContain("Alias: propotsdam-cli dateien");
  });

  it("prints auth JSON only when --json is requested", async () => {
    const { runCli } = await import("../src/cli.js");
    const result: AuthResult = {
      state: "authenticated",
      authenticated: true,
      userId: "user-id"
    };

    const human = createIo();
    const json = createIo();
    const client = minimalClient({
      status: async () => result
    });

    expect(await runCli(["node", "propotsdam-cli", "auth", "status"], human.io, client)).toBe(0);
    expect(human.stdout()).toContain("Auth Status");
    expect(human.stdout()).toContain("authenticated: yes");

    expect(await runCli(["node", "propotsdam-cli", "auth", "status", "--json"], json.io, client)).toBe(0);
    expect(JSON.parse(json.stdout())).toEqual(result);
  });

  it("preserves discover and bare actions as legacy aliases", async () => {
    const { runCli } = await import("../src/cli.js");
    const capabilities: CapabilityMap = {
      generatedAt: "2026-05-15T00:00:00.000Z",
      authenticated: true,
      dataPolicy: "Readable portal data.",
      services: [],
      totals: {
        serviceCount: 0,
        inboxItems: 0,
        portalRecords: 0,
        unknownItems: 0
      },
      artifactPath: "/tmp/capabilities.json"
    };
    const actionMap: PortalActionMap = {
      generatedAt: "2026-05-15T00:00:00.000Z",
      authenticated: true,
      actionPolicy: "Prepare-only.",
      services: [],
      actions: [],
      partial: false,
      detailScanLimit: 250,
      totals: {
        serviceCount: 0,
        actionCount: 0,
        preparableActions: 0,
        skippedActions: 0
      },
      artifactPath: "/tmp/actions.json"
    };
    const client = minimalClient({
      discoverCapabilities: async () => capabilities,
      discoverWriteActions: async () => actionMap
    });
    const discover = createIo();
    const actions = createIo();

    await runCli(["node", "propotsdam-cli", "discover", "--json"], discover.io, client);
    await runCli(["node", "propotsdam-cli", "actions", "--json"], actions.io, client);

    expect(JSON.parse(discover.stdout())).toMatchObject({ artifactPath: "/tmp/capabilities.json" });
    expect(JSON.parse(actions.stdout())).toMatchObject({ artifactPath: "/tmp/actions.json" });
  });

  it("lists structured records by default and returns the client envelope in JSON mode", async () => {
    const { runCli } = await import("../src/cli.js");
    const calls: string[] = [];
    const client = minimalClient({
      listStructuredPortalRecords: async (filter) => {
        calls.push(JSON.stringify(filter));
        return {
          source: "boxlist",
          items: [
            structuredRecord({
              id: "DMG-1",
              title: "Heizung",
              domain: "repair_status",
              status: "in Bearbeitung"
            })
          ]
        };
      }
    });
    const human = createIo();
    const json = createIo();

    await runCli(["node", "propotsdam-cli", "records", "list", "--domain", "repair_status"], human.io, client);
    await runCli(["node", "propotsdam-cli", "records", "list", "--json"], json.io, client);

    expect(human.stdout()).toContain("Records (1)");
    expect(human.stdout()).toContain("DMG-1");
    expect(human.stdout()).toContain("repair_status");
    expect(JSON.parse(json.stdout())).toMatchObject({
      source: "boxlist",
      items: [{ id: "DMG-1" }]
    });
    expect(calls[0]).toContain("repair_status");
  });

  it("lists raw records under records raw", async () => {
    const { runCli } = await import("../src/cli.js");
    const harness = createIo();

    await runCli(
      ["node", "propotsdam-cli", "records", "raw", "list", "--xuclass", "ESQ_TENANT"],
      harness.io,
      minimalClient({
        listPortalRecords: async (filter) => ({
          source: "boxlist",
          items: [
            rawRecord({
              id: "TEN-1",
              title: "Mietvertrag",
              xuclass: filter?.xuclass
            })
          ]
        })
      })
    );

    expect(harness.stdout()).toContain("Raw Portal Records (1)");
    expect(harness.stdout()).toContain("TEN-1");
  });

  it("exports files with an output-dir override", async () => {
    const { runCli } = await import("../src/cli.js");
    const exportCalls: unknown[] = [];
    const harness = createIo();

    await runCli(
      ["node", "propotsdam-cli", "files", "export", "FILE-1", "--output-dir", "/tmp/exports", "--json"],
      harness.io,
      minimalClient({
        listPortalFiles: async () => ({
          source: "boxlist",
          items: [portalFile({ id: "FILE-1", filename: "vertrag.pdf" })]
        }),
        exportPortalFile: async (id, options) => {
          exportCalls.push({ id, options });
          return {
            ok: true,
            id,
            sourceRecordId: "REC-1",
            sourceRecordTitle: "Vertrag",
            filename: "vertrag.pdf",
            path: "/tmp/exports/REC-1-vertrag.pdf",
            mimeType: "application/pdf",
            byteLength: 10,
            sha256: "a".repeat(64),
            exportedAt: "2026-05-15T00:00:00.000Z"
          };
        }
      })
    );

    expect(exportCalls).toEqual([{ id: "FILE-1", options: { outputDir: "/tmp/exports" } }]);
    expect(JSON.parse(harness.stdout())).toMatchObject({ path: "/tmp/exports/REC-1-vertrag.pdf" });
  });

  it("fails without prompting when a non-TTY command is missing an id", async () => {
    const { runCli } = await import("../src/cli.js");
    const harness = createIo();

    const exitCode = await runCli(
      ["node", "propotsdam-cli", "files", "export"],
      harness.io,
      minimalClient({
        listPortalFiles: async () => ({
          source: "boxlist",
          items: [portalFile({ id: "FILE-1" })]
        })
      })
    );

    expect(exitCode).toBe(2);
    expect(harness.stderr()).toContain("Missing file id");
    expect(harness.prompts).toEqual([]);
  });

  it("uses a TTY picker and required-field form for action prepare", async () => {
    const { runCli } = await import("../src/cli.js");
    const action = portalAction({
      id: "DMG-NEW",
      title: "Schaden melden",
      fields: [
        {
          name: "description",
          label: "Beschreibung",
          required: true,
          hidden: false,
          editable: true
        }
      ]
    });
    const calls: unknown[] = [];
    const harness = createIo({
      isTty: true,
      answers: ["1", "Heizung bleibt kalt"]
    });

    const exitCode = await runCli(
      ["node", "propotsdam-cli", "actions", "prepare"],
      harness.io,
      minimalClient({
        listPortalActions: async () => ({
          source: "boxlist",
          items: [action]
        }),
        getPortalAction: async () => action,
        preparePortalAction: async (id, values) => {
          calls.push({ id, values });
          return {
            ok: true,
            preparedOnly: true,
            actionId: id,
            title: action.title,
            summary: "Prepared.",
            validationIssues: [],
            draft: {
              method: "POST",
              endpoint: "/repair-service",
              fields: []
            }
          };
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toContain("Select action");
    expect(calls).toEqual([{ id: "DMG-NEW", values: { description: "Heizung bleibt kalt" } }]);
  });

  it("uses a TTY picker for write prepare capabilities without ids", async () => {
    const { runCli } = await import("../src/cli.js");
    const calls: unknown[] = [];
    const harness = createIo({
      isTty: true,
      answers: ["1", "Heizung bleibt kalt"]
    });

    const exitCode = await runCli(
      ["node", "propotsdam-cli", "writes", "prepare"],
      harness.io,
      minimalClient({
        listPortalWriteCapabilities: async () => ({
          source: "boxlist",
          items: [writeCapability()]
        }),
        preparePortalWrite: async (input) => {
          calls.push(input);
          return {
            ok: true,
            preparedOnly: true,
            willSend: false,
            domain: input.domain,
            title: "Repair report",
            summary: "Prepared.",
            safetyPolicy: "No portal write request was sent.",
            validationIssues: [],
            requiredFields: ["description"],
            values: {
              description: String(input.values?.description)
            }
          };
        }
      })
    );

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toContain("Select write capability");
    expect(calls).toEqual([
      {
        domain: "repair_report",
        values: {
          description: "Heizung bleibt kalt"
        },
        targetId: undefined,
        actionId: undefined
      }
    ]);
  });

  it("merges values from JSON and repeated flags while redacting secret-looking output", async () => {
    const { runCli } = await import("../src/cli.js");
    const action = portalAction({
      id: "DMG-NEW",
      fields: [
        {
          name: "description",
          required: true,
          hidden: false,
          editable: true
        },
        {
          name: "csrfToken",
          required: false,
          hidden: false,
          editable: true
        }
      ]
    });
    const calls: unknown[] = [];
    const harness = createIo();

    await runCli(
      [
        "node",
        "propotsdam-cli",
        "actions",
        "prepare",
        "DMG-NEW",
        "--values-json",
        "{\"description\":\"old\",\"csrfToken\":\"secret-token\"}",
        "--value",
        "description=new",
        "--attachment-file",
        "/tmp/photo.jpg",
        "--json"
      ],
      harness.io,
      minimalClient({
        listPortalActions: async () => ({
          source: "boxlist",
          items: [action]
        }),
        getPortalAction: async () => action,
        preparePortalAction: async (_id, values) => {
          calls.push(values);
          return {
            ok: true,
            preparedOnly: true,
            actionId: "DMG-NEW",
            title: "Schaden melden",
            summary: "Prepared.",
            validationIssues: [],
            draft: {
              method: "POST",
              endpoint: "/repair-service",
              fields: [
                {
                  name: "description",
                  required: true,
                  hidden: false,
                  editable: true,
                  proposedValue: String(values?.description)
                },
                {
                  name: "csrfToken",
                  required: false,
                  hidden: false,
                  editable: true,
                  proposedValue: String(values?.csrfToken)
                }
              ]
            }
          };
        }
      })
    );

    expect(calls).toEqual([{ description: "new", csrfToken: "secret-token", attachmentFilePath: "/tmp/photo.jpg" }]);
    expect(harness.stdout()).toContain("\"proposedValue\": \"new\"");
    expect(harness.stdout()).not.toContain("secret-token");
    expect(harness.stdout()).toContain("[REDACTED]");
  });

  it("shows the exact diff and sends immediately after an interactive yes", async () => {
    const { runCli } = await import("../src/cli.js");
    const action = portalAction({
      id: "save_partner",
      title: "Speichern"
    });
    const stageCalls: Array<{
      actionId: string;
      values?: Record<string, unknown>;
      options?: { recordId?: string; serviceId?: string };
    }> = [];
    const client = minimalClient({
      listPortalActions: async () => ({
        source: "boxlist",
        items: [action]
      }),
      getPortalAction: async () => action,
      stagePortalAction: async (actionId, values, options) => {
        stageCalls.push({ actionId, values, options });
        return {
          ok: true,
          actionId,
          actionTitle: "Speichern",
          pendingWriteHandle: "pending-1",
          expiresAt: "2026-05-15T00:10:00.000Z",
          requiresExplicitApproval: true,
          target: {
            accountId: "MAX",
            domain: "profile_account_setting",
            serviceTitle: "Meine Daten",
            recordId: "PROFILE-1",
            recordTitle: "Meine Daten"
          },
          summary: "Staged.",
          validationIssues: [],
          diff: [
            {
              name: "phone_ref",
              currentValue: "+491",
              proposedValue: String(values?.phone_ref)
            }
          ]
        };
      },
      cancelPendingWrites: async () => ({ ok: true }),
      commitPendingWrites: async (pendingWriteHandles) => ({
        ok: true,
        partial: false,
        attemptedCount: 1,
        counts: { succeeded: 1, notSent: 0, rejected: 0, outcomeUncertain: 0 },
        results: [{
          ok: true,
          outcome: "succeeded",
          pendingWriteHandle: pendingWriteHandles[0]!,
          actionId: "save_partner",
          recordId: "FINAL-1",
          completedAt: "2026-05-15T00:00:00.000Z",
          status: 200,
          summary: "Committed pending write."
        }]
      })
    });
    const harness = createIo({ answers: ["yes"], isTty: true });

    expect(await runCli(
      ["node", "propotsdam-cli", "actions", "send", "save_partner", "--record-id", "PROFILE-1", "--service-id", "PROFILE-SVC", "--value", "phone_ref=+492"],
      harness.io,
      client
    )).toBe(0);

    expect(harness.stdout()).toContain("Review exact portal change");
    expect(harness.stdout()).toContain("Account: MAX");
    expect(harness.stdout()).toContain("Target: Meine Daten");
    expect(harness.stdout()).toContain("phone_ref: +491 -> +492");
    expect(harness.stdout()).toContain('"outcome":"succeeded"');
    expect(harness.stdout()).not.toContain("pending-1");
    expect(harness.prompts).toContain("Send this exact change to ProPotsdam? [y/N] ");
    expect(stageCalls).toEqual([
      {
        actionId: "save_partner",
        values: { phone_ref: "+492" },
        options: { recordId: "PROFILE-1", serviceId: "PROFILE-SVC" }
      }
    ]);
  });

  it("cancels actions send on no and refuses non-interactive or --yes writes", async () => {
    const { runCli } = await import("../src/cli.js");
    const action = portalAction({ id: "save_partner", title: "Speichern" });
    const cancelled: string[][] = [];
    let commits = 0;
    const client = minimalClient({
      listPortalActions: async () => ({ source: "boxlist", items: [action] }),
      getPortalAction: async () => action,
      stagePortalAction: async () => ({
        ok: true,
        actionId: "save_partner",
        actionTitle: "Speichern",
        pendingWriteHandle: "pending-2",
        expiresAt: "2026-05-15T00:10:00.000Z",
        requiresExplicitApproval: true,
        summary: "Staged.",
        validationIssues: [],
        diff: [{ name: "phone_ref", currentValue: "+491", proposedValue: "+492" }]
      }),
      cancelPendingWrites: async (handles) => {
        cancelled.push(handles);
        return { ok: true };
      },
      commitPendingWrites: async () => {
        commits += 1;
        throw new Error("commit should not run");
      }
    });
    const no = createIo({ answers: ["no"], isTty: true });
    const nonTty = createIo({ isTty: false });
    const bypass = createIo({ isTty: true });

    expect(await runCli(
      ["node", "propotsdam-cli", "actions", "send", "save_partner", "--value", "phone_ref=+492"],
      no.io,
      client
    )).toBe(0);
    expect(no.stdout()).toContain("Cancelled. No portal write was sent.");
    expect(cancelled).toEqual([["pending-2"]]);
    expect(commits).toBe(0);

    expect(await runCli(
      ["node", "propotsdam-cli", "actions", "send", "save_partner", "--value", "phone_ref=+492"],
      nonTty.io,
      client
    )).toBe(2);
    expect(nonTty.stderr()).toContain("requires an interactive terminal");

    expect(await runCli(
      ["node", "propotsdam-cli", "actions", "send", "save_partner", "--yes", "--value", "phone_ref=+492"],
      bypass.io,
      client
    )).toBe(2);
    expect(bypass.stderr()).toContain("no --yes bypass");
  });

  it("prints JSON errors in JSON mode with usage exit code 2", async () => {
    const { runCli } = await import("../src/cli.js");
    const harness = createIo();

    const exitCode = await runCli(["node", "propotsdam-cli", "not-real", "--json"], harness.io, minimalClient());

    expect(exitCode).toBe(2);
    expect(JSON.parse(harness.stderr())).toMatchObject({
      ok: false,
      code: "USAGE"
    });
  });

  it("auth set prompts only for username and password by default", async () => {
    const { runCli } = await import("../src/cli.js");
    const saved: unknown[] = [];
    const harness = createIo({
      answers: ["user@example.test"],
      hiddenAnswers: ["super-secret"],
      isTty: true
    });

    const exitCode = await runCli(
      ["node", "propotsdam-cli", "auth", "set"],
      harness.io,
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: async (options) => {
          saved.push(options);
        },
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(exitCode).toBe(0);
    expect(harness.prompts).toEqual(["Username: ", "Password: "]);
    expect(saved).toEqual([
      {
        username: "user@example.test",
        password: "super-secret",
        baseUrl: "https://propotsdam-kundenportal.easysquare.com"
      }
    ]);
    expect(harness.stdout()).toContain("Credentials stored");
  });

  it("renders human CLI errors without a stack trace", async () => {
    const { runCli } = await import("../src/cli.js");
    const harness = createIo({
      answers: [""],
      hiddenAnswers: ["unused"],
      isTty: true
    });

    const exitCode = await runCli(
      ["node", "propotsdam-cli", "auth", "set"],
      harness.io,
      undefined,
      {
        loadConfig: async () => ({
          baseUrl: "https://propotsdam-kundenportal.easysquare.com",
          apiVersion: "6.262",
          appVersion: "6.262.8",
          language: "de",
          exportDir: "/tmp/exports",
          clientId: "client-id"
        }),
        configureCredentials: vi.fn(),
        configFile: "/tmp/propotsdam-mcp/config.json"
      }
    );

    expect(exitCode).toBe(2);
    expect(harness.stderr()).toContain("Username is required.");
    expect(harness.stderr()).not.toContain("at ");
  });
});

function createIo(options: {
  answers?: string[];
  hiddenAnswers?: string[];
  isTty?: boolean;
} = {}): { io: CliIo; stdout(): string; stderr(): string; prompts: string[] } {
  let stdout = "";
  let stderr = "";
  const answers = [...(options.answers ?? [])];
  const hiddenAnswers = [...(options.hiddenAnswers ?? [])];
  const prompts: string[] = [];
  return {
    io: {
      write: (text) => {
        stdout += text;
      },
      error: (text) => {
        stderr += text;
      },
      question: async (prompt) => {
        prompts.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`Unexpected prompt: ${prompt}`);
        }
        return answer;
      },
      questionHidden: async (prompt) => {
        prompts.push(prompt);
        const answer = hiddenAnswers.shift();
        if (answer === undefined) {
          throw new Error(`Unexpected hidden prompt: ${prompt}`);
        }
        return answer;
      },
      isTty: options.isTty ?? false
    },
    stdout: () => stdout,
    stderr: () => stderr,
    prompts
  };
}

function minimalClient(overrides: Partial<CliPortalClient> = {}): CliPortalClient {
  return {
    discoverCapabilities: async () => {
      throw new Error("discoverCapabilities should not be called");
    },
    discoverWriteActions: async () => {
      throw new Error("discoverWriteActions should not be called");
    },
    ...overrides
  };
}

function structuredRecord(overrides: Partial<StructuredPortalRecord> = {}): StructuredPortalRecord {
  return {
    id: "REC-1",
    title: "Record",
    sourceRecordId: "REC-1",
    sourceRecordTitle: "Record",
    serviceTitle: "Service",
    domain: "unknown",
    confidence: "medium",
    itemKind: "record",
    readable: true,
    fields: {},
    rawSource: "boxlist",
    ...overrides
  } as StructuredPortalRecord;
}

function rawRecord(overrides: Partial<PortalRecordItem> = {}): PortalRecordItem {
  return {
    id: "REC-1",
    title: "Record",
    serviceTitle: "Service",
    itemKind: "record",
    readable: true,
    rawSource: "boxlist",
    ...overrides
  };
}

function portalFile(overrides: Partial<PortalFileItem> = {}): PortalFileItem {
  return {
    id: "FILE-1",
    title: "File",
    sourceRecordId: "REC-1",
    sourceRecordTitle: "Record",
    serviceTitle: "Service",
    filename: "file.pdf",
    itemKind: "resource",
    exportable: true,
    ...overrides
  };
}

function portalAction(overrides: Partial<PortalAction> = {}): PortalAction {
  return {
    id: "A-1",
    serviceTitle: "Service",
    title: "Action",
    source: "boxlist",
    actionKind: "form",
    method: "POST",
    fields: [],
    requiresInput: false,
    riskLevel: "medium",
    preparable: true,
    rawHints: {},
    ...overrides
  };
}

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "MSG-1",
    title: "Message",
    subject: "Message",
    unread: true,
    rawSource: "boxlist",
    ...overrides
  };
}

function writeCapability(overrides: Partial<PortalWriteCapability> = {}): PortalWriteCapability {
  return {
    domain: "repair_report",
    title: "Repair report",
    description: "Prepare repair report.",
    source: "static",
    requiredFields: ["description"],
    targetRequired: false,
    uploadSupported: false,
    liveCommitSupported: false,
    executionPolicy: "draft_only_no_live_write",
    ...overrides
  };
}
