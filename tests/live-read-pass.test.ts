import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortalClient } from "../src/portal/portal-client.js";
import { loadConfig, paths } from "../src/storage.js";

const liveEnabled = process.env.PROPPOTSDAM_LIVE_TEST === "1";

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
      ? await client.preparePortalAction(firstPreparable.id, Object.fromEntries(
        firstPreparable.fields
          .filter((field) => field.required && !field.hidden)
          .map((field) => [field.name, "LIVE_TEST_PLACEHOLDER"])
      ))
      : undefined;
    if (prepared) {
      expect(prepared.preparedOnly).toBe(true);
    }

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `live-read-pass-${Date.now()}.json`);
    await writeFile(artifactPath, `${JSON.stringify({ status, capabilities, inbox, records, actionMap, actions, firstActionDetail, prepared }, null, 2)}\n`);
    expect(artifactPath).toContain("live-read-pass");
  }, 600_000);
});
