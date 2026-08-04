-- Extensions the application depends on. Prisma migrations assume these exist.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";        -- semantic search embeddings
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram search on subjects/senders
CREATE EXTENSION IF NOT EXISTS "btree_gin";     -- composite GIN indexes
