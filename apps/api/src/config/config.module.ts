import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';
import { createLogger } from '../common/logger.js';

/**
 * Global because configuration and logging are needed everywhere, and threading
 * them through every module's imports adds noise without adding safety.
 */
@Global()
@Module({
  providers: [
    ConfigService,
    {
      provide: 'LOGGER',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createLogger(config.env),
    },
  ],
  exports: [ConfigService, 'LOGGER'],
})
export class ConfigModule {}
