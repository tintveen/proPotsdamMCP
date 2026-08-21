import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PortalError } from "../errors.js";
import {
  PotsdamWasteClient,
  PotsdamWasteError,
  stagePotsdamWastePhoto,
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
  WASTE_CONFIRMATION_VERSION,
  WASTE_CONFIRMATION_TTL_MS,
  claimWasteConfirmation,
  deleteExpiredWasteConfirmations,
  deleteWasteConfirmationArtifacts,
  ensureWastePhotoStagingDir,
  saveWasteConfirmation,
  type StoredWasteConfirmation
} from "./confirmation-storage.js";
import type {
  AbandonedWasteReportInput,
  BulkyWasteItem,
  BulkyWastePickupInput,
  PortalWasteDefaults,
  PortalWasteDefaultsProvider,
  WasteAddress,
  WasteCommitRequest,
  WasteCommitResult,
  WasteContactOverrides,
  WastePreparation,
  WasteServiceLike
} from "./types.js";

const CONFIRMATION_AUTH_KEY = randomBytes(32);
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
  confirmationId?: () => string;
}

interface PreparedSwpPayload {
  draft: ResolvedSwpDraft;
  approvedDigest: string;
}

interface PreparedPotsdamPayload {
  draft: PotsdamWasteDraft;
  location: PotsdamWasteLocation;
  photos: PotsdamWastePhoto[];
  approvedDigest: string;
}

export class WasteService implements WasteServiceLike {
  private readonly defaultsProvider: PortalWasteDefaultsProvider;
  private readonly swpClient: SwpClientLike;
  private readonly potsdamClient: PotsdamClientLike;
  private readonly now: () => Date;
  private readonly confirmationId: () => string;
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(portalClient: PortalDefaultsClient, dependencies: WasteServiceDependencies = {}) {
    this.defaultsProvider = dependencies.defaultsProvider ?? new PortalClientWasteDefaultsProvider(portalClient);
    this.swpClient = dependencies.swpClient ?? new SwpClient();
    this.potsdamClient = dependencies.potsdamClient ?? new PotsdamWasteClient();
    this.now = dependencies.now ?? (() => new Date());
    this.confirmationId = dependencies.confirmationId ?? randomUUID;
  }

  async prepareBulkyWastePickup(input: BulkyWastePickupInput): Promise<WastePreparation<ResolvedSwpDraft>> {
    await this.maintainConfirmations();
    return this.resolveBulkyWastePickup(input);
  }

  async requestBulkyWastePickupCommit(input: BulkyWastePickupInput): Promise<WasteCommitRequest> {
    const prepared = await this.resolveBulkyWastePickup(input);
    if (!prepared.ok || !prepared.draft || !prepared.remoteFingerprint) {
      return commitRequestFromPreparation(prepared);
    }

    const confirmationId = this.confirmationId();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + WASTE_CONFIRMATION_TTL_MS);
    const content = { draft: prepared.draft };
    const payload: PreparedSwpPayload = {
      ...content,
      approvedDigest: approvalDigest("swp_bulky_waste", prepared.remoteFingerprint, content)
    };
    await this.maintainConfirmations(createdAt);
    await this.saveConfirmation({
      version: WASTE_CONFIRMATION_VERSION,
      confirmationId,
      kind: "swp_bulky_waste",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remoteFingerprint: prepared.remoteFingerprint,
      payload,
      review: prepared.review
    });
    this.scheduleExpiryCleanup(confirmationId, WASTE_CONFIRMATION_TTL_MS);

