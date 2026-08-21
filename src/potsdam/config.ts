import { createHash } from "node:crypto";
import type {
  PotsdamWasteBounds,
  PotsdamWasteConfig,
  PotsdamWastePhotoRules
} from "./types.js";
import { PotsdamWasteError } from "./types.js";

export const POTSDAM_WASTE_PAGE_URL = "https://mitgestalten.potsdam.de/de/maengel-melden/create?step=2";
export const POTSDAM_WASTE_CREATE_URL = "https://mitgestalten.potsdam.de/backend/v1/flaw-reporter/createFlawReport";
export const POTSDAM_WASTE_GEOCODER_ORIGIN = "https://sg.geodatenzentrum.de";

export const POTSDAM_WASTE_MAX_INPUT_PIXELS = 50_000_000;
export const POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE = 4_096;
export const POTSDAM_WASTE_OUTPUT_JPEG_QUALITY = 85;

interface ParsedPageConfig {
  moduleId: number;
  categoryId: number;
  bounds: PotsdamWasteBounds;
  maxDescriptionChars: number;
  photoRequired: boolean;
  geocoderUuid: string;
  wizardChunkPaths: string[];
}

interface FlawReporterProps {
  flawReporterConfig?: {
    refType?: unknown;
    moduleProperties?: {
      moduleId?: unknown;
      categories?: unknown;
      maxNumberOfReportChars?: unknown;
      enablePictureRequired?: unknown;
      mapConfig?: {
        boundingBoxMaxLeftBottom?: {
          latitude?: unknown;
          longitude?: unknown;
        };
        boundingBoxMaxRightTop?: {
          latitude?: unknown;
          longitude?: unknown;
        };
      };
    };
  };
  gdzUUID?: unknown;
}

export function parsePotsdamWastePage(html: string): ParsedPageConfig {
  const candidates = decodeNextPayloadStrings(html);
  const props = findFlawReporterProps(candidates);
  const moduleProperties = props.flawReporterConfig?.moduleProperties;
  if (!moduleProperties) {
    throw configError("The Mängelmelder module configuration is missing.");
  }

  const moduleId = positiveInteger(moduleProperties.moduleId, "moduleId");
  const categories = Array.isArray(moduleProperties.categories) ? moduleProperties.categories : [];
  const wasteCategories = categories.filter((entry): entry is Record<string, unknown> => {
    return isRecord(entry) && entry.categoryName === "Abfall";
  });
  if (wasteCategories.length !== 1) {
    throw configError(`Expected exactly one 'Abfall' category, found ${wasteCategories.length}.`);
  }
  const categoryId = positiveInteger(wasteCategories[0]?.id, "Abfall category id");

  const lower = moduleProperties.mapConfig?.boundingBoxMaxLeftBottom;
  const upper = moduleProperties.mapConfig?.boundingBoxMaxRightTop;
  const bounds = validateBounds({
    west: finiteNumber(lower?.longitude, "bounding-box west longitude"),
    south: finiteNumber(lower?.latitude, "bounding-box south latitude"),
    east: finiteNumber(upper?.longitude, "bounding-box east longitude"),
    north: finiteNumber(upper?.latitude, "bounding-box north latitude")
  });

  const maxDescriptionChars = positiveInteger(
    moduleProperties.maxNumberOfReportChars,
    "maximum report character count"
  );
  if (typeof moduleProperties.enablePictureRequired !== "boolean") {
    throw configError("The live picture-required rule is missing.");
  }
  if (typeof props.gdzUUID !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(props.gdzUUID)) {
    throw configError("The live GDZ geocoder UUID is missing or invalid.");
  }

  const wizardChunkPaths = findWizardChunkPaths(candidates, html);
  if (wizardChunkPaths.length === 0) {
    throw configError("The FlawReporterWizard client assets could not be identified.");
  }

  return {
    moduleId,
    categoryId,
    bounds,
    maxDescriptionChars,
    photoRequired: moduleProperties.enablePictureRequired,
    geocoderUuid: props.gdzUUID,
    wizardChunkPaths
  };
}

