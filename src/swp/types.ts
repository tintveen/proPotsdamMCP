export type SwpSalutation = "mrs" | "mr" | "none";

export interface SwpAddress {
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
}

export interface SwpContact {
  salutation: SwpSalutation;
  surname: string;
  firstName?: string;
  address: SwpAddress;
  email: string;
  phone?: string;
  /** The optional STEP "Kassenzeichen", required for allotment associations. */
  customerReference?: string;
}

export type SwpQuantityItemKind =
  | "couch_sofa_bed"
  | "mattress"
  | "cabinet_sideboard_shelf"
  | "armchair"
  | "chair_stool"
  | "table"
  | "bicycle"
  | "drying_rack"
  | "fridge_freezer"
  | "washer_dryer"
  | "dishwasher"
  | "cooker"
  | "tv_monitor"
  | "vacuum_cleaner";

export type SwpDescribedItemKind =
  | "other_bulky"
  | "other_metal"
  | "electrical_over_50cm"
  | "other_small_electrical";

export type SwpItem =
  | {
      kind: SwpQuantityItemKind;
      quantity: number;
    }
  | {
      kind: "floor_covering";
      areaSquareMetres: number;
    }
  | {
      kind: SwpDescribedItemKind;
      description: string;
      quantity: number;
    };

export type SwpItemKind = SwpItem["kind"];

export interface ResolvedSwpDraft {
  contact: SwpContact;
  /** Omit when the contact address is also the collection address. */
  pickupAddress?: SwpAddress;
  items: readonly SwpItem[];
  /** Earliest possible collection date in ISO calendar form, YYYY-MM-DD. */
  earliestPickupDate: string;
  placement?: string;
  message?: string;
}

export type SwpFormFieldType = "checkbox" | "email" | "select" | "text" | "textarea";

export interface SwpFormFieldContract {
  name: string;
  type: SwpFormFieldType;
  required: boolean;
  conditional: boolean;
  options?: readonly {
    value: string;
    label: string;
  }[];
}

export interface SwpFormContract {
  sourceUrl: string;
  formId: string;
  fingerprint: string;
  fields: readonly SwpFormFieldContract[];
  requiredFields: readonly string[];
  supportedItemKinds: readonly SwpItemKind[];
  constraints: {
    alternatePickupAddressRequiresCompleteAddress: true;
    earliestPickupDateIsNotAnAppointment: true;
    smallElectricalRequiresLargeAppliance: true;
    otherSmallElectricalRequiresFridgeOrWasher: true;
  };
}

export interface SwpCommitResult {
  ok: true;
  status: "submitted";
  httpStatus: number;
  fingerprint: string;
  summary: string;
}

export type SwpInspectResult = SwpFormContract;

export type SwpClientErrorCode =
  | "FORM_PARSE_FAILED"
  | "FORM_UNSUPPORTED"
  | "FORM_DRIFT"
  | "INVALID_DRAFT"
  | "NETWORK_ERROR"
  | "AMBIGUOUS_WRITE"
  | "HTTP_ERROR"
  | "REDIRECT_BLOCKED"
  | "ORIGIN_BLOCKED"
  | "VALIDATION_FAILED";

export class SwpClientError extends Error {
  constructor(
    message: string,
    readonly code: SwpClientErrorCode,
    readonly status?: number
  ) {
    super(message);
    this.name = "SwpClientError";
  }
}
