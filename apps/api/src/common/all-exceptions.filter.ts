import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '@wea/shared';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * The single place an error becomes a response.
 *
 * The rule it enforces: **the client sees `publicMessage`, the logs see
 * everything.** An AppError carries both, and letting the internal message reach
 * a response is how stack traces and record ids end up in someone's browser.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject('LOGGER') private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Correlates the opaque response with the detailed log line, so support can
    // find the cause from what the user reports.
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();

    if (AppError.isAppError(exception)) {
      this.logger.warn(
        {
          event: 'request.failed',
          requestId,
          code: exception.code,
          path: req.path,
          message: exception.message,
          context: exception.context,
        },
        'Request failed',
      );
      res.status(exception.statusCode).json(exception.toJSON(requestId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      this.logger.warn({ event: 'request.http_error', requestId, status, path: req.path });
      res.status(status).json({
        error: { code: 'BAD_REQUEST', message: exception.message, requestId },
      });
      return;
    }

    // Unknown failure: log the whole thing, tell the client nothing.
    this.logger.error(
      { event: 'request.unhandled', requestId, path: req.path, err: exception },
      'Unhandled exception',
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId },
    });
  }
}
