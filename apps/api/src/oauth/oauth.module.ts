import { Module } from '@nestjs/common';
import { GoogleOAuthController } from './google.controller.js';
import { AccountLinkingService } from './account-linking.service.js';
import { PrismaService } from '../common/prisma.service.js';

@Module({
  controllers: [GoogleOAuthController],
  providers: [AccountLinkingService, PrismaService],
})
export class OAuthModule {}
