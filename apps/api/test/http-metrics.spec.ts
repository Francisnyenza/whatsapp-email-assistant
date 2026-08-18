import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpMetrics,
  DURATION_BUCKETS,
  MAX_SERIES,
  OVERFLOW_ROUTE,
  UNMATCHED_ROUTE,
  METRICS_CONTENT_TYPE,
  methodLabel,
  routeLabel,
} from '../src/health/http-metrics.js';
import {
  HttpMetricsMiddleware,
  CLIENT_CLOSED_STATUS,
} from '../src/health/http-metrics.middleware.js';
import { MetricsController } from '../src/health/metrics.controller.js';

/**
 * The API's `/metrics`.
 *
 * Two things are being defended here and they pull in opposite directions.
 *
 * The first is that the numbers are true: a request that was abandoned is not a
 * fast success, a 404 is not invisible, and the histogram's `+Inf` bucket
 * agrees with its count. The second is that the endpoint cannot itself become
 * the outage — every label on it is bounded, including the two an anonymous
 * caller chooses, which are the method token and the path.
 *
 * The exposition format is asserted as text rather than through a parser,
 * because the text *is* the contract with Prometheus.
 */

/** Reads every sample line for one metric out of a scrape. */
function samples(body: string, metric: string): string[] {
  return body.split('\n').filter((line) => line.startsWith(`${metric}{`));
}

/** The value of a single fully-qualified series, or undefined. */
function valueOf(body: string, series: string): number | undefined {
  const line = body.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : undefined;
}

describe('route labels are templates, not paths', () => {
  it('folds every id on a parameterised route into one series', () => {
    const metrics = new HttpMetrics();

    // The whole reason this metric is safe to export. Two hundred accounts is
    // two hundred series if the raw path is recorded, and it never stops
    // growing — one more per account, forever.
    for (let i = 0; i < 200; i += 1) {
      metrics.record({ method: 'GET', route: '/accounts/:id', status: 200, seconds: 0.01 });
    }

    expect(samples(metrics.render(), 'wea_http_requests_total')).toEqual([
      'wea_http_requests_total{method="GET",route="/accounts/:id",status="200"} 200',
    ]);
  });

  it('reads the template Express registered, not the URL requested', () => {
    expect(routeLabel({ baseUrl: '', route: { path: '/accounts/:id' } })).toBe('/accounts/:id');
  });

  it('prefixes the mount point, so two routers with the same path stay distinct', () => {
    expect(routeLabel({ baseUrl: '/oauth/google', route: { path: '/callback' } })).toBe(
      '/oauth/google/callback',
    );
  });

  it('gives every unmatched path one label', () => {
    // A scanner sweeping ten thousand URLs would otherwise mint ten thousand
    // series. Which path was probed is in the access log; it does not belong in
    // a label an anonymous caller writes.
    expect(routeLabel({ path: '/wp-admin/setup-config.php' })).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ baseUrl: '', route: undefined, path: '/.env' })).toBe(UNMATCHED_ROUTE);
  });

  it('drops the trailing slash so /health/ and /health share a series', () => {
    expect(routeLabel({ route: { path: '/health/' } })).toBe('/health');
  });

  it('keeps the root path as a path', () => {
    expect(routeLabel({ route: { path: '/' } })).toBe('/');
  });

  it('truncates a route long enough to be a label attack', () => {
    expect(
      routeLabel({ baseUrl: '/x'.repeat(400), route: { path: '/y' } }).length,
    ).toBeLessThanOrEqual(120);
  });
});

describe('method labels are bounded', () => {
  it('keeps the methods the API actually serves', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'PUT']) {
      expect(methodLabel(method)).toBe(method);
    }
  });

  it('normalises case', () => {
    expect(methodLabel('get')).toBe('GET');
  });

  it('folds an arbitrary method token', () => {
    // The method comes off the request line unvalidated: any token is a legal
    // HTTP request, and each distinct one would otherwise be a new series.
    expect(methodLabel('PROPFIND')).toBe('other');
    expect(methodLabel('  ZZZ')).toBe('other');
    expect(methodLabel('')).toBe('other');
  });
});

