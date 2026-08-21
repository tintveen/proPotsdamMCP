import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PotsdamWastePhoto } from "../src/potsdam/types.js";
import type { PortalDefaultsClient } from "../src/waste/portal-defaults.js";
import type { PortalWasteDefaultsProvider } from "../src/waste/types.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const SWP_FINGERPRINT = "a".repeat(64);
const POTSDAM_FINGERPRINT = "b".repeat(64);

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "propotsdam-waste-service-test-"));
  process.env.PROPPOTSDAM_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PROPPOTSDAM_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("WasteService bulky-waste pickup", () => {
  it("prepares a bed pickup with explicit values and maps it to the SWP contract", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.prepareBulkyWastePickup(completeBulkyInput());

    expect(result).toMatchObject({
      ok: true,
      preparedOnly: true,
      willSend: false,
      remoteFingerprint: SWP_FINGERPRINT,
      draft: {
        contact: {
          salutation: "none",
          surname: "Muster",
          email: "erika@example.test",
          address: { street: "Musterweg", houseNumber: "10", postalCode: "14467", city: "Potsdam" }
        },
        items: [{ kind: "couch_sofa_bed", quantity: 1 }]
      },
      fieldSources: {
        "contact.email": "explicit",
        earliestPickupDate: "explicit",
        items: "explicit"
      }
    });
    expect(swpClient.commit).not.toHaveBeenCalled();
  });

  it("merges portal-derived defaults with explicit field overrides", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: {
        async resolve() {
          return {
            contractId: "CONTRACT-1",
            contact: {
              salutation: "female" as const,
              lastName: "Portalname",
              email: "portal@example.test",
              address: {
                street: "Portalweg",
                houseNumber: "9",
                postalCode: "14469",
                city: "Potsdam"
              }
            },
            fieldSources: {
              "contact.salutation": "portal_profile" as const,
              "contact.lastName": "portal_profile" as const,
              "contact.email": "portal_profile" as const,
              "contact.street": "portal_contract" as const,
              "contact.houseNumber": "portal_contract" as const,
              "contact.postalCode": "portal_contract" as const,
              "contact.city": "portal_contract" as const
            },
            candidates: [{ contractId: "CONTRACT-1", title: "Mietvertrag", address: "Portalweg 9, 14469 Potsdam" }],
            validationIssues: []
          };
        }
      },
      swpClient: fakeSwpClient(),
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.prepareBulkyWastePickup({
      contact: { email: "override@example.test" },
      earliestPickupDate: "2026-08-20",
      items: [{ kind: "couch_sofa_bed", quantity: 1 }]
    });

    expect(result).toMatchObject({
      ok: true,
      draft: {
        contact: {
          salutation: "mrs",
          surname: "Portalname",
          email: "override@example.test",
          address: { street: "Portalweg", houseNumber: "9", postalCode: "14469", city: "Potsdam" }
        }
      },
      fieldSources: {
        "contact.email": "explicit",
        "contact.street": "portal_contract",
        "contact.salutation": "portal_profile"
      }
    });
  });

  it("creates a ten-minute confirmation and commits it exactly once", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => NOW,
      confirmationId: () => "11111111-1111-4111-8111-111111111111"
    });

    const requested = await service.requestBulkyWastePickupCommit(completeBulkyInput());
    expect(requested).toMatchObject({
      ok: true,
      confirmationId: "11111111-1111-4111-8111-111111111111",
      expiresAt: "2026-08-15T10:10:00.000Z"
    });
    expect(swpClient.commit).not.toHaveBeenCalled();

    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).resolves.toMatchObject({
      ok: true,
      state: "request_received"
    });
    expect(swpClient.commit).toHaveBeenCalledOnce();
    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND"
    });
    expect(swpClient.commit).toHaveBeenCalledOnce();
  });

  it("returns ambiguity and missing fields without creating a confirmation", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: {
        async resolve() {
          return {
            contact: {},
            fieldSources: {},
            candidates: [
              { contractId: "A", title: "A", address: "A-Straße 1, 14467 Potsdam" },
              { contractId: "B", title: "B", address: "B-Straße 2, 14469 Potsdam" }
            ],
            validationIssues: ["Multiple high-confidence portal contract addresses are available. Provide contractId to choose one."]
          };
        }
      },
      swpClient: fakeSwpClient(),
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.requestBulkyWastePickupCommit({
      earliestPickupDate: "2026-08-20",
      items: [{ kind: "couch_sofa_bed", quantity: 1 }]
    });

    expect(result.ok).toBe(false);
    expect(result.confirmationId).toBeUndefined();
    expect(result.validationIssues.join(" ")).toContain("Multiple high-confidence portal contract addresses");
    expect(result.validationIssues.join(" ")).toContain("contact.email");
    expect(result.contractCandidates).toHaveLength(2);
  });

  it("validates an explicit contract id even when all required values are overridden", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const defaultsProvider = {
      resolve: vi.fn(async () => ({
        contact: {},
        fieldSources: {},
        candidates: [],
        validationIssues: ["No high-confidence portal contract address matched contractId 'UNKNOWN'."]
      }))
    };
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider,
      swpClient: fakeSwpClient(),
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.requestBulkyWastePickupCommit({
      ...completeBulkyInput(),
      contractId: "UNKNOWN"
    });

    expect(defaultsProvider.resolve).toHaveBeenCalledWith("UNKNOWN");
    expect(result.ok).toBe(false);
    expect(result.validationIssues).toContain(
      "No high-confidence portal contract address matched contractId 'UNKNOWN'."
    );
  });

  it("rejects invalid dates, alternate postcodes, and unsupported item categories during preparation", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.prepareBulkyWastePickup({
      ...completeBulkyInput(),
      earliestPickupDate: "2026-02-30",
      pickupAddress: {
        street: "Abholweg",
        houseNumber: "1",
        postalCode: "ABCDE",
        city: "Potsdam"
      },
      items: [{ kind: "construction_rubble", quantity: 1 } as never]
    });

    expect(result.ok).toBe(false);
    expect(result.validationIssues).toEqual(expect.arrayContaining([
      "earliestPickupDate must be a real calendar date in YYYY-MM-DD format.",
      "pickupAddress.postalCode must contain exactly five digits.",
      "Unsupported bulky-waste item kind 'construction_rubble'."
    ]));
    expect(swpClient.commit).not.toHaveBeenCalled();
  });

  it("lets an explicit value resolve a conflicting portal profile field", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: {
        async resolve() {
          return {
            contact: {},
            fieldSources: {},
            candidates: [{ contractId: "CONTRACT-1", title: "Mietvertrag" }],
            validationIssues: [
              "Multiple portal profile values were found for contact.email. Provide an explicit override."
            ]
          };
        }
      },
      swpClient: fakeSwpClient(),
      potsdamClient: fakePotsdamClient(),
      now: () => NOW
    });

    const result = await service.prepareBulkyWastePickup({
      ...completeBulkyInput(),
      contractId: "CONTRACT-1"
    });

    expect(result.ok).toBe(true);
    expect(result.validationIssues).toEqual([]);
  });

  it("surfaces an uncertain final STEP outcome and consumes the confirmation", async () => {
    const { SwpClientError } = await import("../src/swp/index.js");
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    swpClient.commit.mockRejectedValueOnce(new SwpClientError(
      "The STEP request outcome is uncertain. Do not retry automatically.",
      "AMBIGUOUS_WRITE"
    ));
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => NOW,
      confirmationId: () => "77777777-7777-4777-8777-777777777777"
    });
    const requested = await service.requestBulkyWastePickupCommit(completeBulkyInput());

    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).rejects.toMatchObject({
      code: "SWP_AMBIGUOUS_WRITE",
      details: {
        outcomeUncertain: true,
        warnings: [expect.stringContaining("Do not retry automatically")]
      }
    });
    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND"
    });
    expect(swpClient.commit).toHaveBeenCalledOnce();
  });

  it("consumes a confirmation whose earliest pickup date became stale at midnight", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    let current = new Date("2026-08-15T21:56:00.000Z");
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => current,
      confirmationId: () => "44444444-4444-4444-8444-444444444444"
    });
    const input = { ...completeBulkyInput(), earliestPickupDate: "2026-08-15" };
    const requested = await service.requestBulkyWastePickupCommit(input);
    current = new Date("2026-08-15T22:01:00.000Z");

    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_STALE"
    });
    expect(swpClient.commit).not.toHaveBeenCalled();
  });

  it("atomically permits only one of two concurrent commits", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient: fakePotsdamClient(),
      now: () => NOW,
      confirmationId: () => "55555555-5555-4555-8555-555555555555"
    });
    const requested = await service.requestBulkyWastePickupCommit(completeBulkyInput());

    const results = await Promise.allSettled([
      service.commitBulkyWastePickup(requested.confirmationId!),
      service.commitBulkyWastePickup(requested.confirmationId!)
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFIRMATION_NOT_FOUND" }
    });
    expect(swpClient.commit).toHaveBeenCalledOnce();
  });

  it("consumes a confirmation presented to the wrong workflow without writing", async () => {
    const { WasteService } = await import("../src/waste/waste-service.js");
    const swpClient = fakeSwpClient();
    const potsdamClient = fakePotsdamClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient,
      potsdamClient,
      now: () => NOW,
      confirmationId: () => "66666666-6666-4666-8666-666666666666"
    });
    const requested = await service.requestBulkyWastePickupCommit(completeBulkyInput());

    await expect(service.commitAbandonedWasteReport(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_KIND_MISMATCH"
    });
    await expect(service.commitBulkyWastePickup(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND"
    });
    expect(swpClient.commit).not.toHaveBeenCalled();
    expect(potsdamClient.commit).not.toHaveBeenCalled();
  });
});

