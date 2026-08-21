import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import { CookieJar } from "tough-cookie";
import {
  SwpClientError,
  type ResolvedSwpDraft,
  type SwpAddress,
  type SwpCommitResult,
  type SwpDescribedItemKind,
  type SwpFormContract,
  type SwpFormFieldContract,
  type SwpFormFieldType,
  type SwpItemKind,
  type SwpQuantityItemKind,
  type SwpSalutation
} from "./types.js";

const SWP_ORIGIN = "https://www.swp-potsdam.de";
const SWP_FORM_URL = `${SWP_ORIGIN}/de/entsorgung/sperrm%C3%BCllabholung/`;
const SWP_BOOTSTRAP_URL = `${SWP_ORIGIN}/servlet/form`;
const SWP_FORM_ID = "commandDE77137";
const SWP_SUCCESS_ID = `mwf-success-${SWP_FORM_ID}`;
const SWP_MAX_READ_BODY_BYTES = 8 * 1024 * 1024;
const SWP_MAX_FINAL_BODY_BYTES = 2 * 1024 * 1024;
const SWP_UNCERTAIN_MESSAGE = "The STEP request outcome is uncertain because the final response could not be verified. The confirmation was consumed. Do not retry automatically; check for a STEP response before preparing a replacement.";

const SALUTATION_VALUES: Record<SwpSalutation, string> = {
  mrs: "MISS",
  mr: "MISTER",
  none: "Keine Angabe"
};

const QUANTITY_FIELD_BY_KIND: Record<SwpQuantityItemKind, string> = {
  couch_sofa_bed: "couch",
  mattress: "matratze",
  cabinet_sideboard_shelf: "schrank",
  armchair: "sessel",
  chair_stool: "stuhl",
  table: "tisch",
  bicycle: "fahrrad",
  drying_rack: "waeschestaender",
  fridge_freezer: "kuehlschrank",
  washer_dryer: "waschmaschine",
  dishwasher: "Geschirrspueler",
  cooker: "Herd",
  tv_monitor: "Bildschirme",
  vacuum_cleaner: "Staubsauger"
};

const DESCRIBED_FIELD_BY_KIND: Readonly<Record<SwpDescribedItemKind, string>> = {
  other_bulky: "sonstiges",
  other_metal: "sonstiger_schrott",
  electrical_over_50cm: "Kante_50",
  other_small_electrical: "sonstiges_elektro"
};

const LARGE_ELECTRICAL_KINDS = new Set<SwpItemKind>([
  "fridge_freezer",
  "washer_dryer",
  "dishwasher",
  "cooker",
  "electrical_over_50cm"
]);

const SMALL_ELECTRICAL_KINDS = new Set<SwpItemKind>([
  "other_small_electrical"
]);

const ELECTRICAL_KINDS = new Set<SwpItemKind>([
  ...LARGE_ELECTRICAL_KINDS,
  ...SMALL_ELECTRICAL_KINDS,
  "tv_monitor",
  "vacuum_cleaner"
]);

const SUPPORTED_ITEM_KINDS: readonly SwpItemKind[] = [
  "couch_sofa_bed",
  "mattress",
  "cabinet_sideboard_shelf",
  "armchair",
  "chair_stool",
  "floor_covering",
  "table",
  "other_bulky",
  "bicycle",
  "drying_rack",
  "other_metal",
  "fridge_freezer",
  "washer_dryer",
  "dishwasher",
  "cooker",
  "tv_monitor",
  "vacuum_cleaner",
  "electrical_over_50cm",
  "other_small_electrical"
];

const EXPECTED_FIELD_TYPES: Readonly<Record<string, SwpFormFieldType>> = {
  anrede: "select",
  name: "text",
  vorname: "text",
  strasse: "text",
  hausnummer: "text",
  plz: "text",
  ort: "text",
  Kassenzeichen: "text",
  telefon: "text",
  mail: "email",
  alternative_adresse: "checkbox",
  strasse2: "text",
  hausnummer2: "text",
  plz2: "text",
  ort2: "text",
  couch: "text",
  matratze: "text",
  schrank: "text",
  sessel: "text",
  stuhl: "text",
  teppich: "text",
  tisch: "text",
  sonstiges: "textarea",
  fahrrad: "text",
  waeschestaender: "text",
  sonstiger_schrott: "textarea",
  elektroauswahl: "checkbox",
  kuehlschrank: "text",
  waschmaschine: "text",
  Geschirrspueler: "text",
  Herd: "text",
  Bildschirme: "text",
  Staubsauger: "text",
  Kante_50: "text",
  sonstiges_elektro: "textarea",
  abholtermin: "text",
  Ablageort: "text",
  textfeld: "textarea"
};

