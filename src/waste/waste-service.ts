import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PortalError } from "../errors.js";
import {
  PotsdamWasteClient,
  PotsdamWasteError,
  stagePotsdamWastePhoto,
  verifyStagedPotsdamWastePhoto,
  type PotsdamWasteClient as PotsdamWasteClientType,
  type PotsdamWasteConfig,
  type PotsdamWasteDraft,
  type PotsdamWasteLocation,
  type PotsdamWastePhoto
} from "../potsdam/index.js";
import {
  SwpClient,
  SwpClientError,
  type ResolvedSwpDraft,
  type SwpClient as SwpClientType,
  type SwpItem
} from "../swp/index.js";
import type { PortalDefaultsClient } from "./portal-defaults.js";
import { PortalClientWasteDefaultsProvider } from "./portal-defaults.js";
import {
  PENDING_WRITE_TTL_MS,
  claimPendingWrite,
  deleteClaimedPendingWrite,
  deleteExpiredPendingWrites,
  deletePendingWrite,
  deletePendingWriteArtifacts,
  loadPendingWrite,
  pendingWriteArtifactsDir,
  savePendingWrite
} from "../storage.js";
import type { PendingWasteWrite, PendingWriteCommitResult, WriteOutcome } from "../types.js";
import type {
  AbandonedWasteReportInput,
  BulkyWasteItem,
  BulkyWastePickupInput,
  PortalWasteDefaults,
  PortalWasteDefaultsProvider,
  WasteAddress,
  StagedWasteActionResult,
  WasteContactOverrides,
  WastePreparation,
  WasteServiceLike
} from "./types.js";

const SWP_PRIVACY_URL = "https://www.swp-potsdam.de/content/entsorgung/pdf_4/step_datenschutzerhinweise_dsgvo.pdf";
const SWP_FORM_URL = "https://www.swp-potsdam.de/de/entsorgung/sperrm%C3%BCllabholung/";
const POTSDAM_PRIVACY_URL = "https://mitgestalten.potsdam.de/de/datenschutz";
const POTSDAM_REPORT_INFO_URL = "https://mitgestalten.potsdam.de/de/maengel-melden/info";
const SUPPORTED_BULKY_ITEM_KINDS = new Set([
  "couch_sofa_bed",
  "mattress",
  "cabinet_sideboard_shelf",
  "armchair",
  "chair_stool",
  "table_table_tennis",
  "bicycle",
  "drying_rack",
  "refrigerator_freezer",
  "washer_dryer",
  "dishwasher",
  "cooker",
  "tv_monitor",
  "vacuum_cleaner",
  "floor_covering",
  "other_bulky",
  "other_metal",
  "large_electrical_over_50cm",
  "other_small_electrical"
]);

interface SwpClientLike {
  inspect(): ReturnType<SwpClientType["inspect"]>;
  commit(draft: ResolvedSwpDraft, expectedFingerprint: string): ReturnType<SwpClientType["commit"]>;
}

interface PotsdamClientLike {
  inspectConfig(): Promise<PotsdamWasteConfig>;
  geocodeAddress(query: string, config?: PotsdamWasteConfig): Promise<PotsdamWasteLocation>;
  previewCoordinates(coordinates: { latitude: number; longitude: number }, config?: PotsdamWasteConfig): Promise<PotsdamWasteLocation>;
  commit(draft: PotsdamWasteDraft, photos: PotsdamWastePhoto[], expectedFingerprint: string): ReturnType<PotsdamWasteClientType["commit"]>;
}

export interface WasteServiceDependencies {
  defaultsProvider?: PortalWasteDefaultsProvider;
  swpClient?: SwpClientLike;
  potsdamClient?: PotsdamClientLike;
  now?: () => Date;
  pendingWriteHandle?: () => string;
  deleteClaimedPendingWrite?: typeof deleteClaimedPendingWrite;
}

interface PreparedSwpPayload {
  draft: ResolvedSwpDraft;
}

interface PreparedPotsdamPayload {
  draft: PotsdamWasteDraft;
  location: PotsdamWasteLocation;
  photos: PotsdamWastePhoto[];
}

export class WasteService implements WasteServiceLike {
  private readonly defaultsProvider: PortalWasteDefaultsProvider;
  private readonly swpClient: SwpClientLike;
  private readonly potsdamClient: PotsdamClientLike;
  private readonly now: () => Date;
  private readonly pendingWriteHandle: () => string;
  private readonly cleanupClaimedPendingWrite: typeof deleteClaimedPendingWrite;