describe('the exposition format', () => {
  let metrics: HttpMetrics;

  beforeEach(() => {
    metrics = new HttpMetrics();
  });

  it('declares a type for every metric it emits', () => {
    metrics.record({ method: 'GET', route: '/health/live', status: 200, seconds: 0.002 });
    const body = metrics.render();

    expect(body).toContain('# TYPE wea_http_requests_total counter');
    expect(body).toContain('# TYPE wea_http_request_duration_seconds histogram');
    expect(body).toContain('# TYPE wea_api_up gauge');
  });

  it('ends with a newline', () => {
    // Some parsers silently drop the last sample without it.
    expect(metrics.render().endsWith('\n')).toBe(true);
  });

  it('renders cumulative buckets', () => {
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 0.004 });
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 0.3 });
    const body = metrics.render();

    const labels = 'method="GET",route="/a"';
    // 0.004 falls in the first bucket and is counted in every bucket above it.
    expect(valueOf(body, `wea_http_request_duration_seconds_bucket{${labels},le="0.005"}`)).toBe(1);
    expect(valueOf(body, `wea_http_request_duration_seconds_bucket{${labels},le="0.25"}`)).toBe(1);
    expect(valueOf(body, `wea_http_request_duration_seconds_bucket{${labels},le="0.5"}`)).toBe(2);
  });

  it('makes +Inf equal the count', () => {
    // Mandatory, and a histogram whose +Inf disagrees with its count is
    // rejected by the scraper rather than partially accepted.
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 45 });
    const body = metrics.render();
    const labels = 'method="GET",route="/a"';

    expect(valueOf(body, `wea_http_request_duration_seconds_bucket{${labels},le="+Inf"}`)).toBe(1);
    expect(valueOf(body, `wea_http_request_duration_seconds_count{${labels}}`)).toBe(1);
    // 45s is past the last finite bucket, so it appears only in +Inf.
    expect(valueOf(body, `wea_http_request_duration_seconds_bucket{${labels},le="10"}`)).toBe(0);
  });

  it('sums observed time', () => {
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 0.25 });
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 0.75 });

    expect(
      valueOf(metrics.render(), 'wea_http_request_duration_seconds_sum{method="GET",route="/a"}'),
    ).toBe(1);
  });

  it('counts one series per status, so an error rate is expressible', () => {
    metrics.record({ method: 'POST', route: '/webhooks/whatsapp', status: 200, seconds: 0.01 });
    metrics.record({ method: 'POST', route: '/webhooks/whatsapp', status: 500, seconds: 0.01 });
    metrics.record({ method: 'POST', route: '/webhooks/whatsapp', status: 500, seconds: 0.01 });
    const body = metrics.render();

    expect(
      valueOf(
        body,
        'wea_http_requests_total{method="POST",route="/webhooks/whatsapp",status="200"}',
      ),
    ).toBe(1);
    expect(
      valueOf(
        body,
        'wea_http_requests_total{method="POST",route="/webhooks/whatsapp",status="500"}',
      ),
    ).toBe(2);
  });

  it('shares one histogram across the statuses of a route', () => {
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: 0.01 });
    metrics.record({ method: 'GET', route: '/a', status: 500, seconds: 0.01 });

    expect(
      valueOf(metrics.render(), 'wea_http_request_duration_seconds_count{method="GET",route="/a"}'),
    ).toBe(2);
  });

  it('escapes a quote in a label rather than emitting invalid text', () => {
    metrics.record({ method: 'GET', route: '/a"b', status: 200, seconds: 0.01 });

    expect(metrics.render()).toContain('route="/a\\"b"');
  });

  it('survives a non-finite duration', () => {
    // A clock that goes backwards produces one, and a NaN in the output fails
    // the scrape for every metric on the endpoint, not just this one.
    metrics.record({ method: 'GET', route: '/a', status: 200, seconds: Number.NaN });

    expect(metrics.render()).not.toContain('NaN');
  });

  it('reports itself up', () => {
    expect(metrics.render()).toContain('wea_api_up 1');
  });
});

describe('the cardinality ceiling', () => {
  it('folds new label sets past the cap instead of dropping the request', () => {
    const metrics = new HttpMetrics();

    for (let i = 0; i < MAX_SERIES + 50; i += 1) {
      metrics.record({ method: 'GET', route: `/generated-${i}`, status: 200, seconds: 0.01 });
    }

    const body = metrics.render();
    const lines = samples(body, 'wea_http_requests_total');

    // The cap holds, plus the one overflow series everything else folds into.
    expect(lines.length).toBe(MAX_SERIES + 1);
    expect(
      valueOf(body, `wea_http_requests_total{method="GET",route="${OVERFLOW_ROUTE}",status="200"}`),
    ).toBe(50);

    // And the total is still the truth. Dropping the sample would understate
    // traffic during precisely the incident that blew cardinality up.
    const total = lines.reduce(
      (sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)),
      0,
    );
    expect(total).toBe(MAX_SERIES + 50);
  });

  it('keeps recording a route that already has a series once the cap is reached', () => {
    const metrics = new HttpMetrics();
    metrics.record({ method: 'GET', route: '/health/ready', status: 200, seconds: 0.01 });

    for (let i = 0; i < MAX_SERIES; i += 1) {
      metrics.record({ method: 'GET', route: `/generated-${i}`, status: 200, seconds: 0.01 });
    }
    metrics.record({ method: 'GET', route: '/health/ready', status: 200, seconds: 0.01 });

    expect(
      valueOf(
        metrics.render(),
        'wea_http_requests_total{method="GET",route="/health/ready",status="200"}',
      ),
    ).toBe(2);
  });
});

