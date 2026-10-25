/**
 * Errors the operator can understand. `code` is a translation key the web app
 * renders in the user's language; `params` fill placeholders.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export const notFound = (what: string) => new AppError('error.not_found', 404, { what });
export const forbidden = () => new AppError('error.forbidden', 403);
export const unauthorized = () => new AppError('error.unauthorized', 401);
