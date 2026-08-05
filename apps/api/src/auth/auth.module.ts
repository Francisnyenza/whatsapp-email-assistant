import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { AuthGuard } from './auth.guard.js';
import { PrismaService } from '../common/prisma.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, TokenService, AuthGuard, PrismaService],
  exports: [TokenService, AuthGuard, SessionService],
})
export class AuthModule {}
