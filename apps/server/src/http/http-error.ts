export type HttpErrorCode =
  | 'AUTH_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'VALIDATION_ERROR';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: HttpErrorCode;

  constructor(statusCode: number, code: HttpErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
