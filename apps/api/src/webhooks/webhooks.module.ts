import { Module } from '@nestjs/common';
import { WhatsAppWebhookController } from './whatsapp.controller.js';
import { GmailWebhookController, PubSubTokenVerifier } from './gmail.controller.js';
import { PrismaService } from '../common/prisma.service.js';

@Module({
  controllers: [WhatsAppWebhookController, GmailWebhookController],
  providers: [PubSubTokenVerifier, PrismaService],
})
export class WebhooksModule {}
