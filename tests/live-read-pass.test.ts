import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortalClient } from "../src/portal/portal-client.js";
import { loadConfig, paths } from "../src/storage.js";
import type { AuthResult, CapabilityMap, ListResult, PortalAction, PortalActionMap, PreparedPortalAction } from "../src/types.js";
import { redactSecrets } from "../src/utils/redact.js";

const liveEnabled = process.env.PROPPOTSDAM_LIVE_TEST === "1";
const detailedArtifactsEnabled = process.env.PROPPOTSDAM_LIVE_TEST_DETAILS === "1";

type LiveReadPassArtifactInput = {
  status: AuthResult;
  capabilities: CapabilityMap;
  inbox: ListResult<unknown>;
  records: ListResult<unknown>;
  actionMap: PortalActionMap;
  actions: ListResult<PortalAction>;
  firstActionDetail?: PortalAction;
  prepared?: PreparedPortalAction;
};

type LiveReadPassArtifactOptions = {
  artifactPath: string;
  generatedAt: string;
  detailed: boolean;
};

type LiveEnvironmentSummary = {
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  dataDirConfigured: boolean;
  baseUrlConfigured: boolean;
};

function buildLiveReadPassArtifact(input: LiveReadPassArtifactInput, options: LiveReadPassArtifactOptions): unknown {
  const summary = {
    generatedAt: options.generatedAt,
    artifact: {
      name: "live-read-pass",
      mode: options.detailed ? "details" : "summary",
      path: options.artifactPath
    },
    auth: {
      state: input.status.state,
      authenticated: input.status.authenticated,
      action: input.status.action,
      reason: input.status.reason
    },
    counts: {
      capabilityServices: input.capabilities.services.length,
      inboxItems: input.inbox.items.length,
      portalRecords: input.records.items.length,
      listedActions: input.actions.items.length,
      detailedActions: input.firstActionDetail ? 1 : 0,
      preparedDrafts: input.prepared ? 1 : 0
    },
    totals: {
      capabilities: input.capabilities.totals,
      actions: input.actionMap.totals
    },
    actionKindCounts: countActionKinds(input.actions.items),
    preparable: {
      discovered: input.actionMap.totals.preparableActions,
      listed: input.actions.items.filter((action) => action.preparable).length,
      prepared: input.prepared ? 1 : 0
    },
    skipped: {
      discovered: input.actionMap.totals.skippedActions,
      listed: input.actions.items.filter((action) => !action.preparable).length
    },
    partial: {
      actions: input.actionMap.partial
    },
    metadata: {
      liveTestOptIn: liveEnabled,
      detailsOptIn: options.detailed,
      environment: liveEnvironmentSummary(),
      capabilityArtifactPath: input.capabilities.artifactPath,
      actionArtifactPath: input.actionMap.artifactPath,
      source: "tests/live-read-pass.test.ts"
    }
  };

  if (!options.detailed) {
    return summary;
  }

  return redactSecrets({
    ...summary,
    details: input
  });
}

function countActionKinds(actions: PortalAction[]): Record<string, number> {
  return actions.reduce<Record<string, number>>((counts, action) => {
    counts[action.actionKind] = (counts[action.actionKind] ?? 0) + 1;
    return counts;
  }, {});
}

function liveEnvironmentSummary(env: NodeJS.ProcessEnv = process.env): LiveEnvironmentSummary {
  return {
    usernameConfigured: Boolean(env.PROPPOTSDAM_USERNAME?.trim()),
    passwordConfigured: Boolean(env.PROPPOTSDAM_PASSWORD),
    dataDirConfigured: Boolean(env.PROPPOTSDAM_DATA_DIR?.trim()),
    baseUrlConfigured: Boolean(env.PROPPOTSDAM_BASE_URL?.trim())
  };
}

function prepareOnlyPlaceholderValues(action: PortalAction): Record<string, string> {
  return Object.fromEntries(
    action.fields
      .filter((field) => field.required && !field.hidden && !field.upload && !isSensitiveLiveField(field))
      .map((field) => [field.name, "LIVE_TEST_PLACEHOLDER"])
  );
}

function isSensitiveLiveField(field: PortalAction["fields"][number]): boolean {
  return /csrf|token|cookie|session|password|sap-ffield/i.test(`${field.name} ${field.portalId ?? ""} ${field.label ?? ""}`);
}

