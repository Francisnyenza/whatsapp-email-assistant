# The stateful dependencies the Kubernetes manifests assume already exist.
#
# Scope is deliberate: this provisions the data layer, the encryption key and
# the secret — not the cluster. Every organisation that has Kubernetes already
# has an opinion about how its clusters are created, and a module that insists
# on its own EKS would be ignored or forked. What the manifests actually assume
# and cannot create for themselves is a Postgres with pgvector, a Redis, a KMS
# key and somewhere to keep credentials.
#
# AWS rather than a cloud-agnostic abstraction, and the codebase chose it before
# this file existed: `packages/shared/src/config/env.schema.ts` already reads
# `KMS_KEY_ID`, and ADR 0002's envelope encryption is written against a KMS that
# wraps a data key. A module that pretended to be portable would be three
# untested paths instead of one working one.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  name = "${var.name_prefix}-${var.environment}"

  # An IAM condition key is written against the provider's *issuer host*, not
  # its ARN — `oidc.eks.eu-west-1.amazonaws.com/id/ABC:sub`, never the ARN. The
  # two differ only by the prefix, and getting it wrong produces a role that
  # simply never matches, with no error anywhere to say so.
  oidc_issuer = replace(var.oidc_provider_arn, "/^arn:aws:iam::\\d+:oidc-provider//", "")

  tags = merge(var.tags, {
    Application = "wea"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ---------------------------------------------------------------------------
# Encryption key (ADR 0002)
# ---------------------------------------------------------------------------

# The key that wraps every per-record data key. Rotation is on: the envelope
# scheme stores a `keyVersion` alongside each ciphertext precisely so a rotated
# key does not orphan the data written under the previous one.
resource "aws_kms_key" "envelope" {
  description             = "Envelope encryption master key for ${local.name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.tags
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/${local.name}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------

resource "random_password" "db" {
  length = 32
  # `$`, `'` and backslash all need escaping somewhere between Terraform, a
  # connection URL and a shell, and the failure is a connection refused at 3am
  # rather than at apply time.
  override_special = "!#%*()-_=+[]{}<>:?"
}

# pgvector is an extension, not a Postgres feature — it is only available on
# 15.5+ and 16.x. Pinning the family rather than the exact version lets AWS
# apply patch releases; pinning `engine_version` to a major keeps an automatic
# upgrade from moving the schema out from under the migrations.
resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${local.name}-pg16-"
  family      = "postgres16"

  # Every connection logs its own duration above the threshold, which is what
  # makes a slow query attributable to a request rather than to "the database
  # was busy".
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  # Refuses any connection that is not TLS. Mail bodies are encrypted at the
  # column level before they are written, so this protects the credentials and
  # the metadata around them rather than the bodies — worth having anyway, and
  # `pending-reboot` because it cannot be applied to a running instance.
  #
  # Note what this is *not*: row-level security is enforced by the schema and by
  # connecting as `wea_app`, which the application does. Nothing in a parameter
  # group affects it.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_db_instance" "postgres" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.postgres_instance_class

  allocated_storage     = var.postgres_storage_gb
  max_allocated_storage = var.postgres_max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.envelope.arn

  db_name  = "wea"
  username = "wea"
  password = random_password.db.result

  parameter_group_name = aws_db_parameter_group.postgres.name
  db_subnet_group_name = var.db_subnet_group_name

  vpc_security_group_ids = var.security_group_ids

  # Not publicly reachable, ever. Mail bodies live here, encrypted at rest and
  # at the column level — but an internet-facing database is a decision nobody
  # should be able to make by forgetting a flag.
  publicly_accessible = false

  multi_az                = var.environment == "production"
  backup_retention_period = var.environment == "production" ? 30 : 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"

  # A destroyed production database should leave something behind. The snapshot
  # is named after the instance and the time, because a snapshot nobody can
  # identify is a snapshot nobody restores.
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name}-final" : null
  deletion_protection       = var.environment == "production"

  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "production"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

# BullMQ is not a cache. Every queued job — an unsent reply, a pending
# notification — lives here, so eviction under memory pressure means losing
# work rather than losing a cached value. `noeviction` makes a full Redis
# refuse writes loudly instead of discarding jobs silently, which is the same
# choice docker-compose.yml makes locally.
resource "aws_elasticache_parameter_group" "redis" {
  # `name`, not `name_prefix` — unlike its RDS counterpart this resource has no
  # prefix argument, and so no `create_before_destroy` either: a fixed name
  # cannot be created alongside itself. It does not need one. Adding or changing
  # a `parameter` block is applied in place; only a change to `name` or `family`
  # replaces the resource.
  name   = "${local.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = local.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = local.name
  description          = "Queues and session state for ${local.name}"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  parameter_group_name = aws_elasticache_parameter_group.redis.name
  subnet_group_name    = var.redis_subnet_group_name
  security_group_ids   = var.security_group_ids

  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.envelope.arn

  # Jobs carry user ids and message ids. Persisting them is what makes a failover
  # resume rather than restart, and the daily window is when the queues are
  # quietest.
  snapshot_retention_limit = var.environment == "production" ? 7 : 1
  snapshot_window          = "05:00-06:00"

  maintenance_window = "sun:06:30-sun:07:30"
  apply_immediately  = var.environment != "production"

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

# Provisioned, and **nothing writes to it**.
#
# No S3 client is imported anywhere in this system. Attachment bytes are stored
# in neither direction: an email's file is streamed from Gmail or Graph,
# buffered only as long as it takes to hand to Meta, and dropped; a photo sent
# from WhatsApp is held as Meta's media id until the draft goes out. That is a
# better property than storing them, and it means this bucket, the lifecycle
# rule below and the `S3_*` settings are all scaffolding.
#
# Kept because attachment scanning and OCR would need somewhere to put bytes and
# the schema is already shaped for it (`attachments.storage_key`,
# `extracted_text`, `scanned_at`). An empty bucket costs nothing; being wrong
# about whether one is in use costs a security review. Delete the block if you
# would rather not have it — nothing references it but the `attachments_bucket`
# output.
resource "aws_s3_bucket" "attachments" {
  bucket = "${local.name}-attachments"
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.envelope.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Attachments follow the same clock as message bodies. `RETENTION_BODY_DAYS`
# governs the rows; without this the objects they referred to outlive them, and
# a retention promise that only covers the database is not a retention promise.
resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    id     = "retention"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_body_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

# Written here so the connection strings are assembled once, from the resources
# that define them, rather than copied into a ConfigMap by hand. The cluster
# reads this through External Secrets — which is why the Kubernetes Secret in
# infra/k8s/config.yaml is a template full of REPLACE_ME and not a real object.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  kms_key_id              = aws_kms_key.envelope.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 0

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  # Only the values this module actually knows. The provider credentials —
  # Meta, Google, Microsoft, the model provider — are added out of band, because
  # Terraform state is not a place to keep a secret somebody typed.
  secret_string = jsonencode({
    DATABASE_MIGRATION_URL = "postgresql://wea:${random_password.db.result}@${aws_db_instance.postgres.endpoint}/wea?sslmode=require"
    REDIS_URL              = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
    KMS_KEY_ID             = aws_kms_key.envelope.arn
    S3_BUCKET              = aws_s3_bucket.attachments.id
  })

  lifecycle {
    # The provider credentials are added to this secret by hand after the first
    # apply. Without this, every subsequent apply would overwrite them with the
    # four keys above and take the running system down.
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Reading the secret from the cluster
# ---------------------------------------------------------------------------

# The role `infra/k8s/secrets/external-secrets.yaml` annotates its service
# account with.
#
# Created only when an OIDC provider is supplied, because the trust policy has
# to name one and this module does not create clusters. That is the honest
# shape of the dependency rather than a missing feature: without a cluster there
# is no identity to trust, and a role trusting nothing is worse than no role.
#
# Both halves matter and granting one without the other is the failure worth
# naming. `GetSecretValue` alone fails at read time with an access-denied that
# points at Secrets Manager, when the missing statement is `kms:Decrypt` on a
# different service's key — the secret is encrypted with this module's own key,
# not the AWS-managed default, because `aws_secretsmanager_secret.app` sets
# `kms_key_id`.
data "aws_iam_policy_document" "secrets_reader_trust" {
  count = var.oidc_provider_arn == "" ? 0 : 1

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    # Both conditions, not just the subject. Without the audience check the
    # role trusts any token that provider issued, including ones minted for a
    # different audience entirely.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.secrets_namespace}:${var.secrets_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "secrets_reader" {
  count = var.oidc_provider_arn == "" ? 0 : 1

  # Scoped to this deployment's secrets, by prefix rather than by exact ARN:
  # Secrets Manager appends six random characters to every secret's ARN, so an
  # exact match cannot be written before the secret exists, and the second
  # secret — the provider credentials, created out of band — has no ARN here at
  # all.
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = ["arn:aws:secretsmanager:*:*:secret:${local.name}/*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.envelope.arn]

    # Decrypt only what Secrets Manager asks it to. Without this the role could
    # unwrap any data key this KMS key ever wrapped — which is every encrypted
    # column in the database, not just the connection strings it needs.
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "secrets_reader" {
  count = var.oidc_provider_arn == "" ? 0 : 1

  name               = "${local.name}-secrets-reader"
  assume_role_policy = data.aws_iam_policy_document.secrets_reader_trust[0].json

  tags = local.tags
}

resource "aws_iam_role_policy" "secrets_reader" {
  count = var.oidc_provider_arn == "" ? 0 : 1

  name   = "read-app-secrets"
  role   = aws_iam_role.secrets_reader[0].id
  policy = data.aws_iam_policy_document.secrets_reader[0].json
}

data "aws_region" "current" {}