  constructor(portalClient: PortalDefaultsClient, dependencies: WasteServiceDependencies = {}) {
    this.defaultsProvider = dependencies.defaultsProvider ?? new PortalClientWasteDefaultsProvider(portalClient);
    this.swpClient = dependencies.swpClient ?? new SwpClient();
    this.potsdamClient = dependencies.potsdamClient ?? new PotsdamWasteClient();
    this.now = dependencies.now ?? (() => new Date());
    this.pendingWriteHandle = dependencies.pendingWriteHandle ?? randomUUID;
    this.cleanupClaimedPendingWrite = dependencies.deleteClaimedPendingWrite ?? deleteClaimedPendingWrite;
  }

  async prepareBulkyWastePickup(input: BulkyWastePickupInput): Promise<WastePreparation<ResolvedSwpDraft>> {
    return this.resolveBulkyWastePickup(input);
  }

  async stageBulkyWastePickup(input: BulkyWastePickupInput): Promise<StagedWasteActionResult> {
    await this.maintainPendingWrites();
    const prepared = await this.resolveBulkyWastePickup(input);
    if (!prepared.ok || !prepared.draft || !prepared.remoteFingerprint) {
      return stageResultFromPreparation("swp_bulky_waste", prepared);
    }

    const pendingWriteHandle = this.pendingWriteHandle();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + PENDING_WRITE_TTL_MS);
    const review = stageReview(
      "STEP bulky-waste pickup service",
      prepared.review,
      expiresAt
    );
    const pendingWrite: PendingWasteWrite = {
      pendingWriteHandle,
      state: "staged",
      kind: "swp_bulky_waste",
      workflow: "bulky_waste_pickup",
      destination: "STEP bulky-waste pickup service",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      contractFingerprint: prepared.remoteFingerprint,
      payload: { draft: prepared.draft } satisfies PreparedSwpPayload,
      review,
      warnings: prepared.warnings,
      privacyUrls: prepared.privacyUrls
    };
    try {
      await savePendingWrite(pendingWrite);
    } catch {
      await deletePendingWriteArtifacts(pendingWriteHandle).catch(() => undefined);
      throw new PortalError("The pending STEP request could not be stored safely.", "PENDING_WRITE_STORAGE_ERROR");
    }

