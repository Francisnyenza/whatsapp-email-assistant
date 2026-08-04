/** Public surface of @wea/db. */

export * from '../generated/client/index.js';

export {
  createPrismaClient,
  assertTenantIsolationEnforceable,
  isUniqueViolation,
  isNotFound,
  isRetryableDbError,
  type CreateClientOptions,
} from './client.js';

export {
  withTenant,
  withoutTenantScope,
  type TenantClient,
  type WithTenantOptions,
  type CrossTenantReason,
} from './tenant.js';
