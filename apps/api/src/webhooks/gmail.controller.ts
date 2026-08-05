import {
  Controller,
  Post,
  Req,
  Res,
  Headers,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Logger } from 'pino';
import { QUEUE, JOB } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { PrismaService } from '../common/prisma.service.js';
import { parseGmailPush } from './pubsub-envelope.js';

/**
 * Verifies the OIDC token Pub/Sub attaches to a push.
 *
 * Google signs every push with a service-account token whose audience is the
 * endpoint URL we registered. Without checking it, this endpoint is an
 * unauthenticated way for anyone to make us hammer the Gmail API on behalf of
 * arbitrary mailboxes.
 *
 * Separated from the controller so the controller's behaviour can be tested
 * without reaching for Google's key set.
 */
@Injectable()
export class PubSubTokenVerifier {
  private readonly jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  constructor(private readonly config: ConfigService) {}

  async verify(authorization: string | undefined): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;

    const audience = this.config.env.GOOGLE_PUBSUB_VERIFICATION_AUDIENCE;
    if (!audience) {
      // Refusing every push is the correct failure mode for a missing audience:
      // accepting unverified ones would be worse than delivering nothing.
      return false;
    }

    try {
      await jwtVerify(authorization.slice(7).trim(), this.jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The Gmail push endpoint.
 *
 * Same three properties as the WhatsApp webhook, for the same reasons: verify
 * before parsing, acknowledge fast, and always 2xx once authentic so a bug on
 * our side cannot make Google redeliver forever.
 *
 * The one addition is routing. A push names a mailbox, never a user, so the
 * address is resolved through `provider_account_routes` — a table deliberately
 * outside tenant isolation because it is consulted to *determine* the tenant.
 */
@Controller('webhooks/gmail')
export class GmailWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly verifier: PubSubTokenVerifier,
    private readonly queue: QueueProducer,
    private readonly prisma: PrismaService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  @Post()
  async receive(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    if (!(await this.verifier.verify(authorization))) {
      this.logger.warn(
        { event: 'gmail.webhook.unverified', hasToken: Boolean(authorization) },
        'Rejected Gmail push with an invalid token',
      );
      res.status(HttpStatus.UNAUTHORIZED).send();
      return;
    }

    // Authentic. Everything below returns 204 regardless of outcome.
    res.status(HttpStatus.NO_CONTENT).send();

    try {
      const push = parseGmailPush(req.body);

      if (!push) {
        this.logger.warn({ event: 'gmail.webhook.unparseable' }, 'Dropped unparseable Gmail push');
        return;
      }

      const route = await this.prisma.providerAccountRoute.findUnique({
        where: {
          provider_providerAddress: { provider: 'gmail', providerAddress: push.emailAddress },
        },
        select: { userId: true, accountId: true },
      });

      if (!route) {
        // A mailbox we no longer watch — usually a disconnected account whose
        // Gmail watch has not lapsed yet. Not an error.
        this.logger.info(
          { event: 'gmail.webhook.no_route' },
          'Push for a mailbox with no connected account',
        );
        return;
      }

      await this.queue.enqueue(
        QUEUE.INGEST,
        JOB.PROCESS_CHANGE,
        {
          userId: route.userId,
          accountId: route.accountId,
          // Gmail's historyId in the push is where the mailbox is *now*. The
          // job syncs from the cursor we stored, so this is carried only for
          // logging and ordering.
          cursor: push.historyId,
        },
        // Keyed per account rather than per push: several notifications for one
        // mailbox in quick succession collapse into a single sync, which is
        // exactly right — history.list catches everything since the cursor
        // regardless of how many pushes triggered it.
        { jobId: `ingest:${route.accountId}:${push.historyId}` },
      );

      this.logger.info(
        { event: 'gmail.webhook.accepted', accountId: route.accountId },
        'Mailbox change enqueued',
      );
    } catch (err) {
      this.logger.error(
        { event: 'gmail.webhook.enqueue_failed', err },
        'Failed to enqueue Gmail push after acknowledging',
      );
    }
  }
}