    return {
      ok: true,
      workflow: "bulky_waste_pickup",
      kind: "swp_bulky_waste",
      pendingWriteHandle,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      requiresExplicitApproval: true,
      validationIssues: [],
      warnings: prepared.warnings,
      review,
      privacyUrls: prepared.privacyUrls
    };
  }

  async prepareAbandonedWasteReport(input: AbandonedWasteReportInput): Promise<WastePreparation<unknown>> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "propotsdam-waste-preview-"));
    try {
      const prepared = await this.resolveAbandonedWasteReport(input, temporaryDirectory);
      return {
        ...prepared,
        draft: prepared.draft ? {
          report: prepared.draft.draft,
          location: prepared.draft.location,
          photos: prepared.draft.photos.map((photo) => ({
            filename: photo.filename,
            mimeType: photo.mimeType,
            byteLength: photo.byteLength,
            width: photo.width,
            height: photo.height
          }))
        } : undefined
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async stageAbandonedWasteReport(input: AbandonedWasteReportInput): Promise<StagedWasteActionResult> {
    await this.maintainPendingWrites();
    const pendingWriteHandle = this.pendingWriteHandle();
    const stagingDirectory = pendingWriteArtifactsDir(pendingWriteHandle);
    let prepared: WastePreparation<PreparedPotsdamPayload>;
    try {
      prepared = await this.resolveAbandonedWasteReport(input, stagingDirectory);
      if (!prepared.ok || !prepared.draft || !prepared.remoteFingerprint) {
        await deletePendingWriteArtifacts(pendingWriteHandle);
        return stageResultFromPreparation("potsdam_abandoned_waste", prepared);
      }

      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + PENDING_WRITE_TTL_MS);
      const review = stageReview(
        "Potsdam abandoned-waste reporting service",
        prepared.review,
        expiresAt,
        "Public-data warning: the location, description, and normalized photos may become publicly visible."
      );
      const pendingWrite: PendingWasteWrite = {
        pendingWriteHandle,
        state: "staged",
        kind: "potsdam_abandoned_waste",
        workflow: "abandoned_waste_report",
        destination: "Potsdam abandoned-waste reporting service",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        contractFingerprint: prepared.remoteFingerprint,
        payload: prepared.draft,
        review,
        warnings: prepared.warnings,
        privacyUrls: prepared.privacyUrls,
        artifacts: prepared.draft.photos.map((photo) => ({
          filePath: photo.path,
          filename: photo.filename,
          mimeType: photo.mimeType,
          byteLength: photo.byteLength,
          sha256: photo.sha256
        }))
      };
      try {
        await savePendingWrite(pendingWrite);
      } catch {
        throw new PortalError("The pending Potsdam report could not be stored safely.", "PENDING_WRITE_STORAGE_ERROR");
      }

      return {
        ok: true,
        workflow: "abandoned_waste_report",
        kind: "potsdam_abandoned_waste",
        pendingWriteHandle,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        requiresExplicitApproval: true,
        validationIssues: [],
        warnings: prepared.warnings,
        review,
        privacyUrls: prepared.privacyUrls
      };
    } catch (error) {
      await deletePendingWriteArtifacts(pendingWriteHandle).catch(() => undefined);
      throw externalError(error, "POTSDAM_WASTE");
    }
  }

  async commitPendingWrite(
    pendingWriteHandle: string,
    expectedKind: PendingWasteWrite["kind"]
  ): Promise<PendingWriteCommitResult> {
    const workflow = wasteWorkflow(expectedKind);
    const pendingWrite = await loadPendingWrite(pendingWriteHandle).catch(() => null);
    if (!pendingWrite || pendingWrite.kind !== expectedKind) {
      if (!pendingWrite) {
        await deletePendingWrite(pendingWriteHandle).catch(() => false);
      }
      return wasteCommitResult(
        pendingWriteHandle,
        expectedKind,
        workflow,
        "notSent",
        "Pending action was not found, expired, cancelled, already used, or belongs to a different executor.",
        this.now()
      );
    }
    if (Date.parse(pendingWrite.expiresAt) <= this.now().getTime()) {
      await deletePendingWrite(pendingWriteHandle).catch(() => false);
      return wasteCommitResult(
        pendingWriteHandle,
        expectedKind,
        workflow,
        "notSent",
        "Pending action expired before dispatch. Stage and approve a new action.",
        this.now()
      );
    }

    try {
      if (pendingWrite.kind === "swp_bulky_waste") {
        const payload = parseSwpPayload(pendingWrite);
        if (payload.draft.earliestPickupDate < berlinDate(this.now())) {
          throw new PortalError("The approved earliest pickup date is now in the past. Stage a new request.", "PENDING_WRITE_STALE", 409);
        }
        const contract = await this.swpClient.inspect();
        if (contract.fingerprint !== pendingWrite.contractFingerprint) {
          throw new PortalError("The STEP form changed after review. Stage and approve a new request.", "PENDING_WRITE_CONTRACT_CHANGED", 409);
        }
      } else {
        const payload = parsePotsdamPayload(pendingWrite);
        const config = await this.potsdamClient.inspectConfig();
        if (config.fingerprint !== pendingWrite.contractFingerprint) {
          throw new PortalError("The Potsdam report form changed after review. Stage and approve a new report.", "PENDING_WRITE_CONTRACT_CHANGED", 409);
        }
        for (const photo of payload.photos) {
          await verifyStagedPotsdamWastePhoto(photo);
        }
      }
    } catch (error) {
      await deletePendingWrite(pendingWriteHandle).catch(() => false);
      const failure = externalError(error, pendingWrite.kind === "swp_bulky_waste" ? "SWP" : "POTSDAM_WASTE");
      return wasteCommitResult(
        pendingWriteHandle,
        expectedKind,
        workflow,
        "notSent",
        `Pending action failed preflight: ${failure.message}`,
        this.now(),
        failure.status
      );
    }

    const claimed = await claimPendingWrite(pendingWriteHandle, this.now()).catch(() => null);
    if (!claimed || claimed.kind !== expectedKind) {
      return wasteCommitResult(
        pendingWriteHandle,
        expectedKind,
        workflow,
        "notSent",
        "Pending action could not be claimed because it expired or was already used.",
        this.now()
      );
    }

    let result: PendingWriteCommitResult;
    try {
      if (claimed.kind === "swp_bulky_waste") {
        const payload = parseSwpPayload(claimed);
        const committed = await this.swpClient.commit(payload.draft, claimed.contractFingerprint);
        result = {
          ...wasteCommitResult(
            pendingWriteHandle,
            claimed.kind,
            claimed.workflow,
            "succeeded",
            committed.summary,
            this.now(),
            committed.httpStatus
          ),
          ok: true,
          state: "request_received"
        };
      } else {
        const payload = parsePotsdamPayload(claimed);
        const committed = await this.potsdamClient.commit(payload.draft, payload.photos, claimed.contractFingerprint);
        result = {
          ...wasteCommitResult(
            pendingWriteHandle,
            claimed.kind,
            claimed.workflow,
            "succeeded",
            committed.summary,
            this.now(),
            committed.httpStatus
          ),
          ok: true,
          state: "awaiting_email_confirmation",
          reference: committed.reportId,
          warnings: ["Open the Potsdam email and activate the report before its link expires."]
        };
      }
    } catch (error) {
      const failure = externalError(error, claimed.kind === "swp_bulky_waste" ? "SWP" : "POTSDAM_WASTE");
      const outcome = wasteFailureOutcome(error);
      result = wasteCommitResult(
        pendingWriteHandle,
        claimed.kind,
        claimed.workflow,
        outcome,
        outcome === "outcomeUncertain"
          ? `${failure.message} The final outcome is uncertain. Do not retry automatically.`
          : failure.message,
        this.now(),
        failure.status,
        failure.details?.warnings
      );
    }
    const cleanupFailed = await this.cleanupClaimedPendingWrite(pendingWriteHandle)
      .then(() => false)
      .catch(() => true);
    if (cleanupFailed) {
      result.warnings = [...(result.warnings ?? []), localCleanupWarning()];
    }
    return result;
  }

  private async maintainPendingWrites(now = this.now()): Promise<void> {
    try {
      await deleteExpiredPendingWrites(now);
    } catch {
      throw new PortalError("Local pending-action maintenance failed.", "PENDING_WRITE_STORAGE_ERROR");
    }
  }

  private async resolveBulkyWastePickup(input: BulkyWastePickupInput): Promise<WastePreparation<ResolvedSwpDraft>> {
    const missingFields: string[] = [];
    const validationIssues: string[] = [];
    const warnings = ["The earliest pickup date is not a fixed appointment; STEP may communicate the collection date separately."];
    const fieldSources = explicitFieldSources(input.contact);
    if (input.contractId) fieldSources.contractId = "explicit";
    fieldSources.earliestPickupDate = "explicit";
    fieldSources.items = "explicit";
    if (input.pickupAddress) {
      for (const key of ["street", "houseNumber", "postalCode", "city"] as const) {
        fieldSources[`pickupAddress.${key}`] = "explicit";
      }
    }
    if (input.placement) fieldSources.placement = "explicit";
    if (input.note) fieldSources.note = "explicit";
    if (input.allotmentReference) fieldSources.allotmentReference = "explicit";
    const needsAddress = !completeAddress(input.contact);
    const needsDefaults = Boolean(input.contractId)
      || needsAddress
      || !clean(input.contact?.salutation)
      || !clean(input.contact?.lastName)
      || !clean(input.contact?.email);
    const defaults = needsDefaults ? await this.safeDefaults(input.contractId) : emptyDefaults();
    if (needsDefaults) {
      validationIssues.push(...applicableDefaultIssues(defaults, input.contact, needsAddress));
    }
    const contact = mergeContact(input.contact, defaults, fieldSources);

    requireValue(contact.salutation, "contact.salutation", missingFields);
    requireValue(contact.lastName, "contact.lastName", missingFields);
    requireValue(contact.email, "contact.email", missingFields);
    const address = requireCompleteAddress(contact.address, "contact", missingFields);
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      validationIssues.push("contact.email must be a valid email address.");
    }
    if (!validIsoDate(input.earliestPickupDate)) {
      validationIssues.push("earliestPickupDate must be a real calendar date in YYYY-MM-DD format.");
    } else if (input.earliestPickupDate < berlinDate(this.now())) {
      validationIssues.push("earliestPickupDate must be today or later in Europe/Berlin.");
    }
    validateBulkyItems(input.items, validationIssues);
    if (input.pickupAddress && !isCompleteAddress(input.pickupAddress)) {
      validationIssues.push("pickupAddress must contain street, houseNumber, postalCode, and city.");
    } else if (input.pickupAddress && !/^\d{5}$/.test(input.pickupAddress.postalCode)) {
      validationIssues.push("pickupAddress.postalCode must contain exactly five digits.");
    }

    let contract;
    try {
      contract = await this.swpClient.inspect();
    } catch (error) {
      throw externalError(error, "SWP");
    }

    const draft = missingFields.length === 0 && validationIssues.length === 0 && address
      ? toSwpDraft(input, contact, address)
      : undefined;
    const review = draft ? bulkyWasteReview(draft) : [];
    return {
      ok: Boolean(draft),
      preparedOnly: true,
      willSend: false,
      workflow: "bulky_waste_pickup",
      draft,
      fieldSources,
      missingFields,
      validationIssues: unique(validationIssues),
      warnings,
      review,
      privacyUrls: [SWP_FORM_URL, SWP_PRIVACY_URL],
      ...(defaults.candidates.length > 0 ? { contractCandidates: defaults.candidates } : {}),
      remoteFingerprint: contract.fingerprint
    };
  }

  private async resolveAbandonedWasteReport(
    input: AbandonedWasteReportInput,
    stagingDirectory: string
  ): Promise<WastePreparation<PreparedPotsdamPayload>> {
    const missingFields: string[] = [];
    const validationIssues: string[] = [];
    const warnings = [
      "The city report is not active until the emailed confirmation link is opened.",
      "The report location, description, and normalized photos may become publicly visible."
    ];
    const fieldSources = explicitFieldSources(input.contact);
    if (input.contractId) fieldSources.contractId = "explicit";
    fieldSources.description = "explicit";
    fieldSources.photoPaths = "explicit";
    fieldSources.privacyConsent = "explicit";
    fieldSources.category = "derived";
    fieldSources.normalizedPhotos = "derived";
    const needsLocationDefault = !input.location;
    const needsDefaults = Boolean(input.contractId) || needsLocationDefault || !clean(input.contact?.email);
    const defaults = needsDefaults ? await this.safeDefaults(input.contractId) : emptyDefaults();
    if (needsDefaults) {
      validationIssues.push(...applicableDefaultIssues(defaults, input.contact, needsLocationDefault));
    }
    const contact = mergeContact(input.contact, defaults, fieldSources);
    requireValue(contact.email, "contact.email", missingFields);
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
      validationIssues.push("contact.email must be a valid email address.");
    }
    if (input.contact?.phone && !/^\d+$/.test(input.contact.phone)) {
      validationIssues.push("contact.phone may contain digits only for Potsdam reports.");
    }
    const reporterPhone = contact.phone && /^\d+$/.test(contact.phone) ? contact.phone : undefined;
    if (!input.privacyConsent) {
      validationIssues.push("privacyConsent must be true.");
    }

    let config: PotsdamWasteConfig;
    try {
      config = await this.potsdamClient.inspectConfig();
    } catch (error) {
      throw externalError(error, "POTSDAM_WASTE");
    }
    const description = clean(input.description);
    if (!description) {
      missingFields.push("description");
    } else if (description.length > Math.min(500, config.maxDescriptionChars)) {
      validationIssues.push(`description must be at most ${Math.min(500, config.maxDescriptionChars)} characters.`);
    }
    if (!Array.isArray(input.photoPaths) || input.photoPaths.length < 1 || input.photoPaths.length > Math.min(3, config.photoRules.maxCount)) {
      validationIssues.push(`photoPaths must contain between 1 and ${Math.min(3, config.photoRules.maxCount)} photos.`);
    }
    if (!config.photoRules.acceptedInputMimeTypes.includes("image/jpeg")) {
      validationIssues.push("The live Potsdam form does not currently accept the normalized JPEG photo format.");
    }

    let location: PotsdamWasteLocation | undefined;
    try {
      if (input.location && typeof input.location.address === "string") {
        location = await this.potsdamClient.geocodeAddress(input.location.address, config);
        fieldSources.location = "explicit";
      } else if (input.location && "latitude" in input.location) {
        location = await this.potsdamClient.previewCoordinates({
          latitude: input.location.latitude,
          longitude: input.location.longitude
        }, config);
        if (input.location.label) {
          location = { ...location, displayAddress: input.location.label };
        }
        fieldSources.location = "explicit";
      } else {
        const address = requireCompleteAddress(defaults.contact.address, "location", missingFields);
        if (address) {
          location = await this.potsdamClient.geocodeAddress(formatAddress(address), config);
          fieldSources.location = "portal_contract";
        }
      }
    } catch (error) {
      throw externalError(error, "POTSDAM_WASTE");
    }

    const photos: PotsdamWastePhoto[] = [];
    if (Array.isArray(input.photoPaths) && input.photoPaths.length >= 1 && input.photoPaths.length <= Math.min(3, config.photoRules.maxCount)) {
      for (const photoPath of input.photoPaths) {
        try {
          const photo = await stagePotsdamWastePhoto(photoPath, stagingDirectory);
          photos.push(photo);
          if (photo.byteLength > config.photoRules.maxOutputBytes) {
            validationIssues.push("A normalized photo exceeds the current live photo-size limit.");
          }
        } catch (error) {
          throw externalError(error, "POTSDAM_WASTE");
        }
      }
    }

    const draft: PotsdamWasteDraft | undefined = missingFields.length === 0
      && validationIssues.length === 0
      && location
      && contact.email
      && description
      && photos.length > 0
      ? {
          location: { latitude: location.latitude, longitude: location.longitude },
          description,
          reporterEmail: contact.email,
          ...(contact.firstName ? { reporterFirstName: contact.firstName } : {}),
          ...(contact.lastName ? { reporterLastName: contact.lastName } : {}),
          ...(reporterPhone ? { reporterPhone } : {}),
          privacyConsent: true
        }
      : undefined;
    const content = draft && location ? { draft, location, photos } : undefined;
    const payload: PreparedPotsdamPayload | undefined = content;
    const review = payload ? abandonedWasteReview(payload, input.photoPaths) : [];
    return {
      ok: Boolean(payload),
      preparedOnly: true,
      willSend: false,
      workflow: "abandoned_waste_report",
      draft: payload,
      fieldSources,
      missingFields: unique(missingFields),
      validationIssues: unique(validationIssues),
      warnings,
      review,
      privacyUrls: [POTSDAM_REPORT_INFO_URL, POTSDAM_PRIVACY_URL],
      ...(defaults.candidates.length > 0 ? { contractCandidates: defaults.candidates } : {}),
      remoteFingerprint: config.fingerprint
    };
  }

  private async safeDefaults(contractId?: string): Promise<PortalWasteDefaults> {
    try {
      return await this.defaultsProvider.resolve(contractId);
    } catch (error) {
      return {
        contact: {},
        fieldSources: {},
        candidates: [],
        validationIssues: ["Portal defaults are unavailable. Provide explicit contact and location values or restore portal access."]
      };
    }
  }
}

