import { writeFile } from "node:fs/promises";
import { STATIC_FILE_PATTERN } from "../constants.js";
import type { TraceMode, TraceRecord } from "../types.js";
import type { BrowserContext, Response } from "playwright";

export class TraceRecorder {
  private readonly records: TraceRecord[] = [];
  private readonly origin: string;
  private readonly mode: TraceMode;
  private readonly bodyLimit: number;
  private readonly responseHandler: (response: Response) => Promise<void>;

  constructor(origin: string, mode: TraceMode, bodyLimit = 250_000) {
    this.origin = origin;
    this.mode = mode;
    this.bodyLimit = bodyLimit;
    this.responseHandler = async (response: Response) => {
      await this.captureResponse(response);
    };
  }

  attach(context: BrowserContext): void {
    context.on("response", this.responseHandler);
  }

  detach(context: BrowserContext): void {
    context.off("response", this.responseHandler);
  }

  getRecords(): TraceRecord[] {
    return [...this.records];
  }

  async save(filePath: string): Promise<void> {
    await writeFile(filePath, `${JSON.stringify(this.records, null, 2)}\n`);
  }

  private async captureResponse(response: Response): Promise<void> {
    const request = response.request();
    const url = response.url();
    if (!url.startsWith(this.origin) || STATIC_FILE_PATTERN.test(url)) {
      return;
    }

    const method = request.method();
    const resourceType = request.resourceType();
    const contentType = response.headers()["content-type"];
    if (!contentType && resourceType === "image") {
      return;
    }

    const record: TraceRecord = {
      timestamp: new Date().toISOString(),
      url,
      method,
      status: response.status(),
      resourceType,
      contentType
    };

    if (shouldCaptureBody(this.mode, contentType, resourceType)) {
      try {
        const bodyText = await response.text();
        record.bodyText = bodyText.slice(0, this.bodyLimit);
      } catch {
        // Best effort only.
      }
    }

    this.records.push(record);
  }
}

function shouldCaptureBody(mode: TraceMode, contentType: string | undefined, resourceType: string): boolean {
  if (resourceType === "fetch" || resourceType === "xhr") {
    return true;
  }
  if (mode === "debug" && contentType?.includes("text/html")) {
    return true;
  }
  return Boolean(
    contentType &&
      (contentType.includes("xml") ||
        contentType.includes("json") ||
        contentType.includes("text/plain") ||
        contentType.includes("text/html"))
  );
}
