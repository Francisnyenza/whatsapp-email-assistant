/**
 * Queue names and job contracts.
 *
 * One queue per pipeline stage so each scales, retries and fails independently:
 * a slow LLM provider must not stall email delivery, and a WhatsApp outage must
 * not stop us ingesting mail.
 */

export const QUEUE = {
  INGEST: 'ingest',
  AI: 'ai',
  NOTIFY: 'notify',
  SEND: 'send',
  SYNC: 'sync',
  AUTOMATION: 'automation',
  COMMANDS: 'commands',
  MEDIA: 'media',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const JOB = {
  // ingest
  PROCESS_CHANGE: 'ingest.processChange',
  FETCH_MESSAGE: 'ingest.fetchMessage',
  STORE_ATTACHMENT: 'ingest.storeAttachment',

  // ai
  ANALYZE_EMAIL: 'ai.analyzeEmail',
  EMBED_EMAIL: 'ai.embedEmail',
  DRAFT_REPLY: 'ai.draftReply',
  TRANSCRIBE_AUDIO: 'ai.transcribeAudio',
  SYNTHESIZE_SPEECH: 'ai.synthesizeSpeech',
  OCR_DOCUMENT: 'ai.ocrDocument',

  // notify
  NOTIFY_EMAIL: 'notify.email',
  SEND_DIGEST: 'notify.digest',
  RETRY_DELIVERY: 'notify.retryDelivery',

  // send
  SEND_EMAIL: 'send.email',

  // sync
  SWEEP_WATCHES: 'sync.sweepWatches',
  RENEW_WATCH: 'sync.renewWatch',
  RECONCILE_ACCOUNT: 'sync.reconcileAccount',
  REFRESH_TOKEN: 'sync.refreshToken',
  PURGE_EXPIRED: 'sync.purgeExpired',

  // automation
  EVALUATE_RULES: 'automation.evaluateRules',
  CHECK_REMINDERS: 'automation.checkReminders',

  // commands
  HANDLE_INBOUND: 'commands.handleInbound',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Per-queue defaults. `attempts` counts the first try, so 5 means one attempt
 * plus four retries. Backoff is exponential from `delay`.
 */
export interface QueueDefaults {
  concurrency: number;
  attempts: number;
  backoffMs: number;
  /** Jobs are removed after success to keep Redis bounded; failures are kept. */
  removeOnCompleteCount: number;
  removeOnFailCount: number;
}

export const QUEUE_DEFAULTS: Record<QueueName, QueueDefaults> = {
  [QUEUE.INGEST]: {
    concurrency: 50,
    attempts: 5,
    backoffMs: 2_000,
    removeOnCompleteCount: 1_000,
    removeOnFailCount: 10_000,
  },
  [QUEUE.AI]: {
    concurrency: 25,
    attempts: 3,
    backoffMs: 5_000,
    removeOnCompleteCount: 1_000,
    removeOnFailCount: 10_000,
  },
  [QUEUE.NOTIFY]: {
    concurrency: 50,
    attempts: 5,
    backoffMs: 3_000,
    removeOnCompleteCount: 1_000,
    removeOnFailCount: 10_000,
  },
  [QUEUE.SEND]: {
    // Deliberately modest: a duplicate or mis-threaded send is visible to the
    // recipient, so throughput matters less than ordering and care.
    concurrency: 20,
    attempts: 3,
    backoffMs: 5_000,
    removeOnCompleteCount: 5_000,
    removeOnFailCount: 20_000,
  },
  [QUEUE.SYNC]: {
    concurrency: 10,
    attempts: 3,
    backoffMs: 10_000,
    removeOnCompleteCount: 500,
    removeOnFailCount: 5_000,
  },
  [QUEUE.AUTOMATION]: {
    concurrency: 10,
    attempts: 3,
    backoffMs: 5_000,
    removeOnCompleteCount: 500,
    removeOnFailCount: 5_000,
  },
  [QUEUE.COMMANDS]: {
    concurrency: 40,
    attempts: 3,
    backoffMs: 2_000,
    removeOnCompleteCount: 1_000,
    removeOnFailCount: 10_000,
  },
  [QUEUE.MEDIA]: {
    concurrency: 20,
    attempts: 4,
    backoffMs: 3_000,
    removeOnCompleteCount: 500,
    removeOnFailCount: 5_000,
  },
};

/* -------------------------------- job payloads ------------------------------ */

export interface ProcessChangeJob {
  accountId: string;
  userId: string;
  /** Gmail historyId, Graph resource id, or IMAP UID — interpreted by the adapter. */
  cursor: string;
  /** Present when the provider named the changed message directly. */
  providerMessageId?: string;
}

export interface AnalyzeEmailJob {
  emailMessageId: string;
  userId: string;
}

export interface NotifyEmailJob {
  emailMessageId: string;
  userId: string;
  /** Skips rule evaluation; used when re-sending a notification on request. */
  force?: boolean;
}

export interface SendEmailJob {
  userId: string;
  accountId: string;
  /** The draft row holding the composed message. */
  draftId: string;
  idempotencyKey: string;
}

/**
 * The scheduled sweep. Carries no payload of its own — everything it needs is
 * in the database — but the shape is declared so the processor's job type is
 * honest about what arrives.
 */
export interface SweepWatchesJob {
  /** Overrides the default horizon; used by operators to force an early sweep. */
  horizonHours?: number;
}

export interface RenewWatchJob {
  userId: string;
  accountId: string;
  /**
   * The expiry that made this account due, carried only so the job id can be
   * derived from it — two sweeps that see the same lapsing watch produce the
   * same id and therefore one renewal.
   */
  dueAt: string | null;
}

export interface HandleInboundJob {
  /** Meta's `wamid.…`, also used as the BullMQ job id for de-duplication. */
  whatsappMessageId: string;
  phoneNumber: string;
  /** Full validated inbound payload, serialized. */
  payload: unknown;
}
