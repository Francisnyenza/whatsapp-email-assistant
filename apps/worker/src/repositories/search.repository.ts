import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@wea/db';
import { AppError } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Finding an email the user half-remembers.
 *
 * People do not search their mail the way a database does. "the invoice from
 * Tom" is a topic and a sender; "hotel booking" is a concept whose email may
 * never contain the word "hotel". Neither a `LIKE` nor a vector answers both, so
 * this runs three searches and fuses them:
 *
 *  - **semantic** — cosine distance over the message embedding, which finds mail
 *    about a subject that never uses the user's words for it;
 *  - **full-text** — `tsquery` over subject and snippet, which finds an exact
 *    phrase a vector would rank as merely similar;
 *  - **fuzzy** — trigram similarity on subject and sender, which survives a
 *    typo and a half-remembered name.
 *
 * Fusion is reciprocal rank (RRF): each candidate scores `1/(k + rank)` in every
 * list it appears in. Chosen over a weighted sum of the raw scores because those
 * scores are not comparable — a cosine distance, a `ts_rank` and a trigram
 * similarity are three different units, and any weighting of them is a constant
 * someone tuned once and nobody can defend later. Ranks are comparable by
 * construction.
 *
 * All of it is raw SQL. `vector(1536)` is a type Prisma cannot express (the
 * model declares it `Unsupported`), so there is no generated client method that
 * can read or write it. Every query below still runs inside `forUser`, so
 * row-level security is pinned exactly as it is for the generated queries — raw
 * SQL is not an escape from tenant scoping.
 */

/** The embedding dimension, fixed by text-embedding-3-small and by the column. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * RRF's smoothing constant. 60 is the value from the original paper and the one
 * most implementations use; it flattens the difference between rank 1 and rank 2
 * enough that a single list cannot dominate the fused order on its own.
 */
const RRF_K = 60;

/** How deep each individual search goes before fusion. */
const CANDIDATE_DEPTH = 40;

