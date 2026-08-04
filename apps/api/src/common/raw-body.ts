import type { Request, Response, NextFunction, RequestHandler } from 'express';
import express from 'express';

/**
 * Raw-body capture for signature-verified webhooks.
 *
 * Every webhook signature is computed over the **exact bytes** the provider
 * sent. `JSON.parse` followed by `JSON.stringify` does not reproduce them — key
 * order, whitespace and `\uXXXX` escapes all change — so a handler that verifies
 * against a re-serialized object rejects valid requests, and one written to make
 * that "work" verifies nothing at all.
 *
 * Express's JSON parser exposes the original buffer through a `verify` hook.
 * That is the only place the untouched bytes are still available, so we stash
 * them on the request there and read them back in the controller.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** The exact bytes received, present only on webhook routes. */
    rawBody?: Buffer;
  }
}

/**
 * Routes that need raw bytes. Anything not listed gets the ordinary parser with
 * no buffer retained — holding raw bodies for every request would mean keeping a
 * second copy of every payload in memory for no reason.
 */
const RAW_BODY_ROUTES = ['/webhooks/'];

export function jsonWithRawBody(limitBytes = 1024 * 1024): RequestHandler {
  return express.json({
    limit: limitBytes,
    verify: (req: Request, _res: Response, buf: Buffer) => {
      if (RAW_BODY_ROUTES.some((prefix) => req.path.startsWith(prefix))) {
        req.rawBody = buf;
      }
    },
  });
}

/**
 * Rejects a webhook request that reached a handler without its raw body.
 *
 * This is a fail-closed guard, not a formality: if the parser is ever
 * reconfigured and stops populating `rawBody`, signature verification would
 * silently have nothing to check. Better a 400 than an unauthenticated webhook
 * being processed.
 */
export function requireRawBody(req: Request, _res: Response, next: NextFunction): void {
  if (!req.rawBody || req.rawBody.length === 0) {
    next(new Error('Raw body unavailable — webhook signature cannot be verified'));
    return;
  }
  next();
}
