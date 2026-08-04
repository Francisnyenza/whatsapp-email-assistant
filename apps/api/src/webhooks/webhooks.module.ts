import { Module } from '@nestjs/common';
import { WhatsAppWebhookController } from './whatsapp.controller.js';

@Module({ controllers: [WhatsAppWebhookController] })
export class WebhooksModule {}
