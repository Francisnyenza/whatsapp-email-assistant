import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { jobKey } from '@wea/shared';

/**
 * Does BullMQ actually accept the job ids this codebase builds.
 *
 * Every custom id used to be written as `` `send:${draftId}` ``, and BullMQ
 * rejects a colon in a custom id — it is how BullMQ namespaces its own Redis
 * keys. Sixteen call sites did it, covering every path the product has: inbound
 * WhatsApp, Gmail and Graph push, outbound send, analysis, embedding,
 * notification, digests, reminders, media, polling. Every one threw at enqueue,
 * every caller logged and continued, and the webhook controllers returned the
 * 200 that stops Meta and Google redelivering. The system accepted work,
 * reported success, and did nothing.
 *
 * Every existing test stubs the queue producer, so all of them asserted that
 * `enqueue` was *called* with certain arguments. That is a different question
 * from whether BullMQ would take them, and only the second one was ever wrong.
 * This test exists to ask the second question, which is why it needs real Redis
 * rather than a mock — a mock here would reproduce the original mistake exactly.
 */

const REDIS_URL = process.env['REDIS_URL'];
const runnable = Boolean(REDIS_URL);

describe.skipIf(!runnable)('job ids BullMQ will accept', () => {
  let queue: Queue;

  beforeAll(() => {
    const url = new URL(REDIS_URL!);
    queue = new Queue('jobkey-spec', {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        maxRetriesPerRequest: null,
      },
    });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it('rejects a colon, which is the bug this file exists for', async () => {
    // Pinning the constraint itself. If a future BullMQ relaxes it, this fails
    // and the reason for `jobKey` can be revisited deliberately rather than
    // discovered by someone reintroducing template literals.
    await expect(
      queue.add('probe', {}, { jobId: 'send:7b3f0c1e-0000-4000-8000-000000000000' }),
    ).rejects.toThrow(/Custom Id cannot contain/i);
  });

  it('accepts what jobKey builds for a send', async () => {
    const id = jobKey('send', '7b3f0c1e-0000-4000-8000-000000000000');
    const job = await queue.add('probe', {}, { jobId: id });

    expect(job.id).toBe(id);
  });

  it.each([
    ['inbound WhatsApp', () => jobKey('wa', 'wamid.HBgLMTU1NTAxMDAwMDAVAgASGBQ')],
    ['a delivery status', () => jobKey('wast', 'wamid.ABC', 'delivered')],
    ['a Gmail push', () => jobKey('ingest', '7b3f0c1e-0000-4000-8000-000000000000', 987654)],
    ['a watch renewal', () => jobKey('watch', '7b3f0c1e-0000-4000-8000-000000000000', 471234)],
    [
      'a digest reopen',
      () => jobKey('digest', '7b3f0c1e-0000-4000-8000-000000000000', 'reopen', 12),
    ],
    ['a reminder', () => jobKey('notify', 'reminder', '7b3f0c1e-0000-4000-8000-000000000000')],
  ])('accepts %s', async (_name, build) => {
    // One per real call site shape, because the inputs differ in character: a
    // `wamid` carries dots, ids carry dashes, buckets are numbers.
    const id = build();
    const job = await queue.add('probe', {}, { jobId: id });

    expect(job.id).toBe(id);
  });

  it('still deduplicates, which is the only reason for a custom id', async () => {
    // A job id is a deduplication key. Meta redelivers a webhook it thinks
    // failed, and the second delivery must not produce a second reply.
    const id = jobKey('wa', 'wamid.DUPLICATE');

    const first = await queue.add('probe', { n: 1 }, { jobId: id });
    const second = await queue.add('probe', { n: 2 }, { jobId: id });

    expect(second.id).toBe(first.id);
    expect(await queue.getJobCountByTypes('waiting')).toBeGreaterThan(0);
    // The second add did not create a new job, so the payload is still the first.
    expect((await queue.getJob(id))?.data).toEqual({ n: 1 });
  });
});

describe('building a job id', () => {
  it('keeps parts distinguishable', () => {
    expect(jobKey('send', 'abc')).toBe('send~abc');
    expect(jobKey('digest', 'u1', 'reopen', 7)).toBe('digest~u1~reopen~7');
  });

  it('replaces anything outside a safe set', () => {
    // Provider-supplied strings end up here — a Gmail history id, a `wamid` —
    // and an id that is safe to paste into a log or a dashboard costs nothing.
    expect(jobKey('wa', 'a:b c/d')).toBe('wa~a_b_c_d');
  });

  it('leaves dots and dashes alone, since ids are full of them', () => {
    expect(jobKey('wa', 'wamid.ABC-123')).toBe('wa~wamid.ABC-123');
  });

  it('refuses an empty part rather than making every job of a kind collide', () => {
    expect(() => jobKey('send', '')).toThrow(/empty part/);
    expect(() => jobKey()).toThrow(/at least one part/);
  });
});
