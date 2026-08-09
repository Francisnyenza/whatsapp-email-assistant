import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@wea/shared';
import { AuthGuard } from '../auth/auth.guard.js';
import { AccountsService, type ConnectedAccount } from './accounts.service.js';
import { PreferencesService, type Preferences } from './preferences.service.js';

/**
 * What the settings screen talks to.
 *
 * Everything is behind `AuthGuard`, and every handler scopes on `req.user!.id`
 * rather than on anything in the path — an `accountId` in a URL is a number an
 * attacker chooses, and row-level security is the second lock rather than the
 * first.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly preferences: PreferencesService,
  ) {}

  @Get('accounts')
  list(@Req() req: Request): Promise<ConnectedAccount[]> {
    return this.accounts.list(req.user!.id);
  }

  /**
   * Removes a mailbox.
   *
   * The id is scoped to the caller inside the service, so a guessed id belonging
   * to someone else resolves to nothing rather than to their mailbox.
   */
  @Delete('accounts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(@Req() req: Request, @Param('id') id: string): Promise<void> {
    if (!UUID.test(id)) {
      // Refused before it reaches a query. Not for safety — the query is
      // parameterised — but because a malformed id is a client bug, and a 404
      // for it would send someone looking for a mailbox that never existed.
      throw new AppError('BAD_REQUEST', 'Invalid account id');
    }

    await this.accounts.disconnect(req.user!.id, id);
  }

  @Get('preferences')
  getPreferences(@Req() req: Request): Promise<Preferences> {
    return this.preferences.get(req.user!.id);
  }

  /** Partial: a settings screen that PUTs everything races with its own tabs. */
  @Patch('preferences')
  updatePreferences(@Req() req: Request, @Body() body: unknown): Promise<Preferences> {
    return this.preferences.update(req.user!.id, body);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
