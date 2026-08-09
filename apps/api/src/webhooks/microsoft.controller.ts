import { Controller, Post, Req, Res, Query, HttpStatus, Inject } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { QUEUE, JOB } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { PrismaService } from '../common/prisma.service.js';

/**
 * The Microsoft Graph notification endpoint.
 *
 * Same three properties as the Gmail and WhatsApp webhooks — verify before
 * parsing, acknowledge fast, always 2xx once authentic — plus one thing neither
 * of those has:
 *
 * **A validation handshake.** When a subscription is created, Graph immediately
 * POSTs here with `?validationToken=...` and expects that exact token echoed
 * back as `text/plain`, with a 200, within ten seconds. Get it wrong and the
 * subscription is simply not created — `POST /subscriptions` fails, and the
 * error names the notification URL rather than the handshake, which is a
 * confusing hour for whoever hits it first.
 *
 * Authentication is `clientState`: an opaque secret we set at subscription time
 * and Graph echoes on every notification. Graph does not sign its notifications,
 * so this shared secret is the whole of it — which is why it is compared in
 * constant time and why a missing configured value refuses everything rather
 * than accepting anything.
 */
@Controller('webhooks/microsoft')
export class MicrosoftWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueProducer,
    private readonly prisma: PrismaService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  @Post()
  async receive(
    @Req() req: Request,
    @Res() res: Response,
    @Query('validationToken') validationToken?: string,
  ): Promise<void> {
    // The handshake. Deliberately first and deliberately unauthenticated: it
    // arrives before any subscription exists, so there is no clientState to
    // compare against yet. Echoing a token back proves only that we control this
    // URL, which is exactly what Graph is asking.
    if (validationToken) {
      res.status(HttpStatus.OK).type('text/plain').send(validationToken);
      return;
    }

    const notifications = parseNotifications(req.body);

    // Graph batches, and a batch can legitimately span mailboxes. Every entry is
    // checked rather than the first, because a batch with one valid entry must
    // not authenticate the rest.
    const authentic = notifications.filter((n) => this.isAuthentic(n.clientState));

    if (notifications.length === 0 || authentic.length === 0) {
      this.logger.warn(
        { event: 'graph.webhook.unverified', received: notifications.length },
        'Rejected Graph notification with an invalid client state',
      );
      res.status(HttpStatus.UNAUTHORIZED).send();
      return;
    }

    // Authentic. Everything below returns 202 regardless of outcome — a failure
    // on our side must not make Graph redeliver forever, and Graph drops a
    // subscription whose endpoint keeps failing.
    res.status(HttpStatus.ACCEPTED).send();

    for (const notification of authentic) {
      try {
        await this.enqueue(notification);
      } catch (err) {
        this.logger.error(
          { event: 'graph.webhook.enqueue_failed', err },
          'Failed to enqueue Graph notification after acknowledging',
        );
      }
    }
  }

  /**
   * Routes one notification to the mailbox it concerns.
   *
   * A notification names a subscription, never a user — so the account is found
   * by subscription id. That is a different lookup from Gmail's, which routes by
   * address, and it is the reason `watch_subscription_id` is stored at all.
   */
  private async enqueue(notification: GraphNotification): Promise<void> {
    if (!notification.subscriptionId) return;

    const account = await this.prisma.emailAccount.findFirst({
      where: { watchSubscriptionId: notification.subscriptionId },
      select: { id: true, userId: true },
    });

    if (!account) {
      // A subscription we no longer hold — usually a disconnected account whose
      // subscription has not lapsed yet. Not an error.
      this.logger.info(
        { event: 'graph.webhook.no_route' },
        'Notification for a subscription with no connected account',
      );
      return;
    }

    await this.queue.enqueue(
      QUEUE.INGEST,
      JOB.PROCESS_CHANGE,
      {
        userId: account.userId,
        accountId: account.id,
        // Graph's notification carries no sync position at all — only that
        // *something* changed. Ingest resumes from the delta link we stored,
        // which is the only correct place, and this field exists on the job for
        // Gmail's benefit.
        cursor: '',
        ...(notification.resourceId ? { providerMessageId: notification.resourceId } : {}),
      },
      // Collapsed per account per minute. Graph sends one notification per
      // message, so a burst of twenty arriving mail produces twenty
      // notifications — and one delta walk catches all of them.
      { jobId: `ingest:${account.id}:${Math.floor(Date.now() / 60_000)}` },
    );

    this.logger.info(
      { event: 'graph.webhook.accepted', accountId: account.id },
      'Mailbox change enqueued',
    );
  }

  /**
   * Constant-time comparison against the configured secret.
   *
   * Graph does not sign notifications, so this shared secret is the whole of the
   * authentication — and a `===` on a secret is a timing oracle for it. A
   * missing configured value refuses everything, which is the correct failure
   * mode: accepting unverified notifications would be worse than delivering
   * none.
   */
  private isAuthentic(clientState: string | undefined): boolean {
    const expected = this.config.env.MICROSOFT_WEBHOOK_CLIENT_STATE;
    if (!expected || !clientState) return false;

    const a = Buffer.from(expected);
    const b = Buffer.from(clientState);

    // `timingSafeEqual` throws on a length mismatch, which would itself leak the
    // length — so the lengths are compared first and the result folded in.
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resourceId?: string;
  changeType?: string;
}

/**
 * Reads the notification batch.
 *
 * Deliberately tolerant of shape and intolerant of content: anything that is
 * not an object with a `value` array produces an empty list, which the caller
 * treats as unauthenticated. Nothing here dereferences a field without checking
 * it, because every byte arrived from the internet.
 */
function parseNotifications(body: unknown): GraphNotification[] {
  if (!body || typeof body !== 'object') return [];

  const value = (body as { value?: unknown }).value;
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
    )
    .map((entry) => ({
      ...(typeof entry['subscriptionId'] === 'string'
        ? { subscriptionId: entry['subscriptionId'] }
        : {}),
      ...(typeof entry['clientState'] === 'string' ? { clientState: entry['clientState'] } : {}),
      ...(typeof entry['resourceData'] === 'object' &&
      entry['resourceData'] !== null &&
      typeof (entry['resourceData'] as { id?: unknown }).id === 'string'
        ? { resourceId: (entry['resourceData'] as { id: string }).id }
        : {}),
      ...(typeof entry['changeType'] === 'string' ? { changeType: entry['changeType'] } : {}),
    }));
}
