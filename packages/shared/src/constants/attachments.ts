/**
 * How much an outbound email may carry.
 *
 * Gmail and Microsoft both cap a message at 25 MB after encoding, and base64
 * inflates by roughly a third — so a 20 MB budget on the raw bytes is the
 * largest number that cannot fail at the provider. Composing right up to the
 * line and discovering it at send time would be the worst place to find out,
 * because by then the user has been told the email is going.
 *
 * One number, used by every path that adds bytes to a message: a forward
 * carrying the original's files, and files the user sends into the chat. Two
 * budgets checked separately would let a forward-with-a-photo exceed both
 * without either noticing.
 */
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * How long a file sent into the chat waits for the user to say what to do with
 * it.
 *
 * Meta keeps inbound media for 30 days, so this is not a technical ceiling —
 * it is a judgement about surprise. A photo sent on Monday silently attaching
 * itself to Friday's email is the kind of behaviour nobody would have chosen,
 * and a day is long enough for a conversation to be interrupted and resumed.
 */
export const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
