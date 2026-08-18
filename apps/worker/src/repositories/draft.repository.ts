import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EmailAddress } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';
import { StagedAttachmentRepository } from './staged-attachment.repository.js';

/**
 * Drafts, and the state machine that stops a reply being sent twice.
 *
 * A duplicate email is the failure a user notices most and can least undo, so
 * the guard is a conditional database write rather than an in-process check: two
 * workers racing on the same draft means exactly one `updateMany` matches.
 */
export interface ClaimedDraft {
  id: string;
  accountId: string;
  /** A forward carries the original's attachments; a reply does not. */
  kind: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references: string[];
  providerThreadId?: string;
  inReplyToMessageId?: string;
  idempotencyKey: string;
  /** Where to send the confirmation. */
  phoneNumber: string;
  lastInboundAt: Date | null;
}

@Injectable()
export class DraftRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly staged: StagedAttachmentRepository,
  ) {}

  /**
   * Creates a draft ready to send.
   *
   * The threading headers are captured now and never recomputed. The thread may
   * move on between composing and sending, and a recomputed `References` would
   * detach the reply from its own conversation (ADR 0003).
   *
   * Any file the user sent into the chat and has not yet spent is claimed here,
   * in the same transaction. Doing it here rather than in each composer is the
   * point: a composer that forgot would produce an email the user watched
   * themselves attach a file to, arriving without it. Whichever email they send
   * next carries them — which is what "attach" means in a chat, where there is
   * no draft window to hold a file open.
   */
  async createForSend(input: {
    userId: string;
    accountId: string;
    /**
     * The message being answered. Absent for a fresh compose, which has no
     * parent — the column is nullable for exactly this case, and a draft with
     * no parent is what makes the send path skip threading headers entirely.
     */
    inReplyToMessageId?: string;
    /** `reply` unless stated; a forward and a fresh compose are composed differently. */
    kind?: 'reply' | 'forward' | 'new';
    to: EmailAddress[];
    cc?: EmailAddress[];
    /** Never merged into `cc`: the whole point is that the others cannot see it. */
    bcc?: EmailAddress[];
    subject: string;
    bodyText: string;
    bodyCipher: Uint8Array;
    bodyDek: Uint8Array;
    bodyKeyVersion: number;
    inReplyTo?: string;
    references?: string[];
    providerThreadId?: string;
  }): Promise<{ id: string; idempotencyKey: string; attachmentCount: number }> {
    const idempotencyKey = randomUUID();

    const draft = await this.prisma.forUser(input.userId, async (tx) => {
      const created = await tx.draft.create({
        data: {
          userId: input.userId,
          accountId: input.accountId,
          inReplyToMessageId: input.inReplyToMessageId ?? null,
          kind: input.kind ?? 'reply',
          toAddresses: input.to.map((a) => a.address),
          ccAddresses: (input.cc ?? []).map((a) => a.address),
          bccAddresses: (input.bcc ?? []).map((a) => a.address),
          subject: input.subject,
          // Uint8Array rather than Buffer: Prisma's Bytes maps to
          // Uint8Array<ArrayBuffer>, and Node's Buffer widens to
          // ArrayBufferLike, which TypeScript rejects.
          bodyTextCipher: new Uint8Array(input.bodyCipher),
          bodyDek: new Uint8Array(input.bodyDek),
          bodyKeyVersion: input.bodyKeyVersion,
          inReplyToHeader: input.inReplyTo ?? null,
          referencesHeader: input.references ?? [],
          providerThreadId: input.providerThreadId ?? null,
          status: 'queued',
          idempotencyKey,
        },
        select: { id: true },
      });

      const attachmentCount = await this.staged.claimForDraft(tx, input.userId, created.id);

      return { id: created.id, attachmentCount };
    });

    return { id: draft.id, idempotencyKey, attachmentCount: draft.attachmentCount };
  }

  /**
   * Atomically claims a queued draft for sending.
   *
   * `updateMany` with a status predicate is the whole guard: whichever worker
   * matches first flips it to `sending`, and the loser's update matches zero
   * rows and returns null. An in-process lock would not survive two pods.
   *
   * @returns the draft, or null when another attempt already claimed it.
   */
  async claimForSending(
    userId: string,
    draftId: string,
    /**
     * Decrypts the stored body. Injected rather than done here so this
     * repository never holds key material — decryption lives in exactly one
     * place (ADR 0002).
     */
    decryptBody: (sealed: {
      ciphertext: Buffer;
      wrappedKey: Buffer;
      keyVersion: number;
    }) => Promise<string>,
  ): Promise<ClaimedDraft | null> {
    return this.prisma.forUser(userId, async (tx) => {
      const claimed = await tx.draft.updateMany({
        where: { id: draftId, status: 'queued' },
        data: { status: 'sending' },
      });

      if (claimed.count === 0) return null;

      const draft = await tx.draft.findUnique({ where: { id: draftId } });
      if (!draft) return null;

      const state = await tx.conversationState.findUnique({
        where: { userId },
        select: { lastInboundAt: true },
      });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { phoneNumber: true },
      });

      const bodyText = await decryptBody({
        ciphertext: Buffer.from(draft.bodyTextCipher),
        wrappedKey: Buffer.from(draft.bodyDek),
        keyVersion: draft.bodyKeyVersion,
      });

      return {
        id: draft.id,
        accountId: draft.accountId,
        kind: draft.kind,
        to: draft.toAddresses.map((address) => ({ address })),
        cc: draft.ccAddresses.map((address) => ({ address })),
        bcc: draft.bccAddresses.map((address) => ({ address })),
        subject: draft.subject,
        bodyText,
        ...(draft.inReplyToHeader ? { inReplyTo: draft.inReplyToHeader } : {}),
        references: draft.referencesHeader,
        ...(draft.providerThreadId ? { providerThreadId: draft.providerThreadId } : {}),
        ...(draft.inReplyToMessageId ? { inReplyToMessageId: draft.inReplyToMessageId } : {}),
        idempotencyKey: draft.idempotencyKey,
        phoneNumber: user?.phoneNumber ?? '',
        lastInboundAt: state?.lastInboundAt ?? null,
      };
    });
  }

  /**
   * Takes a draft back before it is sent.
   *
   * The same conditional write that guards against sending twice, used from the
   * other side: whichever happens first wins. If the send worker has already
   * claimed it — flipping `queued` to `sending` — this matches nothing and
   * returns false, and the caller says the mail has gone rather than claiming
   * an undo it did not perform.
   *
   * The queued BullMQ job is deliberately left alone. It will fire, find
   * nothing to claim, and stop; removing it would be a second thing that has to
   * succeed for the cancel to hold.
   */
  async cancelIfQueued(userId: string, draftId: string): Promise<boolean> {
    return this.prisma.forUser(userId, async (tx) => {
      const cancelled = await tx.draft.updateMany({
        where: { id: draftId, status: 'queued' },
        data: { status: 'cancelled' },
      });
      return cancelled.count === 1;
    });
  }

  async markSent(userId: string, draftId: string, providerMessageId: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.draft.update({
        where: { id: draftId },
        data: { status: 'sent', sentAt: new Date(), sentProviderMessageId: providerMessageId },
      });
    });
  }

  /**
   * Records a failure.
   *
   * A retryable failure returns the draft to `queued` so the next attempt can
   * claim it. A permanent one stays `failed`, because returning it to the queue
   * would have it retried forever against an error that will not change.
   */
  async markFailed(
    userId: string,
    draftId: string,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.draft.update({
        where: { id: draftId },
        data: { status: retryable ? 'queued' : 'failed', failureReason: reason },
      });
    });
  }

  /**
   * Establishes that a user may forward a message, and where to fetch it from.
   *
   * Narrow on purpose. Ingest stores only a snippet, so there is no body here to
   * quote — the forward's content comes from the provider. What this row is for
   * is authorization: row-level security is what makes a request to forward
   * someone else's mail return nothing rather than their mail.
   */
  async findForForward(userId: string, emailMessageId: string) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: {
          id: true,
          accountId: true,
          providerMessageId: true,
          subject: true,
          deletedAt: true,
        },
      }),
    );
  }

  /** The original message a reply is threading onto. */
  async findOriginal(userId: string, emailMessageId: string) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: {
          id: true,
          accountId: true,
          messageIdHeader: true,
          references: true,
          subject: true,
          fromAddress: true,
          fromName: true,
          replyTo: true,
          toAddresses: true,
          ccAddresses: true,
          thread: { select: { providerThreadId: true } },
        },
      }),
    );
  }
}
