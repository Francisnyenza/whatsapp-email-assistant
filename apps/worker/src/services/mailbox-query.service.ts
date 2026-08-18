import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { embedQuery, canEmbed } from '@wea/ai';
import { buildSearchResults, buildDigest, buildText, buildAnswer } from '@wea/whatsapp';
import type { CommandIntent, WhatsAppOutboundPayload } from '@wea/shared';
import { AiService } from './ai.service.js';
import {
  SearchRepository,
  type ListKind,
  type SearchHit,
  type Deadline,
} from '../repositories/search.repository.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';
import { AssistantService } from './assistant.service.js';
import { LabelService } from './label.service.js';
import { MailboxPickerService } from './mailbox-picker.service.js';

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
    private readonly assistant: AssistantService,
    private readonly labels: LabelService,
    private readonly mailboxes: MailboxPickerService,
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
      intent.intent === 'question' ||
      intent.intent === 'list_deadlines' ||
      // A read over the mailbox's filing names rather than over its messages,
      // but a read all the same: it concerns no particular email, so it is
      // answered here rather than through the resolution ladder.
      intent.intent === 'list_labels' ||
      intent.intent === 'list_mailboxes'
    );
  }

  async answer(userId: string, intent: CommandIntent): Promise<WhatsAppOutboundPayload | null> {
    if (intent.intent === 'search') {
      return this.answerSearch(userId, intent.query);
    }

    if (intent.intent === 'question') {
      return this.answerQuestion(userId, intent.question);
    }

    if (intent.intent === 'list_deadlines') {
      return this.renderDeadlines(await this.search.deadlines(userId));
    }

    if (intent.intent === 'list_mailboxes') {
      const boxes = await this.mailboxes.list(userId);
      return buildText(
        boxes.length === 0
          ? "You haven't connected a mailbox yet."
          : `You can send from:\n${boxes
              .map(
                (box) =>
                  `• ${box.displayName ? `${box.displayName} — ` : ''}${box.emailAddress}` +
                  (box.isPrimary ? ' _(default)_' : ''),
              )
              .join('\n')}\n\nSay _email alice@acme.com from work saying …_ to pick one.`,
      );
    }

    if (intent.intent === 'list_labels') {
      const names = await this.labels.list(userId);
      return buildText(
        names.length === 0
          ? "You don't have any labels yet. Say _label this as Receipts_ and I'll make one."
          : `Your labels:\n${names.map((name) => `• ${name}`).join('\n')}`,
      );
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

  /* ------------------------------ questions ------------------------------ */

  /**
   * "Did anyone reply about the invoice?"
   *
   * Retrieval-augmented, and the retrieval is the security-relevant half. The
   * same hybrid search that answers `search` picks the candidates, which means
   * two things at once: every candidate is the user's own mail, because the
   * query runs under row-level security; and *which* of their mail is partly
   * chosen by whoever wrote it, because anyone who can send the user an email
   * can write one full of the words a likely question matches.
   *
   * The first is what makes this safe to build at all. The second is why the
   * emails reach the model inside a nonce envelope, numbered rather than
   * identified, with the question placed after them — and why the answer is
   * prose the user reads rather than anything that acts.
   *
   * Fewer sources than a search returns, deliberately. Ten emails of body text
   * would bury the question and the rules under third-party prose, which is the
   * simplest way there is to make an injection land.
   */
  private async answerQuestion(userId: string, question: string): Promise<WhatsAppOutboundPayload> {
    const text = question.trim();

    if (!this.ai.provider()) {
      // Not an apology — the commands that *do* work without a model are the
      // useful thing to say here.
      return buildText(
        'I can’t answer questions about your mailbox without a model configured. ' +
          'Try *search <words>*, *unread*, *urgent* or *deadlines*.',
      );
    }

    const vector = await this.queryVector(userId, text);
    const hits = await this.search.search(userId, text, {
      ...(vector ? { vector } : {}),
      limit: QUESTION_SOURCES,
    });

    if (hits.length === 0) {
      // Answering from nothing is answering from the model's imagination, which
      // is the one output this feature must never produce.
      return buildText(
        'I couldn’t find any email that looks related to that. ' +
          'Try naming a sender, or a word you remember from the subject.',
      );
    }

    const answer = await this.assistant.answerQuestionFrom(userId, text, hits);

    this.logger.info(
      {
        event: 'question.answered',
        semantic: vector !== null,
        retrieved: hits.length,
        cited: answer.usedSources.length,
      },
      'Mailbox question answered',
    );

    // Indexes mapped back to rows we already hold. A citation the model
    // invented was dropped before it reached here, so this cannot name an email
    // that was never retrieved.
    const cited = answer.usedSources.map((index) => hits[index]).filter(Boolean) as SearchHit[];

    return buildAnswer(answer.text, cited.map(toResultItem));
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
/**
 * How many emails a question is answered from.
 *
 * Far fewer than the ten a search shows, and the reason is not cost. Every
 * source is third-party prose competing with the system prompt for the model's
 * attention, so each one added makes an injection marginally more likely to
 * land — and the marginal *answer* stops improving well before ten, because a
 * question the top few cannot answer is usually a question the next six cannot
 * either.
 */
const QUESTION_SOURCES = 4;

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