function toSwpDraft(
  input: BulkyWastePickupInput,
  contact: ReturnType<typeof mergeContact>,
  address: WasteAddress
): ResolvedSwpDraft {
  const salutation = contact.salutation === "female" ? "mrs" : contact.salutation === "male" ? "mr" : "none";
  return {
    contact: {
      salutation,
      surname: contact.lastName!,
      ...(contact.firstName ? { firstName: contact.firstName } : {}),
      address,
      email: contact.email!,
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(input.allotmentReference ? { customerReference: input.allotmentReference } : {})
    },
    ...(input.pickupAddress ? { pickupAddress: input.pickupAddress } : {}),
    items: input.items.map(toSwpItem),
    earliestPickupDate: input.earliestPickupDate,
    ...(input.placement ? { placement: input.placement } : {}),
    ...(input.note ? { message: input.note } : {})
  };
}

function toSwpItem(item: BulkyWasteItem): SwpItem {
  if (item.kind === "floor_covering") {
    return { kind: "floor_covering", areaSquareMetres: item.squareMeters };
  }
  const mappedKind = item.kind === "table_table_tennis"
    ? "table"
    : item.kind === "refrigerator_freezer"
      ? "fridge_freezer"
      : item.kind === "large_electrical_over_50cm"
        ? "electrical_over_50cm"
        : item.kind;
  if ("description" in item) {
    return { kind: mappedKind as Extract<SwpItem, { description: string }>["kind"], description: item.description, quantity: item.quantity };
  }
  return { kind: mappedKind as Extract<SwpItem, { quantity: number; description?: never }>["kind"], quantity: item.quantity };
}

