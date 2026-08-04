-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('free', 'starter', 'pro', 'business', 'enterprise');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'admin', 'member', 'billing');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending_verification', 'active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('gmail', 'outlook', 'microsoft365', 'imap');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('connecting', 'active', 'reauth_required', 'degraded', 'paused', 'disconnected');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('primary', 'work', 'personal', 'finance', 'invoice', 'travel', 'shopping', 'social', 'newsletter', 'promotion', 'notification', 'support', 'recruitment', 'legal', 'spam', 'other');

-- CreateEnum
CREATE TYPE "EmailPriority" AS ENUM ('urgent', 'high', 'normal', 'low');

-- CreateEnum
CREATE TYPE "WhatsAppDeliveryStatus" AS ENUM ('queued', 'accepted', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "WhatsAppMessageKind" AS ENUM ('notification', 'digest', 'reply_confirmation', 'command_response', 'template', 'media', 'error');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('composing', 'awaiting_confirmation', 'queued', 'sending', 'sent', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "NotificationMode" AS ENUM ('instant', 'digest', 'priority_only', 'off');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('email_received', 'no_reply_after', 'invoice_detected', 'vip_sender', 'keyword_match', 'amount_threshold', 'schedule');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan_tier" "PlanTier" NOT NULL DEFAULT 'free',
    "ai_token_budget_daily" INTEGER NOT NULL DEFAULT 5000000,
    "enforce_two_factor" BOOLEAN NOT NULL DEFAULT false,
    "allowed_email_domains" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'member',
    "token_hash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "full_name" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "phone_number" TEXT,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'pending_verification',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_secret_cipher" BYTEA,
    "two_factor_secret_dek" BYTEA,
    "two_factor_secret_key_ver" INTEGER,
    "two_factor_recovery_codes" TEXT[],
    "tokens_valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "location" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 120,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "email_address" TEXT NOT NULL,
    "display_name" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'connecting',
    "access_token_cipher" BYTEA NOT NULL,
    "access_token_dek" BYTEA NOT NULL,
    "refresh_token_cipher" BYTEA,
    "refresh_token_dek" BYTEA,
    "token_key_version" INTEGER NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[],
    "provider_account_id" TEXT NOT NULL,
    "sync_cursor" TEXT,
    "watch_subscription_id" TEXT,
    "watch_expires_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "polling_since" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMP(3),
    "watched_labels" TEXT[],
    "ignored_senders" TEXT[],
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMP(3),

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_threads" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider_thread_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 1,
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "has_unread" BOOLEAN NOT NULL DEFAULT true,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "participant_addresses" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "message_id_header" TEXT NOT NULL,
    "in_reply_to" TEXT,
    "references" TEXT[],
    "direction" "MessageDirection" NOT NULL DEFAULT 'inbound',
    "subject" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "reply_to" TEXT,
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[],
    "bcc_addresses" TEXT[],
    "sent_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "body_text_cipher" BYTEA,
    "body_html_cipher" BYTEA,
    "body_dek" BYTEA,
    "body_key_version" INTEGER,
    "body_purged_at" TIMESTAMP(3),
    "snippet" VARCHAR(300) NOT NULL,
    "is_unread" BOOLEAN NOT NULL DEFAULT true,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "is_important" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_spam" BOOLEAN NOT NULL DEFAULT false,
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "labels" TEXT[],
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID NOT NULL,
    "provider_attachment_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL DEFAULT 'attachment',
    "content_id" TEXT,
    "storage_key" TEXT,
    "is_stored" BOOLEAN NOT NULL DEFAULT false,
    "stored_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "content_hash" TEXT,
    "extracted_text" TEXT,
    "scanned_at" TIMESTAMP(3),
    "is_malicious" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_analyses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "bullet_summary" TEXT[],
    "category" "EmailCategory" NOT NULL DEFAULT 'other',
    "priority" "EmailPriority" NOT NULL DEFAULT 'normal',
    "urgency_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spam_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "language" TEXT NOT NULL DEFAULT 'en',
    "sentiment" TEXT NOT NULL DEFAULT 'neutral',
    "requires_reply" BOOLEAN NOT NULL DEFAULT false,
    "entities" JSONB NOT NULL DEFAULT '[]',
    "action_items" JSONB NOT NULL DEFAULT '[]',
    "suggested_replies" TEXT[],
    "contains_instruction_like_text" BOOLEAN NOT NULL DEFAULT false,
    "model_provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "from_cache" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_embeddings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID,
    "whatsapp_message_id" TEXT,
    "phone_number" TEXT NOT NULL,
    "kind" "WhatsAppMessageKind" NOT NULL DEFAULT 'notification',
    "status" "WhatsAppDeliveryStatus" NOT NULL DEFAULT 'queued',
    "was_template" BOOLEAN NOT NULL DEFAULT false,
    "template_name" TEXT,
    "error_code" INTEGER,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_inbound_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "whatsapp_message_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "body" TEXT,
    "context_message_id" TEXT,
    "media_id" TEXT,
    "media_mime_type" TEXT,
    "transcription" TEXT,
    "resolved_intent" TEXT,
    "intent_source" TEXT,
    "handled_at" TIMESTAMP(3),
    "handler_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_states" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_email_message_id" UUID,
    "active_thread_id" UUID,
    "active_draft_id" UUID,
    "pending_action" TEXT,
    "pending_options" JSONB,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "in_reply_to_message_id" UUID,
    "kind" TEXT NOT NULL DEFAULT 'reply',
    "to_addresses" TEXT[],
    "cc_addresses" TEXT[],
    "bcc_addresses" TEXT[],
    "subject" TEXT NOT NULL,
    "body_text_cipher" BYTEA NOT NULL,
    "body_html_cipher" BYTEA,
    "body_dek" BYTEA NOT NULL,
    "body_key_version" INTEGER NOT NULL,
    "in_reply_to_header" TEXT,
    "references_header" TEXT[],
    "provider_thread_id" TEXT,
    "attachment_keys" TEXT[],
    "status" "DraftStatus" NOT NULL DEFAULT 'composing',
    "idempotency_key" TEXT NOT NULL,
    "was_ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "ai_model" TEXT,
    "sent_at" TIMESTAMP(3),
    "sent_provider_message_id" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_mode" "NotificationMode" NOT NULL DEFAULT 'instant',
    "minimum_priority" "EmailPriority" NOT NULL DEFAULT 'normal',
    "digest_times" TEXT[] DEFAULT ARRAY['08:00', '18:00']::TEXT[],
    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" TEXT NOT NULL DEFAULT '22:00',
    "quiet_hours_end" TEXT NOT NULL DEFAULT '07:00',
    "muted_categories" "EmailCategory"[],
    "muted_senders" TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "auto_translate" BOOLEAN NOT NULL DEFAULT false,
    "translate_to" TEXT,
    "include_summary" BOOLEAN NOT NULL DEFAULT true,
    "include_attachments" BOOLEAN NOT NULL DEFAULT true,
    "voice_replies_enabled" BOOLEAN NOT NULL DEFAULT false,
    "signature" TEXT,
    "retention_body_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_memory" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "writing_style_summary" TEXT,
    "preferred_greeting" TEXT,
    "preferred_signoff" TEXT,
    "average_reply_length" INTEGER,
    "formality_score" DOUBLE PRECISION,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "samples_analyzed" INTEGER NOT NULL DEFAULT 0,
    "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_address" TEXT NOT NULL,
    "display_name" TEXT,
    "aliases" TEXT[],
    "messages_received" INTEGER NOT NULL DEFAULT 0,
    "messages_sent" INTEGER NOT NULL DEFAULT 0,
    "average_response_time" INTEGER,
    "is_vip" BOOLEAN NOT NULL DEFAULT false,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "organization" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "AutomationTrigger" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "times_triggered" INTEGER NOT NULL DEFAULT 0,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID,
    "matched" BOOLEAN NOT NULL,
    "actions_run" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_message_id" UUID,
    "reason" TEXT NOT NULL,
    "remind_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "plan_tier" "PlanTier" NOT NULL DEFAULT 'free',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "stripe_price_id" TEXT,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "max_email_accounts" INTEGER NOT NULL DEFAULT 1,
    "max_whats_app_per_day" INTEGER NOT NULL DEFAULT 50,
    "max_ai_tokens_per_day" INTEGER NOT NULL DEFAULT 20000,
    "max_automation_rules" INTEGER NOT NULL DEFAULT 3,
    "attachment_size_limit_mb" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "task" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "cache_hits" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "organization_id" UUID,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhooks" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_slug_idx" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_deleted_at_idx" ON "organizations"("deleted_at");

-- CreateIndex
CREATE INDEX "org_memberships_user_id_idx" ON "org_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_memberships_organization_id_user_id_key" ON "org_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_name_key" ON "teams"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_membership_id_key" ON "team_members"("team_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_status_idx" ON "invitations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "users_phone_number_idx" ON "users"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "email_accounts_user_id_status_idx" ON "email_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "email_accounts_status_watch_expires_at_idx" ON "email_accounts"("status", "watch_expires_at");

-- CreateIndex
CREATE INDEX "email_accounts_status_last_synced_at_idx" ON "email_accounts"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_user_id_provider_provider_account_id_key" ON "email_accounts"("user_id", "provider", "provider_account_id");

-- CreateIndex
CREATE INDEX "email_threads_user_id_last_message_at_idx" ON "email_threads"("user_id", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "email_threads_user_id_is_archived_last_message_at_idx" ON "email_threads"("user_id", "is_archived", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_account_id_provider_thread_id_key" ON "email_threads"("account_id", "provider_thread_id");

-- CreateIndex
CREATE INDEX "email_messages_user_id_received_at_idx" ON "email_messages"("user_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "email_messages_thread_id_sent_at_idx" ON "email_messages"("thread_id", "sent_at");

-- CreateIndex
CREATE INDEX "email_messages_user_id_is_unread_received_at_idx" ON "email_messages"("user_id", "is_unread", "received_at" DESC);

-- CreateIndex
CREATE INDEX "email_messages_user_id_from_address_idx" ON "email_messages"("user_id", "from_address");

-- CreateIndex
CREATE INDEX "email_messages_content_hash_idx" ON "email_messages"("content_hash");

-- CreateIndex
CREATE INDEX "email_messages_message_id_header_idx" ON "email_messages"("message_id_header");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_account_id_provider_message_id_key" ON "email_messages"("account_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "attachments_email_message_id_idx" ON "attachments"("email_message_id");

-- CreateIndex
CREATE INDEX "attachments_user_id_created_at_idx" ON "attachments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_content_hash_idx" ON "attachments"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "message_analyses_email_message_id_key" ON "message_analyses"("email_message_id");

-- CreateIndex
CREATE INDEX "message_analyses_user_id_priority_created_at_idx" ON "message_analyses"("user_id", "priority", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_analyses_user_id_category_idx" ON "message_analyses"("user_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "message_embeddings_email_message_id_key" ON "message_embeddings"("email_message_id");

-- CreateIndex
CREATE INDEX "message_embeddings_user_id_idx" ON "message_embeddings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_deliveries_whatsapp_message_id_key" ON "whatsapp_deliveries"("whatsapp_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_deliveries_user_id_created_at_idx" ON "whatsapp_deliveries"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_deliveries_email_message_id_idx" ON "whatsapp_deliveries"("email_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_deliveries_status_created_at_idx" ON "whatsapp_deliveries"("status", "created_at");

-- CreateIndex
CREATE INDEX "whatsapp_deliveries_phone_number_created_at_idx" ON "whatsapp_deliveries"("phone_number", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_inbound_messages_whatsapp_message_id_key" ON "whatsapp_inbound_messages"("whatsapp_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_phone_number_received_at_idx" ON "whatsapp_inbound_messages"("phone_number", "received_at" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_user_id_received_at_idx" ON "whatsapp_inbound_messages"("user_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_states_user_id_key" ON "conversation_states"("user_id");

-- CreateIndex
CREATE INDEX "conversation_states_expires_at_idx" ON "conversation_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "drafts_idempotency_key_key" ON "drafts"("idempotency_key");

-- CreateIndex
CREATE INDEX "drafts_user_id_status_created_at_idx" ON "drafts"("user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "drafts_status_created_at_idx" ON "drafts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_memory_user_id_key" ON "ai_memory"("user_id");

-- CreateIndex
CREATE INDEX "contacts_user_id_last_seen_at_idx" ON "contacts"("user_id", "last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "contacts_user_id_is_vip_idx" ON "contacts"("user_id", "is_vip");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_user_id_email_address_key" ON "contacts"("user_id", "email_address");

-- CreateIndex
CREATE INDEX "automation_rules_user_id_is_enabled_priority_idx" ON "automation_rules"("user_id", "is_enabled", "priority");

-- CreateIndex
CREATE INDEX "automation_runs_rule_id_created_at_idx" ON "automation_runs"("rule_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "automation_runs_user_id_created_at_idx" ON "automation_runs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reminders_remind_at_sent_at_cancelled_at_idx" ON "reminders"("remind_at", "sent_at", "cancelled_at");

-- CreateIndex
CREATE INDEX "reminders_user_id_remind_at_idx" ON "reminders"("user_id", "remind_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_customer_id_key" ON "subscriptions"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_stripe_customer_id_idx" ON "subscriptions"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "ai_usage_records_day_idx" ON "ai_usage_records"("day");

-- CreateIndex
CREATE INDEX "ai_usage_records_user_id_day_idx" ON "ai_usage_records"("user_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_records_user_id_day_task_provider_model_key" ON "ai_usage_records"("user_id", "day", "task", "provider", "model");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "processed_webhooks_expires_at_idx" ON "processed_webhooks"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhooks_source_external_id_key" ON "processed_webhooks"("source", "external_id");

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "org_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_analyses" ADD CONSTRAINT "message_analyses_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_inbound_messages" ADD CONSTRAINT "whatsapp_inbound_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_in_reply_to_message_id_fkey" FOREIGN KEY ("in_reply_to_message_id") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_memory" ADD CONSTRAINT "ai_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

