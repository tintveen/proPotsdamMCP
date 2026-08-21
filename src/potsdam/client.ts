import {
  POTSDAM_WASTE_CREATE_URL,
  POTSDAM_WASTE_GEOCODER_ORIGIN,
  POTSDAM_WASTE_PAGE_URL,
  createPotsdamWasteConfig,
  isWithinPotsdamBounds,
  parsePotsdamWastePage,
  parsePotsdamWastePhotoRules,
  semanticPotsdamWasteFingerprint
} from "./config.js";
import { verifyStagedPotsdamWastePhoto } from "./photo.js";
import type {
  PotsdamWasteCommitResult,
  PotsdamWasteConfig,
  PotsdamWasteCoordinates,
  PotsdamWasteDraft,
  PotsdamWasteLocation,
  PotsdamWastePhoto
} from "./types.js";
import { PotsdamWasteError } from "./types.js";

const POTSDAM_ORIGIN = new URL(POTSDAM_WASTE_PAGE_URL).origin;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_GEOCODER_BYTES = 2 * 1024 * 1024;
const MAX_CREATE_RESPONSE_BYTES = 512 * 1024;
const POTSDAM_UNCERTAIN_MESSAGE = "The Potsdam report outcome is uncertain because the final response could not be verified. The confirmation was consumed. Do not retry automatically; check for the activation email before preparing a replacement.";

