/**
 * Queue depth, in the format Prometheus scrapes.
 *
 * Hand-rolled rather than `prom-client`, and the reason is proportion. That
 * library exists to manage a registry of counters, histograms and summaries
 * with label cardinality and default process metrics; what this exports is a
 * handful of gauges read fresh on every scrape, from numbers the worker already
 * computes for its readiness check. The exposition format for that is a dozen
 * lines and a well-specified one, and a dependency is a thing to keep patched.
 *
 * Gauges rather than counters, deliberately. A queue depth is a level, not a
 * total — it goes down as well as up — and exporting it as a counter would make
 * `rate()` produce nonsense at every drain.
 *
 * What this does *not* do is keep state between scrapes. There is no in-process
 * accumulation, so a restarted worker exports the truth immediately rather than
 * a series that resets to zero, and two replicas scraped separately do not
 * double-count: both read the same Redis and report the same depth, which is
 * what the alert wants — a backlog is a property of the queue, not of the pod.
 */

/** Escapes per the exposition format: backslash, newline, and quote in labels. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Renders queue depths.
 *
 * One metric with a `queue` label rather than one metric per queue, so a new
 * queue appears in the alert without anyone editing the alert — a rule written
 * against `wea_queue_depth{queue=~".+"}` covers whatever exists.
 */
export function renderMetrics(depths: Record<string, number>): string {
  const lines = [
    '# HELP wea_queue_depth Jobs waiting in each BullMQ queue.',
    '# TYPE wea_queue_depth gauge',
  ];

  // Sorted so a diff between two scrapes is readable by a person. Prometheus
  // does not care about order.
  for (const queue of Object.keys(depths).sort()) {
    const value = depths[queue];

    // A non-finite value would be scraped as a parse error for the whole
    // endpoint, taking every other metric with it. Skipping one bad series
    // keeps the rest legible.
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;

    lines.push(`wea_queue_depth{queue="${escapeLabel(queue)}"} ${value}`);
  }

  lines.push('# HELP wea_worker_up Always 1. Presence is the signal.');
  lines.push('# TYPE wea_worker_up gauge');
  lines.push('wea_worker_up 1');

  // A trailing newline is required by the format; without it the last sample is
  // silently dropped by some parsers.
  return `${lines.join('\n')}\n`;
}

/** The content type Prometheus expects. A wrong one is scraped as an error. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