describe("live read pass artifact helpers", () => {
  it("builds summary-only artifacts by default", () => {
    const artifact = buildLiveReadPassArtifact(createArtifactInput(), {
      artifactPath: "/tmp/traces/live-read-pass-1.json",
      generatedAt: "2026-05-03T00:00:00.000Z",
      detailed: false
    });

    expect(artifact).toMatchObject({
      artifact: {
        mode: "summary",
        path: "/tmp/traces/live-read-pass-1.json"
      },
      auth: {
        state: "authenticated",
        authenticated: true
      },
      counts: {
        capabilityServices: 2,
        inboxItems: 3,
        portalRecords: 4,
        listedActions: 3,
        detailedActions: 1,
        preparedDrafts: 1
      },
      totals: {
        actions: {
          serviceCount: 2,
          actionCount: 3,
          preparableActions: 1,
          skippedActions: 2
        }
      },
      actionKindCounts: {
        form: 1,
        navigation: 2
      },
      preparable: {
        discovered: 1,
        listed: 1,
        prepared: 1
      },
      skipped: {
        discovered: 2,
        listed: 2
      },
      partial: {
        actions: true
      }
    });
    expect(JSON.stringify(artifact)).not.toContain("Sensitive inbox title");
    expect(JSON.stringify(artifact)).not.toContain("Secret action detail");
  });

  it("redacts detailed artifacts when explicitly enabled", () => {
    const artifact = buildLiveReadPassArtifact(createArtifactInput(), {
      artifactPath: "/tmp/traces/live-read-pass-1.json",
      generatedAt: "2026-05-03T00:00:00.000Z",
      detailed: true
    });
    const serialized = JSON.stringify(artifact);

    expect(artifact).toMatchObject({
      artifact: { mode: "details" },
      details: {
        inbox: {
          source: "boxlist"
        }
      }
    });
    expect((artifact as { details: { inbox: { items: Array<{ title?: string }> } } }).details.inbox.items[0]).toMatchObject({
      title: "Sensitive inbox title"
    });
    expect(serialized).toContain("Sensitive inbox title");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("csrf-token");
    expect(serialized).not.toContain("session=abc");
  });

  it("summarizes live environment readiness without exposing values", () => {
    const summary = liveEnvironmentSummary({
      PROPPOTSDAM_USERNAME: "live-user@example.invalid",
      PROPPOTSDAM_PASSWORD: "live-password",
      PROPPOTSDAM_DATA_DIR: "/tmp/propotsdam-live",
      PROPPOTSDAM_BASE_URL: "https://portal.example.invalid"
    } as NodeJS.ProcessEnv);

    expect(summary).toEqual({
      usernameConfigured: true,
      passwordConfigured: true,
      dataDirConfigured: true,
      baseUrlConfigured: true
    });
    expect(JSON.stringify(summary)).not.toContain("live-user");
    expect(JSON.stringify(summary)).not.toContain("live-password");
    expect(JSON.stringify(summary)).not.toContain("/tmp/propotsdam-live");
  });

  it("builds prepare-only placeholder values without file or sensitive fields", () => {
    const values = prepareOnlyPlaceholderValues(createAction({
      fields: [
        {
          name: "msg_txt",
          label: "Beschreibung",
          required: true,
          hidden: false,
          editable: true
        },
        {
          name: "damage_photo",
          label: "Foto",
          required: true,
          hidden: false,
          editable: true,
          upload: {
            supported: true,
            mode: "multipart_form_data",
            endpoint: "/upload"
          }
        },
        {
          name: "csrfToken",
          required: true,
          hidden: true,
          editable: false
        },
        {
          name: "newPassword",
          label: "Password",
          required: true,
          hidden: false,
          editable: true
        }
      ]
    }));

    expect(values).toEqual({
      msg_txt: "LIVE_TEST_PLACEHOLDER"
    });
  });
});

