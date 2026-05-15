export type PortalSection = "inbox" | "documents" | "generic";
export type AuthState = "authenticated" | "unauthenticated" | "action_required" | "error";

export interface PortalConfig {
  baseUrl: string;
  apiVersion: string;
  appVersion: string;
  language: string;
  username?: string;
  exportDir: string;
  clientId: string;
}

export interface StoredSession {
  cookieJar: unknown;
  csrfToken?: string;
  savedAt: string;
}

export interface AuthResult {
  state: AuthState;
  authenticated: boolean;
  userId?: string;
  userFullName?: string;
  reason?: string;
  action?: "set_credentials" | "login_failed" | "accept_terms" | "password_change" | "verification" | "captcha" | "unknown";
}

export interface PortalService {
  id?: string;
  title: string;
  serviceUrl?: string;
  xuclass?: string;
  raw: Record<string, unknown>;
}

export interface BasePortalItem {
  id: string;
  title: string;
  date?: string;
  category?: string;
  subtitle?: string;
  abstract?: string;
  detailUrl?: string;
  serviceUrl?: string;
  rawSource: "services" | "boxlist" | "detail";
}

export interface InboxItem extends BasePortalItem {
  subject: string;
  sender?: string;
  unread: boolean;
  replied?: boolean;
  detailText?: string;
}

export interface DocumentItem extends BasePortalItem {
  filename?: string;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
}

export type PortalRecordKind = "resource" | "record" | "read_confirmation" | "external_link" | "action";

export interface PortalRecordItem extends BasePortalItem {
  serviceId?: string;
  serviceTitle: string;
  xuclass?: string;
  itemKind: PortalRecordKind;
  readable: boolean;
  filename?: string;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
  detailText?: string;
}

export interface PortalFileItem {
  id: string;
  title: string;
  sourceRecordId: string;
  sourceRecordTitle: string;
  serviceId?: string;
  serviceTitle: string;
  serviceUrl?: string;
  xuclass?: string;
  filename: string;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
  itemKind: PortalRecordKind;
  exportable: boolean;
}

export interface PortalFileExportResult {
  ok: true;
  id: string;
  sourceRecordId: string;
  sourceRecordTitle: string;
  filename: string;
  path: string;
  mimeType?: string;
  byteLength: number;
  sha256: string;
  exportedAt: string;
}

export type PortalReadDomain =
  | "rent_account"
  | "contract"
  | "statement"
  | "repair_status"
  | "service_request"
  | "consumption"
  | "real_estate_listing"
  | "viewing_appointment"
  | "application_status"
  | "inquiry"
  | "house_notice"
  | "profile_setting"
  | "notification"
  | "external_link"
  | "document"
  | "attachment"
  | "unknown";

export type StructuredPortalRecordConfidence = "high" | "medium" | "low";

export interface StructuredPortalRecord {
  id: string;
  title: string;
  sourceRecordId: string;
  sourceRecordTitle: string;
  serviceId?: string;
  serviceTitle: string;
  serviceUrl?: string;
  xuclass?: string;
  domain: PortalReadDomain;
  confidence: StructuredPortalRecordConfidence;
  itemKind: PortalRecordKind;
  readable: boolean;
  date?: string;
  category?: string;
  status?: string;
  period?: string;
  amount?: string;
  address?: string;
  filename?: string;
  mimeType?: string;
  fields: Record<string, string>;
  detailText?: string;
}

export interface ListResult<T> {
  items: T[];
  source: "services" | "boxlist";
}

export type CapabilitySection = PortalSection | "unknown";

export interface ServiceCapability {
  id?: string;
  title: string;
  serviceUrl?: string;
  xuclass?: string;
  section: CapabilitySection;
  readable: boolean;
  boxlist: {
    available: boolean;
    status?: number;
    itemCount: number;
    readableItems: number;
    error?: string;
  };
  sampleItemIds: string[];
}

export interface CapabilityMap {
  generatedAt: string;
  authenticated: boolean;
  dataPolicy: string;
  userId?: string;
  userFullName?: string;
  services: ServiceCapability[];
  totals: {
    serviceCount: number;
    inboxItems: number;
    portalRecords: number;
    unknownItems: number;
  };
  artifactPath: string;
}

export type PortalActionKind = "form" | "portal_action" | "read_confirmation" | "external_link" | "navigation" | "ambiguous";
export type PortalActionRiskLevel = "none" | "low" | "medium" | "high";

