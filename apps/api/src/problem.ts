/**
 * Error responses.
 *
 * A malformed body is a 400 with the field that was wrong, never a 500 (G2). A 500 tells a
 * caller "we broke"; a 400 tells them "you did, here". Getting that backwards is how an
 * agent retries a request that will never succeed.
 */

import type { ZodError } from "zod";

export interface Problem {
  readonly error: string;
  readonly detail: string;
  readonly fields?: Record<string, string>;
}

export const badRequest = (detail: string, fields?: Record<string, string>): Problem => ({
  error: "bad_request",
  detail,
  ...(fields ? { fields } : {}),
});

export const unauthorized = (detail: string): Problem => ({ error: "unauthorized", detail });
export const forbidden = (detail: string): Problem => ({ error: "forbidden", detail });
export const notFound = (detail: string): Problem => ({ error: "not_found", detail });
export const conflict = (detail: string): Problem => ({ error: "conflict", detail });
export const upstream = (detail: string): Problem => ({ error: "upstream_failed", detail });

/** Turns a Zod failure into field-addressed detail, so a caller can fix the right thing. */
export function fromZod(error: ZodError): Problem {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    fields[issue.path.map(String).join(".") || "(root)"] = issue.message;
  }
  return badRequest("the request body does not match the schema", fields);
}
