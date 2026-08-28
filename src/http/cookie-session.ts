import { CookieJar } from "tough-cookie";
import { AUTHENTICATE_PATH } from "../constants.js";
import type { PortalConfig, StoredSession } from "../types.js";
import type { PortalWritePermit } from "./write-permit.js";
import { consumePortalWritePermit } from "./write-permit.js";

export interface HttpResponse<T = string> {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  body: T;
  contentType?: string;
}

export class CookieSession {
  readonly jar: CookieJar;
  csrfToken?: string;

  constructor(
    private readonly config: PortalConfig,
    stored?: StoredSession | null,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.jar = stored?.cookieJar ? CookieJar.fromJSON(stored.cookieJar as Parameters<typeof CookieJar.fromJSON>[0]) : new CookieJar();
    this.csrfToken = stored?.csrfToken;
  }

  serialize(): StoredSession {
    const stored: StoredSession = {
      cookieJar: this.jar.toJSON(),
      savedAt: new Date().toISOString()
    };
    if (this.csrfToken) {
      stored.csrfToken = this.csrfToken;
    }
    return stored;
  }

  async get(pathOrUrl: string, init: RequestInit = {}): Promise<HttpResponse> {
    this.assertReadOnlyGet(pathOrUrl);
    return this.request(pathOrUrl, { ...init, method: "GET" });
  }

  async getBinary(pathOrUrl: string, init: RequestInit = {}): Promise<HttpResponse<Uint8Array>> {
    this.assertReadOnlyGet(pathOrUrl);
    const response = await this.requestRaw(pathOrUrl, { ...init, method: "GET" });
    await this.storeCookies(response, this.buildUrl(pathOrUrl));
    this.captureCsrf(response);
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined
    };
  }

  async post(pathOrUrl: string, body?: BodyInit, init: RequestInit = {}): Promise<HttpResponse> {
    this.assertAuthenticationPost(pathOrUrl);
    return this.request(pathOrUrl, { ...init, body, method: "POST" });
  }

  async writeGet(permit: PortalWritePermit, pathOrUrl: string, init: RequestInit = {}): Promise<HttpResponse> {
    consumePortalWritePermit(permit, "GET", this.buildUrl(pathOrUrl));
    return this.request(pathOrUrl, { ...init, method: "GET" });
  }

  async writePost(
    permit: PortalWritePermit,
    pathOrUrl: string,
    body?: BodyInit,
    init: RequestInit = {}
  ): Promise<HttpResponse> {
    consumePortalWritePermit(permit, "POST", this.buildUrl(pathOrUrl));
    return this.request(pathOrUrl, { ...init, body, method: "POST" });
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<HttpResponse> {
    const response = await this.requestRaw(pathOrUrl, init);
    await this.storeCookies(response, this.buildUrl(pathOrUrl));
    this.captureCsrf(response);
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: response.headers,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? undefined
    };
  }

  buildUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      return pathOrUrl;
    }
    try {
      return new URL(pathOrUrl, this.config.baseUrl).toString();
    } catch {
      throw new Error(`Invalid config baseUrl '${this.config.baseUrl}'. Run \`npm run auth:set\` to repair it.`);
    }
  }

  private assertReadOnlyGet(pathOrUrl: string): void {
    const url = new URL(this.buildUrl(pathOrUrl));
    if (url.searchParams.get("command") !== "action") {
      return;
    }
    const name = url.searchParams.get("name")?.toLowerCase();
    if (name !== "boxlist" && name !== "get") {
      throw new Error(`Portal action '${name ?? "unknown"}' requires an internal write permit.`);
    }
  }

  private assertAuthenticationPost(pathOrUrl: string): void {
    const url = new URL(this.buildUrl(pathOrUrl));
    if (url.pathname !== AUTHENTICATE_PATH) {
      throw new Error("Portal POST requests require an internal write permit unless they authenticate a session.");
    }
  }

  private async requestRaw(pathOrUrl: string, init: RequestInit): Promise<Response> {
    const url = this.buildUrl(pathOrUrl);
    const headers = new Headers(init.headers);
    const cookie = await this.jar.getCookieString(url);
    if (cookie) {
      headers.set("cookie", cookie);
    }
    if (this.csrfToken && !headers.has("X-CSRF-Token")) {
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    headers.set("oppc-id", this.config.clientId);
    headers.set("UTC", String(Date.now()));
    headers.set("user-agent", "propotsdam-mcp/0.2");

    return this.fetchImpl(url, {
      ...init,
      headers,
      redirect: init.redirect ?? "follow"
    });
  }

  private async storeCookies(response: Response, requestUrl: string): Promise<void> {
    const cookies = getSetCookieHeaders(response.headers);
    const cookieUrl = response.url || requestUrl;
    await Promise.all(cookies.map((cookie) => this.jar.setCookie(cookie, cookieUrl)));
  }

  private captureCsrf(response: Response): void {
    const token = response.headers.get("X-CSRF-Token");
    if (token && token.toLowerCase() !== "required") {
      this.csrfToken = token;
    }
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") {
    return withGetter.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? splitCombinedSetCookie(single) : [];
}

function splitCombinedSetCookie(header: string): string[] {
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((entry) => entry.trim()).filter(Boolean);
}
