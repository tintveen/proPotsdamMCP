import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { CliError } from "./errors.js";
import { storagePaths } from "./storage.js";
import type { PortalProfile, SessionStatus } from "./types.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function openBrowserSession(options: {
  headless: boolean;
  storageState?: string;
}): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: options.storageState
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  return { browser, context, page };
}

export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  await session.context.close();
  await session.browser.close();
}

export async function gotoApp(page: Page, profile: PortalProfile): Promise<void> {
  await page.goto(profile.appUrl, { waitUntil: "domcontentloaded" });
  await waitForPortalIdle(page);
}

export async function waitForPortalIdle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1_000);
}

export async function readSessionStatusFromPage(page: Page): Promise<SessionStatus> {
  const details = await page.evaluate(() => {
    const data = {
      url: window.location.href,
      text: document.body?.innerText ?? ""
    };

    const sapCore = (window as typeof window & { sap?: unknown }).sap as
      | { ui?: { getCore?: () => { getModel?: (name: string) => unknown } } }
      | undefined;
    const headerModel = sapCore?.ui?.getCore?.().getModel?.("header") as
      | { getData?: () => unknown }
      | undefined;
    const payload = headerModel?.getData?.();

    const lookup = (target: unknown, key: string): string | undefined => {
      if (!target || typeof target !== "object") {
        return undefined;
      }
      if (Array.isArray(target)) {
        for (const entry of target) {
          const found = lookup(entry, key);
          if (found) {
            return found;
          }
        }
        return undefined;
      }
      const objectTarget = target as Record<string, unknown>;
      for (const [childKey, value] of Object.entries(objectTarget)) {
        if (childKey === key && value !== undefined && value !== null) {
          return String(value);
        }
        const found = lookup(value, key);
        if (found) {
          return found;
        }
      }
      return undefined;
    };

    return {
      url: data.url,
      text: data.text,
      userId: lookup(payload, "USER_ID"),
      userFullName: lookup(payload, "USER_FULLNAME"),
      logged: lookup(payload, "LOGGED")
    };
  });

  const looksLoggedIn =
    !details.url.includes("#/login") &&
    Boolean(
      details.userId ||
        details.userFullName ||
        (details.logged && details.logged !== "false" && details.logged !== "0")
    );

  return {
    valid: looksLoggedIn,
    userId: details.userId,
    userFullName: details.userFullName,
    source: "page"
  };
}

export async function requireStoredSession(): Promise<string> {
  try {
    return storagePaths.storageStateFile;
  } catch {
    throw new CliError("No stored session found. Run `propotsdam auth login` first.", 2);
  }
}
