export type WasteSalutation = "female" | "male" | "unspecified";

export interface WasteAddress {
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
}

export interface WasteContactOverrides {
  salutation?: WasteSalutation;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
}

export interface ResolvedWasteContact {
  salutation?: WasteSalutation;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: Partial<WasteAddress>;
}

export interface PortalWasteDefaults {
  contractId?: string;
  contact: ResolvedWasteContact;
  fieldSources: Record<string, "explicit" | "portal_profile" | "portal_contract">;
  candidates: Array<{
    contractId: string;
    title: string;
    address?: string;
  }>;
  validationIssues: string[];
}

export interface PortalWasteDefaultsProvider {
  resolve(contractId?: string): Promise<PortalWasteDefaults>;
}

export type CountedBulkyWasteItemKind =
  | "couch_sofa_bed"
  | "mattress"
  | "cabinet_sideboard_shelf"
  | "armchair"
  | "chair_stool"
  | "table_table_tennis"
  | "bicycle"
  | "drying_rack"
  | "refrigerator_freezer"
  | "washer_dryer"
  | "dishwasher"
  | "cooker"
  | "tv_monitor"
  | "vacuum_cleaner";

export type DescribedBulkyWasteItemKind =
  | "other_bulky"
  | "other_metal"
  | "large_electrical_over_50cm"
  | "other_small_electrical";

export type BulkyWasteItem =
  | { kind: CountedBulkyWasteItemKind; quantity: number }
  | { kind: "floor_covering"; squareMeters: number }
  | { kind: DescribedBulkyWasteItemKind; description: string; quantity: number };

export interface BulkyWastePickupInput {
  contractId?: string;
  contact?: WasteContactOverrides;
  pickupAddress?: WasteAddress;
  earliestPickupDate: string;
  items: BulkyWasteItem[];
  placement?: string;
  note?: string;
  allotmentReference?: string;
}

export type WasteReportLocationInput =
  | { address: string; latitude?: never; longitude?: never }
  | { latitude: number; longitude: number; label?: string; address?: never };

export interface AbandonedWasteReportInput {
  contractId?: string;
  contact?: WasteContactOverrides;
  location?: WasteReportLocationInput;
  description: string;
  photoPaths: string[];
  privacyConsent: true;
}

export type WasteWorkflow = "bulky_waste_pickup" | "abandoned_waste_report";

export interface WastePreparation<TDraft> {
  ok: boolean;
  preparedOnly: true;
  willSend: false;
  workflow: WasteWorkflow;
  draft?: TDraft;
  fieldSources: Record<string, "explicit" | "portal_profile" | "portal_contract" | "derived">;
  missingFields: string[];
  validationIssues: string[];
  warnings: string[];
  review: string[];
  privacyUrls: string[];
  contractCandidates?: PortalWasteDefaults["candidates"];
  remoteFingerprint?: string;
}

export interface WasteCommitRequest {
  ok: boolean;
  workflow: WasteWorkflow;
  confirmationId?: string;
  expiresAt?: string;
  validationIssues: string[];
  warnings: string[];
  review: string[];
  privacyUrls: string[];
  contractCandidates?: PortalWasteDefaults["candidates"];
}

export interface WasteCommitResult {
  ok: true;
  workflow: WasteWorkflow;
  state: "request_received" | "awaiting_email_confirmation";
  committedAt: string;
  status: number;
  summary: string;
  reference?: string;
  warnings?: string[];
}

export interface WasteServiceLike {
  prepareBulkyWastePickup(input: BulkyWastePickupInput): Promise<WastePreparation<unknown>>;
  requestBulkyWastePickupCommit(input: BulkyWastePickupInput): Promise<WasteCommitRequest>;
  commitBulkyWastePickup(confirmationId: string): Promise<WasteCommitResult>;
  prepareAbandonedWasteReport(input: AbandonedWasteReportInput): Promise<WastePreparation<unknown>>;
  requestAbandonedWasteReportCommit(input: AbandonedWasteReportInput): Promise<WasteCommitRequest>;
  commitAbandonedWasteReport(confirmationId: string): Promise<WasteCommitResult>;
}
