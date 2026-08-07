import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildText, buildNewEmailTemplate } from '@wea/whatsapp';
import { OutboundService } from '../src/services/outbound.service.js';

/**
 * The window check.
 *
 * Not a formality: outside Meta's 24-hour customer service window a free-form
 * message is accepted by the API and then silently dropped. The failure mode is
 * not an error, it is a user who never hears back and no record anywhere of
 * why — which is exactly why the one exception is narrow and named.
 */

const CLOSED = new Date(Date.now() - 25 * 3_600_000);
const OPEN = new Date();

describe('sending outside the window', () => {
  let outbound: OutboundService;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    outbound = new OutboundService(
      {
        env: {
          WHATSAPP_PHONE_NUMBER_ID: '1',
          WHATSAPP_ACCESS_TOKEN: 'x',
          WHATSAPP_API_VERSION: 'v21.0',
        },
      } as never,
      { recordDelivery: vi.fn() } as never,
      logger as never,
    );
  });

  const send = (payload: unknown, lastInboundAt: Date, allowOutsideWindow?: boolean) =>
    outbound.reply({
      userId: 'user-1',
      phoneNumber: '+254700000000',
      payload: payload as never,
      kind: 'notification',
      lastInboundAt,
      ...(allowOutsideWindow === undefined ? {} : { allowOutsideWindow }),
    });

  it('refuses a free-form payload past the window', async () => {
    // No throw: there is nothing useful to do, and inventing an answer would be
    // worse than silence. But it is logged at error, because reaching here in a
    // reply path means something upstream is wrong.
    await send(buildText('hello'), CLOSED);

    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a free-form payload even when the exception is set', async () => {
    // The flag exists for templates. Anything else sent under it would be
    // accepted by the API and dropped, which is worse than an error because
    // nothing anywhere records that the user was never told.
    await expect(send(buildText('hello'), CLOSED, true)).rejects.toThrow();
  });

  it('accepts a template under the exception', async () => {
    const template = buildNewEmailTemplate({
      fromAddress: 'sarah@acme.com',
      subject: 'Q3 report',
    });

    // The send itself reaches a stubbed HTTP client and fails; what matters is
    // that it was not refused by the window check first.
    await send(template, CLOSED, true).catch(() => undefined);

    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'outbound.window_closed' }),
      expect.anything(),
    );
  });

  it('does not require the exception inside the window', async () => {
    await send(buildText('hello'), OPEN).catch(() => undefined);

    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'outbound.window_closed' }),
      expect.anything(),
    );
  });
});
