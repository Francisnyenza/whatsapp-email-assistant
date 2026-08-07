import { Injectable } from '@nestjs/common';
import type { AiUsage, EmailAnalysis } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Storing what the model said, and what it cost.
 *
 * Both matter, and for different reasons. The analysis is what makes a
 * notification card useful. The usage is what stops a runaway loop or a hostile
 * mailbox turning into an unbounded bill — a budget nobody meters is a number
 * in a config file.
 */
@Injectable()
export class AnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores an analysis.
   *
   * Idempotent on the message: a retried job that already stored one overwrites
   * rather than failing on the unique constraint, and a second opinion from a
   * later model version is more useful than the first.
   */
  async save(
    userId: string,
    emailMessageId: string,
    analysis: EmailAnalysis,
    usage: AiUsage,
    fromCache = false,
  ): Promise<void> {
    const data = {
      summary: analysis.summary,
      bulletSummary: analysis.bulletSummary,
      category: analysis.category,
      priority: analysis.priority,
      urgencyScore: analysis.urgencyScore,
      spamScore: analysis.spamScore,
      language: analysis.language,
      sentiment: analysis.sentiment,
      requiresReply: analysis.requiresReply,
      entities: analysis.entities,
      actionItems: analysis.actionItems,
      suggestedReplies: analysis.suggestedReplies,
      containsInstructionLikeText: analysis.containsInstructionLikeText,
      modelProvider: usage.provider,
      model: usage.model,
      tokensUsed: usage.totalTokens,
      fromCache,
    };

    await this.prisma.forUser(userId, async (tx) => {
      await tx.messageAnalysis.upsert({
        where: { emailMessageId },
        create: { userId, emailMessageId, ...data },
        update: data,
      });
    });
  }

  /**
   * Adds one call to today's tally.
   *
   * Aggregated per day, task, provider and model rather than one row per call:
   * at any real volume a row per call is a table nobody can query and a bill
   * nobody can explain.
   */
  async recordUsage(
    userId: string,
    task: string,
    usage: AiUsage,
    outcome: { cached?: boolean; failed?: boolean } = {},
  ): Promise<void> {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    const key = {
      userId_day_task_provider_model: {
        userId,
        day,
        task,
        provider: usage.provider,
        model: usage.model,
      },
    };

    await this.prisma.forUser(userId, async (tx) => {
      await tx.aiUsageRecord.upsert({
        where: key,
        create: {
          userId,
          day,
          task,
          provider: usage.provider,
          model: usage.model,
          requests: 1,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costMicros: usage.costMicros,
          cacheHits: outcome.cached ? 1 : 0,
          failures: outcome.failed ? 1 : 0,
        },
        update: {
          requests: { increment: 1 },
          promptTokens: { increment: usage.promptTokens },
          completionTokens: { increment: usage.completionTokens },
          totalTokens: { increment: usage.totalTokens },
          costMicros: { increment: usage.costMicros },
          ...(outcome.cached ? { cacheHits: { increment: 1 } } : {}),
          ...(outcome.failed ? { failures: { increment: 1 } } : {}),
        },
      });
    });
  }

  /** Today's token count for this user, against their daily ceiling. */
  async tokensUsedToday(userId: string): Promise<number> {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    return this.prisma.forUser(userId, async (tx) => {
      const rows = await tx.aiUsageRecord.aggregate({
        where: { day },
        _sum: { totalTokens: true },
      });
      return rows._sum.totalTokens ?? 0;
    });
  }

  /**
   * Deliberately absent: a cross-tenant cache keyed on content hash.
   *
   * The same newsletter reaches thousands of mailboxes and analysing it
   * thousands of times is the largest avoidable cost here, so the temptation is
   * real. But reading another user's analysis means an unscoped read of
   * `email_messages` — precisely the widening that was refused for the watch
   * sweep, on the grounds that a scheduled job should not be able to read every
   * mailbox. Taking it now for a cost saving, having refused it for a
   * correctness problem, would be the inconsistency that makes the earlier
   * decision meaningless.
   *
   * The version worth building keeps the derived analysis in its own table,
   * keyed by content hash and carrying no user id at all — the same shape as
   * `provider_account_routes`. That is a schema change and a separate piece of
   * work; see docs/status.md.
   */
}
