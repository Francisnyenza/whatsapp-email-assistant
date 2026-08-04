import { AppError } from '../errors/app-error.js';

/**
 * Action payloads carried on WhatsApp interactive buttons and list rows.
 *
 * When a user taps "Reply", WhatsApp echoes back the `id` we set on that button.
 * That id is how we know, with certainty, which email the tap refers to — rank 2
 * on the thread-resolution ladder (ADR 0003).
 *
 * Two properties matter:
 *
 *  1. **Server-minted.** The id is built from our own database ids, never from
 *     user or email content. A tap therefore authorizes exactly one action on one
 *     record, which is what makes confirmation taps a real authorization step
 *     rather than a UI gesture (ADR 0004).
 *  2. **Short.** Meta caps ids at 256 characters, so the encoding is terse.
 *
 * Format: `act:<action>:<targetId>[:<arg>]`
 */

export const ACTION_PAYLOAD_PREFIX = 'act';
export const MAX_PAYLOAD_LENGTH = 256;

export type PayloadAction =
  | 'reply'
  | 'reply_yes'
  | 'reply_no'
  | 'archive'
  | 'delete'
  | 'confirm_delete'
  | 'confirm_send'
  | 'forward'
  | 'summarize'
  | 'translate'
  | 'read_aloud'
  | 'mark_read'
  | 'mark_important'
  | 'open_thread'
  | 'cancel'
  | 'undo'
  | 'more';

const VALID_ACTIONS: ReadonlySet<string> = new Set<PayloadAction>([
  'reply',
  'reply_yes',
  'reply_no',
  'archive',
  'delete',
  'confirm_delete',
  'confirm_send',
  'forward',
  'summarize',
  'translate',
  'read_aloud',
  'mark_read',
  'mark_important',
  'open_thread',
  'cancel',
  'undo',
  'more',
]);

export interface ActionPayload {
  action: PayloadAction;
  /** Our own record id — an email message, thread or draft. */
  targetId: string;
  /** Optional action argument, e.g. a language code for `translate`. */
  arg?: string;
}

/** Ids we mint are UUIDs or short opaque tokens; anything else is a red flag. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ARG = /^[A-Za-z0-9_.-]{1,32}$/;

export function encodeActionPayload(payload: ActionPayload): string {
  if (!VALID_ACTIONS.has(payload.action)) {
    throw new AppError('BAD_REQUEST', `Unknown action payload verb: ${payload.action}`);
  }
  if (!SAFE_ID.test(payload.targetId)) {
    throw new AppError('BAD_REQUEST', 'Action payload target id has an unexpected shape');
  }
  if (payload.arg !== undefined && !SAFE_ARG.test(payload.arg)) {
    throw new AppError('BAD_REQUEST', 'Action payload argument has an unexpected shape');
  }

  const parts = [ACTION_PAYLOAD_PREFIX, payload.action, payload.targetId];
  if (payload.arg) parts.push(payload.arg);
  const encoded = parts.join(':');

  if (encoded.length > MAX_PAYLOAD_LENGTH) {
    throw new AppError('BAD_REQUEST', `Action payload exceeds ${MAX_PAYLOAD_LENGTH} characters`);
  }
  return encoded;
}

/**
 * Parses an id echoed back by WhatsApp.
 *
 * Returns `null` rather than throwing for anything unrecognized: the value came
 * over the wire, and a malformed one means "this is not one of our buttons", not
 * "crash the worker".
 */
export function decodeActionPayload(raw: string): ActionPayload | null {
  if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD_LENGTH) return null;

  const parts = raw.split(':');
  if (parts.length < 3 || parts.length > 4) return null;

  const [prefix, action, targetId, arg] = parts;
  if (prefix !== ACTION_PAYLOAD_PREFIX) return null;
  if (!action || !VALID_ACTIONS.has(action)) return null;
  if (!targetId || !SAFE_ID.test(targetId)) return null;
  if (arg !== undefined && !SAFE_ARG.test(arg)) return null;

  return { action: action as PayloadAction, targetId, ...(arg ? { arg } : {}) };
}

/**
 * Actions that must not execute on the tap alone — the handler turns these into
 * a confirmation prompt whose button carries the matching `confirm_*` action.
 */
export function requiresConfirmation(action: PayloadAction): boolean {
  return action === 'delete' || action === 'forward';
}
