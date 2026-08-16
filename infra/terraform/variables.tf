variable "environment" {
  description = "Which environment this is. Drives every durability decision in main.tf — multi-AZ, deletion protection, backup retention, whether a final snapshot is taken."
  type        = string

  validation {
    # A free-form string here would let `prod`, `production` and `Production`
    # all exist, each with different durability, and the difference would only
    # surface when one of them was deleted without a snapshot.
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging or production."
  }
}

variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
  default     = "wea"
}

variable "postgres_version" {
  description = "Postgres major version. pgvector needs 15.5 or later; the schema and migrations are written against 16."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^(15\\.[5-9]|15\\.[1-9][0-9]|16|16\\.)", var.postgres_version))
    error_message = "pgvector requires Postgres 15.5+; this schema targets 16."
  }
}

variable "postgres_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_storage_gb" {
  description = "Initial allocated storage."
  type        = number
  default     = 50
}

variable "postgres_max_storage_gb" {
  description = "Ceiling for storage autoscaling. Message bodies dominate growth and the retention sweep is what bounds it."
  type        = number
  default     = 500
}

variable "redis_node_type" {
  description = "ElastiCache node type. Queue depth rather than dataset size is the constraint — jobs are small and short-lived."
  type        = string
  default     = "cache.t4g.small"
}

variable "retention_body_days" {
  description = "How long attachment objects live. Must match RETENTION_BODY_DAYS in the application config, or the objects outlive the rows that referenced them."
  type        = number
  default     = 90

  validation {
    condition     = var.retention_body_days >= 1
    error_message = "retention_body_days must be at least 1; use the application's own setting to disable retention, not this."
  }
}

variable "db_subnet_group_name" {
  description = "Existing DB subnet group. Private subnets — the instance is never publicly accessible."
  type        = string
}

variable "redis_subnet_group_name" {
  description = "Existing ElastiCache subnet group."
  type        = string
}

variable "security_group_ids" {
  description = "Security groups permitting access from the cluster's nodes, and from nowhere else."
  type        = list(string)
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
