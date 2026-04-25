export type PortalSection = "inbox" | "documents" | "generic";
export type AuthState = "authenticated" | "unauthenticated" | "action_required" | "error";

export interface PortalConfig {
  baseUrl: string;
  apiVersion: string;
  appVersion: string;
  language: string;
  username?: string;
  downloadDir: string;
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
  downloadable: boolean;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
}

export type PortalRecordKind = "resource" | "record" | "read_confirmation" | "external_link" | "action";
export type DownloadSkipReason =
  | "not_a_resource"
  | "read_confirmation"
  | "external_link"
  | "portal_action"
  | "missing_resource_id";

export interface PortalRecordItem extends BasePortalItem {
  serviceId?: string;
  serviceTitle: string;
  xuclass?: string;
  itemKind: PortalRecordKind;
  readable: boolean;
  safeDownload: boolean;
  skipReason?: DownloadSkipReason;
  filename?: string;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
  detailText?: string;
}

export interface ListResult<T> {
  items: T[];
  source: "services" | "boxlist";
}

export interface DownloadResult {
  ok: true;
  path: string;
  filename: string;
  mimeType?: string;
  document?: DocumentItem;
  candidate?: DownloadCandidate;
}

export interface DownloadCandidate {
  id: string;
  title: string;
  filename?: string;
  source: "documents" | "generic";
  serviceId?: string;
  serviceTitle?: string;
  serviceUrl?: string;
  xuclass?: string;
  safeDownload: boolean;
  skipReason?: DownloadSkipReason;
  resourceId?: string;
  resourceOrigin?: string;
  mimeType?: string;
}

export interface DownloadCandidateList {
  safe: DownloadCandidate[];
  skipped: DownloadCandidate[];
}

export type CapabilitySection = PortalSection | "unknown";

export interface ServiceCapability {
  id?: string;
  title: string;
  serviceUrl?: string;
  xuclass?: string;
  section: CapabilitySection;
  readable: boolean;
  downloadable: boolean;
  boxlist: {
    available: boolean;
    status?: number;
    itemCount: number;
    readableItems: number;
    downloadableItems: number;
    error?: string;
  };
  sampleItemIds: string[];
}

export interface CapabilityMap {
  generatedAt: string;
  authenticated: boolean;
  userId?: string;
  userFullName?: string;
  services: ServiceCapability[];
  totals: {
    services: number;
    inboxItems: number;
    documentItems: number;
    downloadableDocuments: number;
    genericRecords: number;
    safeDownloadCandidates: number;
    skippedDownloadCandidates: number;
    unknownItems: number;
  };
  safety: {
    maxDocumentsBeforeConfirmation: number;
    maxDownloadBytesBeforeConfirmation: number;
    needsConfirmation: boolean;
    estimatedDownloadBytes?: number;
    reason?: string;
  };
  artifactPath: string;
}
