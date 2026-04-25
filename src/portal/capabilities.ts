import { DOCUMENT_ALIASES, GENERIC_SERVICE_ALIASES, INBOX_ALIASES } from "../constants.js";
import type {
  CapabilitySection,
  DocumentItem,
  InboxItem,
  PortalRecordItem,
  PortalService,
  ServiceCapability
} from "../types.js";
import { flattenScalars } from "./xml.js";

export function classifyServiceCapability(service: PortalService): Pick<ServiceCapability, "section" | "readable"> {
  const haystack = `${service.title} ${service.xuclass ?? ""} ${JSON.stringify(flattenScalars(service.raw))}`.toLowerCase();
  const section: CapabilitySection = INBOX_ALIASES.some((alias) => haystack.includes(alias))
    ? "inbox"
    : DOCUMENT_ALIASES.some((alias) => haystack.includes(alias))
      ? "documents"
      : GENERIC_SERVICE_ALIASES.some((alias) => haystack.includes(alias))
        ? "generic"
        : "unknown";

  return {
    section,
    readable: section === "inbox" || section === "documents" || section === "generic"
  };
}

export function buildServiceCapability(input: {
  service: PortalService;
  status?: number;
  available: boolean;
  inboxItems?: InboxItem[];
  documentItems?: DocumentItem[];
  portalRecords?: PortalRecordItem[];
  unknownItemCount?: number;
  error?: string;
}): ServiceCapability {
  const classified = classifyServiceCapability(input.service);
  const inboxItems = input.inboxItems ?? [];
  const documentItems = input.documentItems ?? [];
  const portalRecords = input.portalRecords ?? [];
  const itemCount = inboxItems.length + documentItems.length + portalRecords.length + (input.unknownItemCount ?? 0);
  const sampleItemIds = [...inboxItems, ...documentItems, ...portalRecords].map((item) => item.id).slice(0, 10);

  return {
    id: input.service.id,
    title: input.service.title,
    serviceUrl: input.service.serviceUrl,
    xuclass: input.service.xuclass,
    section: classified.section,
    readable: classified.readable || itemCount > 0,
    boxlist: {
      available: input.available,
      status: input.status,
      itemCount,
      readableItems: inboxItems.length + documentItems.length + portalRecords.length,
      error: input.error
    },
    sampleItemIds
  };
}
