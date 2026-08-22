import { Module } from '@nestjs/common';
import { GoogleOAuthController } from './google.controller.js';
import { MicrosoftOAuthController } from './microsoft.controller.js';
import { AccountLinkingService } from './account-linking.service.js';
import { PrismaService } from '../common/prisma.service.js';
import { AuditService } from '../common/audit.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [GoogleOAuthController, MicrosoftOAuthController],
  providers: [AccountLinkingService, PrismaService, AuditService],
})
export class OAuthModule {}
