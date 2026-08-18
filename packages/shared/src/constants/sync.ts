/**
 * How often mailboxes with no push subscription are polled.
 *
 * The gap between the product's promise and its fallback. Push delivers in
 * seconds; two minutes is the most a user should wait for mail on an account
 * whose watch could not be established, and it is still cheap — `history.list`
 * from a stored cursor is two quota units and usually returns nothing.
 *
 * It lives in `shared` rather than beside the sweep that uses it because the
 * preflight check quotes it: an operator running without a Pub/Sub topic is
 * told how long mail will take, and a second copy of the number would
 * eventually tell them the wrong thing.
 */
export const POLL_INTERVAL_MS = 2 * 60_000;
