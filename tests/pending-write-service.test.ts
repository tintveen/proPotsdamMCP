import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../src/portal/portal-client.js";
import type { PendingPortalWrite, PendingWasteWrite } from "../src/types.js";
import type { WasteServiceLike } from "../src/waste/types.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "propotsdam-pending-service-"));
  process.env.PROPPOTSDAM_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PROPPOTSDAM_DATA_DIR;
  vi.resetModules();
  await rm(dataDir, { recursive: true, force: true });
});

describe("PendingWriteService", () => {
  it("lists portal and waste actions once in creation order with safe review context", async () => {
    const { PendingWriteService } = await import("../src/pending-write-service.js");
    const { savePendingWrite } = await import("../src/storage.js");
    await savePendingWrite(portalWrite("portal-1", "2026-08-29T08:00:00.000Z"));
    await savePendingWrite(wasteWrite("waste-1", "swp_bulky_waste", "2026-08-29T08:00:01.000Z"));
    await savePendingWrite(wasteWrite("waste-2", "potsdam_abandoned_waste", "2026-08-29T08:00:02.000Z"));
    const service = new PendingWriteService(portalExecutor(), wasteExecutor());

    const result = await service.listPendingWrites();

    expect(result.items.map((item) => item.pendingWriteHandle)).toEqual(["portal-1", "waste-1", "waste-2"]);
    expect(new Set(result.items.map((item) => item.pendingWriteHandle)).size).toBe(3);
    expect(result.items[2]).toMatchObject({
      kind: "potsdam_abandoned_waste",
      destination: "Potsdam abandoned-waste reporting service",
      warnings: [expect.stringContaining("public")]
    });
  });

  it("rejects duplicate handles before any executor is called", async () => {
    const { PendingWriteService } = await import("../src/pending-write-service.js");
    const portal = portalExecutor();
    const waste = wasteExecutor();
    const service = new PendingWriteService(portal, waste);

    await expect(service.commitPendingWrites(["same-1", "same-1"])).rejects.toMatchObject({
      code: "DUPLICATE_PENDING_WRITE_HANDLE"
    });
    expect(portal.commitPendingWrites).not.toHaveBeenCalled();
    expect(waste.commitPendingWrite).not.toHaveBeenCalled();
  });

  it("executes an approved mixed batch sequentially, continues after rejection, and reports partial completion", async () => {
    const { PendingWriteService } = await import("../src/pending-write-service.js");
    const { savePendingWrite } = await import("../src/storage.js");
    await savePendingWrite(portalWrite("portal-1", "2026-08-29T08:00:00.000Z"));
    await savePendingWrite(wasteWrite("waste-1", "swp_bulky_waste", "2026-08-29T08:00:01.000Z"));
    await savePendingWrite(wasteWrite("waste-2", "potsdam_abandoned_waste", "2026-08-29T08:00:02.000Z"));
    const calls: string[] = [];
    const portal = {
      commitPendingWrites: vi.fn(async ([handle]: string[]) => {
        calls.push(handle!);
        return {
          ok: true,
          partial: false,
          attemptedCount: 1,
          counts: { succeeded: 1, notSent: 0, rejected: 0, outcomeUncertain: 0 },
          results: [{
            ok: true,
            outcome: "succeeded" as const,
            pendingWriteHandle: handle!,
            actionId: "save_partner",
            completedAt: "2026-08-29T08:01:00.000Z",
            summary: "Portal action committed."
          }]
        };
      })
    };
    const waste = {
      commitPendingWrite: vi.fn(async (handle: string, kind: PendingWasteWrite["kind"]) => {
        calls.push(handle);
        const rejected = kind === "swp_bulky_waste";
        return {
          ok: !rejected,
          outcome: rejected ? "rejected" as const : "succeeded" as const,
          pendingWriteHandle: handle,
          kind,
          workflow: kind === "swp_bulky_waste" ? "bulky_waste_pickup" as const : "abandoned_waste_report" as const,
          completedAt: "2026-08-29T08:01:01.000Z",
          summary: rejected ? "STEP rejected the request." : "Potsdam accepted the report."
        };
      })
    } as unknown as WasteServiceLike;
    const service = new PendingWriteService(portal as unknown as Pick<PortalClient, "commitPendingWrites">, waste);

    const result = await service.commitPendingWrites(["portal-1", "waste-1", "waste-2"]);

    expect(calls).toEqual(["portal-1", "waste-1", "waste-2"]);
    expect(result).toMatchObject({
      ok: false,
      partial: true,
      attemptedCount: 3,
      counts: { succeeded: 2, rejected: 1, notSent: 0, outcomeUncertain: 0 }
    });
    expect(result.results.map((item) => item.outcome)).toEqual(["succeeded", "rejected", "succeeded"]);
  });

  it("cancels local staged state and its artifacts without invoking an executor", async () => {
    const { PendingWriteService } = await import("../src/pending-write-service.js");
    const storage = await import("../src/storage.js");
    const pending = wasteWrite("waste-cancel-1", "potsdam_abandoned_waste", "2026-08-29T08:00:00.000Z");
    const artifacts = storage.pendingWriteArtifactsDir(pending.pendingWriteHandle);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(path.join(artifacts, "photo.jpg"), "photo", { mode: 0o600 });
    await storage.savePendingWrite(pending);
    const portal = portalExecutor();
    const waste = wasteExecutor();
    const service = new PendingWriteService(portal, waste);

    await expect(service.cancelPendingWrites([pending.pendingWriteHandle])).resolves.toMatchObject({
      ok: true,
      cancelledHandles: [pending.pendingWriteHandle]
    });
    await expect(stat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
    expect(portal.commitPendingWrites).not.toHaveBeenCalled();
    expect(waste.commitPendingWrite).not.toHaveBeenCalled();
  });
});

function portalExecutor() {
  return {
    commitPendingWrites: vi.fn()
  } as unknown as Pick<PortalClient, "commitPendingWrites">;
}

function wasteExecutor() {
  return {
    commitPendingWrite: vi.fn()
  } as unknown as WasteServiceLike;
}

function portalWrite(pendingWriteHandle: string, createdAt: string): PendingPortalWrite {
  return {
    pendingWriteHandle,
    state: "staged",
    kind: "portal_action",
    workflow: "portal_action",
    destination: "ProPotsdam customer portal",
    contractFingerprint: "portal-contract",
    review: ["Phone: +491 -> +492"],
    warnings: [],
    privacyUrls: [],
    accountId: "MAX",
    domain: "profile_account_setting",
    actionId: "save_partner",
    actionTitle: "Speichern",
    values: { phone_ref: "+492" },
    diff: [{ name: "phone_ref", currentValue: "+491", proposedValue: "+492" }],
    createdAt,
    expiresAt: "2099-08-29T08:10:00.000Z"
  };
}

function wasteWrite(
  pendingWriteHandle: string,
  kind: PendingWasteWrite["kind"],
  createdAt: string
): PendingWasteWrite {
  const abandoned = kind === "potsdam_abandoned_waste";
  return {
    pendingWriteHandle,
    state: "staged",
    kind,
    workflow: abandoned ? "abandoned_waste_report" : "bulky_waste_pickup",
    destination: abandoned
      ? "Potsdam abandoned-waste reporting service"
      : "STEP bulky-waste pickup service",
    contractFingerprint: abandoned ? "b".repeat(64) : "a".repeat(64),
    review: abandoned ? ["Description: Fixture pile"] : ["Item: Fixture mattress"],
    warnings: abandoned ? ["The location, description, and photos may become public."] : [],
    privacyUrls: [],
    payload: { fixture: true },
    createdAt,
    expiresAt: "2099-08-29T08:10:00.000Z"
  };
}
