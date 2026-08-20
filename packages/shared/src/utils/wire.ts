import type { InboundWhatsAppMessage, WhatsAppStatusUpdate } from '../types/whatsapp.js';

/**
 * Crossing the queue boundary.
 *
 * A BullMQ job payload is JSON. `JSON.stringify` turns a `Date` into a string
 * and `JSON.parse` leaves it as one, so a domain object that goes into a queue
 * does not come out the same shape it went in.
 *
 * Nothing said so. `HandleInboundJob.payload` was typed `unknown` and the
 * consumer opened it with `job.data.payload as InboundWhatsAppMessage` — an
 * assertion, which is the one construct TypeScript will not check. The declared
 * type said `timestamp: Date`; the value was a string; and the first line to
 * actually treat it as a date threw `at.getTime is not a function`, deep inside
 * the handler rather than at the seam that lied.
 *
 * That failure was invisible for as long as it was, because it only fires on
 * the path where the sender is a *known* user — an unrecognized number returns
 * before reaching it. So every test that exercised onboarding passed, and the
 * break was reserved for the one case that matters in production: an existing
 * customer sending a command.
 *
 * The fix is to stop asserting and start converting, in one place, with types
 * that describe what is actually on the wire.
 */

/**
 * What `T` looks like after a round trip through JSON.
 *
 * `Date` becomes `string`; everything else keeps its shape, recursively.
 * Declaring a job payload as `Wire<Something>` makes the compiler reject the
 * very mistake above — reading `.timestamp.getTime()` off a wire type is an
 * error, not a runtime surprise — and makes the revive call the only way in.
 *
 * Functions, `Map` and `Set` do not survive JSON at all and are not modelled:
 * nothing in a job payload has any business carrying one.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends Array<infer E>
    ? Array<Wire<E>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * A date from the wire, or `fallback` when the value is unusable.
 *
 * Unusable happens: a job enqueued by an older build, a payload hand-injected
 * for a replay, an upstream field that was absent. The alternative to a
 * fallback is throwing here, which would send the job to the dead-letter queue
 * and lose a real customer message over a timestamp — the least important field
 * in it. Falling back to "now" is off by at most the queue latency.
 */
export function reviveDate(value: unknown, fallback: Date = new Date()): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * An inbound message, as the worker should hold it.
 *
 * Only `timestamp` needs converting; the rest of the payload is strings,
 * numbers and plain objects, which JSON preserves exactly. Written as an
 * explicit spread rather than a generic deep-walk so that adding a `Date` field
 * to {@link InboundWhatsAppMessage} without handling it here is a type error
 * rather than a field that silently stays a string.
 */
export function reviveInboundMessage(payload: Wire<InboundWhatsAppMessage>): InboundWhatsAppMessage {
  return { ...payload, timestamp: reviveDate(payload.timestamp) };
}

/** The same, for a delivery status. */
export function reviveStatusUpdate(payload: Wire<WhatsAppStatusUpdate>): WhatsAppStatusUpdate {
  return { ...payload, timestamp: reviveDate(payload.timestamp) };
}