interface GeocoderFeature {
  id?: unknown;
  type?: unknown;
  geometry?: {
    type?: unknown;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
}

export class PotsdamWasteClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async inspectConfig(): Promise<PotsdamWasteConfig> {
    const pageResponse = await this.fetchPinned(POTSDAM_WASTE_PAGE_URL, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml"
      }
    }, POTSDAM_ORIGIN, "CONFIG_FETCH_FAILED");
    if (!pageResponse.ok) {
      throw new PotsdamWasteError(
        `The Potsdam Mängelmelder configuration page returned HTTP ${pageResponse.status}.`,
        "CONFIG_FETCH_FAILED",
        pageResponse.status
      );
    }
    const html = await readLimitedText(pageResponse, MAX_HTML_BYTES, "Mängelmelder configuration page");
    const page = parsePotsdamWastePage(html);

    // Feature-specific chunks are at the end of the Next import list. Search
    // backwards and stop as soon as the live photo rule literals are found.
    for (const chunkPath of [...page.wizardChunkPaths].reverse()) {
      const chunkUrl = new URL(chunkPath, POTSDAM_ORIGIN);
      if (chunkUrl.origin !== POTSDAM_ORIGIN || !chunkUrl.pathname.startsWith("/_next/static/chunks/")) {
        throw new PotsdamWasteError("The page advertised an unsafe client-asset URL.", "CONFIG_INVALID");
      }
      let chunkResponse: Response;
      try {
        chunkResponse = await this.fetchPinned(chunkUrl.toString(), {
          method: "GET",
          headers: {
            accept: "application/javascript,text/javascript;q=0.9"
          }
        }, POTSDAM_ORIGIN, "CONFIG_FETCH_FAILED");
      } catch (error) {
        if (
          error instanceof PotsdamWasteError
          && (error.code === "UNSAFE_REDIRECT" || error.code === "ORIGIN_MISMATCH")
        ) {
          throw error;
        }
        continue;
      }
      if (!chunkResponse.ok) {
        continue;
      }
      const script = await readLimitedText(chunkResponse, MAX_SCRIPT_BYTES, "FlawReporterWizard client asset");
      const photoRules = parsePotsdamWastePhotoRules(script, page.photoRequired);
      if (photoRules) {
        return createPotsdamWasteConfig(page, photoRules);
      }
    }

    throw new PotsdamWasteError(
      "The live Mängelmelder photo constraints could not be verified from its client assets.",
      "CONFIG_INVALID"
    );
  }

  async geocodeAddress(
    query: string,
    config?: PotsdamWasteConfig
  ): Promise<PotsdamWasteLocation> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 4 || normalizedQuery.length > 300) {
      throw new PotsdamWasteError("Enter an address query between 4 and 300 characters.", "ADDRESS_INVALID");
    }
    const current = config ?? await this.inspectConfig();
    assertConfigSnapshot(current);
    const url = geocoderUrl(current, {
      query: normalizedQuery,
      bbox: [current.bounds.west, current.bounds.south, current.bounds.east, current.bounds.north].join(","),
      outputformat: "json"
    });
    const features = await this.fetchGeocoderFeatures(url);
    const inBounds = uniqueLocations(features
      .map((feature) => featureToLocation(feature, "address"))
      .filter((location): location is PotsdamWasteLocation => location !== null)
      .filter((location) => isWithinPotsdamBounds(location.latitude, location.longitude, current.bounds)));

    if (inBounds.length === 0) {
      if (features.length > 0) {
        throw new PotsdamWasteError("The address result is outside the Potsdam reporting area.", "LOCATION_OUT_OF_BOUNDS");
      }
      throw new PotsdamWasteError("No address matched the query.", "ADDRESS_NOT_FOUND");
    }
    if (inBounds.length !== 1) {
      throw new PotsdamWasteError(
        `The address is ambiguous (${inBounds.length} in-bounds matches). Add a house number or a more precise locality.`,
        "ADDRESS_AMBIGUOUS"
      );
    }
    return inBounds[0]!;
  }

  async previewCoordinates(
    coordinates: PotsdamWasteCoordinates,
    config?: PotsdamWasteConfig
  ): Promise<PotsdamWasteLocation> {
    const current = config ?? await this.inspectConfig();
    assertConfigSnapshot(current);
    assertCoordinates(coordinates, current);
    return {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      displayAddress: `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}`,
      source: "coordinates"
    };
  }

  async commit(
    draft: PotsdamWasteDraft,
    photos: PotsdamWastePhoto[],
    expectedFingerprint: string
  ): Promise<PotsdamWasteCommitResult> {
    // Always re-inspect first: ids, validation limits, and the GDZ/module
    // configuration may have changed since a confirmation was prepared.
    const current = await this.inspectConfig();
    if (current.fingerprint !== expectedFingerprint) {
      throw new PotsdamWasteError(
        "The Potsdam Mängelmelder configuration changed after preparation. Prepare and confirm the report again.",
        "CONFIG_CHANGED",
        409
      );
    }
    const normalized = validateDraft(draft, current);
    if (current.photoRules.required && photos.length === 0) {
      throw new PotsdamWasteError("At least one normalized photo is required.", "PHOTO_REQUIRED", 400);
    }
    if (photos.length > current.photoRules.maxCount) {
      throw new PotsdamWasteError(
        `At most ${current.photoRules.maxCount} photos may be submitted.`,
        "PHOTO_INVALID",
        400
      );
    }
    if (!current.photoRules.acceptedInputMimeTypes.includes("image/jpeg")) {
      throw new PotsdamWasteError("The live form no longer accepts normalized JPEG uploads.", "CONFIG_CHANGED", 409);
    }

    const verifiedPhotos = [];
    for (const photo of photos) {
      if (photo.byteLength > current.photoRules.maxOutputBytes) {
        throw new PotsdamWasteError("A staged photo exceeds the current live size limit.", "PHOTO_INVALID", 400);
      }
      verifiedPhotos.push(await verifyStagedPotsdamWastePhoto(photo));
    }

    const form = new FormData();
    form.append("flawReporterId", String(current.moduleId));
    form.append("latitude", String(normalized.location.latitude));
    form.append("longitude", String(normalized.location.longitude));
    form.append("categoryId", String(current.category.id));
    form.append("text", normalized.description);
    form.append("reporterEmail", normalized.reporterEmail);
    if (normalized.reporterFirstName) {
      form.append("reporterFirstname", normalized.reporterFirstName);
    }
    if (normalized.reporterLastName) {
      form.append("reporterName", normalized.reporterLastName);
    }
    if (normalized.reporterPhone) {
      form.append("reporterPhone", normalized.reporterPhone);
    }
    verifiedPhotos.forEach(({ photo, bytes }, index) => {
      const uploadBytes = new Uint8Array(bytes.byteLength);
      uploadBytes.set(bytes);
      form.append(
        `pictures[${index}]`,
        new Blob([uploadBytes], { type: "image/jpeg" }),
        photo.filename
      );
    });

    let response: Response;
    try {
      response = await this.fetchPinned(POTSDAM_WASTE_CREATE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "X-Language": "de"
        },
        body: form
      }, POTSDAM_ORIGIN, "CREATE_FAILED");
    } catch {
      throw new PotsdamWasteError(POTSDAM_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE");
    }
    let body: string;
    try {
      body = await readLimitedText(response, MAX_CREATE_RESPONSE_BYTES, "Mängelmelder create response");
    } catch {
      throw new PotsdamWasteError(POTSDAM_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE", response.status);
    }
    const parsedBody = parseOptionalJson(body);
    const apiErrorCode = isRecord(parsedBody) && typeof parsedBody.apiErrorCode === "string"
      ? parsedBody.apiErrorCode
      : undefined;
    if (apiErrorCode) {
      throw mapCreateError(response.status, parsedBody);
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new PotsdamWasteError(POTSDAM_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE", response.status);
      }
      throw mapCreateError(response.status, parsedBody);
    }
    const reportId = extractReportId(parsedBody);
    if (!reportId) {
      throw new PotsdamWasteError(POTSDAM_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE", response.status);
    }

    return {
      ok: true,
      state: "awaiting_email_confirmation",
      httpStatus: response.status,
      reportId,
      summary: "The report was accepted and is awaiting activation through the reporter email confirmation link."
    };
  }

  private async fetchGeocoderFeatures(url: URL): Promise<GeocoderFeature[]> {
    const response = await this.fetchPinned(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/geo+json,application/json"
      }
    }, POTSDAM_WASTE_GEOCODER_ORIGIN, "ADDRESS_NOT_FOUND");
    if (!response.ok) {
      throw new PotsdamWasteError(
        `The Potsdam address service returned HTTP ${response.status}.`,
        "ADDRESS_NOT_FOUND",
        response.status
      );
    }
    const text = await readLimitedText(response, MAX_GEOCODER_BYTES, "Potsdam address response");
    const parsed = parseOptionalJson(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.features)) {
      throw new PotsdamWasteError("The Potsdam address service returned an invalid response.", "ADDRESS_NOT_FOUND");
    }
    return parsed.features.filter((entry): entry is GeocoderFeature => isRecord(entry));
  }

  private async fetchPinned(
    url: string,
    init: RequestInit,
    expectedOrigin: string,
    networkErrorCode: "CONFIG_FETCH_FAILED" | "ADDRESS_NOT_FOUND" | "CREATE_FAILED"
  ): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== expectedOrigin) {
      throw new PotsdamWasteError(`Refusing an unpinned origin: ${target.origin}`, "ORIGIN_MISMATCH");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        ...init,
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        cache: "no-store"
      });
    } catch {
      throw new PotsdamWasteError(
        `The request to ${target.hostname} failed.`,
        networkErrorCode
      );
    }

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new PotsdamWasteError(
        `Refusing HTTP redirect ${response.status || "response"} from ${target.hostname}.`,
        "UNSAFE_REDIRECT",
        response.status || undefined
      );
    }
    if (response.url) {
      let responseOrigin: string;
      try {
        responseOrigin = new URL(response.url).origin;
      } catch {
        throw new PotsdamWasteError("The response URL is invalid.", "ORIGIN_MISMATCH");
      }
      if (responseOrigin !== expectedOrigin || response.redirected) {
        throw new PotsdamWasteError("The response left its pinned origin.", "ORIGIN_MISMATCH", response.status);
      }
    }
    return response;
  }
}

