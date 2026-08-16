# Deliberately no output carries a credential.
#
# `terraform output` is run casually, its result is pasted into chat, and it is
# stored in state either way — so the database password is not here. What is
# here is the set of identifiers the cluster needs in order to *find* the
# secret, which is the safe half of the same information.

output "secret_arn" {
  description = "Secrets Manager secret holding the connection strings. Point External Secrets at this."
  value       = aws_secretsmanager_secret.app.arn
}

output "kms_key_arn" {
  description = "Envelope encryption key. This is KMS_KEY_ID in the application config."
  value       = aws_kms_key.envelope.arn
}

output "postgres_endpoint" {
  description = "Host and port. The credentials are in the secret, not here."
  value       = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  description = "Primary endpoint. TLS is enforced, so the URL scheme is rediss://."
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "attachments_bucket" {
  description = "S3 bucket for attachments, expiring on the same clock as message bodies."
  value       = aws_s3_bucket.attachments.id
}

output "database_password" {
  description = "Initial owner password. Rotate it after the first apply and remove this output — it exists only so the first migration can run."
  value       = random_password.db.result
  sensitive   = true
}