describe("WasteService abandoned-waste report", () => {
  it("normalizes a photo, stores exact approved bytes, and returns email activation state", async () => {
    const photoPaths = ["pile-1.png", "pile-2.png", "pile-3.png"].map((filename) => path.join(dataDir, filename));
    await Promise.all(photoPaths.map((photoPath, index) => sharp({
      create: { width: 32 + index, height: 24, channels: 3, background: "orange" }
    }).png().toFile(photoPath)));
    const { WasteService } = await import("../src/waste/waste-service.js");
    const potsdamClient = fakePotsdamClient();
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient: fakeSwpClient(),
      potsdamClient,
      now: () => NOW,
      confirmationId: () => "22222222-2222-4222-8222-222222222222"
    });

    const requested = await service.requestAbandonedWasteReportCommit({
      contact: { email: "erika@example.test" },
      location: { latitude: 52.4, longitude: 13.05, label: "Musterweg 10" },
      description: "Ein Bett und zwei Matratzen stehen neben den Mülltonnen.",
      photoPaths,
      privacyConsent: true
    });
    expect(requested).toMatchObject({
      ok: true,
      confirmationId: "22222222-2222-4222-8222-222222222222"
    });
    expect(potsdamClient.commit).not.toHaveBeenCalled();

    await expect(service.commitAbandonedWasteReport(requested.confirmationId!)).resolves.toMatchObject({
      ok: true,
      state: "awaiting_email_confirmation",
      reference: "REPORT-1"
    });
    expect(potsdamClient.commit).toHaveBeenCalledOnce();
    const photos = potsdamClient.commit.mock.calls[0]![1];
    expect(photos).toHaveLength(3);
    expect(photos.every((photo) => photo.mimeType === "image/jpeg")).toBe(true);
    expect(photos.every((photo) => !existsSync(photo.path))).toBe(true);
  });

  it("detects a modified stored payload before the city write", async () => {
    const photoPath = path.join(dataDir, "pile.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toFile(photoPath);
    const { WasteService } = await import("../src/waste/waste-service.js");
    const { wasteConfirmationPaths } = await import("../src/waste/confirmation-storage.js");
    const potsdamClient = fakePotsdamClient();
    const confirmationId = "33333333-3333-4333-8333-333333333333";
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient: fakeSwpClient(),
      potsdamClient,
      now: () => NOW,
      confirmationId: () => confirmationId
    });

    await service.requestAbandonedWasteReportCommit({
      contact: { email: "erika@example.test" },
      location: { latitude: 52.4, longitude: 13.05 },
      description: "Ein Bett steht neben den Mülltonnen.",
      photoPaths: [photoPath],
      privacyConsent: true
    });
    const confirmationPath = path.join(wasteConfirmationPaths.confirmationsDir, `${confirmationId}.json`);
    const stored = JSON.parse(await readFile(confirmationPath, "utf8")) as {
      remoteFingerprint: string;
      payload: {
        draft: { description: string };
        location: unknown;
        photos: unknown;
        approvedDigest: string;
      };
    };
    stored.payload.draft.description = "Geänderter Text";
    const content = {
      draft: stored.payload.draft,
      location: stored.payload.location,
      photos: stored.payload.photos
    };
    stored.payload.approvedDigest = createHash("sha256").update(JSON.stringify({
      kind: "potsdam_abandoned_waste",
      fingerprint: stored.remoteFingerprint,
      content
    })).digest("hex");
    await writeFile(confirmationPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    await expect(service.commitAbandonedWasteReport(confirmationId)).rejects.toMatchObject({
      code: "CONFIRMATION_TAMPERED"
    });
    expect(potsdamClient.commit).not.toHaveBeenCalled();
  });

  it("surfaces an uncertain city outcome, consumes the confirmation, and cleans photos", async () => {
    const photoPath = path.join(dataDir, "pile.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toFile(photoPath);
    const { PotsdamWasteError } = await import("../src/potsdam/index.js");
    const { WasteService } = await import("../src/waste/waste-service.js");
    const potsdamClient = fakePotsdamClient();
    potsdamClient.commit.mockRejectedValueOnce(new PotsdamWasteError(
      "The Potsdam report outcome is uncertain. Do not retry automatically.",
      "AMBIGUOUS_WRITE"
    ));
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient: fakeSwpClient(),
      potsdamClient,
      now: () => NOW,
      confirmationId: () => "88888888-8888-4888-8888-888888888888"
    });
    const requested = await service.requestAbandonedWasteReportCommit({
      contact: { email: "erika@example.test" },
      location: { latitude: 52.4, longitude: 13.05 },
      description: "Ein Bett steht neben den Mülltonnen.",
      photoPaths: [photoPath],
      privacyConsent: true
    });

    await expect(service.commitAbandonedWasteReport(requested.confirmationId!)).rejects.toMatchObject({
      code: "POTSDAM_WASTE_AMBIGUOUS_WRITE",
      details: { outcomeUncertain: true }
    });
    const staged = potsdamClient.commit.mock.calls[0]![1][0]!;
    expect(existsSync(staged.path)).toBe(false);
    await expect(service.commitAbandonedWasteReport(requested.confirmationId!)).rejects.toMatchObject({
      code: "CONFIRMATION_NOT_FOUND"
    });
  });

  it("rejects a normalized photo that exceeds the discovered live output limit before confirmation", async () => {
    const photoPath = path.join(dataDir, "pile.png");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toFile(photoPath);
    const { WasteService } = await import("../src/waste/waste-service.js");
    const potsdamClient = fakePotsdamClient();
    const config = await potsdamClient.inspectConfig();
    potsdamClient.inspectConfig.mockResolvedValue({
      ...config,
      photoRules: { ...config.photoRules, maxOutputBytes: 1 }
    });
    const service = new WasteService(emptyPortalClient(), {
      defaultsProvider: unusedDefaults(),
      swpClient: fakeSwpClient(),
      potsdamClient,
      now: () => NOW,
      confirmationId: () => "99999999-9999-4999-8999-999999999999"
    });

    const requested = await service.requestAbandonedWasteReportCommit({
      contact: { email: "erika@example.test" },
      location: { latitude: 52.4, longitude: 13.05 },
      description: "Ein Bett steht neben den Mülltonnen.",
      photoPaths: [photoPath],
      privacyConsent: true
    });

    expect(requested.ok).toBe(false);
    expect(requested.confirmationId).toBeUndefined();
    expect(requested.validationIssues).toContain("A normalized photo exceeds the current live photo-size limit.");
    expect(potsdamClient.commit).not.toHaveBeenCalled();
  });
});

