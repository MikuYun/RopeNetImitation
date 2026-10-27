export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
