import type { AuthResult, ListResult, PortalAction, PortalReadDomain, StructuredPortalRecord } from "../types.js";
import type {
  PortalWasteDefaults,
  PortalWasteDefaultsProvider,
  ResolvedWasteContact,
  WasteAddress,
  WasteSalutation
} from "./types.js";

export interface PortalDefaultsClient {
  status(): Promise<AuthResult>;
  listStructuredPortalRecords(filter?: {
    serviceId?: string;
    xuclass?: string;
    domain?: PortalReadDomain;
  }): Promise<ListResult<StructuredPortalRecord>>;
  listPortalActions(filter?: {
    serviceId?: string;
    xuclass?: string;
    actionKind?: PortalAction["actionKind"];
    source?: PortalAction["source"];
    recordId?: string;
  }): Promise<ListResult<PortalAction>>;
  listPortalActionsForDefaults?(): Promise<ListResult<PortalAction>>;
}

interface AddressCandidate {
  contractId: string;
  title: string;
  displayAddress: string;
  address: WasteAddress;
}

export class PortalClientWasteDefaultsProvider implements PortalWasteDefaultsProvider {
  constructor(private readonly client: PortalDefaultsClient) {}

  async resolve(contractId?: string): Promise<PortalWasteDefaults> {
    // Portal reads can establish a fresh session from configured credentials.
    // Resolve them before status so first use works even without saved cookies.
    const records = await this.client.listStructuredPortalRecords();
    const actions = await (this.client.listPortalActionsForDefaults?.() ?? this.client.listPortalActions())
      .catch(() => ({ items: [], source: "boxlist" as const }));
    const status = await this.client.status();

    if (!status.authenticated) {
      return {
        contact: {},
        fieldSources: {},
        candidates: [],
        validationIssues: [status.reason ?? "ProPotsdam authentication is required to resolve contact defaults."]
      };
    }

    const addressCandidates = collectAddressCandidates(records.items);
    const selected = selectAddressCandidate(addressCandidates, contractId);
    const validationIssues: string[] = [];
    if (contractId && !selected) {
      validationIssues.push(`No high-confidence portal contract address matched contractId '${contractId}'.`);
    } else if (!contractId && addressCandidates.length > 1) {
      validationIssues.push("Multiple high-confidence portal contract addresses are available. Provide contractId to choose one.");
    }

    const contact: ResolvedWasteContact = {};
    const fieldSources: PortalWasteDefaults["fieldSources"] = {};
    if (selected) {
      contact.address = selected.address;
      for (const key of ["street", "houseNumber", "postalCode", "city"] as const) {
        fieldSources[`contact.${key}`] = "portal_contract";
      }
    }

    const profileActions = actions.items.filter((action) => action.id === "save_partner"
      || /meine daten|profile|profil/i.test(`${action.title} ${action.serviceTitle}`));
    const ambiguousProfileFields = new Set<string>();
    if (profileActions.length > 0) {
      assignUniqueProfileField(
        contact,
        fieldSources,
        validationIssues,
        ambiguousProfileFields,
        "email",
        fieldValues(profileActions, ["mail", "email", "smtp_addr"])
      );
      assignUniqueProfileField(
        contact,
        fieldSources,
        validationIssues,
        ambiguousProfileFields,
        "phone",
        fieldValues(profileActions, ["phone_ref", "phone", "telephone", "telefon"])
      );
      assignUniqueProfileField(
        contact,
        fieldSources,
        validationIssues,
        ambiguousProfileFields,
        "firstName",
        fieldValues(profileActions, ["firstname", "first_name", "name_first", "name_first_ref", "vorname"])
      );
      assignUniqueProfileField(
        contact,
        fieldSources,
        validationIssues,
        ambiguousProfileFields,
        "lastName",
        fieldValues(profileActions, ["lastname", "last_name", "name_last", "name_last_ref", "surname", "nachname"])
      );
      const salutations = uniqueValues(profileActions.flatMap(salutationsFromAction));
      if (salutations.length === 1) {
        contact.salutation = salutations[0] as WasteSalutation;
        fieldSources["contact.salutation"] = "portal_profile";
      } else if (salutations.length > 1) {
        ambiguousProfileFields.add("contact.salutation");
        validationIssues.push("Multiple portal profile values were found for contact.salutation. Provide an explicit override.");
      }
    }

    if (!contact.firstName && !contact.lastName
      && !ambiguousProfileFields.has("contact.firstName")
      && !ambiguousProfileFields.has("contact.lastName")) {
      const name = splitUnambiguousFullName(status.userFullName);
      if (name) {
        contact.firstName = name.firstName;
        contact.lastName = name.lastName;
        fieldSources["contact.firstName"] = "portal_profile";
        fieldSources["contact.lastName"] = "portal_profile";
      }
    }

    return {
      contractId: selected?.contractId,
      contact,
      fieldSources,
      candidates: addressCandidates.map((candidate) => ({
        contractId: candidate.contractId,
        title: candidate.title,
        address: candidate.displayAddress
      })),
      validationIssues
    };
  }
}

