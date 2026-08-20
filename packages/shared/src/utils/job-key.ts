/**
 * Building a BullMQ custom job id.
 *
 * Every custom id in this codebase was written as `` `send:${draftId}` `` — the
 * obvious shape, and the one BullMQ rejects: **a custom id cannot contain a
 * colon**, because the colon is how BullMQ namespaces its own Redis keys. The
 * `add` call throws `Custom Id cannot contain :`.
 *
 * The consequence was not a loud failure. Sixteen call sites built ids this way,
 * covering every path the product has: an inbound WhatsApp message, a Gmail or
 * Graph push, an outbound send, analysis, embedding, notification, digests,
 * reminders, media and polling. Each one threw at enqueue, each caller logged
 * and carried on, and the webhook controllers answered Meta and Google with the
 * 200 that stops them redelivering. So the whole system accepted work, reported
 * success, and did nothing with any of it.
 *
 * Nothing caught it because every test stubs the queue producer: asserting
 * "enqueue was called with these arguments" is a different question from
 * "BullMQ accepted them", and only the second one was ever wrong.
 *
 * So ids are built here, in one place, and a real-Redis test in
 * `apps/worker/test/job-key.integration.spec.ts` proves the result is
 * acceptable to BullMQ rather than merely well-formed.
 */

/**
 * Characters a job id may contain.
 *
 * Deliberately narrower than what BullMQ forbids. Only the colon is actually
 * rejected, but ids end up in Redis keys, log lines and dashboards, and the
 * inputs here include provider-supplied strings — a Gmail history id, a WhatsApp
 * `wamid`. Restricting to an unambiguous set means an id is always safe to paste
 * somewhere, and it costs nothing.
 */
const UNSAFE = /[^A-Za-z0-9._-]/g;

/** Joins segments. Not a character any sanitised segment can contain. */
const SEPARATOR = '~';

/**
 * Builds a job id from its parts.
 *
 * `jobKey('send', draftId)` → `send~7b3f…`. The parts keep their own meaning:
 * the first is conventionally the kind of work, and what follows identifies the
 * thing it is being done to, which is what makes the id a deduplication key
 * rather than a name.
 *
 * @throws when handed no parts, or parts that sanitise away to nothing — an
 *   empty id is not a deduplication key, it is a collision between every job of
 *   that kind.
 */
export function jobKey(...parts: Array<string | number>): string {
  if (parts.length === 0) {
    throw new Error('jobKey needs at least one part');
  }

  const cleaned = parts.map((part) => String(part).replace(UNSAFE, '_'));

  if (cleaned.some((part) => part.length === 0)) {
    throw new Error(`jobKey received an empty part: ${JSON.stringify(parts)}`);
  }

  return cleaned.join(SEPARATOR);
}
