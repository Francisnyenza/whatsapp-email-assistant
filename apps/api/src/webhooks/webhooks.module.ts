import { Module } from '@nestjs/common';
import { WhatsAppWebhookController } from './whatsapp.controller.js';
import { GmailWebhookController, PubSubTokenVerifier } from './gmail.controller.js';
import { MicrosoftWebhookController } from './microsoft.controller.js';
import { PrismaService } from '../common/prisma.service.js';

@Module({
  controllers: [WhatsAppWebhookController, GmailWebhookController, MicrosoftWebhookController],
  providers: [PubSubTokenVerifier, PrismaService],
})
export class WebhooksModule {}