function validateBulkyItems(items: BulkyWasteItem[], issues: string[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push("items must contain at least one supported bulky-waste item.");
    return;
  }
  const kinds = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.kind !== "string") {
      issues.push("items contains an invalid item.");
      continue;
    }
    if (!SUPPORTED_BULKY_ITEM_KINDS.has(item.kind)) {
      issues.push(`Unsupported bulky-waste item kind '${item.kind}'.`);
      continue;
    }
    kinds.add(item.kind);
    if (item.kind === "floor_covering") {
      if (!Number.isFinite(item.squareMeters) || item.squareMeters <= 0) {
        issues.push("floor_covering.squareMeters must be positive.");
      }
    } else if (!(Number.isSafeInteger(item.quantity) && item.quantity > 0)) {
      issues.push(`${item.kind}.quantity must be a positive integer.`);
    }
    if ("description" in item && !clean(item.description)) {
      issues.push(`${item.kind}.description is required.`);
    }
  }
  if (kinds.has("other_small_electrical") && !kinds.has("refrigerator_freezer") && !kinds.has("washer_dryer")) {
    issues.push("The current STEP form allows other small electrical devices only with a refrigerator/freezer or washer/dryer.");
  }
}

function mergeContact(
  explicit: WasteContactOverrides | undefined,
  defaults: PortalWasteDefaults,
  sources: Record<string, "explicit" | "portal_profile" | "portal_contract" | "derived">
) {
  const contact = {
    salutation: explicit?.salutation ?? defaults.contact.salutation,
    firstName: clean(explicit?.firstName) ?? defaults.contact.firstName,
    lastName: clean(explicit?.lastName) ?? defaults.contact.lastName,
    email: clean(explicit?.email) ?? defaults.contact.email,
    phone: clean(explicit?.phone) ?? defaults.contact.phone,
    address: {
      street: clean(explicit?.street) ?? defaults.contact.address?.street,
      houseNumber: clean(explicit?.houseNumber) ?? defaults.contact.address?.houseNumber,
      postalCode: clean(explicit?.postalCode) ?? defaults.contact.address?.postalCode,
      city: clean(explicit?.city) ?? defaults.contact.address?.city
    }
  };
  for (const [key, source] of Object.entries(defaults.fieldSources)) {
    if (!sources[key]) {
      sources[key] = source;
    }
  }
  return contact;
}

