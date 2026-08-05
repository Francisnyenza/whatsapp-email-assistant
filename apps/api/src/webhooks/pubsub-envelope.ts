import { z } from 'zod';

/**
 * Gmail's Pub/Sub push envelope.
 *
 * Google wraps the actual notification twice: a Pub/Sub message envelope, whose
 * `data` field is base64 holding the Gmail payload. Both layers arrive from a
 * third party, so neither is trusted until parsed — and parsing returns null
 * rather than throwing, because a push we cannot understand must be
 * acknowledged and dropped. Returning a non-2xx would have Google redeliver
 * something we can never parse, forever.
 */

const envelopeSchema = z.object({
  message: z.object({
    data: z.string().optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

const notificationSchema = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]),
});

export interface GmailPushNotification {
  /** Lower-cased, so it matches how routes are stored. */
  emailAddress: string;
  /** Always a string — Gmail sends it as a number, the API wants a string. */
  historyId: string;
  /** Pub/Sub's own id, used to de-duplicate redelivery. */
  messageId: string;
}

export function parseGmailPush(body: unknown): GmailPushNotification | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success || !envelope.data.message.data) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  const notification = notificationSchema.safeParse(decoded);
  if (!notification.success) return null;

  const emailAddress = notification.data.emailAddress.trim().toLowerCase();
  if (!emailAddress.includes('@')) return null;

  // historyId arrives as a number in JSON but exceeds nothing dangerous; it is
  // carried as a string because that is what the Gmail API expects back.
  const historyId = String(notification.data.historyId);
  if (!/^\d+$/.test(historyId)) return null;

  return {
    emailAddress,
    historyId,
    messageId:
      envelope.data.message.messageId ??
      envelope.data.message.message_id ??
      // Some emulators omit it; the envelope hash is a usable fallback for
      // de-duplication.
      envelope.data.message.data.slice(0, 64),
  };
}
