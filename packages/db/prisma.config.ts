import { defineConfig } from 'prisma/config';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The monorepo keeps one .env at its root; Prisma would otherwise only look
// beside the schema and fail with "Environment variable not found".
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env'), quiet: true });

export default defineConfig({
  schema: resolve(here, 'prisma/schema.prisma'),
  migrations: {
    path: resolve(here, 'prisma/migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