export interface SearchHit {
  emailMessageId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string;
  snippet: string;
  receivedAt: Date;
  isUnread: boolean;
  /** The fused score. Comparable within one result set and meaningless outside it. */
  score: number;
}

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores the vector for one message.
   *
   * Idempotent on the message: a retried job overwrites rather than failing on
   * the unique constraint, and re-embedding after a model change is the same
   * operation.
   *
   * The row is inserted from a `SELECT` over `email_messages` rather than from
   * literal values, and that is the whole security of this method. Row-level
   * security checks the row being *written* — `user_id` is ours, so a policy
   * check passes — but it does not check the foreign key, because Postgres runs
   * referential-integrity triggers as the table owner and exempts them from RLS.
   * Writing `(alice, bobs_message_id)` therefore satisfies every policy on this
   * table. Nothing leaks (the read path joins `email_messages`, which is scoped),
   * but the unique constraint on `email_message_id` means the row squats on the
   * one Bob's own job needs — a cross-tenant denial of service via a column
   * nobody would think to check. Sourcing the id from a scoped `SELECT` closes
   * it: another tenant's message simply produces no row to insert.
   *
   * @returns false when the message is not this user's, or no longer exists.
   */
  async saveEmbedding(
    userId: string,
    emailMessageId: string,
    vector: number[],
    model: string,
  ): Promise<boolean> {
    const literal = vectorLiteral(vector);

    const written = await this.prisma.forUser(
      userId,
      async (tx) =>
        tx.$executeRaw`
        INSERT INTO message_embeddings (id, user_id, email_message_id, embedding, model, created_at)
        SELECT ${randomUUID()}::uuid, m.user_id, m.id, ${literal}::vector, ${model}, now()
        FROM email_messages m
        WHERE m.id = ${emailMessageId}::uuid
        ON CONFLICT (email_message_id) DO UPDATE
          SET embedding = EXCLUDED.embedding,
              model = EXCLUDED.model,
              created_at = now()
      `,
    );

    return written > 0;
  }

  /** Whether this message already has a vector, so a re-run does not re-bill. */
  async hasEmbedding(userId: string, emailMessageId: string): Promise<boolean> {
    return this.prisma.forUser(userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ exists: boolean }>>`
        SELECT true AS exists
        FROM message_embeddings
        WHERE email_message_id = ${emailMessageId}::uuid
        LIMIT 1
      `;
      return rows.length > 0;
    });
  }

  /**
   * Hybrid search.
   *
   * `vector` is optional and its absence is an ordinary state, not a
   * degradation to apologise for: a deployment with no model provider, or a
   * mailbox whose backlog has not been embedded yet, still gets keyword and
   * fuzzy results. The semantic arm simply contributes nothing.
   */
  async search(
    userId: string,
    query: string,
    options: { vector?: number[]; limit?: number } = {},
  ): Promise<SearchHit[]> {
    const text = query.trim();
    if (!text) return [];

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

    // An empty CTE rather than a conditional query. The alternative — two
    // versions of this SQL — is two things to keep in step, and the one that
    // runs less often is the one that rots.
    const semantic = options.vector
      ? Prisma.sql`
          SELECT e.email_message_id AS id,
                 row_number() OVER (ORDER BY e.embedding <=> ${vectorLiteral(options.vector)}::vector)
                   AS rank
          FROM message_embeddings e
          ORDER BY e.embedding <=> ${vectorLiteral(options.vector)}::vector
          LIMIT ${CANDIDATE_DEPTH}
        `
      : Prisma.sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`;

    const k = Prisma.sql`${RRF_K}::int`;

    const rows = await this.prisma.forUser(
      userId,
      async (tx) =>
        tx.$queryRaw<Array<SearchRow>>`
        WITH semantic AS (${semantic}),
        lexical AS (
          SELECT m.id,
                 row_number() OVER (
                   ORDER BY ts_rank(
                     to_tsvector('simple', coalesce(m.subject, '') || ' ' || coalesce(m.snippet, '')),
                     plainto_tsquery('simple', ${text})
                   ) DESC,
                   m.received_at DESC
                 ) AS rank
          FROM email_messages m
          WHERE m.deleted_at IS NULL
            AND to_tsvector('simple', coalesce(m.subject, '') || ' ' || coalesce(m.snippet, ''))
                @@ plainto_tsquery('simple', ${text})
          LIMIT ${CANDIDATE_DEPTH}
        ),
        fuzzy AS (
          SELECT m.id,
                 row_number() OVER (
                   ORDER BY GREATEST(
                     word_similarity(${text}, m.subject),
                     word_similarity(${text}, coalesce(m.from_name, '')),
                     word_similarity(${text}, m.from_address)
                   ) DESC,
                   m.received_at DESC
                 ) AS rank
          FROM email_messages m
          WHERE m.deleted_at IS NULL
            AND (
              ${text} %> m.subject
              OR ${text} %> m.from_name
              OR ${text} %> m.from_address
            )
          LIMIT ${CANDIDATE_DEPTH}
        ),
        candidates AS (
          SELECT id FROM semantic
          UNION
          SELECT id FROM lexical
          UNION
          SELECT id FROM fuzzy
        )
        SELECT m.id,
               m.subject,
               m.from_name,
               m.from_address,
               m.snippet,
               m.received_at,
               m.is_unread,
               coalesce(1.0 / (${k} + s.rank), 0)
             + coalesce(1.0 / (${k} + l.rank), 0)
             + coalesce(1.0 / (${k} + f.rank), 0) AS score
        FROM candidates c
        JOIN email_messages m ON m.id = c.id
        LEFT JOIN semantic s ON s.id = c.id
        LEFT JOIN lexical  l ON l.id = c.id
        LEFT JOIN fuzzy    f ON f.id = c.id
        WHERE m.deleted_at IS NULL
        ORDER BY score DESC, m.received_at DESC
        LIMIT ${limit}
      `,
    );

    return rows.map(toHit);
  }

  /**
   * The standing lists — today's mail, what is unread, what is urgent.
   *
   * Ordinary Prisma rather than raw SQL: there is no vector involved, and the
   * generated client gives the tenant filter and the type for free. `urgent`
   * reads the stored analysis, so a deployment with no model provider returns
   * nothing for it rather than a wrong answer — which the caller turns into a
   * sentence that says so.
   */
  async list(userId: string, kind: ListKind, limit = 10): Promise<SearchHit[]> {
    const where = listFilter(kind);

    const rows = await this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findMany({
        where: {
          direction: 'inbound',
          deletedAt: null,
          isSpam: false,
          ...where,
        },
        orderBy: { receivedAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 50),
        select: {
          id: true,
          subject: true,
          fromName: true,
          fromAddress: true,
          snippet: true,
          receivedAt: true,
          isUnread: true,
        },
      }),
    );

    return rows.map((row) => ({
      emailMessageId: row.id,
      subject: row.subject,
      fromName: row.fromName,
      fromAddress: row.fromAddress,
      snippet: row.snippet,
      receivedAt: row.receivedAt,
      isUnread: row.isUnread,
      // Recency is the whole ranking for a list; a score would be theatre.
      score: 0,
    }));
  }
}

export type ListKind = 'today' | 'unread' | 'urgent';

function listFilter(kind: ListKind): Prisma.EmailMessageWhereInput {
  switch (kind) {
    case 'unread':
      return { isUnread: true, isArchived: false };

    case 'today':
      // Midnight UTC, not the user's midnight. Honest about what it is: the
      // per-user version needs their timezone threaded through, and guessing
      // would make "today" quietly wrong for half the world. See docs/status.md.
      return { receivedAt: { gte: startOfUtcDay() } };

    case 'urgent':
      return {
        isArchived: false,
        analysis: { priority: { in: ['urgent', 'high'] } },
      };
  }
}

function startOfUtcDay(): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

interface SearchRow {
  id: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  snippet: string;
  received_at: Date;
  is_unread: boolean;
  /** Postgres `numeric` arrives as a Decimal, not a number. */
  score: unknown;
}

function toHit(row: SearchRow): SearchHit {
  return {
    emailMessageId: row.id,
    subject: row.subject,
    fromName: row.from_name,
    fromAddress: row.from_address,
    snippet: row.snippet,
    receivedAt: row.received_at,
    isUnread: row.is_unread,
    // Postgres `numeric` arrives as a Decimal instance, not a number.
    score: Number(String(row.score)),
  };
}

/**
 * A pgvector literal, built only from validated numbers.
 *
 * This is the one place in the codebase where values are interpolated into SQL
 * text rather than bound, and it is worth being explicit about why: the string
 * this produces *is* passed as a bind parameter (`${literal}::vector`), so the
 * interpolation happens inside a value Postgres never parses as SQL. The
 * validation below is therefore about data integrity rather than injection — a
 * `NaN` reaches the column as something that silently never matches, and a
 * wrong-length array is a dimension error at write time on a code path that only
 * runs in the background.
 */
export function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError(
      'BAD_REQUEST',
      `Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`,
    );
  }

  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AppError('BAD_REQUEST', 'Embedding contained a non-finite value');
    }
  }

  return `[${vector.join(',')}]`;
}
