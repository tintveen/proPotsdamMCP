import path from "node:path";
import { EXIT_CODES } from "../constants.js";
import { CliError } from "../errors.js";
import { logger } from "../logger.js";
import { loadProfile, storagePaths } from "../storage.js";
import { closeBrowserSession, gotoApp, openBrowserSession, waitForPortalIdle } from "../browser.js";
import { TraceRecorder } from "../transport/trace-recorder.js";
import type {
  DocumentItem,
  InboxItem,
  ListResult,
  PortalProfile,
  PortalSection
} from "../types.js";
import { extractSectionItemsFromTraces } from "./response-parsers.js";
import { extractItemsFromUi } from "./ui-extractors.js";

export class PortalClient {
  async listInbox(): Promise<ListResult<InboxItem>> {
    const result = await this.listSection("inbox");
    return {
      items: result.items as InboxItem[],
      source: result.source,
      traceFile: result.traceFile
    };
  }

  async getInboxItem(id: string): Promise<InboxItem> {
    const profile = await loadProfile();
    const { session, recorder } = await this.openTrackedSession(profile, "section", true);

    try {
      await gotoApp(session.page, profile);
      await navigateToSection(session.page, profile, "inbox");
      const items = await this.extractSectionItems(session.page, recorder, "inbox");
      const match = items.find((item) => item.id === id);
      if (!match) {
        throw new CliError(`Inbox item '${id}' was not found.`, EXIT_CODES.PORTAL_CHANGED);
      }

      await clickBestEffort(session.page, [match.id, match.title]);
      await waitForPortalIdle(session.page);

      const detailText = await session.page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "");
      return {
        ...(match as InboxItem),
        detailText
      };
    } finally {
      recorder.detach(session.context);
      await closeBrowserSession(session);
    }
  }

  async listDocuments(): Promise<ListResult<DocumentItem>> {
    const result = await this.listSection("documents");
    return {
      items: result.items as DocumentItem[],
      source: result.source,
      traceFile: result.traceFile
    };
  }

  async downloadDocument(id: string, outPath: string): Promise<string> {
    const profile = await loadProfile();
    const { session, recorder } = await this.openTrackedSession(profile, "section", true);

    try {
      await gotoApp(session.page, profile);
      await navigateToSection(session.page, profile, "documents");
      const items = await this.extractSectionItems(session.page, recorder, "documents");
      const match = items.find((item) => item.id === id);
      if (!match) {
        throw new CliError(`Document '${id}' was not found.`, EXIT_CODES.PORTAL_CHANGED);
      }

      const download = session.page.waitForEvent("download", { timeout: 15_000 }).catch(() => null);
      await clickBestEffort(session.page, [match.id, match.title, "Download", "Herunterladen"]);
      const result = await download;
      if (!result) {
        throw new CliError(
          `No browser download was triggered for document '${id}'.`,
          EXIT_CODES.DOWNLOAD_FAILED
        );
      }

      await result.saveAs(path.resolve(outPath));
      return path.resolve(outPath);
    } finally {
      recorder.detach(session.context);
      await closeBrowserSession(session);
    }
  }

  async debugTrace(seconds: number): Promise<string> {
    const profile = await loadProfile();
    const { session, recorder, traceFile } = await this.openTrackedSession(profile, "debug", false);

    try {
      await gotoApp(session.page, profile);
      logger.info(
        `Trace recording started. You can interact with the browser for the next ${seconds} seconds.`
      );
      await session.page.waitForTimeout(seconds * 1000);
      await recorder.save(traceFile);
      return traceFile;
    } finally {
      recorder.detach(session.context);
      await closeBrowserSession(session);
    }
  }

  private async listSection(section: PortalSection): Promise<ListResult<InboxItem | DocumentItem>> {
    const profile = await loadProfile();
    const { session, recorder, traceFile } = await this.openTrackedSession(profile, "section", true);

    try {
      await gotoApp(session.page, profile);
      await navigateToSection(session.page, profile, section);
      const items = await this.extractSectionItems(session.page, recorder, section);
      await recorder.save(traceFile);

      return {
        items,
        source: items[0]?.rawSource ?? "ui",
        traceFile
      };
    } finally {
      recorder.detach(session.context);
      await closeBrowserSession(session);
    }
  }

  private async extractSectionItems(
    page: import("playwright").Page,
    recorder: TraceRecorder,
    section: PortalSection
  ): Promise<(InboxItem | DocumentItem)[]> {
    const fromNetwork = extractSectionItemsFromTraces(section, recorder.getRecords());
    if (fromNetwork.length > 0) {
      return fromNetwork;
    }

    const fromUi = await extractItemsFromUi(page, section);
    if (fromUi.length > 0) {
      return fromUi;
    }

    throw new CliError(
      `Could not extract ${section} entries from network responses or the UI. Run \`propotsdam debug trace\` to inspect the portal.`,
      EXIT_CODES.PORTAL_CHANGED
    );
  }

  private async openTrackedSession(profile: PortalProfile, mode: "section" | "debug", headless: boolean) {
    const session = await openBrowserSession({
      headless,
      storageState: storagePaths.storageStateFile
    });
    const recorder = new TraceRecorder(profile.baseUrl, mode);
    recorder.attach(session.context);
    const traceFile = path.join(storagePaths.tracesDir, `${mode}-${Date.now()}.json`);
    return { session, recorder, traceFile };
  }
}

async function navigateToSection(
  page: import("playwright").Page,
  profile: PortalProfile,
  section: PortalSection
): Promise<void> {
  const aliases = profile.aliases[section];
  for (const alias of aliases) {
    const clicked = await clickLocatorCandidates(page, alias);
    if (clicked) {
      await waitForPortalIdle(page);
      return;
    }
  }

  const menuButton = page.getByRole("button", { name: /seitenmenü|profilmenü|menü/i }).first();
  if (await menuButton.isVisible().catch(() => false)) {
    await menuButton.click();
    await waitForPortalIdle(page);
    for (const alias of aliases) {
      const clicked = await clickLocatorCandidates(page, alias);
      if (clicked) {
        await waitForPortalIdle(page);
        return;
      }
    }
  }

  throw new CliError(
    `Could not find a visible portal entry for ${section}. Adjust aliases in ${storagePaths.profileFile} if needed.`,
    EXIT_CODES.PORTAL_CHANGED
  );
}

async function clickLocatorCandidates(page: import("playwright").Page, text: string): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: new RegExp(text, "i") }).first(),
    page.getByRole("link", { name: new RegExp(text, "i") }).first(),
    page.getByText(new RegExp(text, "i")).first()
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return true;
    }
  }

  return false;
}

async function clickBestEffort(page: import("playwright").Page, texts: string[]): Promise<void> {
  for (const text of texts) {
    const clicked = await clickLocatorCandidates(page, text);
    if (clicked) {
      return;
    }
  }
}
