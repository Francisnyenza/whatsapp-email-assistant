import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUE, type DeliverAttachmentJob } from '@wea/shared';
import { buildText } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { OutboundService } from '../services/outbound.service.js';
import { AttachmentRepository } from '../repositories/attachment.repository.js';
import { startWorker } from './base.processor.js';

/**
 * Sending an email's attachments into the chat.
 *
 * `QUEUE.MEDIA` was declared in the shared constants with its own concurrency
 * and retry policy from the beginning of the project and had no producer and no
 * consumer — a notification named an email's attachments and nothing ever
 * delivered them. This is the consumer.
 *
 * On its own queue rather than on `notify`, and the reason is the shape of the
 * work rather than tidiness. A notification is small and must not wait; an
 * attachment is a provider download, a Meta upload, and up to twenty-five
 * megabytes moving through a worker. Sharing a queue would put one large file
 * in front of somebody's mail.
 *
 * The job carries ids and nothing else. Filename, type, size and bytes are all
 * read server-side from the row, so a replayed or crafted job can only describe
 * the file its ids already name.
 */
@Injectable()
export class MediaProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<DeliverAttachmentJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountService,
    private readonly outbound: OutboundService,
    private readonly attachments: AttachmentRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<DeliverAttachmentJob>({
      queueName: QUEUE.MEDIA,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<DeliverAttachmentJob>): Promise<void> {
    const { userId, emailMessageId, attachmentId } = job.data;

    const context = await this.attachments.findForDelivery(userId, emailMessageId, attachmentId);

    if (!context) {
      // Deleted, purged by the retention sweep, or never belonged to this user
      // — row-level security makes all three resolve to nothing here, which is
      // the point.
      this.logger.info(
        { event: 'media.attachment_gone', attachmentId },
        'Attachment is no longer available',
      );
      return;
    }

    const { attachment, phoneNumber, lastInboundAt, providerMessageId } = context;

    if (!phoneNumber) {
      // An unverified number, cleared at `findForDelivery` exactly as it is for
      // every other delivery. Sending someone's attachment to a number nobody
      // proved they own is the failure this guard exists for.
      this.logger.warn(
        { event: 'media.no_verified_phone', attachmentId },
        'No verified number to deliver an attachment to',
      );
      return;
    }

    const refusal = this.refuse(attachment);
    if (refusal) {
      await this.outbound.reply({
        userId,
        phoneNumber,
        payload: buildText(refusal),
        kind: 'command_response',
        emailMessageId,
        lastInboundAt,
      });
      return;
    }

    const account = await this.accounts.load(userId, context.accountId);
    const provider = this.accounts.providerFor(account.provider);

    const stream = await provider.getAttachment(
      account,
      providerMessageId,
      attachment.providerAttachmentId,
    );

    // The provider streams because attachments reach 25 MB and beyond, and this
    // is where that stops being free: Meta's upload wants a whole body, so the
    // bytes are buffered — and the cap is enforced *while* reading rather than
    // after, because a `sizeBytes` that disagrees with reality is exactly what
    // an oversized file looks like.
    const content = await readBounded(stream, MAX_DELIVERABLE_BYTES);

    if (!content) {
      await this.outbound.reply({
        userId,
        phoneNumber,
        payload: buildText(
          `“${attachment.filename}” is larger than I can send over WhatsApp. ` +
            'It is still on the email.',
        ),
        kind: 'command_response',
        emailMessageId,
        lastInboundAt,
      });
      return;
    }

    const mediaId = await this.outbound.uploadMedia(
      content,
      attachment.mimeType,
      attachment.filename,
    );

    await this.outbound.reply({
      userId,
      phoneNumber,
      payload: {
        kind: 'media',
        // Images render inline and everything else becomes a document. Sending
        // a PDF as an image is rejected by Meta; sending an image as a document
        // works but makes the user tap to see a photo.
        mediaType: attachment.mimeType.startsWith('image/') ? 'image' : 'document',
        mediaId,
        // Only a document shows one. An image caption would be dropped, and the
        // filename is the only clue to what a document is.
        ...(attachment.mimeType.startsWith('image/') ? {} : { filename: attachment.filename }),
      },
      kind: 'command_response',
      emailMessageId,
      lastInboundAt,
    });

    this.logger.info(
      {
        event: 'media.attachment_delivered',
        attachmentId,
        bytes: content.length,
        mimeType: attachment.mimeType,
      },
      'Attachment delivered',
    );
  }

  /**
   * Why this file will not be sent, or null.
   *
   * Separate from the delivery path so each refusal is a sentence the user
   * reads rather than a silent drop. "I asked for the attachment and nothing
   * happened" is indistinguishable from the product being broken.
   */
  private refuse(attachment: {
    filename: string;
    disposition: string;
    isMalicious: boolean | null;
  }): string | null {
    if (attachment.isMalicious === true) {
      return `I'm not going to send “${attachment.filename}” — it was flagged as malicious.`;
    }

    // `null` means *not scanned*, not *safe*, and this deliberately does not
    // refuse on it. Nothing in this system sets the column yet, so refusing
    // would block every attachment; and this is the user's own mail, which any
    // mail client would hand them unscanned. What must not happen is the
    // opposite mistake — treating null as a clean result and saying so.
    if (attachment.disposition === 'inline') {
      // Signature logos and tracking pixels. The forward path filters them for
      // the same reason: nobody asked for a 3 KB company logo.
      return `“${attachment.filename}” is part of the message layout rather than a real attachment.`;
    }

    return null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

/**
 * How large a file may be before WhatsApp is the wrong way to send it.
 *
 * Meta allows 100 MB for a document, but the number that matters here is not
 * theirs: the bytes are buffered in a worker that runs with a 1 GB memory limit
 * and a concurrency of twenty. Twenty concurrent 100 MB downloads is an OOM
 * kill, and the alert for it fires long after the attachments stopped arriving.
 * Twenty-five megabytes is what most providers accept on an outbound email
 * anyway, so a file above it is unusual and worth a sentence rather than a
 * silent failure.
 */
export const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;

/**
 * Reads a stream into memory, or gives up.
 *
 * Returns null past the limit rather than throwing, because being too large is
 * an ordinary property of a file and not an error — the caller says so and the
 * job succeeds. Throwing would retry the download four times to reach the same
 * answer.
 *
 * The check is inside the loop on purpose. Trusting a declared `sizeBytes`
 * would mean a provider that under-reports, or a row that went stale, is the
 * one case where the guard does not run.
 */
async function readBounded(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;

    if (total > limit) {
      // Stop pulling. Without this the rest of a 200 MB file still crosses the
      // network to be discarded.
      // `Readable` has `destroy`; the `NodeJS.ReadableStream` this is typed as
      // does not declare it, so the cast goes through `unknown`. Checked before
      // it is called rather than assumed, because a provider is free to hand
      // back any readable.
      const destroyable = stream as unknown as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') destroyable.destroy();
      return null;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}
