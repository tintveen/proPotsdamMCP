import type { DocumentItem, InboxItem, PortalSection } from "../types.js";

type ExtractedUiCandidate = {
  id: string;
  title: string;
  subtitle?: string;
  abstract?: string;
  date?: string;
  category?: string;
  unread?: boolean;
  replied?: boolean;
};

export async function extractItemsFromUi(
  page: import("playwright").Page,
  section: PortalSection
): Promise<InboxItem[] | DocumentItem[]> {
  const candidates = await page.evaluate(() => {
    const results: ExtractedUiCandidate[] = [];
    const seen = new Set<string>();

    const readNode = (node: Element | null): string | undefined => {
      const text = node?.textContent?.replace(/\s+/g, " ").trim();
      return text || undefined;
    };

    const pushCandidate = (candidate: ExtractedUiCandidate): void => {
      const key = `${candidate.id}::${candidate.title}`;
      if (!candidate.id || !candidate.title || seen.has(key)) {
        return;
      }
      seen.add(key);
      results.push(candidate);
    };

    const maybeDataObjects = (() => {
      const sapWindow = window as typeof window & {
        sap?: { ui?: { getCore?: () => { mElements?: Record<string, unknown> } } };
      };
      return Object.values(sapWindow.sap?.ui?.getCore?.().mElements ?? {});
    })();

    for (const element of maybeDataObjects) {
      const value = element as {
        getDataObject?: () => Element | null;
        getVisible?: () => boolean;
      };
      if (value.getVisible && value.getVisible() === false) {
        continue;
      }
      const dataObject = value.getDataObject?.();
      if (!dataObject) {
        continue;
      }
      const candidate = {
        id: readNode(dataObject.querySelector("id")) ?? readNode(dataObject.querySelector("title")),
        title: readNode(dataObject.querySelector("title")) ?? readNode(dataObject.querySelector("subtitle")),
        subtitle: readNode(dataObject.querySelector("subtitle")),
        abstract: readNode(dataObject.querySelector("abstract")),
        date: readNode(dataObject.querySelector("date")),
        category: readNode(dataObject.querySelector("category")),
        unread: dataObject.getAttribute("unread") === "true",
        replied: dataObject.getAttribute("replied") === "true"
      };
      if (candidate.id && candidate.title) {
        pushCandidate({
          ...candidate,
          id: candidate.id,
          title: candidate.title
        });
      }
    }

    if (results.length > 0) {
      return results;
    }

    const containers = Array.from(
      document.querySelectorAll(
        [
          ".formitem-Style1-Container",
          ".formitem-Style1VC-Container",
          ".formlist-item-style2",
          "[role='listitem']",
          "li"
        ].join(",")
      )
    );

    for (const container of containers) {
      const title =
        readNode(container.querySelector("[class*='Title']")) ??
        readNode(container.querySelector("h1, h2, h3, h4")) ??
        readNode(container);
      const date =
        readNode(container.querySelector("[class*='Date']")) ??
        container.textContent?.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/)?.[0];
      const subtitle = readNode(container.querySelector("[class*='Subtitle']"));
      const abstract = readNode(container.querySelector("[class*='Abstract']"));
      if (title) {
        pushCandidate({
          id: title,
          title,
          date,
          subtitle,
          abstract
        });
      }
    }

    return results;
  });

  if (section === "inbox") {
    return candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      subject: candidate.title,
      subtitle: candidate.subtitle,
      sender: candidate.subtitle,
      abstract: candidate.abstract,
      date: candidate.date,
      category: candidate.category,
      unread: candidate.unread ?? false,
      replied: candidate.replied,
      rawSource: "ui"
    }));
  }

  return candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    subtitle: candidate.subtitle,
    abstract: candidate.abstract,
    date: candidate.date,
    category: candidate.category,
    filename: candidate.title,
    downloadable: true,
    rawSource: "ui"
  }));
}
