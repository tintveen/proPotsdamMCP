export const APP_NAME = "propotsdam-mcp";
export const KEYCHAIN_SERVICE = "propotsdam-mcp";
export const DEFAULT_BASE_URL = "https://propotsdam-kundenportal.easysquare.com";
export const DEFAULT_APP_PATH = "/propotsdam-kundenportal";
export const DEFAULT_API_VERSION = "6.262";
export const DEFAULT_APP_VERSION = "6.262.8";
export const DEFAULT_LANGUAGE = "de";

export const AUTHENTICATE_PATH = `${DEFAULT_APP_PATH}/api5/authenticate`;
export const API5_SERVICES_PATH = `${DEFAULT_APP_PATH}/api5/services`;
export const LOGGED_SERVICES_PATH = "/prorex/esq/logi/services";

export const INBOX_ALIASES = [
  "postfach",
  "nachrichten",
  "mitteilungen",
  "mailbox",
  "message",
  "messages"
];

export const DOCUMENT_ALIASES = [
  "dokumente",
  "unterlagen",
  "dateien",
  "bescheide",
  "documents",
  "files"
];

export const GENERIC_SERVICE_ALIASES = [
  "verträge",
  "vertraege",
  "vertrag",
  "tenant",
  "reparatur",
  "kundenservice",
  "verbräuche",
  "verbraeuche",
  "hausinfo",
  "pinbrd",
  "immobiliensuche",
  "meine daten",
  "ESQ_TENANT",
  "ESQ_TENA_DMG",
  "ESQ_TENA_SRV",
  "ESQ_TENA_CSM",
  "TN_PINBRD",
  "ESQ_IA_REOBJ",
  "ESQ_IA_PART"
].map((value) => value.toLowerCase());

export const SECRET_REDACTION = "[REDACTED]";