const EXPECTED_REQUIRED_FIELDS = new Set([
  "anrede",
  "name",
  "strasse",
  "hausnummer",
  "plz",
  "ort",
  "mail",
  "strasse2",
  "hausnummer2",
  "plz2",
  "ort2",
  "abholtermin"
]);

const CONDITIONAL_FIELDS = new Set([
  "strasse2",
  "hausnummer2",
  "plz2",
  "ort2",
  "kuehlschrank",
  "waschmaschine",
  "Geschirrspueler",
  "Herd",
  "Bildschirme",
  "Staubsauger",
  "Kante_50",
  "sonstiges_elektro"
]);

const EXPECTED_SALUTATION_VALUES = ["VALUE_EMPTY", "MISS", "MISTER", "Keine Angabe"];

interface BootstrapResult {
  contract: SwpFormContract;
  submitUrl: string;
  jar: CookieJar;
  currentOtherSmallElectricalRule: boolean;
}

interface PinnedResponse {
  body: string;
  status: number;
}

export class SwpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async inspect(): Promise<SwpFormContract> {
    const bootstrapped = await this.bootstrap();
    assertSupportedContract(bootstrapped);
    return cloneContract(bootstrapped.contract);
  }

  async commit(draft: ResolvedSwpDraft, expectedFingerprint: string): Promise<SwpCommitResult> {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
      throw new SwpClientError("A valid SWP form fingerprint is required.", "INVALID_DRAFT");
    }

    const bootstrapped = await this.bootstrap();
    if (bootstrapped.contract.fingerprint !== expectedFingerprint) {
      throw new SwpClientError(
        "The SWP form changed after inspection; inspect it again before submitting.",
        "FORM_DRIFT"
      );
    }
    assertSupportedContract(bootstrapped);

    const body = buildSubmissionBody(draft);
    const response = await this.requestPinned(
      bootstrapped.jar,
      bootstrapped.submitUrl,
      {
        method: "POST",
        headers: ajaxHeaders(),
        body
      },
      "submission",
      true
    );

    const $ = load(response.body);
    const success = $(`#${SWP_SUCCESS_ID}`);
    if (success.length !== 1) {
      if ($(`[id$="errors"], .has-error, #${SWP_FORM_ID}`).length > 0) {
        throw new SwpClientError(
          "SWP rejected the submission as invalid.",
          "VALIDATION_FAILED",
          response.status
        );
      }
      throw new SwpClientError(
        SWP_UNCERTAIN_MESSAGE,
        "AMBIGUOUS_WRITE",
        response.status
      );
    }

    return {
      ok: true,
      status: "submitted",
      httpStatus: response.status,
      fingerprint: bootstrapped.contract.fingerprint,
      summary: "STEP received the bulky-waste pickup request. The pickup date may be communicated separately."
    };
  }

  private async bootstrap(): Promise<BootstrapResult> {
    const jar = new CookieJar();
    const landing = await this.requestPinned(jar, SWP_FORM_URL, { method: "GET" }, "landing page");
    const formDefinition = parseFormDefinition(landing.body);
    const bootstrapBody = new URLSearchParams([
      ["_parentUrl", SWP_FORM_URL],
      ["_view", "webform"],
      ["_fd", formDefinition],
      ["_refs", ""],
      ["_lang", "de_DE"],
      ["_ticket", "&_ticket="],
      ["_reset", "true"]
    ]).toString();

    const formResponse = await this.requestPinned(
      jar,
      SWP_BOOTSTRAP_URL,
      {
        method: "POST",
        headers: ajaxHeaders(),
        body: bootstrapBody
      },
      "form bootstrap"
    );
    const parsed = parseFormContract(formResponse.body);
    return { ...parsed, jar };
  }

  private async requestPinned(
    jar: CookieJar,
    requestUrl: string,
    init: RequestInit,
    purpose: string,
    finalWrite = false
  ): Promise<PinnedResponse> {
    const url = assertPinnedUrl(requestUrl);
    const headers = new Headers(init.headers);
    const cookie = await jar.getCookieString(url.toString());
    if (cookie) {
      headers.set("cookie", cookie);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        ...init,
        headers,
        redirect: "manual"
      });
    } catch {
      throw new SwpClientError(
        finalWrite ? SWP_UNCERTAIN_MESSAGE : `The SWP ${purpose} request failed.`,
        finalWrite ? "AMBIGUOUS_WRITE" : "NETWORK_ERROR"
      );
    }

    if (response.redirected || (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      throw new SwpClientError(
        finalWrite ? SWP_UNCERTAIN_MESSAGE : `The SWP ${purpose} request attempted a redirect.`,
        finalWrite ? "AMBIGUOUS_WRITE" : "REDIRECT_BLOCKED",
        response.status
      );
    }
    if (response.url) {
      try {
        assertPinnedUrl(response.url);
      } catch (error) {
        if (finalWrite) {
          throw new SwpClientError(SWP_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE", response.status);
        }
        throw error;
      }
    }
    if (!response.ok) {
      if (finalWrite && response.status >= 500) {
        throw new SwpClientError(SWP_UNCERTAIN_MESSAGE, "AMBIGUOUS_WRITE", response.status);
      }
      throw new SwpClientError(`The SWP ${purpose} request failed.`, "HTTP_ERROR", response.status);
    }

    if (!finalWrite) {
      await storeCookies(jar, response.headers, url.toString());
    }
    let body: string;
    try {
      body = await readLimitedText(
        response,
        finalWrite ? SWP_MAX_FINAL_BODY_BYTES : SWP_MAX_READ_BODY_BYTES
      );
    } catch {
      throw new SwpClientError(
        finalWrite ? SWP_UNCERTAIN_MESSAGE : `The SWP ${purpose} response was too large or unreadable.`,
        finalWrite ? "AMBIGUOUS_WRITE" : "FORM_PARSE_FAILED",
        response.status
      );
    }
    return {
      body,
      status: response.status
    };
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error("response too large");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseFormDefinition(html: string): string {
  const $ = load(html);
  for (const script of $("script").toArray()) {
    const source = $(script).html() ?? "";
    const match = source.match(/(?:["']?_fd["']?\s*:\s*["'])([^"']+)(?:["'])/);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new SwpClientError("The SWP landing page did not expose its form bootstrap.", "FORM_PARSE_FAILED");
}

function parseFormContract(html: string): Omit<BootstrapResult, "jar"> {
  const $ = load(html);
  const form = $("form").filter((_, element) => $(element).find('[name="anrede"]').length > 0).first();
  if (form.length !== 1) {
    throw new SwpClientError("The SWP form could not be identified.", "FORM_PARSE_FAILED");
  }

  const formId = form.attr("id") ?? "";
  if (!formId) {
    throw new SwpClientError("The SWP form has no stable form identifier.", "FORM_PARSE_FAILED");
  }

  const fields: SwpFormFieldContract[] = [];
  const names = new Set<string>();
  for (const element of form.find("input[name], select[name], textarea[name]").toArray()) {
    const control = $(element);
    const name = control.attr("name") ?? "";
    const inputType = (control.attr("type") ?? "text").toLowerCase();
    if (!name || inputType === "hidden" || name.startsWith("_")) {
      continue;
    }
    if (names.has(name)) {
      throw new SwpClientError("The SWP form contains duplicate semantic fields.", "FORM_PARSE_FAILED");
    }
    names.add(name);

    const type = semanticFieldType(control.get(0)?.tagName ?? "", inputType);
    const id = control.attr("id") ?? "";
    const label = form.find("label").filter((_, candidate) => $(candidate).attr("for") === id).first();
    const required = label.find(".mwf-required").length > 0;
    const options = type === "select"
      ? control.find("option").toArray().map((option) => ({
          value: $(option).attr("value") ?? "",
          label: normalizeWhitespace($(option).text())
        }))
      : undefined;

    fields.push({
      name,
      type,
      required,
      conditional: CONDITIONAL_FIELDS.has(name),
      ...(options ? { options } : {})
    });
  }
  fields.sort((left, right) => compareStrings(left.name, right.name));

  const scriptSource = formConfigScript($, formId);
  const submitUrl = parseSubmitUrl(scriptSource);
  const currentOtherSmallElectricalRule = hasCurrentOtherSmallElectricalRule($, form, scriptSource);
  const requiredFields = fields
    .filter((field) => field.required)
    .map((field) => field.name)
    .sort(compareStrings);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      formId,
      fields,
      currentOtherSmallElectricalRule,
      submitPath: "/servlet/form"
    }))
    .digest("hex");

  return {
    submitUrl,
    currentOtherSmallElectricalRule,
    contract: {
      sourceUrl: SWP_FORM_URL,
      formId,
      fingerprint,
      fields,
      requiredFields,
      supportedItemKinds: [...SUPPORTED_ITEM_KINDS],
      constraints: {
        alternatePickupAddressRequiresCompleteAddress: true,
        earliestPickupDateIsNotAnAppointment: true,
        smallElectricalRequiresLargeAppliance: true,
        otherSmallElectricalRequiresFridgeOrWasher: true
      }
    }
  };
}

function formConfigScript($: CheerioAPI, formId: string): string {
  for (const script of $("script").toArray()) {
    const source = $(script).html() ?? "";
    if (source.includes(formId) && source.includes(".webforms") && /\burl\s*:/.test(source)) {
      return source;
    }
  }
  throw new SwpClientError("The SWP form submission configuration is missing.", "FORM_PARSE_FAILED");
}

function parseSubmitUrl(scriptSource: string): string {
  const match = scriptSource.match(/\burl\s*:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new SwpClientError("The SWP form submission target is missing.", "FORM_PARSE_FAILED");
  }
  const url = assertPinnedUrl(new URL(match[1], SWP_ORIGIN).toString());
  const hasToken = [...url.searchParams.keys()].some((key) => key.startsWith("_mwfToken:"));
  if (url.pathname !== "/servlet/form" || !hasToken) {
    throw new SwpClientError("The SWP form submission target is unsupported.", "FORM_PARSE_FAILED");
  }
  return url.toString();
}

function hasCurrentOtherSmallElectricalRule(
  $: CheerioAPI,
  form: ReturnType<CheerioAPI>,
  scriptSource: string
): boolean {
  const idFor = (name: string) => form.find(`[name="${name}"]`).attr("data-mwf-id")
    ?? form.find(`[name="${name}"]`).attr("id")
    ?? "";
  const fridgeId = idFor("kuehlschrank");
  const washerId = idFor("waschmaschine");
  const otherSmallId = idFor("sonstiges_elektro");
  if (!fridgeId || !washerId || !otherSmallId) {
    return false;
  }

  const emptyCondition = (id: string, name: string) => new RegExp(
    `["']${escapeRegex(id)}["']\\s*,\\s*["']${escapeRegex(name)}["']\\s*,\\s*["']empty["']`
  ).test(scriptSource);
  const disabledTarget = new RegExp(
    `["']input["']\\s*:\\s*["']${escapeRegex(otherSmallId)}["'][^}]*["']state["']\\s*:\\s*["']disabled["']`
  ).test(scriptSource);
  return emptyCondition(fridgeId, "kuehlschrank")
    && emptyCondition(washerId, "waschmaschine")
    && disabledTarget;
}

function assertSupportedContract(parsed: Omit<BootstrapResult, "jar"> | BootstrapResult): void {
  const { contract, currentOtherSmallElectricalRule } = parsed;
  const fieldNames = contract.fields.map((field) => field.name);
  const expectedNames = Object.keys(EXPECTED_FIELD_TYPES).sort(compareStrings);
  if (
    contract.formId !== SWP_FORM_ID
    || fieldNames.length !== expectedNames.length
    || fieldNames.some((name, index) => name !== expectedNames[index])
    || !currentOtherSmallElectricalRule
  ) {
    throw new SwpClientError("The current SWP form contract is not supported.", "FORM_UNSUPPORTED");
  }

  for (const field of contract.fields) {
    if (field.type !== EXPECTED_FIELD_TYPES[field.name]) {
      throw new SwpClientError("The current SWP form field types are not supported.", "FORM_UNSUPPORTED");
    }
  }
  const actualRequired = new Set(contract.requiredFields);
  if (
    actualRequired.size !== EXPECTED_REQUIRED_FIELDS.size
    || [...EXPECTED_REQUIRED_FIELDS].some((name) => !actualRequired.has(name))
  ) {
    throw new SwpClientError("The current SWP required fields are not supported.", "FORM_UNSUPPORTED");
  }

  const salutation = contract.fields.find((field) => field.name === "anrede");
  const values = salutation?.options?.map((option) => option.value) ?? [];
  if (values.length !== EXPECTED_SALUTATION_VALUES.length || values.some((value, index) => value !== EXPECTED_SALUTATION_VALUES[index])) {
    throw new SwpClientError("The current SWP salutation options are not supported.", "FORM_UNSUPPORTED");
  }
}

function buildSubmissionBody(draft: ResolvedSwpDraft): string {
  if (!draft || typeof draft !== "object") {
    throw new SwpClientError("A resolved SWP draft is required.", "INVALID_DRAFT");
  }
  const contact = draft.contact;
  if (!contact || typeof contact !== "object") {
    throw new SwpClientError("The SWP contact is required.", "INVALID_DRAFT");
  }

  const contactAddress = validateAddress(contact.address, "contact address");
  const pickupAddress = draft.pickupAddress
    ? validateAddress(draft.pickupAddress, "pickup address")
    : undefined;
  const salutation = SALUTATION_VALUES[contact.salutation];
  if (!salutation) {
    throw new SwpClientError("The SWP salutation is invalid.", "INVALID_DRAFT");
  }
  const surname = requiredText(contact.surname, "surname");
  const email = requiredText(contact.email, "email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SwpClientError("The SWP email address is invalid.", "INVALID_DRAFT");
  }
  const date = formatGermanDate(draft.earliestPickupDate);

  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    throw new SwpClientError("At least one SWP item is required.", "INVALID_DRAFT");
  }
  const itemKinds = new Set<SwpItemKind>();
  for (const item of draft.items) {
    if (!item || typeof item !== "object" || !SUPPORTED_ITEM_KINDS.includes(item.kind)) {
      throw new SwpClientError("The SWP item list contains an unsupported item.", "INVALID_DRAFT");
    }
    itemKinds.add(item.kind);
  }
  const hasSmallElectrical = [...itemKinds].some((kind) => SMALL_ELECTRICAL_KINDS.has(kind));
  const hasLargeElectrical = [...itemKinds].some((kind) => LARGE_ELECTRICAL_KINDS.has(kind));
  if (hasSmallElectrical && !hasLargeElectrical) {
    throw new SwpClientError(
      "Small electrical devices require at least one large electrical appliance.",
      "INVALID_DRAFT"
    );
  }
  if (
    itemKinds.has("other_small_electrical")
    && !itemKinds.has("fridge_freezer")
    && !itemKinds.has("washer_dryer")
  ) {
    throw new SwpClientError(
      "The current SWP form accepts other small electrical devices only with a fridge/freezer or washer/dryer.",
      "INVALID_DRAFT"
    );
  }

  const values = Object.fromEntries(Object.keys(EXPECTED_FIELD_TYPES).map((name) => [name, ""])) as Record<string, string>;
  values.anrede = salutation;
  values.name = surname;
  values.vorname = optionalText(contact.firstName, "first name");
  values.strasse = contactAddress.street;
  values.hausnummer = contactAddress.houseNumber;
  values.plz = contactAddress.postalCode;
  values.ort = contactAddress.city;
  values.Kassenzeichen = optionalText(contact.customerReference, "customer reference");
  values.telefon = optionalText(contact.phone, "phone");
  values.mail = email;
  if (pickupAddress) {
    values.alternative_adresse = "alternativ_adresse";
    values.strasse2 = pickupAddress.street;
    values.hausnummer2 = pickupAddress.houseNumber;
    values.plz2 = pickupAddress.postalCode;
    values.ort2 = pickupAddress.city;
  }
  if ([...itemKinds].some((kind) => ELECTRICAL_KINDS.has(kind))) {
    values.elektroauswahl = "elektroschrott";
  }

  const quantityTotals = new Map<string, number>();
  const describedValues = new Map<string, string[]>();
  let floorCoveringArea = 0;
  for (const item of draft.items) {
    switch (item.kind) {
      case "floor_covering":
        floorCoveringArea += positiveNumber(item.areaSquareMetres, "floor-covering area");
        break;
      case "other_bulky":
      case "other_metal":
      case "electrical_over_50cm":
      case "other_small_electrical": {
        const field = DESCRIBED_FIELD_BY_KIND[item.kind as SwpDescribedItemKind];
        const entries = describedValues.get(field) ?? [];
        entries.push(`${positiveInteger(item.quantity, "item quantity")} x ${requiredText(item.description, "item description")}`);
        describedValues.set(field, entries);
        break;
      }
      default: {
        const field = QUANTITY_FIELD_BY_KIND[item.kind as SwpQuantityItemKind];
        quantityTotals.set(field, (quantityTotals.get(field) ?? 0) + positiveInteger(item.quantity, "item quantity"));
      }
    }
  }
  for (const [field, quantity] of quantityTotals) {
    values[field] = String(quantity);
  }
  if (floorCoveringArea > 0) {
    values.teppich = formatGermanNumber(floorCoveringArea);
  }
  for (const [field, entries] of describedValues) {
    values[field] = entries.join("\n");
  }
  values.abholtermin = date;
  values.Ablageort = optionalText(draft.placement, "placement");
  values.textfeld = optionalText(draft.message, "message");

  const body = new URLSearchParams();
  body.set("_parentUrl", SWP_FORM_URL);
  for (const name of Object.keys(EXPECTED_FIELD_TYPES)) {
    body.set(name, values[name] ?? "");
  }
  body.set("_alternative_adresse", "on");
  body.set("_elektroauswahl", "on");
  body.set("_finish", "1");
  return body.toString();
}

function validateAddress(value: SwpAddress, label: string): SwpAddress {
  if (!value || typeof value !== "object") {
    throw new SwpClientError(`The SWP ${label} is required.`, "INVALID_DRAFT");
  }
  const postalCode = requiredText(value.postalCode, `${label} postcode`);
  if (!/^\d{5}$/.test(postalCode)) {
    throw new SwpClientError(`The SWP ${label} postcode is invalid.`, "INVALID_DRAFT");
  }
  return {
    street: requiredText(value.street, `${label} street`),
    houseNumber: requiredText(value.houseNumber, `${label} house number`),
    postalCode,
    city: requiredText(value.city, `${label} city`)
  };
}

function requiredText(value: unknown, label: string): string {
  const normalized = optionalText(value, label);
  if (!normalized) {
    throw new SwpClientError(`The SWP ${label} is required.`, "INVALID_DRAFT");
  }
  return normalized;
}

function optionalText(value: unknown, label: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new SwpClientError(`The SWP ${label} is invalid.`, "INVALID_DRAFT");
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SwpClientError(`The SWP ${label} must be a positive integer.`, "INVALID_DRAFT");
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SwpClientError(`The SWP ${label} must be positive.`, "INVALID_DRAFT");
  }
  return value;
}

function formatGermanDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new SwpClientError("The earliest SWP pickup date is invalid.", "INVALID_DRAFT");
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new SwpClientError("The earliest SWP pickup date must use YYYY-MM-DD.", "INVALID_DRAFT");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new SwpClientError("The earliest SWP pickup date is invalid.", "INVALID_DRAFT");
  }
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function formatGermanNumber(value: number): string {
  return String(value).replace(".", ",");
}

