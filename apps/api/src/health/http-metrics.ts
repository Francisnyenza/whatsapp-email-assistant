import { Injectable } from '@nestjs/common';

/**
 * What the API is actually doing, in the format Prometheus scrapes.
 *
 * The worker has exported queue depth since Phase 11; the API has exported
 * nothing, which meant its latency and its error rate were visible only by
 * reading log lines. `WeaApiDown` fires when zero replicas are available —
 * every failure short of that (a provider timing out inside an OAuth callback,
 * a webhook returning 500 to Meta on every delivery, a route that got slow) was
 * a condition the alerts could not see at all.
 *
 * Hand-rolled rather than `prom-client`, for the same reason the worker's is:
 * a counter and a histogram in the exposition format are about eighty lines of
 * well-specified text, and a dependency is a thing to keep patched. The format
 * is the contract, and it is the format that is tested.
 *
 * Unlike the worker's gauges, this **does** keep state between scrapes, because
 * a request count is a total rather than a level. That is what a counter is
 * for, and Prometheus already understands that a process restart resets one —
 * `rate()` detects the reset and does not report a negative spike.
 */

/**
 * The Prometheus default set, unchanged.
 *
 * Deliberately not tuned to what this API currently does. Buckets are the one
 * histogram decision that cannot be revised retroactively — changing them
 * discards the comparability of everything recorded before the change — and the
 * default set spans 5 ms to 10 s, which covers both a health probe and an OAuth
 * callback waiting on Google.
 */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * The ceiling on distinct label combinations, per metric.
 *
 * Cardinality is how a metrics endpoint takes down the monitoring system that
 * scrapes it, and the input here is partly attacker-controlled: a request line
 * carries an arbitrary method token, and an unmatched path is whatever was
 * asked for. Both are folded to fixed labels below, so this cap should never be
 * reached — it is the backstop for the case where that reasoning is wrong.
 */
export const MAX_SERIES = 500;

/** Requests past the cap are counted here rather than dropped. See `record`. */
export const OVERFLOW_ROUTE = 'overflow';

/** Anything else is folded to `other`, because the method token is arbitrary text. */
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** A path that matched no route. One label for all of them — see `routeLabel`. */
export const UNMATCHED_ROUTE = 'unmatched';

/** Long enough for the deepest route this app registers, short enough to bound a label. */
const MAX_ROUTE_CHARS = 120;

export interface HttpObservation {
  method: string;
  /** A route **template** — `/accounts/:id`, never `/accounts/7b3f…`. */
  route: string;
  status: number;
  /** Wall time from the first byte of the request to the last of the response. */
  seconds: number;
}

interface Counter {
  method: string;
  route: string;
  status: number;
  count: number;
}