function completeBulkyInput() {
  return {
    contact: {
      salutation: "unspecified" as const,
      firstName: "Erika",
      lastName: "Muster",
      email: "erika@example.test",
      street: "Musterweg",
      houseNumber: "10",
      postalCode: "14467",
      city: "Potsdam"
    },
    earliestPickupDate: "2026-08-20",
    items: [{ kind: "couch_sofa_bed" as const, quantity: 1 }]
  };
}

function unusedDefaults(): PortalWasteDefaultsProvider {
  return {
    async resolve() {
      throw new Error("defaults should not be queried");
    }
  };
}

function emptyPortalClient(): PortalDefaultsClient {
  return {
    async status() {
      return { state: "unauthenticated", authenticated: false };
    },
    async listStructuredPortalRecords() {
      return { items: [], source: "boxlist" };
    },
    async listPortalActions() {
      return { items: [], source: "boxlist" };
    }
  };
}

function fakeSwpClient() {
  return {
    inspect: vi.fn(async () => ({
      sourceUrl: "https://www.swp-potsdam.de/de/entsorgung/sperrm%C3%BCllabholung/",
      formId: "commandDE77137",
      fingerprint: SWP_FINGERPRINT,
      fields: [],
      requiredFields: [],
      supportedItemKinds: [],
      constraints: {
        alternatePickupAddressRequiresCompleteAddress: true as const,
        earliestPickupDateIsNotAnAppointment: true as const,
        smallElectricalRequiresLargeAppliance: true as const,
        otherSmallElectricalRequiresFridgeOrWasher: true as const
      }
    })),
    commit: vi.fn(async () => ({
      ok: true as const,
      status: "submitted" as const,
      httpStatus: 200,
      fingerprint: SWP_FINGERPRINT,
      summary: "STEP received the request."
    }))
  };
}

