import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { AuthGuard } from './auth.guard.js';
import { MfaGuard } from './mfa.guard.js';
import { TwoFactorService } from './two-factor.service.js';
import { PrismaService } from '../common/prisma.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    TokenService,
    TwoFactorService,
    AuthGuard,
    MfaGuard,
    PrismaService,
  ],
  exports: [TokenService, AuthGuard, MfaGuard, SessionService],
})
export class AuthModule {}