describe.skipIf(!liveEnabled)("live ProPotsdam read and prepare-only pass", () => {
  it("discovers account capabilities and exercises read-only plus prepare-only tools", async () => {
    const config = await loadConfig();
    if (!config.username) {
      console.warn("Skipping live test because credentials are not configured.");
      return;
    }

    const client = new PortalClient();
    const login = await client.login();
    if (!login.authenticated) {
      console.warn(`Skipping live test because login did not authenticate: ${login.reason ?? login.action ?? login.state}`);
      return;
    }

    const status = await client.status();
    expect(status.authenticated).toBe(true);

    const capabilities = await client.discoverCapabilities();
    expect(capabilities.services.length).toBeGreaterThan(0);

    const inbox = await client.listInbox();
    for (const item of inbox.items) {
      const detail = await client.getInboxItem(item.id);
      expect(detail.id).toBe(item.id);
    }

    const records = await client.listPortalRecords();
    for (const item of records.items) {
      const detail = await client.getPortalRecord(item.id);
      expect(detail.id).toBe(item.id);
    }

    const actionMap = await client.discoverWriteActions();
    const actions = await client.listPortalActions();
    expect(actions.items.length).toBe(actionMap.totals.actionCount);
    const firstAction = actions.items[0];
    const firstActionDetail = firstAction ? await client.getPortalAction(firstAction.id) : undefined;
    const firstPreparable = actions.items.find((action) => action.preparable);
    const prepared = firstPreparable
      ? await client.preparePortalAction(firstPreparable.id, prepareOnlyPlaceholderValues(firstPreparable))
      : undefined;
    if (prepared) {
      expect(prepared.preparedOnly).toBe(true);
    }

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `live-read-pass-${Date.now()}.json`);
    const artifact = buildLiveReadPassArtifact(
      { status, capabilities, inbox, records, actionMap, actions, firstActionDetail, prepared },
      {
        artifactPath,
        generatedAt: new Date().toISOString(),
        detailed: detailedArtifactsEnabled
      }
    );
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    expect(artifactPath).toContain("live-read-pass");
  }, 600_000);
});

function createArtifactInput(): LiveReadPassArtifactInput {
  const actions: PortalAction[] = [
    createAction({ id: "A-1", title: "Secret action detail", actionKind: "form", preparable: true }),
    createAction({ id: "A-2", title: "Navigate", actionKind: "navigation", preparable: false }),
    createAction({ id: "A-3", title: "Navigate again", actionKind: "navigation", preparable: false })
  ];

  return {
    status: {
      state: "authenticated",
      authenticated: true,
      userId: "USER-1",
      userFullName: "Sensitive User"
    },
    capabilities: {
      generatedAt: "2026-05-03T00:00:00.000Z",
      authenticated: true,
      dataPolicy: "test",
      services: [
        createCapabilityService("Postfach"),
        createCapabilityService("Vertraege")
      ],
      totals: {
        serviceCount: 2,
        inboxItems: 3,
        portalRecords: 4,
        unknownItems: 5
      },
      artifactPath: "/tmp/traces/capabilities-1.json"
    },
    inbox: {
      source: "boxlist",
      items: [
        { id: "I-1", title: "Sensitive inbox title", csrfToken: "csrf-token" },
        { id: "I-2" },
        { id: "I-3" }
      ]
    },
    records: {
      source: "boxlist",
      items: [{ id: "R-1" }, { id: "R-2" }, { id: "R-3" }, { id: "R-4" }]
    },
    actionMap: {
      generatedAt: "2026-05-03T00:00:00.000Z",
      authenticated: true,
      actionPolicy: "prepare-only",
      services: [],
      actions,
      partial: true,
      detailScanLimit: 20,
      totals: {
        serviceCount: 2,
        actionCount: 3,
        preparableActions: 1,
        skippedActions: 2
      },
      artifactPath: "/tmp/traces/write-actions-1.json"
    },
    actions: {
      source: "boxlist",
      items: actions
    },
    firstActionDetail: createAction({
      id: "A-1",
      title: "Secret action detail",
      actionKind: "form",
      preparable: true,
      rawHints: {
        Cookie: "session=abc"
      }
    }),
    prepared: {
      ok: true,
      preparedOnly: true,
      actionId: "A-1",
      title: "Secret action detail",
      summary: "prepared",
      validationIssues: [],
      draft: {
        method: "POST",
        fields: []
      }
    }
  };
}

function createAction(action: Partial<PortalAction>): PortalAction {
  return {
    id: action.id ?? "A-1",
    serviceTitle: "Service",
    title: action.title ?? "Action",
    source: "boxlist",
    actionKind: action.actionKind ?? "form",
    method: "POST",
    fields: action.fields ?? [],
    requiresInput: false,
    riskLevel: "low",
    preparable: action.preparable ?? true,
    rawHints: action.rawHints ?? {}
  };
}

function createCapabilityService(title: string): CapabilityMap["services"][number] {
  return {
    title,
    section: "generic",
    readable: true,
    boxlist: {
      available: true,
      itemCount: 1,
      readableItems: 1
    },
    sampleItemIds: []
  };
}
