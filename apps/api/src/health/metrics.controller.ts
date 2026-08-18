import { Controller, Get, Header } from '@nestjs/common';
import { HttpMetrics, METRICS_CONTENT_TYPE } from './http-metrics.js';

/**
 * `/metrics`, for Prometheus.
 *
 * On the main port, alongside `/health/live` and `/health/ready`, rather than
 * on a listener of its own. It is the same trust boundary those two already
 * sit behind — reachable from inside the cluster, exposing counts rather than
 * user data — and a second listener would be a second thing to secure for no
 * change in who can reach it.
 *
 * That does put it on the port an Ingress terminates, so **an Ingress must not
 * route `/metrics` from the public internet**: route names and traffic volumes
 * are not secrets worth much, but they are free reconnaissance. The same is
 * already true of `/health/ready`, which will happily tell an anonymous caller
 * that the database is unreachable.
 *
 * Returns a string, not an object. Nest serializes a returned object as JSON
 * regardless of the declared content type, and a scrape of JSON is a parse
 * error for the whole endpoint.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: HttpMetrics) {}

  @Get('metrics')
  @Header('content-type', METRICS_CONTENT_TYPE)
  // A cached scrape is a series that silently stops moving while every alert
  // written against it reads the stale value as calm.
  @Header('cache-control', 'no-store')
  scrape(): string {
    return this.metrics.render();
  }
}