export function parsePotsdamWastePhotoRules(script: string, required: boolean): PotsdamWastePhotoRules | null {
  const endpointNeedle = "/api/v1/flaw-reporter/createFlawReport";
  let endpointIndex = script.indexOf(endpointNeedle);
  while (endpointIndex >= 0) {
    const window = script.slice(Math.max(0, endpointIndex - 60_000), endpointIndex + 4_000);
    const accept = /accept\s*:\s*(["'])([^"']+)\1/.exec(window)?.[2];
    const maxFileSizeInMb = /maxFileSizeInMb\s*:\s*(\d+(?:\.\d+)?)/.exec(window)?.[1];
    const maxCount = /maxCount\s*:\s*(\d+)/.exec(window)?.[1];
    if (accept && maxFileSizeInMb && maxCount) {
      const acceptedInputMimeTypes = [...new Set(accept.split(",").map((value) => value.trim()).filter(Boolean))];
      const maxMegabytes = Number(maxFileSizeInMb);
      const parsedMaxCount = Number(maxCount);
      if (
        acceptedInputMimeTypes.length > 0
        && Number.isFinite(maxMegabytes)
        && maxMegabytes > 0
        && Number.isInteger(parsedMaxCount)
        && parsedMaxCount > 0
      ) {
        const maxBytes = Math.floor(maxMegabytes * 1024 * 1024);
        return {
          required,
          maxCount: parsedMaxCount,
          maxInputBytes: maxBytes,
          maxInputPixels: POTSDAM_WASTE_MAX_INPUT_PIXELS,
          maxOutputBytes: maxBytes,
          maxOutputLongEdge: POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE,
          acceptedInputMimeTypes,
          outputMimeType: "image/jpeg",
          outputJpegQuality: POTSDAM_WASTE_OUTPUT_JPEG_QUALITY
        };
      }
    }
    endpointIndex = script.indexOf(endpointNeedle, endpointIndex + endpointNeedle.length);
  }
  return null;
}

export function createPotsdamWasteConfig(
  page: ParsedPageConfig,
  photoRules: PotsdamWastePhotoRules
): PotsdamWasteConfig {
  const withoutFingerprint = {
    sourceUrl: POTSDAM_WASTE_PAGE_URL,
    moduleId: page.moduleId,
    category: {
      id: page.categoryId,
      name: "Abfall" as const
    },
    bounds: page.bounds,
    maxDescriptionChars: page.maxDescriptionChars,
    geocoderUuid: page.geocoderUuid,
    photoRules
  };
  return {
    ...withoutFingerprint,
    fingerprint: semanticPotsdamWasteFingerprint(withoutFingerprint)
  };
}

export function semanticPotsdamWasteFingerprint(
  config: Omit<PotsdamWasteConfig, "fingerprint"> | PotsdamWasteConfig
): string {
  const semantic = {
    schema: 1,
    moduleId: config.moduleId,
    categoryId: config.category.id,
    categoryName: config.category.name,
    bounds: {
      west: config.bounds.west,
      south: config.bounds.south,
      east: config.bounds.east,
      north: config.bounds.north
    },
    maxDescriptionChars: config.maxDescriptionChars,
    geocoderUuid: config.geocoderUuid,
    photoRules: {
      required: config.photoRules.required,
      maxCount: config.photoRules.maxCount,
      maxInputBytes: config.photoRules.maxInputBytes,
      maxInputPixels: config.photoRules.maxInputPixels,
      maxOutputBytes: config.photoRules.maxOutputBytes,
      maxOutputLongEdge: config.photoRules.maxOutputLongEdge,
      acceptedInputMimeTypes: [...config.photoRules.acceptedInputMimeTypes].sort(),
      outputMimeType: config.photoRules.outputMimeType,
      outputJpegQuality: config.photoRules.outputJpegQuality
    }
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(semantic)).digest("hex")}`;
}

export function isWithinPotsdamBounds(
  latitude: number,
  longitude: number,
  bounds: PotsdamWasteBounds
): boolean {
  return latitude >= bounds.south
    && latitude <= bounds.north
    && longitude >= bounds.west
    && longitude <= bounds.east;
}

function decodeNextPayloadStrings(html: string): string[] {
  const candidates = [html];
  const expression = /self\.__next_f\.push\(\[1,("(?:\\[\s\S]|[^"\\])*")\]\)/g;
  for (const match of html.matchAll(expression)) {
    try {
      const decoded = JSON.parse(match[1] ?? "") as unknown;
      if (typeof decoded === "string") {
        candidates.push(decoded);
      }
    } catch {
      // Ignore unrelated or incomplete streamed fragments. A complete matching
      // configuration is still required below.
    }
  }
  return candidates;
}

function findFlawReporterProps(candidates: string[]): FlawReporterProps {
  for (const candidate of candidates) {
    let needleIndex = candidate.indexOf('"gdzUUID"');
    while (needleIndex >= 0) {
      const parsed = findContainingJsonObject(candidate, needleIndex);
      if (
        parsed
        && isRecord(parsed)
        && typeof parsed.gdzUUID === "string"
        && isRecord(parsed.flawReporterConfig)
        && parsed.flawReporterConfig.refType === "FLAW_REPORTER"
      ) {
        return parsed as FlawReporterProps;
      }
      needleIndex = candidate.indexOf('"gdzUUID"', needleIndex + 1);
    }
  }
  throw configError("The live FlawReporterWizard properties could not be parsed.");
}

function findContainingJsonObject(text: string, containedIndex: number): unknown | null {
  let openingIndex = text.lastIndexOf("{", containedIndex);
  let attempts = 0;
  while (openingIndex >= 0 && attempts < 500) {
    const closingIndex = matchingBraceIndex(text, openingIndex);
    if (closingIndex > containedIndex) {
      try {
        return JSON.parse(text.slice(openingIndex, closingIndex + 1)) as unknown;
      } catch {
        // Try the next enclosing object.
      }
    }
    openingIndex = text.lastIndexOf("{", openingIndex - 1);
    attempts += 1;
  }
  return null;
}

function matchingBraceIndex(text: string, openingIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findWizardChunkPaths(candidates: string[], html: string): string[] {
  for (const candidate of candidates) {
    const expression = /I\[\d+,(\[(?:"(?:\\.|[^"\\])*"\s*,?\s*)+\]),"FlawReporterWizard"\]/g;
    for (const match of candidate.matchAll(expression)) {
      try {
        const paths = JSON.parse(match[1] ?? "[]") as unknown;
        if (Array.isArray(paths)) {
          const valid = paths.filter(isSafeNextChunkPath);
          if (valid.length > 0) {
            return [...new Set(valid)];
          }
        }
      } catch {
        // Fall back to script tags below.
      }
    }
  }

  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/gi)]
    .map((match) => match[1])
    .filter(isSafeNextChunkPath)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function isSafeNextChunkPath(value: unknown): value is string {
  return typeof value === "string"
    && /^\/_next\/static\/chunks\/[A-Za-z0-9._~-]+\.js$/.test(value);
}

function validateBounds(bounds: PotsdamWasteBounds): PotsdamWasteBounds {
  if (
    bounds.west < -180
    || bounds.east > 180
    || bounds.south < -90
    || bounds.north > 90
    || bounds.west >= bounds.east
    || bounds.south >= bounds.north
  ) {
    throw configError("The live Mängelmelder bounding box is invalid.");
  }
  return bounds;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw configError(`The live ${label} is invalid.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw configError(`The live ${label} is invalid.`);
  }
  return value;
}

function configError(message: string): PotsdamWasteError {
  return new PotsdamWasteError(message, "CONFIG_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
