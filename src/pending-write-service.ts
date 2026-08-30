import { PortalError } from "./errors.js";
import type { PortalClient } from "./portal/portal-client.js";
import {
  deletePendingWrite,
  listPendingWrites as listStoredPendingWrites,
  loadPendingWrite
} from "./storage.js";
import type {
  CancelPendingWritesResult,
  PendingPortalWrite,
  PendingWrite,
  PendingWriteCommitBatchResult,
  PendingWriteCommitResult,
  PendingWriteList,
  PendingWriteSummary,
  PortalAttachmentReview,
  PortalCommitResult,
  StagedPortalAttachment,
  WriteOutcome
} from "./types.js";
import type { WasteServiceLike } from "./waste/types.js";

export interface PendingWriteServiceLike {
  listPendingWrites(): Promise<PendingWriteList>;
  cancelPendingWrites(pendingWriteHandles: string[]): Promise<CancelPendingWritesResult>;
  commitPendingWrites(pendingWriteHandles: string[]): Promise<PendingWriteCommitBatchResult>;
}

type PortalPendingWriteExecutor = Pick<PortalClient, "commitPendingWrites">;

export class PendingWriteService implements PendingWriteServiceLike {
  constructor(
    private readonly portalExecutor: PortalPendingWriteExecutor,
    private readonly wasteExecutor: WasteServiceLike
  ) {}

  async listPendingWrites(): Promise<PendingWriteList> {
    const pendingWrites = await listStoredPendingWrites();
    return { items: pendingWrites.map(pendingWriteSummary) };
  }

  async cancelPendingWrites(pendingWriteHandles: string[]): Promise<CancelPendingWritesResult> {
    const cancelledHandles: string[] = [];
    const missingHandles: string[] = [];
    for (const pendingWriteHandle of [...new Set(pendingWriteHandles)]) {
      if (await deletePendingWrite(pendingWriteHandle).catch(() => false)) {
        cancelledHandles.push(pendingWriteHandle);
      } else {
        missingHandles.push(pendingWriteHandle);
      }
    }
    return {
      ok: missingHandles.length === 0,
      cancelledHandles,
      missingHandles
    };
  }

  async commitPendingWrites(pendingWriteHandles: string[]): Promise<PendingWriteCommitBatchResult> {
    if (new Set(pendingWriteHandles).size !== pendingWriteHandles.length) {
      throw new PortalError(
        "Duplicate pending-action handles are not allowed. No action was dispatched.",
        "DUPLICATE_PENDING_WRITE_HANDLE",
        400
      );
    }

    const results: PendingWriteCommitResult[] = [];
    for (const pendingWriteHandle of pendingWriteHandles) {
      const pendingWrite = await loadPendingWrite(pendingWriteHandle).catch(() => null);
      if (!pendingWrite) {
        await deletePendingWrite(pendingWriteHandle).catch(() => false);
        results.push(unknownNotSentResult(pendingWriteHandle));
        continue;
      }
      try {
        if (pendingWrite.kind === "portal_action") {
          const portalBatch = await this.portalExecutor.commitPendingWrites([pendingWriteHandle]);
          const portalResult = portalBatch.results[0];
          results.push(portalResult
            ? fromPortalResult(pendingWrite, portalResult)
            : knownFailureResult(
                pendingWrite,
                "outcomeUncertain",
                "Portal executor returned no result after execution began. Do not retry automatically."
              ));
        } else {
          results.push(await this.wasteExecutor.commitPendingWrite(pendingWriteHandle, pendingWrite.kind));
        }
      } catch (error) {
        results.push(knownFailureResult(
          pendingWrite,
          "outcomeUncertain",
          `Pending-action execution failed with an unknown final state. Do not retry automatically. ${error instanceof Error ? error.message : String(error)}`
        ));
      }
    }

    const counts = countOutcomes(results);
    return {
      ok: results.length > 0 && counts.succeeded === results.length,
      partial: counts.succeeded > 0 && counts.succeeded < results.length,
      attemptedCount: results.length,
      counts,
      results
    };
  }
}

function pendingWriteSummary(pendingWrite: PendingWrite): PendingWriteSummary {
  const common = {
    pendingWriteHandle: pendingWrite.pendingWriteHandle,
    kind: pendingWrite.kind,
    workflow: pendingWrite.workflow,
    destination: pendingWrite.destination,
    review: pendingWrite.review,
    warnings: pendingWrite.warnings,
    privacyUrls: pendingWrite.privacyUrls,
    createdAt: pendingWrite.createdAt,
    expiresAt: pendingWrite.expiresAt,
    requiresExplicitApproval: true as const
  };
  if (pendingWrite.kind !== "portal_action") {
    return common;
  }
  return {
    ...common,
    target: {
      accountId: pendingWrite.accountId,
      domain: pendingWrite.domain,
      serviceId: pendingWrite.serviceId,
      serviceTitle: pendingWrite.serviceTitle,
      recordId: pendingWrite.recordId,
      recordTitle: pendingWrite.recordTitle
    },
    diff: pendingWrite.diff,
    ...(pendingWrite.attachments?.length
      ? { attachments: pendingWrite.attachments.map(attachmentReview) }
      : {})
  };
}

function attachmentReview(attachment: StagedPortalAttachment): PortalAttachmentReview {
  return {
    fieldName: attachment.fieldName,
    fieldLabel: attachment.fieldLabel,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    sha256: attachment.sha256,
    uploadSupported: attachment.uploadSupported
  };
}

function fromPortalResult(
  pendingWrite: PendingPortalWrite,
  portalResult: PortalCommitResult
): PendingWriteCommitResult {
  return {
    ok: portalResult.ok,
    outcome: portalResult.outcome,
    pendingWriteHandle: portalResult.pendingWriteHandle,
    kind: pendingWrite.kind,
    workflow: pendingWrite.workflow,
    completedAt: portalResult.completedAt,
    summary: portalResult.summary,
    ...(portalResult.status === undefined ? {} : { status: portalResult.status }),
    portal: portalResult
  };
}

function knownFailureResult(
  pendingWrite: PendingWrite,
  outcome: Exclude<WriteOutcome, "succeeded">,
  summary: string
): PendingWriteCommitResult {
  return {
    ok: false,
    outcome,
    pendingWriteHandle: pendingWrite.pendingWriteHandle,
    kind: pendingWrite.kind,
    workflow: pendingWrite.workflow,
    completedAt: new Date().toISOString(),
    summary
  };
}

function unknownNotSentResult(pendingWriteHandle: string): PendingWriteCommitResult {
  return {
    ok: false,
    outcome: "notSent",
    pendingWriteHandle,
    kind: "unknown",
    workflow: "unknown",
    completedAt: new Date().toISOString(),
    summary: "Pending action was not found, expired, cancelled, or already used."
  };
}

function countOutcomes(results: PendingWriteCommitResult[]): Record<WriteOutcome, number> {
  return {
    succeeded: results.filter((result) => result.outcome === "succeeded").length,
    notSent: results.filter((result) => result.outcome === "notSent").length,
    rejected: results.filter((result) => result.outcome === "rejected").length,
    outcomeUncertain: results.filter((result) => result.outcome === "outcomeUncertain").length
  };
}