function explicitFieldSources(contact: WasteContactOverrides | undefined) {
  const sources: Record<string, "explicit" | "portal_profile" | "portal_contract" | "derived"> = {};
  if (!contact) {
    return sources;
  }
  for (const [key, value] of Object.entries(contact)) {
    if (clean(value)) {
      sources[`contact.${key}`] = "explicit";
    }
  }
  return sources;
}

function requireCompleteAddress(
  value: Partial<WasteAddress> | undefined,
  prefix: string,
  missing: string[]
): WasteAddress | undefined {
  if (!value) {
    for (const key of ["street", "houseNumber", "postalCode", "city"] as const) {
      missing.push(`${prefix}.${key}`);
    }
    return undefined;
  }
  for (const key of ["street", "houseNumber", "postalCode", "city"] as const) {
    if (!clean(value[key])) {
      missing.push(`${prefix}.${key}`);
    }
  }
  if (!isCompleteAddress(value)) {
    return undefined;
  }
  if (!/^\d{5}$/.test(value.postalCode)) {
    missing.push(`${prefix}.postalCode`);
    return undefined;
  }
  return value;
}

function completeAddress(contact: WasteContactOverrides | undefined): boolean {
  return Boolean(contact && isCompleteAddress(contact));
}

function isCompleteAddress(value: Partial<WasteAddress>): value is WasteAddress {
  return Boolean(clean(value.street) && clean(value.houseNumber) && clean(value.postalCode) && clean(value.city));
}

