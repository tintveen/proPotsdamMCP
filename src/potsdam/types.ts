export interface PotsdamWasteBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PotsdamWastePhotoRules {
  required: boolean;
  maxCount: number;
  maxInputBytes: number;
  maxInputPixels: number;
  maxOutputBytes: number;
  maxOutputLongEdge: number;
  acceptedInputMimeTypes: string[];
  outputMimeType: "image/jpeg";
  outputJpegQuality: number;
}

export interface PotsdamWasteConfig {
  sourceUrl: string;
  moduleId: number;
  category: {
    id: number;
    name: "Abfall";
  };
  bounds: PotsdamWasteBounds;
  maxDescriptionChars: number;
  geocoderUuid: string;
  photoRules: PotsdamWastePhotoRules;
  fingerprint: string;
}

export interface PotsdamWasteCoordinates {
  latitude: number;
  longitude: number;
}

export interface PotsdamWasteLocation extends PotsdamWasteCoordinates {
  displayAddress: string;
  featureId?: string;
  source: "address" | "coordinates";
}

export interface PotsdamWasteDraft {
  location: PotsdamWasteCoordinates;
  description: string;
  reporterEmail: string;
  reporterFirstName?: string;
  reporterLastName?: string;
  reporterPhone?: string;
  /** Required for unauthenticated reports. It gates submission but is not sent as a form field. */
  privacyConsent: boolean;
}

/**
 * A normalized, persisted upload artifact. It intentionally contains no source
 * filename and no image bytes, so it can be stored in a confirmation record.
 */
export interface PotsdamWastePhoto {
  path: string;
  filename: string;
  mimeType: "image/jpeg";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
}

export interface VerifiedPotsdamWastePhoto {
  photo: PotsdamWastePhoto;
  bytes: Uint8Array;
}

export interface PotsdamWasteCommitResult {
  ok: true;
  state: "awaiting_email_confirmation";
  httpStatus: number;
  reportId: string;
  summary: string;
}

export type PotsdamWasteErrorCode =
  | "CONFIG_FETCH_FAILED"
  | "CONFIG_INVALID"
  | "CONFIG_CHANGED"
  | "UNSAFE_REDIRECT"
  | "ORIGIN_MISMATCH"
  | "ADDRESS_INVALID"
  | "ADDRESS_NOT_FOUND"
  | "ADDRESS_AMBIGUOUS"
  | "LOCATION_OUT_OF_BOUNDS"
  | "DRAFT_INVALID"
  | "PHOTO_INVALID"
  | "PHOTO_CONVERSION_REQUIRED"
  | "PHOTO_CHANGED"
  | "PHOTO_REQUIRED"
  | "MAX_REPORTS_REACHED"
  | "AMBIGUOUS_WRITE"
  | "CREATE_FAILED";

export class PotsdamWasteError extends Error {
  constructor(
    message: string,
    readonly code: PotsdamWasteErrorCode,
    readonly status?: number
  ) {
    super(message);
    this.name = "PotsdamWasteError";
  }
}
