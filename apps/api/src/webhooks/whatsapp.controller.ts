import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  Headers,
  Inject,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyMetaSignature } from '@wea/crypto';
import { parseWebhook, handleVerificationChallenge, webhookDedupeKey } from '@wea/whatsapp';
import type { Logger } from 'pino';
import { QUEUE, JOB } from '@wea/shared';
import { QueueProducer } from '../queue/queue.producer.js';
import { ConfigService } from '../config/config.service.js';

/**
 * The WhatsApp webhook.
 *
 * This is a public, unauthenticated URL that causes us to read mailboxes and
 * send messages on people's behalf. Three properties govern everything here:
 *
 *  1. **Verify before parsing.** The signature is checked against the raw bytes
 *     first. Nothing in the payload is trusted, or even read, until it passes.
 *  2. **Acknowledge fast.** Meta retries anything that is slow or non-2xx, and a
 *     retry storm during an incident is how a backlog becomes an outage. We
 *     validate, enqueue and return — target under 50 ms. Nothing that can block
 *     happens on this thread.
 *  3. **Always 200 after verification.** Once a payload is authentic, a failure
 *     on our side must not make Meta redeliver forever. It goes on a queue with
 *     its own retries and a dead-letter, where it is visible and replayable.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Meta's subscription handshake. It GETs with a challenge and expects it
   * echoed only when the verify token matches.
   */
  @Get()
  verify(@Query() query: Record<string, string>, @Res() res: Response): void {
    const challenge = handleVerificationChallenge(
      query,
      this.config.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    );

    if (challenge === null) {
      this.logger.warn({ event: 'whatsapp.verify.rejected' }, 'Webhook verification rejected');
      res.status(HttpStatus.FORBIDDEN).send();
      return;
    }

    // Meta requires the challenge echoed as plain text, not JSON.
    res.status(HttpStatus.OK).type('text/plain').send(challenge);
  }

  @Post()
  async receive(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<void> {
    const rawBody = req.rawBody;

    // Fail closed. If the raw bytes are missing there is nothing to verify, and
    // processing an unverified webhook is worse than dropping a real one.
    if (!rawBody) {
      this.logger.error({ event: 'whatsapp.webhook.no_raw_body' }, 'Raw body unavailable');
      res.status(HttpStatus.BAD_REQUEST).send();
      return;
    }

    if (!verifyMetaSignature(rawBody, signature, this.config.env.WHATSAPP_APP_SECRET)) {
      // No detail in the response: an attacker probing the endpoint learns
      // nothing about why their signature failed.
      this.logger.warn(
        { event: 'whatsapp.webhook.bad_signature', hasSignature: Boolean(signature) },
        'Rejected webhook with invalid signature',
      );
      res.status(HttpStatus.UNAUTHORIZED).send();
      return;
    }

    // Authentic from here on. Everything below returns 200 regardless of
    // outcome, so a bug on our side cannot trigger endless redelivery.
    res.status(HttpStatus.OK).send();

    try {
      const parsed = parseWebhook(req.body);

      if (!parsed) {
        // Not a payload we recognize. Already 200'd, so Meta will not retry —
        // which is correct: retrying something unparseable is a loop.
        this.logger.warn({ event: 'whatsapp.webhook.unparseable' }, 'Dropped unparseable webhook');
        return;
      }

      const envelopeKey = webhookDedupeKey(rawBody);

      await Promise.all([
        ...parsed.messages.map((message) =>
          this.queue.enqueue(
            QUEUE.COMMANDS,
            JOB.HANDLE_INBOUND,
            {
              whatsappMessageId: message.id,
              phoneNumber: message.from,
              payload: message,
            },
            // Meta's wamid as the job id: a redelivered webhook resolves to the
            // same job and BullMQ discards the duplicate.
            { jobId: `wa:${message.id}` },
          ),
        ),
        ...parsed.statuses.map((status) =>
          this.queue.enqueue(
            QUEUE.NOTIFY,
            JOB.RETRY_DELIVERY,
            { statusUpdate: status },
            { jobId: `wast:${status.messageId}:${status.status}` },
          ),
        ),
      ]);

      this.logger.info(
        {
          event: 'whatsapp.webhook.accepted',
          messages: parsed.messages.length,
          statuses: parsed.statuses.length,
          envelopeKey: envelopeKey.slice(0, 12),
        },
        'Webhook enqueued',
      );
    } catch (err) {
      // The response has already gone. Log loudly — this is a dropped inbound
      // message, which the user experiences as us ignoring them.
      this.logger.error(
        { event: 'whatsapp.webhook.enqueue_failed', err },
        'Failed to enqueue webhook after acknowledging',
      );
    }
  }
}
