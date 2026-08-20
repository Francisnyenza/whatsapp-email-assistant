import { describe, it, expect } from 'vitest';
import {
  JobMetrics,
  JOB_DURATION_BUCKETS,
  MAX_SERIES,
  OVERFLOW_JOB,
} from '../src/health/job-metrics.js';
import { renderMetrics } from '../src/health/metrics.js';

/**
 * What the worker exports about its own work.
 *
 * Queue depth already said a backlog exists. It cannot say why, and the three
 * reasons want different answers: jobs arriving faster than they finish, jobs
 * finishing slowly, or jobs failing and being retried into the same queue. A
 * queue holding steady while every job fails four times looks, from depth
 * alone, exactly like a healthy one.
 *
 * The tests that matter here are the exposition-format ones. A metrics endpoint
 * fails as a unit — one unparseable sample and Prometheus discards the whole
 * scrape, taking queue depth with it — so "is this valid text" is the property
 * to hold, not "was the counter incremented".
 */

function metrics(): JobMetrics {
  return new JobMetrics();
}

/** Every sample line, ignoring HELP/TYPE and blanks. */
function samples(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('counting outcomes', () => {
  it('separates completed from failed', () => {
    const m = metrics();
    m.record({ queue: 'send', job: 'send.email', outcome: 'completed', seconds: 0.4 });
    m.record({ queue: 'send', job: 'send.email', outcome: 'completed', seconds: 0.6 });
    m.record({ queue: 'send', job: 'send.email', outcome: 'failed', seconds: 0.1 });

    const out = m.render();
    expect(out).toContain('wea_jobs_total{queue="send",job="send.email",outcome="completed"} 2');
    expect(out).toContain('wea_jobs_total{queue="send",job="send.email",outcome="failed"} 1');
  });

  it('counts every failed attempt but only the last dead-letter', () => {
    // The pair is the point. Four retries then a dead-letter is one lost job
    // and four failures; an alert on dead-letters alone pages only after the
    // retries are spent, which on the ingest queue is minutes later.
    const m = metrics();
    for (let i = 0; i < 4; i += 1) {
      m.record({ queue: 'ingest', job: 'ingest.message', outcome: 'failed', seconds: 2 });
    }
    m.record({ queue: 'ingest', job: 'ingest.message', outcome: 'dead_lettered' });

    const out = m.render();
    expect(out).toContain('outcome="failed"} 4');
    expect(out).toContain('outcome="dead_lettered"} 1');
  });

  it('does not time a dead-letter twice', () => {
    // The attempt that got there already recorded its duration. Timing the
    // verdict as well would count the same work twice in the histogram.
    const m = metrics();
    m.record({ queue: 'ai', job: 'ai.analyze', outcome: 'failed', seconds: 3 });
    m.record({ queue: 'ai', job: 'ai.analyze', outcome: 'dead_lettered' });

    expect(m.render()).toContain('wea_job_duration_seconds_count{queue="ai",job="ai.analyze"} 1');
  });
});

describe('the duration histogram', () => {
  it('is cumulative, with +Inf equal to the count', () => {
    // A histogram whose +Inf disagrees with its _count is rejected by the
    // scraper rather than partially accepted.
    const m = metrics();
    for (const seconds of [0.02, 0.3, 7, 200]) {
      m.record({ queue: 'sync', job: 'sync.mailbox', outcome: 'completed', seconds });
    }

    const out = m.render();
    expect(out).toContain(
      'wea_job_duration_seconds_bucket{queue="sync",job="sync.mailbox",le="+Inf"} 4',
    );
    expect(out).toContain('wea_job_duration_seconds_count{queue="sync",job="sync.mailbox"} 4');
    expect(out).toContain(
      'wea_job_duration_seconds_bucket{queue="sync",job="sync.mailbox",le="0.5"} 2',
    );
  });

  it('reaches past five minutes, because jobs are not requests', () => {
    // An HTTP handler taking 10 s has already failed; a mailbox sync over
    // thousands of messages taking three minutes has not. A job past the top
    // bucket lands only in +Inf, which loses the shape of exactly the tail
    // anyone is looking at.
    expect(Math.max(...JOB_DURATION_BUCKETS)).toBeGreaterThanOrEqual(300);
  });

  it('keeps a slow job out of the fast buckets', () => {
    const m = metrics();
    m.record({ queue: 'ai', job: 'ai.embed', outcome: 'completed', seconds: 45 });

    const out = m.render();
    expect(out).toContain('le="30"} 0');
    expect(out).toContain('le="60"} 1');
  });

  it('survives a duration that is not a number', () => {
    // A clock that went backwards, or a NaN from arithmetic on one. A single
    // unparseable sample fails the scrape for every metric on the endpoint.
    const m = metrics();
    m.record({ queue: 'q', job: 'j', outcome: 'completed', seconds: Number.NaN });
    m.record({ queue: 'q', job: 'j', outcome: 'completed', seconds: -5 });

    expect(m.render()).not.toMatch(/NaN|-\d/);
  });
});

describe('exposition format', () => {
  it('emits nothing but HELP, TYPE and well-formed samples', () => {
    const m = metrics();
    m.record({ queue: 'notify', job: 'notify.email', outcome: 'completed', seconds: 1.5 });
    m.record({ queue: 'notify', job: 'notify.retryDelivery', outcome: 'failed', seconds: 0.2 });

    for (const line of samples(m.render())) {
      expect(line).toMatch(/^wea_[a-z_]+(\{[^}]*\})? -?[0-9.e+]+$/);
    }
  });

  it('escapes a label that would otherwise break the line', () => {
    const m = metrics();
    m.record({ queue: 'q"uote', job: 'back\\slash', outcome: 'completed', seconds: 0 });

    const out = m.render();
    expect(out).toContain('queue="q\\"uote"');
    expect(out).toContain('job="back\\\\slash"');
  });

  it('renders an empty registry as headers alone, not as broken samples', () => {
    // The first scrape after a restart, which is a real and frequent state.
    expect(samples(metrics().render())).toEqual([]);
  });
});

