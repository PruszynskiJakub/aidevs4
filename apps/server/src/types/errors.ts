export type DomainErrorType =
  | "validation"
  | "auth"
  | "permission"
  | "not_found"
  | "conflict"
  | "capacity"
  | "provider"
  | "timeout";

export interface DomainErrorData {
  type: DomainErrorType;
  message: string;
  internalMessage?: string;
  cause?: unknown;
  provider?: string;
}

export class DomainError extends Error {
  readonly type: DomainErrorType;
  readonly internalMessage?: string;
  readonly provider?: string;

  constructor(data: DomainErrorData) {
    super(data.message, data.cause !== undefined ? { cause: data.cause } : undefined);
    this.name = "DomainError";
    this.type = data.type;
    this.internalMessage = data.internalMessage;
    this.provider = data.provider;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export function toHttpStatus(type: DomainErrorType): number {
  switch (type) {
    case "validation":  return 400;
    case "auth":        return 401;
    case "permission":  return 403;
    case "not_found":   return 404;
    case "conflict":    return 409;
    case "capacity":    return 429;
    case "provider":    return 502;
    case "timeout":     return 504;
  }
}
