export interface PortalErrorDetails {
  outcomeUncertain?: boolean;
  warnings?: string[];
}

export class PortalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: PortalErrorDetails
  ) {
    super(message);
    this.name = "PortalError";
  }
}