describe('sharing the endpoint with queue depth', () => {
  it('produces one valid document, not two concatenated ones', () => {
    // The two exporters have opposite state semantics and were written apart.
    // What the scraper sees is a single response, and a stray blank line or a
    // missing trailing newline drops the last sample silently.
    const out = renderMetrics({ send: 3, ingest: 0 });

    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toMatch(/\n\n/);
    for (const line of samples(out)) {
      expect(line).toMatch(/^wea_[a-z_]+(\{[^}]*\})? -?[0-9.e+]+$/);
    }
  });

  it('still carries queue depth and worker liveness', () => {
    const out = renderMetrics({ send: 3 });

    expect(out).toContain('wea_queue_depth{queue="send"} 3');
    expect(out).toContain('wea_worker_up 1');
  });

  it('declares a TYPE for every metric it emits', () => {
    // A sample whose metric has no TYPE is accepted as untyped, and `rate()`
    // over an untyped counter silently returns nothing.
    const out = renderMetrics({ send: 1 });
    const declared = new Set([...out.matchAll(/^# TYPE (\S+) /gm)].map((match) => match[1]!));

    for (const line of samples(out)) {
      const name = line.split(/[{ ]/)[0]!;
      const base = name.replace(/_(bucket|sum|count)$/, '');
      expect(declared.has(base) || declared.has(name)).toBe(true);
    }
  });
});

describe('cardinality', () => {
  it('folds past the cap rather than dropping the sample', () => {
    // Dropping would make the failure-rate panel understate during precisely
    // the incident that blew the cardinality up — the moment it is being read.
    const m = metrics();
    for (let i = 0; i < MAX_SERIES + 50; i += 1) {
      m.record({ queue: 'q', job: `job-${i}`, outcome: 'completed', seconds: 0.1 });
    }

    const out = m.render();
    expect(out).toContain(`job="${OVERFLOW_JOB}"`);
    expect(samples(out).filter((l) => l.startsWith('wea_jobs_total')).length).toBeLessThanOrEqual(
      MAX_SERIES + 1,
    );
  });

  it('never folds the first failure of a job that has been succeeding', () => {
    // The sample that matters most. A job with an existing series is not new,
    // so it keeps its own labels even once the map is full.
    const m = metrics();
    m.record({ queue: 'send', job: 'send.email', outcome: 'failed', seconds: 0.1 });
    for (let i = 0; i < MAX_SERIES + 10; i += 1) {
      m.record({ queue: 'q', job: `job-${i}`, outcome: 'completed', seconds: 0.1 });
    }
    m.record({ queue: 'send', job: 'send.email', outcome: 'failed', seconds: 0.1 });

    expect(m.render()).toContain(
      'wea_jobs_total{queue="send",job="send.email",outcome="failed"} 2',
    );
  });
});
