import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { embedQuery, canEmbed } from '@wea/ai';
import { buildSearchResults, buildDigest, buildText } from '@wea/whatsapp';
import type { CommandIntent, WhatsAppOutboundPayload } from '@wea/shared';
import { AiService } from './ai.service.js';
import {
  SearchRepository,
  type ListKind,
  type SearchHit,
  type Deadline,
} from '../repositories/search.repository.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';

/**
 * Reads over the mailbox: "find the invoice from Tom", "what's unread".
 *
 * These are the intents that concern no particular email, so they never reach
 * the response planner — the planner is pure and answers questions about *one*
 * message, and a search is a database query by definition. Handling them here
 * keeps that separation intact rather than threading a repository through a
 * class whose whole value is that it has none.
 *
 * The result is always a list payload with server-minted row ids, so the tap
 * that follows names an email we chose from the user's own mailbox. Nothing the
 * search returns can widen what a subsequent action is allowed to touch
 * (ADR 0004).
 */
@Injectable()
export class MailboxQueryService {
  constructor(
    private readonly search: SearchRepository,
    private readonly ai: AiService,
    private readonly analyses: AnalysisRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Whether this intent is a mailbox read at all. Exported as a type guard so
   * the caller's branch and this class cannot drift apart.
   */
  handles(intent: CommandIntent): boolean {
    return (
      LIST_KINDS[intent.intent] !== undefined ||
      intent.intent === 'search' ||
      intent.intent === 'list_deadlines'
    );
  }

  async answer(userId: string, intent: CommandIntent): Promise<WhatsAppOutboundPayload | null> {
    if (intent.intent === 'search') {
      return this.answerSearch(userId, intent.query);
    }

    if (intent.intent === 'list_deadlines') {
      return this.renderDeadlines(await this.search.deadlines(userId));
    }

    const kind = LIST_KINDS[intent.intent];
    if (!kind) return null;

    const hits = await this.search.list(userId, kind);
    return this.renderList(kind, hits);
  }

  /* ------------------------------- search -------------------------------- */

  private async answerSearch(userId: string, query: string): Promise<WhatsAppOutboundPayload> {
    const text = query.trim();

    if (text.length < 2) {
      return buildText('What should I search for? A sender’s name or a word from the subject.');
    }

    const vector = await this.queryVector(userId, text);
    const hits = await this.search.search(userId, text, {
      ...(vector ? { vector } : {}),
      limit: 10,
    });

    this.logger.info(
      { event: 'search.performed', semantic: vector !== null, results: hits.length },
      'Mailbox search',
    );

    return buildSearchResults(text, hits.map(toResultItem));
  }

  /**
   * The query's embedding, or null.
   *
   * Null is not a failure to report to the user. Search still runs — full-text
   * and trigram carry it — and a message that apologised for a missing model
   * every time someone searched would be noise attached to a working feature.
   * The log line records which arm ran, which is where that fact belongs.
   */
  private async queryVector(userId: string, text: string): Promise<number[] | null> {
    // The fallback is consulted for the same reason it is at write time: with
    // Anthropic as the primary there are no embeddings at all, and a query
    // embedded by a different provider than the documents were would land in a
    // different vector space — so this must resolve to whatever
    // `AiProcessor` used, and both ask in the same order.
    const provider = [this.ai.provider(), this.ai.secondary()].find(canEmbed);
    if (!provider) return null;

    if (await this.ai.isOverBudget(userId)) {
      this.logger.warn(
        { event: 'search.budget_exhausted', userId },
        'Daily token budget spent; searching without the semantic arm',
      );
      return null;
    }

    try {
      const result = await embedQuery(provider, text);
      await this.analyses.recordUsage(userId, 'embedding', result.usage);
      return result.data;
    } catch (err) {
      this.logger.warn(
        { event: 'search.embed_failed', err },
        'Could not embed the query; falling back to keyword search',
      );
      return null;
    }
  }

  /* ------------------------------ deadlines ------------------------------ */

  /**
   * What the user has been asked to do, and by when.
   *
   * Built from action items an analysis already extracted, so this costs a query
   * rather than a model call. A mailbox with no analyses — no provider, or one
   * configured after the mail arrived — genuinely has no deadlines to show, and
   * the empty message says which of those it is rather than implying the user
   * has nothing due.
   */
  private renderDeadlines(deadlines: Deadline[]): WhatsAppOutboundPayload {
    if (deadlines.length === 0) {
      return buildText(
        this.ai.provider()
          ? 'Nothing with a deadline that I can see.'
          : "I can't pull out deadlines without a model configured — nothing has been read closely enough to find one.",
      );
    }

    // A list row gives 24 characters for its title and 72 for its description,
    // which is what decides the layout here. The *task* takes the title,
    // because this is the one list where what needs doing matters more than who
    // asked — and the due date goes in the description, where "in 3d" and the
    // subject both fit rather than crowding each other out of the title.
    return buildDigest(
      deadlines.map((deadline) => ({
        emailMessageId: deadline.emailMessageId,
        fromName: deadline.description,
        fromAddress: deadline.fromAddress,
        subject: `${formatDue(deadline.dueAt)} · ${deadline.subject}`,
        priority: 'normal' as const,
      })),
      'Deadlines',
    );
  }

  /* -------------------------------- lists -------------------------------- */

  private renderList(kind: ListKind, hits: SearchHit[]): WhatsAppOutboundPayload {
    if (hits.length === 0) return buildText(EMPTY[kind]);

    return buildDigest(
      hits.map((hit) => ({
        emailMessageId: hit.emailMessageId,
        ...(hit.fromName ? { fromName: hit.fromName } : {}),
        fromAddress: hit.fromAddress,
        subject: hit.subject,
        // The digest builder counts urgency for its summary line. These lists
        // are already filtered, so claiming a priority we did not read would be
        // inventing one.
        priority: 'normal' as const,
      })),
      TITLE[kind],
    );
  }
}

/**
 * Which list intents map to which mailbox query. `list_deadlines` is not one of
 * them — it reads extracted action items rather than messages, so it has its own
 * branch above and its own shape on the way out.
 */
const LIST_KINDS: Partial<Record<CommandIntent['intent'], ListKind>> = {
  list_today: 'today',
  list_unread: 'unread',
  list_urgent: 'urgent',
};

const TITLE: Record<ListKind, string> = {
  today: 'Today’s email',
  unread: 'Unread',
  urgent: 'Needs attention',
};

const EMPTY: Record<ListKind, string> = {
  today: 'Nothing has arrived today yet.',
  unread: 'You’re all caught up — nothing unread.',
  urgent: 'Nothing urgent right now.',
};

/**
 * A due date at a glance.
 *
 * Relative rather than absolute, because "in 2 days" is answerable without
 * arithmetic and "2026-08-11T09:00:00Z" is not — and because a list row has
 * twenty-four characters to work with. Overdue is stated plainly: it is the one
 * case where the user needs to act now rather than plan.
 */
function formatDue(dueAt: Date, now = new Date()): string {
  const days = Math.round((dueAt.getTime() - now.getTime()) / (24 * 3_600_000));

  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

function toResultItem(hit: SearchHit) {
  return {
    emailMessageId: hit.emailMessageId,
    ...(hit.fromName ? { fromName: hit.fromName } : {}),
    fromAddress: hit.fromAddress,
    subject: hit.subject,
    isUnread: hit.isUnread,
  };
}