interface Histogram {
  method: string;
  route: string;
  /** Per-bucket, non-cumulative. Made cumulative at render time. */
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * Folds an arbitrary request method to a bounded label.
 *
 * The method arrives in the request line and is not validated by anything
 * upstream, so `curl -X $(head -c 200 /dev/urandom | base64)` is a valid HTTP
 * request and would otherwise be a new time series.
 */
export function methodLabel(raw: string): string {
  const upper = (raw ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'other';
}

/**
 * Turns an Express request into a route **template**.
 *
 * This is the decision the whole metric rests on. `/accounts/7b3f…` and
 * `/accounts/9a12…` are the same route and must share one series; recording the
 * raw path would mean a new series per account, per user, forever — which is
 * the classic way an exporter becomes the outage.
 *
 * `route.path` is populated by Express once a layer matches, and it is the
 * pattern as registered (`/accounts/:id`), not the URL as requested. When
 * nothing matched there is no template to report and the path is
 * attacker-chosen, so every 404 shares one fixed label. That loses which path
 * was probed — the access log has that — and keeps a scanner sweeping ten
 * thousand URLs from creating ten thousand series.
 */
export function routeLabel(req: {
  baseUrl?: string;
  route?: { path?: string } | undefined;
  path?: string;
}): string {
  const pattern = req.route?.path;
  if (typeof pattern !== 'string' || pattern.length === 0) return UNMATCHED_ROUTE;

  const joined = `${req.baseUrl ?? ''}${pattern}`;
  const trimmed = joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
  const label = trimmed.length === 0 ? '/' : trimmed;

  return label.length > MAX_ROUTE_CHARS ? label.slice(0, MAX_ROUTE_CHARS) : label;
}

/** Escapes per the exposition format: backslash, newline, and quote in labels. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Renders a float the way the exposition format wants it.
 *
 * `1e-7` is legal and `0.0000001` is legal; what is not legal is `NaN` from a
 * clock that went backwards, and one unparseable sample fails the scrape for
 * every metric on the endpoint.
 */
function sample(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

@Injectable()
export class HttpMetrics {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  /**
   * Records one finished request.
   *
   * Never throws. This is called from a middleware on the response's `close`
   * event, where there is no request left to fail — an exception would become
   * an unhandled rejection that takes the process down, and losing the process
   * to lose a metric is the wrong trade in every direction.
   */
  record(observation: HttpObservation): void {
    const method = methodLabel(observation.method);
    const status = Number.isInteger(observation.status) ? observation.status : 0;
    const seconds = Number.isFinite(observation.seconds) ? Math.max(observation.seconds, 0) : 0;

    // Past the cap the labels are folded rather than the sample discarded. A
    // dropped sample would make the request-rate panel understate traffic
    // during precisely the incident that blew the cardinality up, which is the
    // moment the panel is being read.
    const route = this.routeWithinCap(method, observation.route, status);

    const counterKey = `${method}\u0000${route}\u0000${status}`;
    const counter = this.counters.get(counterKey);
    if (counter) {
      counter.count += 1;
    } else {
      this.counters.set(counterKey, { method, route, status, count: 1 });
    }

    const histogramKey = `${method}\u0000${route}`;
    let histogram = this.histograms.get(histogramKey);
    if (!histogram) {
      histogram = { method, route, buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.histograms.set(histogramKey, histogram);
    }

    histogram.count += 1;
    histogram.sum += seconds;

    // Non-cumulative here, summed at render. Storing it cumulatively would mean
    // touching every bucket at or above the observation on each request.
    const index = DURATION_BUCKETS.findIndex((upper) => seconds <= upper);
    if (index >= 0) histogram.buckets[index]! += 1;
  }

  /**
   * Whether this label set may have a series of its own, or must be folded.
   *
   * Checked against the counter map, which is the wider of the two: a route
   * that already has a counter for one status is not new, so a 500 appearing on
   * a route that has been serving 200s is never the sample that gets folded.
   */
  private routeWithinCap(method: string, route: string, status: number): string {
    if (this.counters.has(`${method}\u0000${route}\u0000${status}`)) return route;
    if (this.counters.size < MAX_SERIES) return route;
    return OVERFLOW_ROUTE;
  }

  /**
   * The exposition text.
   *
   * Sorted, so a diff between two scrapes is readable by a person. Prometheus
   * does not care about the order.
   */
  render(): string {
    const lines: string[] = [];

    lines.push('# HELP wea_http_requests_total Requests the API has finished serving.');
    lines.push('# TYPE wea_http_requests_total counter');
    for (const key of [...this.counters.keys()].sort()) {
      const { method, route, status, count } = this.counters.get(key)!;
      lines.push(
        `wea_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
      );
    }

    lines.push('# HELP wea_http_request_duration_seconds Time to serve a request.');
    lines.push('# TYPE wea_http_request_duration_seconds histogram');
    for (const key of [...this.histograms.keys()].sort()) {
      const { method, route, buckets, sum, count } = this.histograms.get(key)!;
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;

      let cumulative = 0;
      for (const [index, upper] of DURATION_BUCKETS.entries()) {
        cumulative += buckets[index]!;
        lines.push(
          `wea_http_request_duration_seconds_bucket{${labels},le="${upper}"} ${cumulative}`,
        );
      }

      // `+Inf` is mandatory and must equal `_count`. A histogram missing it is
      // rejected by the scraper rather than partially accepted.
      lines.push(`wea_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${count}`);
      lines.push(`wea_http_request_duration_seconds_sum{${labels}} ${sample(sum)}`);
      lines.push(`wea_http_request_duration_seconds_count{${labels}} ${count}`);
    }

    lines.push('# HELP wea_api_up Always 1. Presence is the signal.');
    lines.push('# TYPE wea_api_up gauge');
    lines.push('wea_api_up 1');

    // A trailing newline is required by the format; without it the last sample
    // is silently dropped by some parsers.
    return `${lines.join('\n')}\n`;
  }
}

/** The content type Prometheus expects. A wrong one is scraped as an error. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