    return {
      ok: true,
      workflow: "bulky_waste_pickup",
      confirmationId,
      expiresAt: expiresAt.toISOString(),
      validationIssues: [],
      warnings: prepared.warnings,
      review: prepared.review,
      privacyUrls: prepared.privacyUrls
    };
  }

  async commitBulkyWastePickup(confirmationId: string): Promise<WasteCommitResult> {
    const claimed = await this.claimConfirmation(confirmationId);
    if (claimed.status === "missing") {
      throw new PortalError("Waste confirmation was not found or has already been used.", "CONFIRMATION_NOT_FOUND", 404);
    }
    if (claimed.status === "expired") {
      throw new PortalError("Waste confirmation expired. Prepare a new request.", "CONFIRMATION_EXPIRED", 410);
    }

    this.cancelExpiryCleanup(confirmationId);
    const confirmation = claimed.confirmation;
    let outcome: WasteCommitResult | undefined;
    let failure: PortalError | undefined;
    try {
      if (confirmation.kind !== "swp_bulky_waste") {
        throw new PortalError("Confirmation belongs to a different waste workflow.", "CONFIRMATION_KIND_MISMATCH", 409);
      }
      const payload = parseSwpPayload(confirmation);
      if (payload.draft.earliestPickupDate < berlinDate(this.now())) {
        throw new PortalError(
          "The approved earliest pickup date is now in the past. Prepare a new request.",
          "CONFIRMATION_STALE",
          409
        );
      }
      const result = await this.swpClient.commit(payload.draft, confirmation.remoteFingerprint);
      outcome = {
        ok: true,
        workflow: "bulky_waste_pickup",
        state: "request_received",
        committedAt: this.now().toISOString(),
        status: result.httpStatus,
        summary: result.summary
      };
    } catch (error) {
      failure = externalError(error, "SWP");
    }
    const cleanupFailed = await this.cleanupConfirmation(confirmationId);
    if (failure) {
      throw failure;
    }
    if (!outcome) {
      throw new PortalError("The STEP bulky-waste service failed.", "SWP_UNKNOWN");
    }
    if (cleanupFailed) {
      outcome.warnings = [...(outcome.warnings ?? []), localCleanupWarning()];
    }
    return outcome;
  }

  async prepareAbandonedWasteReport(input: AbandonedWasteReportInput): Promise<WastePreparation<unknown>> {
    await this.maintainConfirmations();
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

  async requestAbandonedWasteReportCommit(input: AbandonedWasteReportInput): Promise<WasteCommitRequest> {
    const confirmationId = this.confirmationId();
    const stagingDirectory = await this.ensurePhotoStaging(confirmationId);
    let prepared: WastePreparation<PreparedPotsdamPayload>;
    try {
      prepared = await this.resolveAbandonedWasteReport(input, stagingDirectory);
      if (!prepared.ok || !prepared.draft || !prepared.remoteFingerprint) {
        await deleteWasteConfirmationArtifacts(confirmationId);
        return commitRequestFromPreparation(prepared);
      }

      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + WASTE_CONFIRMATION_TTL_MS);
      await this.maintainConfirmations(createdAt);
      await this.saveConfirmation({
        version: WASTE_CONFIRMATION_VERSION,
        confirmationId,
        kind: "potsdam_abandoned_waste",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        remoteFingerprint: prepared.remoteFingerprint,
        payload: prepared.draft,
        review: prepared.review,
        stagedPhotos: prepared.draft.photos.map((photo) => ({
          stagedPath: photo.path,
          filename: photo.filename,
          mimeType: photo.mimeType,
          byteLength: photo.byteLength,
          sha256: photo.sha256
        }))
      });
      this.scheduleExpiryCleanup(confirmationId, WASTE_CONFIRMATION_TTL_MS);

      return {
        ok: true,
        workflow: "abandoned_waste_report",
        confirmationId,
        expiresAt: expiresAt.toISOString(),
        validationIssues: [],
        warnings: prepared.warnings,
        review: prepared.review,
        privacyUrls: prepared.privacyUrls
      };
    } catch (error) {
      await deleteWasteConfirmationArtifacts(confirmationId);
      throw externalError(error, "POTSDAM_WASTE");
    }
  }

  async commitAbandonedWasteReport(confirmationId: string): Promise<WasteCommitResult> {
    const claimed = await this.claimConfirmation(confirmationId);
    if (claimed.status === "missing") {
      throw new PortalError("Waste confirmation was not found or has already been used.", "CONFIRMATION_NOT_FOUND", 404);
    }
    if (claimed.status === "expired") {
      throw new PortalError("Waste confirmation expired. Prepare a new report.", "CONFIRMATION_EXPIRED", 410);
    }

    this.cancelExpiryCleanup(confirmationId);
    const confirmation = claimed.confirmation;
    let outcome: WasteCommitResult | undefined;
    let failure: PortalError | undefined;
    try {
      if (confirmation.kind !== "potsdam_abandoned_waste") {
        throw new PortalError("Confirmation belongs to a different waste workflow.", "CONFIRMATION_KIND_MISMATCH", 409);
      }
      const payload = parsePotsdamPayload(confirmation);
      const result = await this.potsdamClient.commit(payload.draft, payload.photos, confirmation.remoteFingerprint);
      outcome = {
        ok: true,
        workflow: "abandoned_waste_report",
        state: "awaiting_email_confirmation",
        committedAt: this.now().toISOString(),
        status: result.httpStatus,
        summary: result.summary,
        reference: result.reportId,
        warnings: ["Open the Potsdam email and activate the report before its link expires."]
      };
    } catch (error) {
      failure = externalError(error, "POTSDAM_WASTE");
    }
    const cleanupFailed = await this.cleanupConfirmation(confirmationId);
    if (failure) {
      throw failure;
    }
    if (!outcome) {
      throw new PortalError("The Potsdam abandoned-waste service failed.", "POTSDAM_WASTE_UNKNOWN");
    }
    if (cleanupFailed) {
      outcome.warnings = [...(outcome.warnings ?? []), localCleanupWarning()];
    }
    return outcome;
  }

  private scheduleExpiryCleanup(confirmationId: string, delayMs: number): void {
    this.cancelExpiryCleanup(confirmationId);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(confirmationId);
      void deleteWasteConfirmationArtifacts(confirmationId).catch(() => undefined);
    }, Math.max(0, delayMs) + 50);
    timer.unref?.();
    this.cleanupTimers.set(confirmationId, timer);
  }

  private cancelExpiryCleanup(confirmationId: string): void {
    const timer = this.cleanupTimers.get(confirmationId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(confirmationId);
    }
  }

  private async cleanupConfirmation(confirmationId: string): Promise<boolean> {
    try {
      await deleteWasteConfirmationArtifacts(confirmationId);
      return false;
    } catch {
      return true;
    }
  }

  private async maintainConfirmations(now = this.now()): Promise<void> {
    try {
      await deleteExpiredWasteConfirmations(now);
    } catch {
      throw new PortalError("Local waste confirmation maintenance failed.", "WASTE_CONFIRMATION_STORAGE_ERROR");
    }
  }

  private async saveConfirmation(confirmation: StoredWasteConfirmation): Promise<void> {
    try {
      await saveWasteConfirmation(confirmation);
    } catch {
      throw new PortalError("The waste confirmation could not be stored safely.", "WASTE_CONFIRMATION_STORAGE_ERROR");
    }
  }

  private async claimConfirmation(
    confirmationId: string
  ): Promise<Awaited<ReturnType<typeof claimWasteConfirmation>>> {
    try {
      return await claimWasteConfirmation(confirmationId, this.now());
    } catch {
      throw new PortalError("The waste confirmation could not be read safely.", "WASTE_CONFIRMATION_STORAGE_ERROR");
    }
  }

  private async ensurePhotoStaging(confirmationId: string): Promise<string> {
    try {
      return await ensureWastePhotoStagingDir(confirmationId);
    } catch {
      throw new PortalError("The waste-photo staging area could not be created safely.", "WASTE_CONFIRMATION_STORAGE_ERROR");
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
    const payload: PreparedPotsdamPayload | undefined = content
      ? {
          ...content,
          approvedDigest: approvalDigest("potsdam_abandoned_waste", config.fingerprint, content)
        }
      : undefined;
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

function commitRequestFromPreparation(prepared: WastePreparation<unknown>): WasteCommitRequest {
  return {
    ok: false,
    workflow: prepared.workflow,
    validationIssues: unique([...prepared.missingFields.map((field) => `Missing required field '${field}'.`), ...prepared.validationIssues]),
    warnings: prepared.warnings,
    review: prepared.review,
    privacyUrls: prepared.privacyUrls,
    ...(prepared.contractCandidates ? { contractCandidates: prepared.contractCandidates } : {})
  };
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

function approvalDigest(kind: string, fingerprint: string, content: unknown): string {
  return createHmac("sha256", CONFIRMATION_AUTH_KEY)
    .update(JSON.stringify({ kind, fingerprint, content }))
    .digest("hex");
}

function equalDigest(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function parseSwpPayload(confirmation: StoredWasteConfirmation): PreparedSwpPayload {
  const payload = confirmation.payload as Partial<PreparedSwpPayload> | undefined;
  if (!payload?.draft || typeof payload.approvedDigest !== "string") {
    throw new PortalError("Stored STEP confirmation is invalid.", "CONFIRMATION_TAMPERED", 409);
  }
  const expected = approvalDigest("swp_bulky_waste", confirmation.remoteFingerprint, { draft: payload.draft });
  if (!equalDigest(payload.approvedDigest, expected)) {
    throw new PortalError("Stored STEP confirmation was changed after approval.", "CONFIRMATION_TAMPERED", 409);
  }
  return payload as PreparedSwpPayload;
}

function parsePotsdamPayload(confirmation: StoredWasteConfirmation): PreparedPotsdamPayload {
  const payload = confirmation.payload as Partial<PreparedPotsdamPayload> | undefined;
  if (!payload?.draft || !payload.location || !Array.isArray(payload.photos) || typeof payload.approvedDigest !== "string") {
    throw new PortalError("Stored Potsdam report confirmation is invalid.", "CONFIRMATION_TAMPERED", 409);
  }
  const content = { draft: payload.draft, location: payload.location, photos: payload.photos };
  const expected = approvalDigest("potsdam_abandoned_waste", confirmation.remoteFingerprint, content);
  if (!equalDigest(payload.approvedDigest, expected) || !sameStagedPhotos(payload.photos, confirmation)) {
    throw new PortalError("Stored Potsdam report confirmation was changed after approval.", "CONFIRMATION_TAMPERED", 409);
  }
  return payload as PreparedPotsdamPayload;
}

function sameStagedPhotos(photos: PotsdamWastePhoto[], confirmation: StoredWasteConfirmation): boolean {
  const metadata = confirmation.stagedPhotos ?? [];
  return photos.length === metadata.length && photos.every((photo, index) => {
    const stored = metadata[index];
    return stored?.stagedPath === photo.path
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
        warnings: ["The one-time confirmation is consumed. Do not retry automatically; verify the external response or activation email before preparing a replacement."]
      } : undefined
    );
  }
  return new PortalError(
    prefix === "SWP" ? "The STEP bulky-waste service failed." : "The Potsdam abandoned-waste service failed.",
    `${prefix}_UNKNOWN`
  );
}

function localCleanupWarning(): string {
  return "The external request was accepted, but local confirmation cleanup could not be verified. Do not reuse this confirmation id.";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
