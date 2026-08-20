/**
 * What the worker is actually doing, in the format Prometheus scrapes.
 *
 * Queue depth says a backlog exists. It cannot say why, and the three reasons
 * are not alike: jobs arriving faster than they finish, jobs finishing slowly,
 * or jobs failing and being retried into the same queue they came from. Those
 * want different responses — more replicas, a slow provider to chase, a bug —
 * and depth alone cannot tell them apart. A queue draining at a steady depth
 * while every job fails four times looks identical to one that is healthy.
 *
 * Everything here was already known and already logged. `startWorker` measures
 * each job's duration for its `job.completed` line and classifies every failure
 * for `job.failed` and `job.dead_lettered`. What was missing was the export,
 * not the detection — so this records at exactly those three points and adds no
 * new instrumentation to the handlers.
 *
 * Hand-rolled rather than `prom-client`, matching the API's and the queue-depth
 * exporter's reasoning: a counter and a histogram in the exposition format are
 * well-specified text, and a dependency is a thing to keep patched.
 *
 * Unlike the queue-depth gauges alongside this, it **does** keep state between
 * scrapes — deliberately. A depth is a level, read fresh from Redis on every
 * scrape so a restarted worker reports the truth immediately and two replicas
 * do not double-count. A job total is a total: it belongs to the process that
 * did the work, so two replicas *should* each report their own, and Prometheus
 * already understands that a restart resets a counter — `rate()` detects the
 * reset rather than reporting a negative spike.
 */

/**
 * Buckets for a job, which is not a request.
 *
 * The API's default set tops out at 10 s because an HTTP handler that takes
 * longer has already failed. Jobs are the opposite: an LLM call, a mailbox sync
 * over thousands of messages, or a media download are all legitimately slow, and
 * the interesting question is usually whether something normally taking two
 * seconds now takes thirty. So the range runs from 10 ms to five minutes, which
 * is past `QUEUE_DEFAULTS`' longest timeout.
 *
 * Buckets are the one histogram decision that cannot be revised retroactively —
 * changing them discards the comparability of everything recorded before — so
 * this errs wide.
 */
export const JOB_DURATION_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
] as const;

/**
 * The ceiling on distinct label combinations.
 *
 * Both labels are ours — a queue name from `QUEUE`, a job name from `JOB` —
 * so unlike the API's route label neither is attacker-influenced, and the real
 * count is around two hundred series. This is the backstop for a future where
 * someone derives a job name from a payload.
 */
export const MAX_SERIES = 400;

/** Work past the cap is counted here rather than dropped. See `record`. */
export const OVERFLOW_JOB = 'overflow';

/**
 * How a job ended.
 *
 * `failed` counts every failed attempt, `dead_lettered` only the last one —
 * they are not alternatives, and a job that exhausts four retries increments
 * `failed` four times and `dead_lettered` once. That is the pair worth having:
 * the first is the error rate, the second is the number of things actually
 * lost, and an alert on the second without the first pages far too late.
 */
export type JobOutcome = 'completed' | 'failed' | 'dead_lettered';

export interface JobObservation {
  queue: string;
  job: string;
  outcome: JobOutcome;
  /** Wall time in the handler. Absent for a dead-letter, which times nothing. */
  seconds?: number;
}

interface Counter {
  queue: string;
  job: string;
  outcome: JobOutcome;
  count: number;
}

interface Histogram {
  queue: string;
  job: string;
  /** Per-bucket, non-cumulative. Made cumulative at render time. */
  buckets: number[];
  sum: number;
  count: number;
}

/** Escapes per the exposition format: backslash, newline, and quote in labels. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Renders a float the way the exposition format wants it.
 *
 * One unparseable sample fails the scrape for every metric on the endpoint, so
 * a `NaN` from a clock that went backwards must not reach the output.
 */
