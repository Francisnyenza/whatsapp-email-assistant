/**
 * WhatsApp Business Cloud API types.
 *
 * These mirror Meta's webhook and send payloads closely enough to be useful, but
 * only the fields we actually consume — the full surface is large and mostly
 * irrelevant to us. Inbound payloads are validated at the edge with Zod before
 * anything here is trusted.
 */

export type WhatsAppMessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'button'
  | 'reaction'
  | 'order'
  | 'system'
  | 'unknown';

export interface InboundWhatsAppMessage {
  /** Meta's message id, `wamid.…`. Our de-duplication key. */
  id: string;
  /** E.164 without the leading '+', as Meta sends it. */
  from: string;
  timestamp: Date;
  type: WhatsAppMessageType;

  text?: string;

  /**
   * Set when the user used WhatsApp's native reply-to. Contains the id of the
   * message being replied to — the highest-confidence signal for resolving which
   * email a reply belongs to (ADR 0003, rank 1).
   */
  context?: { id: string; from?: string };

  /** Present for media types; bytes are fetched separately via the media API. */
  media?: {
    id: string;
    mimeType: string;
    sha256: string;
    filename?: string;
    caption?: string;
    /** Voice notes arrive as audio with `voice: true`. */
    voice?: boolean;
  };

  /** Button or list selection. `id` is a payload we minted ourselves. */
  interactive?: {
    type: 'button_reply' | 'list_reply';
    id: string;
    title: string;
  };

  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export type WhatsAppDeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppStatusUpdate {
  messageId: string;
  recipient: string;
  status: WhatsAppDeliveryStatus;
  timestamp: Date;
  error?: { code: number; title: string; details?: string };
  /** Meta's billing categorization for the conversation this message belonged to. */
  conversation?: { id: string; category?: string };
}

/* --------------------------------- outbound -------------------------------- */

export interface WhatsAppTextPayload {
  kind: 'text';
  body: string;
  previewUrl?: boolean;
}

export interface WhatsAppButton {
  /**
   * Server-minted action payload, e.g. `act:reply:<emailMessageId>`. Max 256
   * characters per Meta; we keep ours far shorter. Never contains user input.
   */
  id: string;
  /** Max 20 characters — Meta truncates silently, so we truncate deliberately. */
  title: string;
}

export interface WhatsAppButtonsPayload {
  kind: 'buttons';
  body: string;
  header?: string;
  footer?: string;
  /** Meta permits at most three. */
  buttons: WhatsAppButton[];
}

export interface WhatsAppListSection {
  title: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface WhatsAppListPayload {
  kind: 'list';
  body: string;
  header?: string;
  footer?: string;
  buttonText: string;
  sections: WhatsAppListSection[];
}

export interface WhatsAppMediaPayload {
  kind: 'media';
  mediaType: 'image' | 'document' | 'audio' | 'video';
  /** Either a previously uploaded media id or a publicly reachable link. */
  mediaId?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

/**
 * The only message kind permitted outside the 24-hour customer service window.
 * Templates must be pre-approved by Meta; see packages/whatsapp/templates.
 */
export interface WhatsAppTemplatePayload {
  kind: 'template';
  name: string;
  languageCode: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters: Array<{ type: 'text' | 'currency' | 'date_time'; text?: string }>;
  }>;
}

export type WhatsAppOutboundPayload =
  | WhatsAppTextPayload
  | WhatsAppButtonsPayload
  | WhatsAppListPayload
  | WhatsAppMediaPayload
  | WhatsAppTemplatePayload;

export interface WhatsAppSendResult {
  messageId: string;
  recipient: string;
}

/** Meta's hard limits. Exceeding one is a 400, so builders clamp to these. */
export const WHATSAPP_LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  headerText: 60,
  footerText: 60,
  buttonTitle: 20,
  buttonCount: 3,
  listRowTitle: 24,
  listRowDescription: 72,
  listRowCount: 10,
  listButtonText: 20,
  payloadId: 256,
  /** Media upload ceiling for documents; images and audio are lower. */
  documentBytes: 100 * 1024 * 1024,
  /** The customer service window, in milliseconds. */
  sessionWindowMs: 24 * 60 * 60 * 1000,
} as const;