function geocoderUrl(config: PotsdamWasteConfig, parameters: Record<string, string>): URL {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.geocoderUuid)) {
    throw new PotsdamWasteError("The stored geocoder UUID is invalid.", "CONFIG_INVALID");
  }
  const url = new URL(
    `/gdz_geokodierung__${config.geocoderUuid}/geosearch`,
    POTSDAM_WASTE_GEOCODER_ORIGIN
  );
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

function featureToLocation(
  feature: GeocoderFeature,
  source: PotsdamWasteLocation["source"]
): PotsdamWasteLocation | null {
  if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) {
    return null;
  }
  const [longitude, latitude] = feature.geometry.coordinates;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) {
    return null;
  }
  const displayAddress = displayAddressFromProperties(feature.properties);
  if (!displayAddress) {
    return null;
  }
  return {
    latitude,
    longitude,
    displayAddress,
    featureId: typeof feature.id === "string" ? feature.id : undefined,
    source
  };
}

function displayAddressFromProperties(properties: Record<string, unknown> | undefined): string {
  if (!properties) {
    return "";
  }
  if (typeof properties.text === "string" && properties.text.trim()) {
    return properties.text.trim();
  }
  const road = stringValue(properties.strasse);
  const house = stringValue(properties.haus);
  const postcode = stringValue(properties.plz);
  const city = stringValue(properties.ort);
  const locality = stringValue(properties.ortsteil);
  const street = [road, house].filter(Boolean).join(" ");
  const place = [postcode, city].filter(Boolean).join(" ");
  return [street, place, locality].filter(Boolean).join(" - ");
}