function fakePotsdamClient() {
  return {
    inspectConfig: vi.fn(async () => ({
      sourceUrl: "https://mitgestalten.potsdam.de/de/maengel-melden/create",
      moduleId: 3,
      category: { id: 1, name: "Abfall" as const },
      bounds: { west: 12.5, south: 52.2, east: 13.4, north: 52.7 },
      maxDescriptionChars: 500,
      geocoderUuid: "00000000-0000-4000-8000-000000000000",
      photoRules: {
        required: true,
        maxCount: 3,
        maxInputBytes: 8 * 1024 * 1024,
        maxInputPixels: 50_000_000,
        maxOutputBytes: 8 * 1024 * 1024,
        maxOutputLongEdge: 4096,
        acceptedInputMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        outputMimeType: "image/jpeg" as const,
        outputJpegQuality: 85
      },
      fingerprint: POTSDAM_FINGERPRINT
    })),
    geocodeAddress: vi.fn(async (address: string) => ({
      latitude: 52.4,
      longitude: 13.05,
      displayAddress: address,
      source: "address" as const
    })),
    previewCoordinates: vi.fn(async (coordinates: { latitude: number; longitude: number }) => ({
      ...coordinates,
      displayAddress: "Musterweg 10, 14467 Potsdam",
      source: "coordinates" as const
    })),
    commit: vi.fn(async (_draft: unknown, photos: PotsdamWastePhoto[]) => {
      expect(photos.every((photo) => existsSync(photo.path))).toBe(true);
      return {
        ok: true as const,
        state: "awaiting_email_confirmation" as const,
        httpStatus: 200,
        reportId: "REPORT-1",
        summary: "Report received; activate it by email."
      };
    })
  };
}
