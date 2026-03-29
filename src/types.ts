export type PortalSection = "inbox" | "documents";
export type OutputFormat = "text" | "json";
export type TraceMode = "login" | "section" | "debug";

export interface PortalProfile {
  baseUrl: string;
  appUrl: string;
  apiVersion: string;
  aliases: Record<PortalSection, string[]>;
  lastLoginAt?: string;
  lastValidatedAt?: string;
  discoveredEndpoints: string[];
  lastTraceFile?: string;
}

export interface SessionStatus {
  valid: boolean;
  userId?: string;
  userFullName?: string;
  source: "http" | "page" | "none";
}

export interface BasePortalItem {
  id: string;
  title: string;
  date?: string;
  category?: string;
  subtitle?: string;
  abstract?: string;
  detailUrl?: string;
  rawSource: "network" | "ui";
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
}

export interface TraceRecord {
  timestamp: string;
  url: string;
  method: string;
  status: number;
  resourceType: string;
  contentType?: string;
  bodyText?: string;
}

export interface ListResult<T> {
  items: T[];
  source: "network" | "ui";
  traceFile?: string;
}