function uniqueLocations(locations: PotsdamWasteLocation[]): PotsdamWasteLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.latitude.toFixed(7)}|${location.longitude.toFixed(7)}|${location.displayAddress}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function assertConfigSnapshot(config: PotsdamWasteConfig): void {
  if (
    config.sourceUrl !== POTSDAM_WASTE_PAGE_URL
    || config.category.name !== "Abfall"
    || semanticPotsdamWasteFingerprint(config) !== config.fingerprint
  ) {
    throw new PotsdamWasteError("The supplied Potsdam configuration snapshot is invalid.", "CONFIG_INVALID");
  }
}

function assertCoordinates(coordinates: PotsdamWasteCoordinates, config: PotsdamWasteConfig): void {
  if (
    typeof coordinates.latitude !== "number"
    || !Number.isFinite(coordinates.latitude)
    || typeof coordinates.longitude !== "number"
    || !Number.isFinite(coordinates.longitude)
  ) {
    throw new PotsdamWasteError("Latitude and longitude must be finite numbers.", "DRAFT_INVALID");
  }
  if (!isWithinPotsdamBounds(coordinates.latitude, coordinates.longitude, config.bounds)) {
    throw new PotsdamWasteError("The report location is outside the Potsdam reporting area.", "LOCATION_OUT_OF_BOUNDS");
  }
}

function validateDraft(draft: PotsdamWasteDraft, config: PotsdamWasteConfig): PotsdamWasteDraft {
  assertCoordinates(draft.location, config);
  const description = draft.description.trim();
  const reporterEmail = draft.reporterEmail.trim();
  const reporterFirstName = optionalTrimmed(draft.reporterFirstName);
  const reporterLastName = optionalTrimmed(draft.reporterLastName);
  const reporterPhone = optionalTrimmed(draft.reporterPhone);
  if (!description || description.length > config.maxDescriptionChars) {
    throw new PotsdamWasteError(
      `The description must contain 1 to ${config.maxDescriptionChars} characters.`,
      "DRAFT_INVALID",
      400
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail) || reporterEmail.length > 254) {
    throw new PotsdamWasteError("A valid reporter email address is required.", "DRAFT_INVALID", 400);
  }
  if (!draft.privacyConsent) {
    throw new PotsdamWasteError("Privacy consent is required for an unauthenticated report.", "DRAFT_INVALID", 400);
  }
  if (reporterPhone && !/^\d+$/.test(reporterPhone)) {
    throw new PotsdamWasteError("The reporter phone number may contain digits only.", "DRAFT_INVALID", 400);
  }
  for (const [label, value] of [["first name", reporterFirstName], ["last name", reporterLastName]] as const) {
    if (value && value.length > 200) {
      throw new PotsdamWasteError(`The reporter ${label} is too long.`, "DRAFT_INVALID", 400);
    }
  }
  if (reporterPhone && reporterPhone.length > 40) {
    throw new PotsdamWasteError("The reporter phone number is too long.", "DRAFT_INVALID", 400);
  }
  return {
    location: {
      latitude: draft.location.latitude,
      longitude: draft.location.longitude
    },
    description,
    reporterEmail,
    reporterFirstName,
    reporterLastName,
    reporterPhone,
    privacyConsent: true
  };
}

async function readLimitedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new PotsdamWasteError(`The ${label} exceeds the ${maxBytes}-byte safety limit.`, "CONFIG_INVALID");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PotsdamWasteError(`The ${label} exceeds the ${maxBytes}-byte safety limit.`, "CONFIG_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function mapCreateError(status: number, body: unknown): PotsdamWasteError {
  const apiErrorCode = isRecord(body) && typeof body.apiErrorCode === "string" ? body.apiErrorCode : undefined;
  if (apiErrorCode === "flaw-reporter-error-001") {
    return new PotsdamWasteError("The portal's maximum report count has been reached.", "MAX_REPORTS_REACHED", status);
  }
  if (apiErrorCode === "flaw-reporter-error-002") {
    return new PotsdamWasteError("The portal rejected the report because a required picture is missing.", "PHOTO_REQUIRED", status);
  }
  return new PotsdamWasteError(`The Potsdam Mängelmelder returned HTTP ${status}.`, "CREATE_FAILED", status);
}

function extractReportId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  for (const key of ["flawReportId", "id"]) {
    const value = body[key];
    if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value.trim())) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
  }
  return undefined;
}

function parseOptionalJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
