import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { startHealthServer } from '../src/health/health.server.js';

/**
 * The worker's health listener.
 *
 * Every failure here is one Kubernetes acts on without anyone watching, which
 * is why the tests are against a real socket rather than against a handler
 * function. The two that would actually hurt: a readiness endpoint that reports
 * "degraded" behind a 200 keeps receiving work while saying it cannot do it —
 * a probe reads the status code and nothing else — and a liveness endpoint that
 * checks dependencies restarts every worker during a Redis blip, turning a
 * degradation into a cluster-wide crashloop at the moment the backlog most
 * needs consumers.
 */

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('liveness', () => {
  it('answers 200 while the process is up', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('does not touch the database or the queues', async () => {
    // The whole point. A liveness probe that checks Redis restarts every worker
    // during a Redis blip — and a restarted worker still cannot reach Redis, so
    // the restart buys nothing and costs the in-flight jobs.
    const database = vi.fn();
    const queues = vi.fn();
    const { url } = await start({ database, queues });

    await fetch(`${url}/health/live`);

    expect(database).not.toHaveBeenCalled();
    expect(queues).not.toHaveBeenCalled();
  });
});

describe('readiness', () => {
  it('answers 200 when both dependencies answer', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', queues: 'ok' },
    });
  });

  it('answers 503, not 200, when a dependency is down', async () => {
    // A body saying "degraded" behind a 200 is a worker that reports itself
    // broken and keeps being sent work, because the probe never reads the body.
    const { url } = await start({ queues: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: 'ok', queues: 'unreachable' },
    });
  });

  it('names which dependency failed', async () => {
    const { url } = await start({ database: vi.fn().mockRejectedValue(new Error('down')) });

    expect(await (await fetch(`${url}/health/ready`)).json()).toMatchObject({
      checks: { database: 'unreachable', queues: 'ok' },
    });
  });

  it('checks both even when the first fails', async () => {
    // Short-circuiting would report "database unreachable" during a Redis
    // outage and send whoever is holding the pager to the wrong system.
    const queues = vi.fn().mockResolvedValue({});
    const { url } = await start({
      database: vi.fn().mockRejectedValue(new Error('down')),
      queues,
    });

    await fetch(`${url}/health/ready`);

    expect(queues).toHaveBeenCalled();
  });

  it('reports both when both are down', async () => {
    const { url } = await start({
      database: vi.fn().mockRejectedValue(new Error('down')),
      queues: vi.fn().mockRejectedValue(new Error('down')),
    });

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      checks: { database: 'unreachable', queues: 'unreachable' },
    });
  });

  it('surfaces the failure to the logger, with the cause', async () => {
    // A pod removed from rotation with nothing in the logs is an outage nobody
    // can explain.
    const onError = vi.fn();
    const cause = new Error('ECONNREFUSED');
    const { url } = await start({ queues: vi.fn().mockRejectedValue(cause) }, onError);

    await fetch(`${url}/health/ready`);

    expect(onError).toHaveBeenCalledWith('health.redis_unreachable', cause);
  });

  it('is never cached', async () => {
    // A stale readiness answer is the one thing this endpoint must not give.
    const { url } = await start();

    expect((await fetch(`${url}/health/ready`)).headers.get('cache-control')).toBe('no-store');
  });
});

describe('the surface', () => {
  it('is two routes and nothing else', async () => {
    // Reachable from anywhere in the cluster that can route to the pod. The
    // smallest thing that answers the kubelet is the right one.
    const { url } = await start();

    for (const path of ['/', '/metrics', '/health', '/../etc/passwd', '/health/readyz']) {
      expect((await fetch(`${url}${path}`)).status, path).toBe(404);
    }
  });

  it('refuses anything that is not a GET', async () => {
    const { url } = await start();

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(`${url}/health/live`, { method })).status, method).toBe(405);
    }
  });

  it('reflects nothing back from the request', async () => {
    // A 404 that echoes the path is a reflected-content primitive in a listener
    // that has no business having one.
    const { url } = await start();

    const body = await (await fetch(`${url}/%3Cscript%3Ealert(1)%3C/script%3E`)).text();

    expect(body).not.toContain('script');
    expect(body).toBe(JSON.stringify({ error: 'not_found' }));
  });
});

describe('shutdown', () => {
  it('stops answering once closed, so a draining worker is routed away from', async () => {
    const { url } = await start();

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    await expect(fetch(`${url}/health/live`)).rejects.toThrow();
  });
});

/* --------------------------------- helpers -------------------------------- */

async function start(
  checks: Partial<{ database: () => Promise<unknown>; queues: () => Promise<unknown> }> = {},
  onError: (event: string, err: unknown) => void = () => {},
): Promise<{ url: string }> {
  // Port 0 lets the OS pick a free one, so these run in parallel with anything
  // else and never collide on a fixed number.
  server = startHealthServer({
    port: 0,
    checks: {
      database: checks.database ?? (async () => ({})),
      queues: checks.queues ?? (async () => ({})),
    },
    onError,
  });

  await new Promise<void>((resolve) => server!.once('listening', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  return { url: `http://127.0.0.1:${address.port}` };
}
