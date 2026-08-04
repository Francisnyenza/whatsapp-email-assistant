import { Global, Module } from '@nestjs/common';
import { QueueProducer } from './queue.producer.js';

@Global()
@Module({ providers: [QueueProducer], exports: [QueueProducer] })
export class QueueModule {}
