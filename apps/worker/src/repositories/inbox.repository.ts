import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.js';
import { withoutTenantScope, Prisma } from '@wea/db';
import type { ResolutionCandidate } from '../services/thread-resolver.js';

/**
 * The reads the command pipeline needs.
 *
 * Every query here is tenant-scoped through `withTenant`, with one deliberate
 * exception marked and justified below. That is not ceremony: row-level security
 * refuses a query with no tenant context, so an unscoped read does not leak —
 * it returns nothing, which would look like "no recent emails" and quietly
 * break the resolver rather than quietly leak. Both are bugs; only one is
 * visible. Hence the explicit scoping.
 */
@Injectable()
export class InboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds the user a WhatsApp number belongs to.
   *
   * Necessarily cross-tenant: at this point we do not yet know whose message
   * this is, so there is no tenant to scope to. It reads exactly one indexed
   * column and returns only an id — nothing about the user's mail.
   */
  async findUserByPhone(phoneNumber: string): Promise<{ id: string; timezone: string } | null> {
    return withoutTenantScope(this.prisma, 'webhook-account-lookup', async (db) =>
      db.user.findUnique({
        where: { phoneNumber },
        select: { id: true, timezone: true },
      }),
    );
  }

  /**
   * Redeems a verification code sent from a number we do not recognise.
   *
   * Unscoped, and it has to be: the whole point is that we do not yet know whose
   * number this is. The lookup is by code hash against a unique column, so it
   * identifies exactly one user or none — and it reads nothing about anyone's
   * mail, only the id it is establishing.
   *
   * @returns the user the number was just linked to, or null when the text was
   *   not a live code, which is the ordinary case for a message from a stranger.
   */
  async redeemPhoneCode(
    codeHash: string,
    phoneNumber: string,
  ): Promise<{ id: string; timezone: string } | null> {
    return withoutTenantScope(this.prisma, 'webhook-account-lookup', async (db) => {
      const user = await db.user.findFirst({
        where: {
          phoneVerificationCodeHash: codeHash,
          phoneVerificationExpiresAt: { gt: new Date() },
          deletedAt: null,
        },
        select: { id: true, timezone: true },
      });

      if (!user) return null;

      try {
        await db.user.update({
          where: { id: user.id },
          data: {
            phoneNumber,
            phoneVerified: true,
            // Spent. A code that survived redemption could link a second
            // account to this number the moment the first released it.
            phoneVerificationCodeHash: null,
            phoneVerificationExpiresAt: null,
          },
        });
      } catch (err) {
        // Already verified against another account. Refused rather than moved:
        // silently reassigning would let anyone who can send one message take a
        // number away from whoever currently holds it.
        if ((err as { code?: string }).code === 'P2002') return null;
        throw err;
      }

      return user;
    });
  }

  /**
   * Rank 1 of the resolution ladder: the WhatsApp message the user replied to,
   * mapped back to the email it notified about.
   *
   * Returns null when we have no record of that message — an old notification
   * past retention, or one we never sent. The resolver treats that as "fall
   * through and ask", never as "close enough".
   */
  async findEmailByDelivery(userId: string, whatsappMessageId: string): Promise<string | null> {
    return this.prisma.forUser(userId, async (tx) => {
      const delivery = await tx.whatsAppDelivery.findUnique({
        where: { whatsappMessageId },
        select: { emailMessageId: true },
      });
      return delivery?.emailMessageId ?? null;
    });
  }

  /**
   * Recent emails the user could plausibly mean.
   *
   * Bounded deliberately. This feeds a disambiguation list capped at ten rows by
   * WhatsApp, and "recent" past a day or so stops being a useful guess anyway —
   * offering someone a week-old newsletter as a reply target is noise.
   *
   * Aliases come from the derived contact book, so "reply to my boss" can match
   * a name the user chose rather than one the sender did.
   */
  async findRecentCandidates(
    userId: string,
    limit = 20,
    since?: Date,
  ): Promise<ResolutionCandidate[]> {
    const cutoff = since ?? new Date(Date.now() - 48 * 3_600_000);

    return this.prisma.forUser(userId, async (tx) => {
      const messages = await tx.emailMessage.findMany({
        where: {
          direction: 'inbound',
          isArchived: false,
          isSpam: false,
          // Offering someone an email they just deleted as a thing to reply to
          // is how "did that work?" starts.
          deletedAt: null,
          receivedAt: { gte: cutoff },
          // Only mail we actually told the user about. An email they never saw
          // is not something they can be replying to.
          deliveries: { some: {} },
        },
        orderBy: { receivedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          fromAddress: true,
          fromName: true,
          subject: true,
          receivedAt: true,
        },
      });

      if (messages.length === 0) return [];

      // One query for every alias rather than one per message.
      const contacts = await tx.contact.findMany({
        where: { emailAddress: { in: messages.map((m) => m.fromAddress) } },
        select: { emailAddress: true, aliases: true },
      });
      const aliasesByAddress = new Map(contacts.map((c) => [c.emailAddress, c.aliases]));

      return messages.map((message) => ({
        emailMessageId: message.id,
        fromAddress: message.fromAddress,
        ...(message.fromName ? { fromName: message.fromName } : {}),
        subject: message.subject,
        receivedAt: message.receivedAt,
        ...(aliasesByAddress.get(message.fromAddress)?.length
          ? { aliases: aliasesByAddress.get(message.fromAddress)! }
          : {}),
      }));
    });
  }

  /** Rank 3: the conversation currently in progress, if it has not expired. */
  async findConversationState(userId: string): Promise<{
    activeEmailMessageId: string | null;
    expiresAt: Date;
    lastInboundAt: Date | null;
  } | null> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.conversationState.findUnique({
        where: { userId },
        select: { activeEmailMessageId: true, expiresAt: true, lastInboundAt: true },
      }),
    );
  }

  /**
   * Records that the user has just messaged us.
   *
   * `lastInboundAt` is what the entire 24-hour messaging window hangs off, so it
   * is written on every inbound message regardless of whether we understood it.
   * A message we failed to parse still reopens the window.
   */
  async touchConversation(
    userId: string,
    at: Date,
    activeEmailMessageId?: string | null,
    ttlMs = 30 * 60_000,
  ): Promise<void> {
    const expiresAt = new Date(at.getTime() + ttlMs);

    await this.prisma.forUser(userId, async (tx) => {
      await tx.conversationState.upsert({
        where: { userId },
        create: {
          userId,
          lastInboundAt: at,
          expiresAt,
          ...(activeEmailMessageId ? { activeEmailMessageId } : {}),
        },
        update: {
          lastInboundAt: at,
          expiresAt,
          // Only overwrite the active email when we actually resolved one;
          // an unrelated "help" must not clear the thread being worked on.
          ...(activeEmailMessageId ? { activeEmailMessageId } : {}),
        },
      });
    });
  }

  /**
   * Remembers an action the user has been asked to confirm.
   *
   * This is what makes a confirmation tap safe. The button carries only our own
   * record id — never a recipient — so the address a forward goes to is written
   * here, server-side, at the moment the user typed it. A replayed or crafted
   * tap therefore cannot redirect someone's mail anywhere; the worst it can do
   * is re-authorize the forward the user already described.
   */
  async setPendingAction(
    userId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.conversationState.updateMany({
        where: { userId },
        data: { pendingAction: action, pendingOptions: details as Prisma.InputJsonValue },
      });
    });
  }

  /**
   * Reads and clears a pending action.
   *
   * Clearing on read is the point: a confirmation is spent once. Tapping the
   * same button twice must not send two emails, and the send path's idempotency
   * key does not help here because a second tap would compose a second draft.
   */
  async takePendingAction(userId: string, action: string): Promise<Record<string, unknown> | null> {
    return this.prisma.forUser(userId, async (tx) => {
      const state = await tx.conversationState.findUnique({
        where: { userId },
        select: { pendingAction: true, pendingOptions: true, expiresAt: true },
      });

      if (!state || state.pendingAction !== action) return null;
      // An expired confirmation is not a confirmation. The user has moved on,
      // and acting on it now would act on something they no longer have in mind.
      if (state.expiresAt.getTime() <= Date.now()) return null;

      await tx.conversationState.updateMany({
        where: { userId, pendingAction: action },
        // `Prisma.DbNull` writes SQL NULL; a bare `null` on a Json column means
        // the JSON value `null`, and `undefined` means "leave it alone" — both
        // would leave the spent confirmation readable.
        data: { pendingAction: null, pendingOptions: Prisma.DbNull },
      });

      return (state.pendingOptions as Record<string, unknown> | null) ?? {};
    });
  }

  /** Clears the active thread — on `cancel`, or when the user changes topic. */
  async clearActiveThread(userId: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.conversationState.updateMany({
        where: { userId },
        data: { activeEmailMessageId: null, activeDraftId: null, pendingAction: null },
      });
    });
  }

  /**
   * Persists the inbound message.
   *
   * Written before handling, so a message that later crashes a processor is
   * still on record — "the user says they replied and nothing happened" is
   * answerable only if the inbound side was recorded independently of the
   * outcome.
   */
  async recordInbound(input: {
    userId: string | null;
    whatsappMessageId: string;
    phoneNumber: string;
    messageType: string;
    body?: string;
    contextMessageId?: string;
    receivedAt: Date;
  }): Promise<void> {
    const data = {
      userId: input.userId,
      whatsappMessageId: input.whatsappMessageId,
      phoneNumber: input.phoneNumber,
      messageType: input.messageType,
      body: input.body ?? null,
      contextMessageId: input.contextMessageId ?? null,
      receivedAt: input.receivedAt,
    };

    // `createMany` with skipDuplicates compiles to INSERT ... ON CONFLICT DO
    // NOTHING, which is exactly the intent: record the message once, and let a
    // redelivered webhook be a no-op.
    //
    // Prisma's `upsert` would emit ON CONFLICT DO UPDATE instead, and Postgres
    // evaluates the policy's USING clause on that path — which is NULL for an
    // ownerless row and fails, even though the WITH CHECK permits it.
    const write = async (db: {
      whatsAppInboundMessage: { createMany: (a: unknown) => Promise<unknown> };
    }) => {
      await db.whatsAppInboundMessage.createMany({ data: [data], skipDuplicates: true });
    };

    if (input.userId) {
      // Scoped, so row-level security accepts the write on its normal path.
      await this.prisma.forUser(input.userId, (tx) => write(tx as never));
      return;
    }

    // No owner: someone with no connected account messaged the business number.
    // The policy permits a NULL-owner row precisely for this, and no tenant can
    // ever read it back.
    await withoutTenantScope(this.prisma, 'webhook-account-lookup', (db) => write(db as never));
  }

  /**
   * Records how a message was interpreted, for analytics and for debugging
   * misroutes. Always scoped — by this point the owner is known, and an
   * unattributed message is never interpreted in the first place.
   */
  async recordResolution(
    userId: string,
    whatsappMessageId: string,
    intent: string,
    source: string,
    handlerError?: string,
  ): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.whatsAppInboundMessage.updateMany({
        where: { whatsappMessageId },
        data: {
          resolvedIntent: intent,
          intentSource: source,
          handledAt: new Date(),
          handlerError: handlerError ?? null,
        },
      });
    });
  }

  /**
   * Records an outbound message.
   *
   * `whatsappMessageId` is what a future native reply resolves through — rank 1
   * of the ladder — so a response sent without recording it is a reply the user
   * can never answer by replying to.
   */
  async recordDelivery(input: {
    userId: string;
    phoneNumber: string;
    kind: 'notification' | 'digest' | 'reply_confirmation' | 'command_response' | 'error';
    whatsappMessageId?: string;
    emailMessageId?: string;
    status?: 'sent' | 'failed';
    errorMessage?: string;
  }): Promise<void> {
    await this.prisma.forUser(input.userId, async (tx) => {
      await tx.whatsAppDelivery.create({
        data: {
          userId: input.userId,
          phoneNumber: input.phoneNumber,
          kind: input.kind,
          status: input.status ?? 'sent',
          whatsappMessageId: input.whatsappMessageId ?? null,
          emailMessageId: input.emailMessageId ?? null,
          errorMessage: input.errorMessage ?? null,
          ...(input.status === 'failed' ? { failedAt: new Date() } : { sentAt: new Date() }),
        },
      });
    });
  }

  /** The subject of a resolved email, for confirmation prompts. */
  async findSubject(userId: string, emailMessageId: string): Promise<string | null> {
    return this.prisma.forUser(userId, async (tx) => {
      const message = await tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: { subject: true },
      });
      return message?.subject ?? null;
    });
  }
}
