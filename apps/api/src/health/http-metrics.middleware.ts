import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { HttpMetrics, routeLabel } from './http-metrics.js';

/**
 * Times every request and hands the result to {@link HttpMetrics}.
 *
 * A middleware rather than a Nest interceptor, and the difference is the one
 * that matters here. A global interceptor runs inside a matched route handler,
 * so it never sees a request that matched nothing — which would make a 404
 * storm, the cheapest way to probe an API, the one thing the error-rate metric
 * could not show. Middleware is mounted on the Express instance ahead of the
 * router, so it sees everything.
 *
 * The cost of that choice is that the route template is not known when `use`
 * runs — Express fills `req.route` in only once a layer matches. Hence the
 * measurement is taken on the way out rather than on the way in: the listener
 * below reads the template after the response has finished, when it is there.
 */

/**
 * The status recorded when the client hung up before the response completed.
 *
 * Borrowed from nginx, which has meant exactly this by 499 for twenty years.
 * The alternative is `res.statusCode`, which for an abandoned request is
 * whatever was set before the socket closed — usually the default 200. That
 * would report the requests users gave up waiting on as the successful ones,
 * and they are the requests a latency alert exists to find.
 */
export const CLIENT_CLOSED_STATUS = 499;

/**
 * Never measured, deliberately.
 *
 * Prometheus scrapes this every fifteen seconds from every replica. On an API
 * that is quiet at three in the morning, that scrape is the overwhelming
 * majority of requests, and a request-rate panel dominated by the monitoring
 * system watching itself tells you nothing about the product. Whether the
 * scrape is happening is already answered by Prometheus's own `up` series.
 *
 * The health probes are *not* excluded, though they are frequent for the same
 * reason. A readiness probe that starts failing is a real signal, it carries
 * its own route label, and a query that wants to exclude it can say so.
 */
const NOT_MEASURED = new Set(['/metrics']);

const NANOSECONDS_PER_SECOND = 1e9;

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: HttpMetrics) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    // `close` rather than `finish`. `finish` fires only when the response was
    // written in full, so a request the client abandoned — or one cut off by a
    // shutdown mid-flight — would never be recorded at all. Those are slow by
    // definition, so dropping them biases the latency histogram towards health.
    //
    // `once`, because a listener added per request that fired twice would
    // double-count, and one that leaked would be a slow memory leak on the hot
    // path.
    res.once('close', () => {
      const route = routeLabel(req);
      if (NOT_MEASURED.has(route)) return;

      const seconds = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_SECOND;
      const status = res.writableEnded ? res.statusCode : CLIENT_CLOSED_STATUS;

      this.metrics.record({ method: req.method, route, status, seconds });
    });

    next();
  }
}