export interface PortalActionField {
  name: string;
  portalId?: string;
  label?: string;
  type?: string;
  required: boolean;
  hidden: boolean;
  editable: boolean;
  value?: string;
}

export interface PortalAction {
  id: string;
  serviceId?: string;
  serviceTitle: string;
  serviceUrl?: string;
  xuclass?: string;
  title: string;
  source: "boxlist" | "detail";
  recordId?: string;
  recordTitle?: string;
  actionKind: PortalActionKind;
  method: "GET" | "POST";
  endpoint?: string;
  fields: PortalActionField[];
  requiresInput: boolean;
  riskLevel: PortalActionRiskLevel;
  preparable: boolean;
  notPreparableReason?: "read_confirmation" | "external_link" | "navigation" | "ambiguous" | "missing_form_metadata";
  rawHints: Record<string, string>;
}

export interface PortalActionMap {
  generatedAt: string;
  authenticated: boolean;
  actionPolicy: string;
  userId?: string;
  userFullName?: string;
  services: Array<{
    serviceId?: string;
    title: string;
    xuclass?: string;
    actionCount: number;
    preparableActions: number;
    skippedActions: number;
    actionIds: string[];
    error?: string;
  }>;
  actions: PortalAction[];
  partial: boolean;
  detailScanLimit: number;
  totals: {
    serviceCount: number;
    actionCount: number;
    preparableActions: number;
    skippedActions: number;
  };
  artifactPath: string;
}

export interface PreparedPortalAction {
  ok: boolean;
  preparedOnly: true;
  actionId: string;
  title: string;
  summary: string;
  validationIssues: string[];
  draft: {
    method: "GET" | "POST";
    endpoint?: string;
    fields: Array<{
      name: string;
      label?: string;
      required: boolean;
      hidden: boolean;
      editable: boolean;
      currentValue?: string;
      proposedValue?: string;
    }>;
  };
}

export interface PortalActionCommitRequest {
  ok: boolean;
  actionId: string;
  actionTitle?: string;
  confirmationId?: string;
  expiresAt?: string;
  summary: string;
  validationIssues: string[];
  diff: Array<{
    name: string;
    label?: string;
    currentValue?: string;
    proposedValue: string;
  }>;
}

export type PortalWriteDomain =
  | "inbox_compose"
  | "inbox_reply"
  | "inbox_state"
  | "workflow_reply"
  | "read_confirmation"
  | "repair_report"
  | "repair_file_upload"
  | "repair_appointment"
  | "service_ticket"
  | "pet_approval"
  | "payment_method"
  | "meter_reading"
  | "house_notice_ack"
  | "real_estate_inquiry"
  | "viewing_booking"
  | "rental_application"
  | "registration_activation"
  | "password_change"
  | "terms_acceptance"
  | "account_verification"
  | "captcha_completion"
  | "profile_account_setting"
  | "external_navigation";

export interface PortalWriteCapability {
  domain: PortalWriteDomain;
  title: string;
  description: string;
  source: "portal_action" | "static";
  serviceId?: string;
  serviceTitle?: string;
  xuclass?: string;
  actionId?: string;
  actionTitle?: string;
  actionKind?: PortalActionKind;
  recordId?: string;
  recordTitle?: string;
  requiredFields: string[];
  targetRequired: boolean;
  uploadSupported: boolean;
  liveCommitSupported: false;
  executionPolicy: "draft_only_no_live_write";
}

export interface PreparedPortalWrite {
  ok: boolean;
  preparedOnly: true;
  willSend: false;
  domain: PortalWriteDomain;
  title: string;
  summary: string;
  safetyPolicy: "No portal write request was sent.";
  validationIssues: string[];
  targetId?: string;
  actionId?: string;
  actionTitle?: string;
  requiredFields: string[];
  values: Record<string, string>;
  draft?: PreparedPortalAction["draft"];
}

export interface StoredPortalActionConfirmation {
  confirmationId: string;
  actionId: string;
  actionTitle: string;
  recordId?: string;
  recordTitle?: string;
  xuclass?: string;
  serviceUrl?: string;
  values: Record<string, string>;
  diff: PortalActionCommitRequest["diff"];
  createdAt: string;
  expiresAt: string;
}

export interface PortalCommitResult {
  ok: boolean;
  actionId: string;
  recordId?: string;
  committedAt: string;
  status: number;
  summary: string;
  portalMessage?: string;
}
