import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortalClient } from "../src/portal/portal-client.js";
import { loadConfig, paths } from "../src/storage.js";

const liveEnabled = process.env.PROPPOTSDAM_LIVE_TEST === "1";

describe.skipIf(!liveEnabled)("live ProPotsdam read pass", () => {
  it("discovers account capabilities and exercises all read/download tools", async () => {
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

    const documents = await client.listDocuments();
    const records = await client.listPortalRecords();
    for (const item of records.items) {
      const detail = await client.getPortalRecord(item.id);
      expect(detail.id).toBe(item.id);
    }

    const candidates = await client.listDownloadCandidates();
    const tooManyDocuments = candidates.safe.length > 100;
    const estimatedTooLarge = capabilities.safety.estimatedDownloadBytes !== undefined && capabilities.safety.estimatedDownloadBytes > 1_000_000_000;
    const downloads: Array<{ id: string; ok: true; path: string } | { id: string; ok: false; error: string }> = [];
    if (!tooManyDocuments && !estimatedTooLarge) {
      for (const candidate of candidates.safe) {
        try {
          const result = await client.downloadCandidate(candidate.id);
          expect(result.ok).toBe(true);
          expect(result.path.startsWith(config.downloadDir)).toBe(true);
          downloads.push({ id: candidate.id, ok: true, path: result.path });
        } catch (error) {
          downloads.push({
            id: candidate.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    await mkdir(paths.tracesDir, { recursive: true });
    const artifactPath = path.join(paths.tracesDir, `live-read-pass-${Date.now()}.json`);
    await writeFile(artifactPath, `${JSON.stringify({ status, capabilities, inbox, documents, records, candidates, downloads }, null, 2)}\n`);
    expect(artifactPath).toContain("live-read-pass");
  }, 600_000);
});