describe('the middleware, against a real Express app', () => {
  let metrics: HttpMetrics;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    metrics = new HttpMetrics();
    const middleware = new HttpMetricsMiddleware(metrics);
    const app = express();

    // Mounted ahead of the router, which is what lets it see a request that
    // matches nothing.
    app.use((req, res, next) => middleware.use(req, res, next));
    app.get('/accounts/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.post('/boom', (_req, res) => {
      res.status(500).json({ error: 'x' });
    });
    app.get('/metrics', (_req, res) => {
      res.status(200).send(metrics.render());
    });

    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // `close` alone waits for undici's keep-alive sockets to time out, which
    // adds seconds per test to a suite that has already finished.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('records the template Express matched', async () => {
    await fetch(`${base}/accounts/1a2b3c`);
    await fetch(`${base}/accounts/zzzzzz`);

    expect(
      valueOf(
        metrics.render(),
        'wea_http_requests_total{method="GET",route="/accounts/:id",status="200"}',
      ),
    ).toBe(2);
  });

  it('records a request that matched no route', async () => {
    // The reason this is middleware and not a Nest interceptor: an interceptor
    // runs inside a matched handler and would never see this at all.
    await fetch(`${base}/nope`);

    expect(
      valueOf(
        metrics.render(),
        `wea_http_requests_total{method="GET",route="${UNMATCHED_ROUTE}",status="404"}`,
      ),
    ).toBe(1);
  });

  it('records the status the handler set', async () => {
    await fetch(`${base}/boom`, { method: 'POST' });

    expect(
      valueOf(
        metrics.render(),
        'wea_http_requests_total{method="POST",route="/boom",status="500"}',
      ),
    ).toBe(1);
  });

  it('does not measure the scrape itself', async () => {
    // Prometheus hits this every fifteen seconds from every replica. Counted,
    // it would be most of the traffic on a quiet API, and the request-rate
    // panel would be the monitoring system watching itself.
    await fetch(`${base}/metrics`);

    expect(metrics.render()).not.toContain('route="/metrics"');
  });

  it('records a duration', async () => {
    await fetch(`${base}/accounts/1`);

    const sum = valueOf(
      metrics.render(),
      'wea_http_request_duration_seconds_sum{method="GET",route="/accounts/:id"}',
    );
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThan(5);
  });

  it('counts a request once, not once per listener', async () => {
    await fetch(`${base}/accounts/1`);
    await fetch(`${base}/accounts/2`);
    await fetch(`${base}/accounts/3`);

    expect(
      valueOf(
        metrics.render(),
        'wea_http_request_duration_seconds_count{method="GET",route="/accounts/:id"}',
      ),
    ).toBe(3);
  });
});

describe('a request the client abandoned', () => {
  it('is recorded as 499, not as the status that was never sent', async () => {
    const metrics = new HttpMetrics();
    const middleware = new HttpMetricsMiddleware(metrics);
    const app = express();

    app.use((req, res, next) => middleware.use(req, res, next));
    // Never responds. The client gives up; `finish` never fires, `close` does.
    app.get('/hang', () => {});

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    const port = (server.address() as AddressInfo).port;

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/hang`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await request.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Recording `res.statusCode` here would say 200: it is the default, and
    // nothing overwrote it. The requests users gave up waiting on would then be
    // the ones the dashboard shows as the successes.
    expect(
      valueOf(
        metrics.render(),
        `wea_http_requests_total{method="GET",route="/hang",status="${CLIENT_CLOSED_STATUS}"}`,
      ),
    ).toBe(1);

    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});

describe('the controller', () => {
  it('returns the exposition text, not an object', () => {
    // Nest serializes a returned object as JSON whatever the declared content
    // type says, and a scrape of JSON is a parse error for the whole endpoint.
    const body = new MetricsController(new HttpMetrics()).scrape();

    expect(typeof body).toBe('string');
    expect(body).toContain('# TYPE wea_api_up gauge');
  });

  it('declares the content type Prometheus expects', () => {
    expect(METRICS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});

describe('the bucket set', () => {
  it('is ascending, which the format requires', () => {
    expect([...DURATION_BUCKETS]).toEqual([...DURATION_BUCKETS].sort((a, b) => a - b));
  });
});