function semanticFieldType(tagName: string, inputType: string): SwpFormFieldType {
  const tag = tagName.toLowerCase();
  if (tag === "select") {
    return "select";
  }
  if (tag === "textarea") {
    return "textarea";
  }
  if (tag !== "input" || !["checkbox", "email", "text"].includes(inputType)) {
    throw new SwpClientError("The SWP form contains an unsupported field type.", "FORM_PARSE_FAILED");
  }
  return inputType as SwpFormFieldType;
}

function ajaxHeaders(): HeadersInit {
  return {
    accept: "text/html, */*;q=0.8",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    referer: SWP_FORM_URL,
    "x-requested-with": "XMLHttpRequest"
  };
}

function assertPinnedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SwpClientError("The SWP request target is invalid.", "ORIGIN_BLOCKED");
  }
  if (url.protocol !== "https:" || url.origin !== SWP_ORIGIN || url.username || url.password || url.hash) {
    throw new SwpClientError("The SWP request target left the pinned HTTPS origin.", "ORIGIN_BLOCKED");
  }
  return url;
}

async function storeCookies(jar: CookieJar, headers: Headers, requestUrl: string): Promise<void> {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = typeof withGetter.getSetCookie === "function"
    ? withGetter.getSetCookie()
    : splitCombinedSetCookie(headers.get("set-cookie") ?? "");
  for (const cookie of cookies) {
    try {
      await jar.setCookie(cookie, requestUrl);
    } catch {
      throw new SwpClientError("SWP returned an invalid session cookie.", "NETWORK_ERROR");
    }
  }
}

function splitCombinedSetCookie(header: string): string[] {
  return header
    ? header.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function cloneContract(contract: SwpFormContract): SwpFormContract {
  return {
    ...contract,
    fields: contract.fields.map((field) => ({
      ...field,
      ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {})
    })),
    requiredFields: [...contract.requiredFields],
    supportedItemKinds: [...contract.supportedItemKinds],
    constraints: { ...contract.constraints }
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
