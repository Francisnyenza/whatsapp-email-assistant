/**
 * How long a queued email waits before the send worker may claim it.
 *
 * The whole of "undo send". Nothing else makes it possible: once a message has
 * left for the provider it is with the recipient, and no API takes it back. So
 * the only honest way to offer an undo is to not have sent it yet — which is
 * what every mail client that offers one does, and why they all ask you to pick
 * a number of seconds in settings.
 *
 * Fifteen seconds is the middle of what those clients offer (Gmail: 5, 10, 20,
 * 30). Long enough to notice the mistake you make as you press send, short
 * enough that "sending…" does not start to look like a failure.
 *
 * The delay costs nothing when unused: the job simply sits in Redis, and the
 * draft's status guard is what actually decides whether it goes.
 */
export const SEND_DELAY_MS = 15_000;
