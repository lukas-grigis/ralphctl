import { Result } from '@src/domain/result.ts';
import type { HttpUrl } from '@src/domain/value/http-url.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Parse an HTTP/HTTPS URL string. Accepts only `http:` and `https:` protocols (rejects `ftp:`,
 * `file:`, `data:`, etc.). Returns the trimmed input branded as {@link HttpUrl} on success.
 */
export const parseHttpUrl = (field: string, value: unknown): Result<HttpUrl, ValidationError> => {
  if (typeof value !== 'string') {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a string` }));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a non-empty string` }));
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return Result.error(new ValidationError({ field, value, message: `${field} must be a valid URL` }));
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Result.error(new ValidationError({ field, value, message: `${field} must use http or https` }));
  }
  return Result.ok(trimmed as HttpUrl);
};