function sample(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

/**
 * The counters, held for the life of the process.
 *
 * A module-level instance rather than an injected provider because
 * `startWorker` is a free function called from eight processors' `onModuleInit`,
 * and threading a dependency through all of them to reach one counter would be
 * more machinery than the thing it carries.
 */
export class JobMetrics {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  /**
   * Records one finished job.
   *
   * Never throws. It is called from the worker's completion and failure paths,
   * where an exception would become an unhandled rejection — losing the process
   * to record a metric is the wrong trade in every direction.
   */
  record(observation: JobObservation): void {
    const queue = String(observation.queue ?? '');
    // Past the cap the label is folded rather than the sample dropped. Dropping
    // would make the failure-rate panel understate during precisely the
    // incident that blew the cardinality up.
    const job = this.jobWithinCap(queue, String(observation.job ?? ''), observation.outcome);

    const counterKey = `${queue}\u0000${job}\u0000${observation.outcome}`;
    const counter = this.counters.get(counterKey);
    if (counter) {
      counter.count += 1;
    } else {
      this.counters.set(counterKey, { queue, job, outcome: observation.outcome, count: 1 });
    }

    // A dead-letter is a verdict on a job that already recorded its own
    // duration when it failed. Timing it again would count the same work twice
    // in the histogram.
    if (observation.seconds === undefined) return;

    const seconds = Number.isFinite(observation.seconds) ? Math.max(observation.seconds, 0) : 0;
    const histogramKey = `${queue}\u0000${job}`;
    let histogram = this.histograms.get(histogramKey);
    if (!histogram) {
      histogram = { queue, job, buckets: JOB_DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.histograms.set(histogramKey, histogram);
    }

    histogram.count += 1;
    histogram.sum += seconds;

    // Non-cumulative here, summed at render. Storing it cumulatively would mean
    // touching every bucket at or above the observation on each job.
    const index = JOB_DURATION_BUCKETS.findIndex((upper) => seconds <= upper);
    if (index >= 0) histogram.buckets[index]! += 1;
  }

  /**
   * Whether this label set may have a series of its own, or must be folded.
   *
   * Checked against the counter map: a job that already has a series for one
   * outcome is not new, so the first failure of a job that has been completing
   * happily is never the sample that gets folded — which is the one that
   * matters most.
   */
  private jobWithinCap(queue: string, job: string, outcome: JobOutcome): string {
    if (this.counters.has(`${queue}\u0000${job}\u0000${outcome}`)) return job;
    if (this.counters.size < MAX_SERIES) return job;
    return OVERFLOW_JOB;
  }

  /**
   * The exposition text for these two metrics.
   *
   * Sorted, so a diff between two scrapes is readable by a person. Prometheus
   * does not care about the order.
   */
  render(): string {
    const lines: string[] = [];

    lines.push('# HELP wea_jobs_total Jobs the worker has finished, by outcome.');
    lines.push('# TYPE wea_jobs_total counter');
    for (const key of [...this.counters.keys()].sort()) {
      const { queue, job, outcome, count } = this.counters.get(key)!;
      lines.push(
        `wea_jobs_total{queue="${escapeLabel(queue)}",job="${escapeLabel(job)}",outcome="${outcome}"} ${count}`,
      );
    }

    lines.push('# HELP wea_job_duration_seconds Time spent in a job handler.');
    lines.push('# TYPE wea_job_duration_seconds histogram');
    for (const key of [...this.histograms.keys()].sort()) {
      const { queue, job, buckets, sum, count } = this.histograms.get(key)!;
      const labels = `queue="${escapeLabel(queue)}",job="${escapeLabel(job)}"`;

      let cumulative = 0;
      for (const [index, upper] of JOB_DURATION_BUCKETS.entries()) {
        cumulative += buckets[index]!;
        lines.push(`wea_job_duration_seconds_bucket{${labels},le="${upper}"} ${cumulative}`);
      }

      // `+Inf` is mandatory and must equal `_count`. A histogram missing it is
      // rejected by the scraper rather than partially accepted.
      lines.push(`wea_job_duration_seconds_bucket{${labels},le="+Inf"} ${count}`);
      lines.push(`wea_job_duration_seconds_sum{${labels}} ${sample(sum)}`);
      lines.push(`wea_job_duration_seconds_count{${labels}} ${count}`);
    }

    return lines.join('\n');
  }
}

/** The one the worker records into. See the class comment for why it is here. */
export const jobMetrics = new JobMetrics();
