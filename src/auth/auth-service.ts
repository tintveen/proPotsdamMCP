import path from "node:path";
import { DEFAULT_TIMEOUT_MS, EXIT_CODES } from "../constants.js";
import { CliError } from "../errors.js";
import { logger } from "../logger.js";
import {
  deleteStoredSession,
  ensureStorageDirs,
  hasStoredSession,
  loadProfile,
  saveProfile,
  storagePaths
} from "../storage.js";
import { closeBrowserSession, gotoApp, openBrowserSession, readSessionStatusFromPage } from "../browser.js";
import { probeSessionOverHttp } from "../transport/portal-http-client.js";
import { TraceRecorder } from "../transport/trace-recorder.js";
import type { PortalProfile, SessionStatus } from "../types.js";

export class AuthService {
  async login(baseUrl?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SessionStatus> {
    await ensureStorageDirs();
    const profile = await loadProfile();
    const nextProfile: PortalProfile = {
      ...profile,
      baseUrl: baseUrl ?? profile.baseUrl,
      appUrl: `${baseUrl ?? profile.baseUrl}/propotsdam-kundenportal/index.html#`
    };

    const session = await openBrowserSession({ headless: false });
    const recorder = new TraceRecorder(nextProfile.baseUrl, "login");
    recorder.attach(session.context);

    try {
      logger.info("Browser opened for interactive login. Complete the login in the browser window.");
      await gotoApp(session.page, nextProfile);
      await waitForSuccessfulLogin(session.page, timeoutMs);
      const status = await readSessionStatusFromPage(session.page);
      if (!status.valid) {
        throw new CliError("Login completed but no authenticated session marker was found.", EXIT_CODES.AUTH_INVALID);
      }

      await session.context.storageState({ path: storagePaths.storageStateFile });
      const traceFile = path.join(storagePaths.tracesDir, `login-${Date.now()}.json`);
      await recorder.save(traceFile);

      nextProfile.lastLoginAt = new Date().toISOString();
      nextProfile.lastValidatedAt = nextProfile.lastLoginAt;
      nextProfile.lastTraceFile = traceFile;
      nextProfile.discoveredEndpoints = [
        ...new Set([
          ...nextProfile.discoveredEndpoints,
          ...recorder
            .getRecords()
            .map((record) => record.url)
            .filter((url) => url.includes("/api") || url.includes("/logi/"))
        ])
      ];
      await saveProfile(nextProfile);

      return status;
    } finally {
      recorder.detach(session.context);
      await closeBrowserSession(session);
    }
  }

  async logout(): Promise<void> {
    await deleteStoredSession();
  }

  async status(): Promise<SessionStatus> {
    const profile = await loadProfile();
    if (!(await hasStoredSession())) {
      return { valid: false, source: "none" };
    }

    const status = await probeSessionOverHttp(profile, storagePaths.storageStateFile);
    if (status.valid) {
      profile.lastValidatedAt = new Date().toISOString();
      await saveProfile(profile);
      return status;
    }

    const session = await openBrowserSession({
      headless: true,
      storageState: storagePaths.storageStateFile
    });

    try {
      await gotoApp(session.page, profile);
      const pageStatus = await readSessionStatusFromPage(session.page);
      if (pageStatus.valid) {
        profile.lastValidatedAt = new Date().toISOString();
        await saveProfile(profile);
      }
      return pageStatus;
    } finally {
      await closeBrowserSession(session);
    }
  }
}

async function waitForSuccessfulLogin(page: import("playwright").Page, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await readSessionStatusFromPage(page);
    if (status.valid) {
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new CliError(
    `Login timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
    EXIT_CODES.AUTH_INVALID
  );
}