function collectAddressCandidates(records: StructuredPortalRecord[]): AddressCandidate[] {
  const candidates = new Map<string, AddressCandidate>();
  for (const record of records) {
    if (record.confidence !== "high" || !isContractLike(record)) {
      continue;
    }
    const address = extractCompleteAddress(record);
    if (!address) {
      continue;
    }
    const contractId = record.serviceId ?? record.sourceRecordId;
    const key = `${contractId}:${formatAddress(address).toLocaleLowerCase("de-DE")}`;
    candidates.set(key, {
      contractId,
      title: record.serviceTitle || record.sourceRecordTitle,
      displayAddress: formatAddress(address),
      address
    });
  }
  return [...candidates.values()];
}

function isContractLike(record: StructuredPortalRecord): boolean {
  return record.domain === "contract"
    || record.xuclass === "ESQ_TENANT"
    || /vertrag|miet|tenant/i.test(`${record.serviceTitle} ${record.sourceRecordTitle} ${record.title}`);
}

function extractCompleteAddress(record: StructuredPortalRecord): WasteAddress | undefined {
  const values = [
    record.address,
    record.fields.address,
    record.detailText,
    record.sourceRecordTitle,
    record.title
  ].filter((value): value is string => Boolean(value));
  for (const value of values) {
    const parsed = parseGermanAddress(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function parseGermanAddress(value: string): WasteAddress | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  const postcodeMatch = /(?:^|\s|,)\b(\d{5})\b\s+([^,;|]+?)(?=$|[,;|])/.exec(normalized);
  if (!postcodeMatch?.index) {
    return undefined;
  }
  const beforePostcode = normalized.slice(0, postcodeMatch.index).replace(/^.*?(?:adresse|anschrift)\s*:?\s*/i, "").replace(/[,:;|\s]+$/, "");
  const streetMatch = /(.+\S)\s+(\d+[a-zA-Z]?(?:\s*[-/]\s*\d+[a-zA-Z]?)?)$/.exec(beforePostcode);
  if (!streetMatch) {
    return undefined;
  }
  const city = postcodeMatch[2]?.trim();
  const street = streetMatch[1]?.trim();
  const houseNumber = streetMatch[2]?.replace(/\s+/g, "");
  if (!street || !houseNumber || !city) {
    return undefined;
  }
  return {
    street,
    houseNumber,
    postalCode: postcodeMatch[1]!,
    city
  };
}

function selectAddressCandidate(candidates: AddressCandidate[], contractId?: string): AddressCandidate | undefined {
  if (contractId) {
    const matches = candidates.filter((candidate) => candidate.contractId === contractId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function fieldValues(actions: PortalAction[], aliases: string[]): string[] {
  const normalizedAliases = aliases.map(normalizeFieldName);
  return uniqueValues(actions.flatMap((action) => action.fields
    .filter((candidate) => fieldMatchesAliases(candidate, normalizedAliases))
    .map((field) => field.value?.trim())
    .filter((value): value is string => Boolean(value))));
}

function fieldMatchesAliases(field: PortalAction["fields"][number], normalizedAliases: string[]): boolean {
  const name = normalizeFieldName(field.name);
  const portalId = normalizeFieldName(field.portalId ?? "");
  return normalizedAliases.some((alias) => name === alias
    || alias.length >= 5 && name.includes(alias)
    || alias.length >= 5 && portalId.includes(alias));
}

function salutationsFromAction(action: PortalAction): WasteSalutation[] {
  const aliases = ["salutation", "anrede", "int_anrede"].map(normalizeFieldName);
  return action.fields
    .filter((candidate) => fieldMatchesAliases(candidate, aliases))
    .map((field) => {
      const direct = normalizeSalutation(field.value);
      if (direct) {
        return direct;
      }
      const selected = field.options?.find((option) => option.selected || option.value === field.value);
      return normalizeSalutation(selected?.label ?? selected?.value);
    })
    .filter((value): value is WasteSalutation => Boolean(value));
}

function normalizeFieldName(value: string): string {
  return value.toLocaleLowerCase("de-DE").replace(/[^a-z0-9]/g, "");
}

function assignUniqueProfileField(
  contact: ResolvedWasteContact,
  sources: PortalWasteDefaults["fieldSources"],
  validationIssues: string[],
  ambiguousFields: Set<string>,
  key: "firstName" | "lastName" | "email" | "phone",
  values: string[]
): void {
  if (values.length === 0) {
    return;
  }
  if (values.length > 1) {
    const field = `contact.${key}`;
    ambiguousFields.add(field);
    validationIssues.push(`Multiple portal profile values were found for ${field}. Provide an explicit override.`);
    return;
  }
  contact[key] = values[0];
  sources[`contact.${key}`] = "portal_profile";
}

function uniqueValues<T extends string>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase("de-DE");
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeSalutation(value: string | undefined): WasteSalutation | undefined {
  if (!value) {
    return undefined;
  }
  if (/frau|female|weiblich/i.test(value)) {
    return "female";
  }
  if (/herr|male|männlich|maennlich/i.test(value)) {
    return "male";
  }
  if (/keine|none|unspecified|divers/i.test(value)) {
    return "unspecified";
  }
  return undefined;
}

function splitUnambiguousFullName(value: string | undefined): { firstName: string; lastName: string } | undefined {
  if (!value) {
    return undefined;
  }
  const commaParts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length === 2) {
    return { firstName: commaParts[1]!, lastName: commaParts[0]! };
  }
  const words = value.trim().split(/\s+/);
  return words.length === 2 ? { firstName: words[0]!, lastName: words[1]! } : undefined;
}

function formatAddress(address: WasteAddress): string {
  return `${address.street} ${address.houseNumber}, ${address.postalCode} ${address.city}`;
}
