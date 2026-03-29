export const APP_NAME = "propotsdam-cli";
export const DEFAULT_BASE_URL = "https://propotsdam-kundenportal.easysquare.com";
export const DEFAULT_APP_PATH = "/propotsdam-kundenportal/index.html#";
export const DEFAULT_APP_URL = `${DEFAULT_BASE_URL}${DEFAULT_APP_PATH}`;
export const DEFAULT_API_VERSION = "6.262";
export const LOGGED_SERVICES_PATH = "/prorex/esq/logi/services";
export const OPEN_SERVICES_PATH = "/propotsdam-kundenportal/api5/services";
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_ALIASES = {
  inbox: ["Postfach", "Nachrichten", "Mitteilungen", "Mailbox", "Nachricht"],
  documents: ["Dokumente", "Unterlagen", "Dateien", "Dokument", "Bescheide"]
} as const;

export const EXIT_CODES = {
  UNKNOWN: 1,
  AUTH_INVALID: 2,
  PORTAL_CHANGED: 3,
  DOWNLOAD_FAILED: 4
} as const;

export const STATIC_FILE_PATTERN =
  /\.(?:css|js|map|png|jpe?g|gif|svg|ico|woff2?|ttf|json)$/i;
