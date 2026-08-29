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

export interface PortalActionFieldOption {
  value: string;
  label?: string;
  selected?: boolean;
}

export interface PortalActionUpload {
  supported: boolean;
  mode?: "multipart_form_data";
  endpoint?: string;
  acceptMimeTypes?: string[];
  maxBytes?: number;
  reason?: string;
}

export interface PortalActionField {
  name: string;
  portalId?: string;
  label?: string;
  type?: string;
  required: boolean;
  hidden: boolean;
  editable: boolean;
  value?: string;
  options?: PortalActionFieldOption[];
  upload?: PortalActionUpload;
}

export interface PreparedPortalAttachment {
  fieldName: string;
  fieldLabel?: string;
  filePath: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  byteLength: number;
  uploadSupported: boolean;
  uploadEndpoint?: string;
}

export interface StagedPortalAttachment extends PreparedPortalAttachment {
  sha256: string;
}

export interface PortalAttachmentReview {
  fieldName: string;
  fieldLabel?: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  byteLength: number;
  sha256: string;
  uploadSupported: boolean;
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
      type?: string;
      required: boolean;
      hidden: boolean;
      editable: boolean;
      currentValue?: string;
      proposedValue?: string;
      options?: PortalActionFieldOption[];
      upload?: PortalActionUpload;
    }>;
    attachments?: PreparedPortalAttachment[];
  };
}

export interface PortalActionDiffEntry {
  name: string;
  label?: string;
  currentValue?: string;
  proposedValue: string;
}

export interface PortalWriteTargetReview {
  accountId: string;
  domain: PortalWriteDomain;
  serviceId?: string;
  serviceTitle?: string;
  recordId?: string;
  recordTitle?: string;
}

export interface StagedPortalActionResult {
  ok: boolean;
  actionId: string;
  actionTitle?: string;
  pendingWriteHandle?: string;
  expiresAt?: string;
  requiresExplicitApproval: boolean;
  target?: PortalWriteTargetReview;
  summary: string;
  validationIssues: string[];
  diff: PortalActionDiffEntry[];
  attachments?: PortalAttachmentReview[];
}

export interface PortalActionCommitTarget {
  recordId?: string;
  serviceId?: string;
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
  liveCommitSupported: boolean;
  executionPolicy: "draft_only_no_live_write" | "conversational_approval_required_live_commit";
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

export type PendingWriteKind = "portal_action" | "swp_bulky_waste" | "potsdam_abandoned_waste";
export type PendingWriteWorkflow = "portal_action" | "bulky_waste_pickup" | "abandoned_waste_report";
export type PendingWriteState = "staged" | "claimed";

export interface PendingWriteBase {
  pendingWriteHandle: string;
  state: PendingWriteState;
  kind: PendingWriteKind;
  workflow: PendingWriteWorkflow;
  destination: string;
  contractFingerprint: string;
  review: string[];
  warnings: string[];
  privacyUrls: string[];
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
}

export interface PendingWriteArtifact {
  filePath: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export type PendingPortalWriteState = PendingWriteState;

export interface PendingPortalWrite extends PendingWriteBase {
  kind: "portal_action";
  workflow: "portal_action";
  accountId: string;
  domain: PortalWriteDomain;
  actionId: string;
  actionTitle: string;
  serviceId?: string;
  serviceTitle?: string;
  recordId?: string;
  recordTitle?: string;
  xuclass?: string;
  serviceUrl?: string;
  values: Record<string, string>;
  diff: PortalActionDiffEntry[];
  attachments?: StagedPortalAttachment[];
}

export interface PendingWasteWrite extends PendingWriteBase {
  kind: "swp_bulky_waste" | "potsdam_abandoned_waste";
  workflow: "bulky_waste_pickup" | "abandoned_waste_report";
  payload: unknown;
  artifacts?: PendingWriteArtifact[];
}

export type PendingWrite = PendingPortalWrite | PendingWasteWrite;

export interface PendingPortalWriteSummary {
  pendingWriteHandle: string;
  kind: "portal_action";
  workflow: "portal_action";
  destination: string;
  accountId: string;
  domain: PortalWriteDomain;
  actionId: string;
  actionTitle: string;
  serviceId?: string;
  serviceTitle?: string;
  recordId?: string;
  recordTitle?: string;
  diff: PortalActionDiffEntry[];
  attachments?: PortalAttachmentReview[];
  createdAt: string;
  expiresAt: string;
  review: string[];
  warnings: string[];
  privacyUrls: string[];
  requiresExplicitApproval: true;
}

export interface PendingPortalWriteList {
  items: PendingPortalWriteSummary[];
}

export interface CancelPendingWritesResult {
  ok: boolean;
  cancelledHandles: string[];
  missingHandles: string[];
}

export interface PendingWriteSummary {
  pendingWriteHandle: string;
  kind: PendingWriteKind;
  workflow: PendingWriteWorkflow;
  destination: string;
  review: string[];
  warnings: string[];
  privacyUrls: string[];
  createdAt: string;
  expiresAt: string;
  requiresExplicitApproval: true;
  target?: PortalWriteTargetReview;
  diff?: PortalActionDiffEntry[];
  attachments?: PortalAttachmentReview[];
}

export interface PendingWriteList {
  items: PendingWriteSummary[];
}

export type WriteOutcome = "succeeded" | "notSent" | "rejected" | "outcomeUncertain";
export type PortalWriteOutcome = WriteOutcome;

export interface PortalCommitResult {
  ok: boolean;
  outcome: PortalWriteOutcome;
  pendingWriteHandle: string;
  actionId: string;
  recordId?: string;
  completedAt: string;
  status?: number;
  summary: string;
  portalMessage?: string;
  attachmentUploads?: Array<{
    fieldName: string;
    filename: string;
    ok: boolean;
    status: number;
  }>;
}

export interface PortalCommitBatchResult {
  ok: boolean;
  partial: boolean;
  attemptedCount: number;
  counts: Record<PortalWriteOutcome, number>;
  results: PortalCommitResult[];
}

export interface PendingWriteCommitResult {
  ok: boolean;
  outcome: WriteOutcome;
  pendingWriteHandle: string;
  kind: PendingWriteKind | "unknown";
  workflow: PendingWriteWorkflow | "unknown";
  completedAt: string;
  summary: string;
  status?: number;
  reference?: string;
  state?: "request_received" | "awaiting_email_confirmation";
  warnings?: string[];
  portal?: PortalCommitResult;
}

export interface PendingWriteCommitBatchResult {
  ok: boolean;
  partial: boolean;
  attemptedCount: number;
  counts: Record<WriteOutcome, number>;
  results: PendingWriteCommitResult[];
}
