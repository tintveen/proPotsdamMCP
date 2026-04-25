export type PortalSection = "inbox" | "documents";
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

export interface ListResult<T> {
  items: T[];
  source: "services" | "boxlist";
}

export interface DownloadResult {
  ok: true;
  path: string;
  filename: string;
  mimeType?: string;
  document: DocumentItem;
}