function requireValue(value: unknown, field: string, missing: string[]): void {
  if (!clean(value)) {
    missing.push(field);
  }
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function berlinDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function bulkyWasteReview(draft: ResolvedSwpDraft): string[] {
  const pickup = draft.pickupAddress ?? draft.contact.address;
  return [
    `Contact: ${[draft.contact.firstName, draft.contact.surname].filter(Boolean).join(" ")} <${draft.contact.email}>${draft.contact.phone ? `, ${draft.contact.phone}` : ""}`,
    `Contact address: ${formatAddress(draft.contact.address)}`,
    `Pickup address: ${formatAddress(pickup)}`,
    `Earliest pickup date: ${draft.earliestPickupDate}`,
    ...draft.items.map((item) => `Item: ${describeSwpItem(item)}`),
    ...(draft.placement ? [`Placement: ${draft.placement}`] : []),
    ...(draft.message ? [`Note: ${draft.message}`] : []),
    "STEP will receive the contact, address, item, and scheduling details shown above."
  ];
}

function abandonedWasteReview(payload: PreparedPotsdamPayload, sourcePaths: string[]): string[] {
  return [
    `Category: Abfall`,
    `Location: ${payload.location.displayAddress} (${payload.location.latitude}, ${payload.location.longitude})`,
    `Description: ${payload.draft.description}`,
    `Contact email: ${payload.draft.reporterEmail}`,
    ...payload.photos.map((photo, index) => `Normalized public photo: ${path.basename(sourcePaths[index] ?? photo.filename)} (${photo.width}x${photo.height}, ${photo.byteLength} bytes)`),
    "The location, description, and normalized photos may become publicly visible.",
    "After the city receives the report, activate it using the emailed confirmation link."
  ];
}

function describeSwpItem(item: SwpItem): string {
  if (item.kind === "floor_covering") {
    return `${item.kind}, ${item.areaSquareMetres} m²`;
  }
  if ("description" in item) {
    return `${item.kind}, ${item.quantity} x ${item.description}`;
  }
  return `${item.kind}, quantity ${item.quantity}`;
}

function formatAddress(address: WasteAddress): string {
  return `${address.street} ${address.houseNumber}, ${address.postalCode} ${address.city}`;
}

function stageResultFromPreparation(
  kind: PendingWasteWrite["kind"],
  prepared: WastePreparation<unknown>
): StagedWasteActionResult {
  return {
    ok: false,
    workflow: prepared.workflow,
    kind,
    requiresExplicitApproval: false,
    validationIssues: unique([...prepared.missingFields.map((field) => `Missing required field '${field}'.`), ...prepared.validationIssues]),
    warnings: prepared.warnings,
    review: prepared.review,
    privacyUrls: prepared.privacyUrls,
    ...(prepared.contractCandidates ? { contractCandidates: prepared.contractCandidates } : {})
  };
}

function stageReview(
  destination: string,
  review: string[],
  expiresAt: Date,
  prominentWarning?: string
): string[] {
  return [
    ...(prominentWarning ? [prominentWarning] : []),
    `Destination: ${destination}`,
    ...review,
    `Approval deadline: ${expiresAt.toISOString()}`
  ];
}

function emptyDefaults(): PortalWasteDefaults {
  return { contact: {}, fieldSources: {}, candidates: [], validationIssues: [] };
}

function applicableDefaultIssues(
  defaults: PortalWasteDefaults,
  explicit: WasteContactOverrides | undefined,
  needsContractAddress: boolean
): string[] {
  return defaults.validationIssues.filter((issue) => {
    if (!needsContractAddress && issue.startsWith("Multiple high-confidence portal contract addresses")) {
      return false;
    }
    const field = /for contact\.(salutation|firstName|lastName|email|phone)\b/.exec(issue)?.[1] as
      | keyof WasteContactOverrides
      | undefined;
    return !field || !clean(explicit?.[field]);
  });
}

function parseSwpPayload(pendingWrite: PendingWasteWrite): PreparedSwpPayload {
  const payload = pendingWrite.payload as Partial<PreparedSwpPayload> | undefined;
  if (pendingWrite.kind !== "swp_bulky_waste" || !payload?.draft || typeof payload.draft !== "object") {
    throw new PortalError("Stored STEP pending action is invalid.", "PENDING_WRITE_TAMPERED", 409);
  }
  return payload as PreparedSwpPayload;
}

function parsePotsdamPayload(pendingWrite: PendingWasteWrite): PreparedPotsdamPayload {
  const payload = pendingWrite.payload as Partial<PreparedPotsdamPayload> | undefined;
  if (
    pendingWrite.kind !== "potsdam_abandoned_waste"
    || !payload?.draft
    || !payload.location
    || !Array.isArray(payload.photos)
    || !sameStagedPhotos(payload.photos, pendingWrite)
  ) {
    throw new PortalError("Stored Potsdam report pending action is invalid.", "PENDING_WRITE_TAMPERED", 409);
  }
  return payload as PreparedPotsdamPayload;
}

function sameStagedPhotos(photos: PotsdamWastePhoto[], pendingWrite: PendingWasteWrite): boolean {
  const metadata = pendingWrite.artifacts ?? [];
  return photos.length === metadata.length && photos.every((photo, index) => {
    const stored = metadata[index];
    return stored?.filePath === photo.path
      && stored.filename === photo.filename
      && stored.mimeType === photo.mimeType
      && stored.byteLength === photo.byteLength
      && stored.sha256 === photo.sha256;
  });
}

function externalError(error: unknown, prefix: "SWP" | "POTSDAM_WASTE"): PortalError {
  if (error instanceof PortalError) {
    return error;
  }
  if (error instanceof SwpClientError || error instanceof PotsdamWasteError) {
    const ambiguous = error.code === "AMBIGUOUS_WRITE";
    return new PortalError(
      error.message,
      `${prefix}_${error.code}`,
      error.status,
      ambiguous ? {
        outcomeUncertain: true,
        warnings: ["The one-time pending action is consumed. Do not retry automatically; verify the external response or activation email before staging a replacement."]
      } : undefined
    );
  }
  return new PortalError(
    prefix === "SWP" ? "The STEP bulky-waste service failed." : "The Potsdam abandoned-waste service failed.",
    `${prefix}_UNKNOWN`
  );
}

function wasteWorkflow(kind: PendingWasteWrite["kind"]): PendingWasteWrite["workflow"] {
  return kind === "swp_bulky_waste" ? "bulky_waste_pickup" : "abandoned_waste_report";
}

function wasteCommitResult(
  pendingWriteHandle: string,
  kind: PendingWasteWrite["kind"],
  workflow: PendingWasteWrite["workflow"],
  outcome: WriteOutcome,
  summary: string,
  completedAt: Date,
  status?: number,
  warnings?: string[]
): PendingWriteCommitResult {
  return {
    ok: outcome === "succeeded",
    outcome,
    pendingWriteHandle,
    kind,
    workflow,
    completedAt: completedAt.toISOString(),
    summary,
    ...(status === undefined ? {} : { status }),
    ...(warnings?.length ? { warnings } : {})
  };
}

function wasteFailureOutcome(error: unknown): Exclude<WriteOutcome, "succeeded"> {
  if (error instanceof PortalError) {
    return error.details?.outcomeUncertain ? "outcomeUncertain" : "notSent";
  }
  if (error instanceof SwpClientError) {
    if (error.code === "AMBIGUOUS_WRITE") {
      return "outcomeUncertain";
    }
    if (error.code === "VALIDATION_FAILED" || (error.code === "HTTP_ERROR" && Boolean(error.status && error.status < 500))) {
      return "rejected";
    }
    return "notSent";
  }
  if (error instanceof PotsdamWasteError) {
    if (error.code === "AMBIGUOUS_WRITE") {
      return "outcomeUncertain";
    }
    if (
      error.code === "MAX_REPORTS_REACHED"
      || error.code === "CREATE_FAILED"
      || (error.code === "PHOTO_REQUIRED" && error.status !== undefined)
    ) {
      return "rejected";
    }
    return "notSent";
  }
  return "outcomeUncertain";
}

function localCleanupWarning(): string {
  return "The external attempt completed, but local pending-action cleanup could not be verified. Do not retry automatically.";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
