import { createServer, type Server } from 'node:http';

/**
 * A minimal HTTP listener, so Kubernetes can tell a live worker from a wedged one.
 *
 * The worker is a standalone Nest context and deliberately serves nothing —
 * nothing calls it, it consumes queues. This is the exception, and it exists
 * because the alternative was worse: without a listener its Deployment had no
 * probes at all, which meant a worker whose Redis connection had died silently
 * stayed in the deployment consuming nothing. The options that avoid a listener
 * were all forms of lying — an `exec` probe that greps for the process only
 * restates what the kubelet already knows.
 *
 * Deliberately `node:http` rather than a second Nest application. A Nest HTTP
 * app would pull the whole request pipeline — guards, interceptors, body
 * parsing, an Express instance — into a process whose entire external surface
 * is two routes that take no input. Every one of those is a component that can
 * hold a vulnerability, in a listener that exists to answer the kubelet.
 *
 * Two endpoints, two different questions, and the distinction is the same one
 * the API makes:
 *
 *   - `/health/live` asks whether the process is alive, and checks nothing else.
 *     A liveness probe that checks Redis restarts every worker during a Redis
 *     blip, turning a degradation into a cluster-wide crashloop at the exact
 *     moment the backlog most needs consumers.
 *   - `/health/ready` asks whether this worker is doing its job, and does check
 *     dependencies — because a worker that cannot reach Postgres or Redis is
 *     not consuming anything, and that is worth surfacing.
 */

export interface HealthChecks {
  /** Resolves when the database answers. Rejects otherwise. */
  database: () => Promise<unknown>;
  /** Resolves when Redis answers. Rejects otherwise. */
  queues: () => Promise<unknown>;
}

export interface HealthServerOptions {
  port: number;
  checks: HealthChecks;
  onError?: (event: string, err: unknown) => void;
}

/**
 * Binds the listener.
 *
 * Returns the server so the caller owns its lifetime — the worker closes it on
 * shutdown alongside the queue consumers, because a process that keeps
 * answering "ready" while it drains is a process Kubernetes keeps sending work
 * to.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '';

    // Only GET, and only these two paths. Not defensiveness for its own sake:
    // this listener is reachable from anywhere in the cluster that can route to
    // the pod, and the smallest surface that answers the kubelet is the right
    // one. Anything else is a 404 with no body to reflect back.
    if (req.method !== 'GET') {
      return respond(res, 405, { error: 'method_not_allowed' });
    }

    if (url === '/health/live' || url === '/health/live/') {
      return respond(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()) });
    }

    if (url === '/health/ready' || url === '/health/ready/') {
      void ready(options).then((body) =>
        // 503 rather than 200-with-a-status-field. A readiness probe reads the
        // status code and nothing else, so a body saying "degraded" behind a
        // 200 is a worker that reports itself broken and keeps receiving work.
        respond(res, body.status === 'ok' ? 200 : 503, body),
      );
      return;
    }

    return respond(res, 404, { error: 'not_found' });
  });

  // A probe that hangs is indistinguishable from a probe that fails, but it
  // holds a socket while it waits. Both are bounded so a wedged dependency
  // cannot accumulate connections.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;

  server.on('error', (err) => options.onError?.('health.server_error', err));

  server.listen(options.port);

  return server;
}

async function ready(
  options: HealthServerOptions,
): Promise<{ status: string; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  let healthy = true;

  // Both are attempted even when the first fails. Short-circuiting would report
  // "database unreachable" during a Redis outage and send whoever is holding
  // the pager to the wrong system.
  const [database, queues] = await Promise.allSettled([
    options.checks.database(),
    options.checks.queues(),
  ]);

  if (database.status === 'fulfilled') {
    checks['database'] = 'ok';
  } else {
    checks['database'] = 'unreachable';
    healthy = false;
    options.onError?.('health.database_unreachable', database.reason);
  }

  if (queues.status === 'fulfilled') {
    checks['queues'] = 'ok';
  } else {
    checks['queues'] = 'unreachable';
    healthy = false;
    options.onError?.('health.redis_unreachable', queues.reason);
  }

  return { status: healthy ? 'ok' : 'degraded', checks };
}

function respond(
  res: {
    writeHead: (code: number, headers: Record<string, string>) => void;
    end: (b: string) => void;
  },
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    // Nothing here is cacheable and a stale readiness answer is the one thing
    // this endpoint must never give.
    'cache-control': 'no-store',
  });
  res.end(payload);
}
