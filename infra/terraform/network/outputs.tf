# Named to match the root module's inputs, so the two wire together directly:
#
#   module "network" {
#     source      = "./network"
#     environment = var.environment
#   }
#
#   module "wea" {
#     source                  = "./"
#     environment             = var.environment
#     db_subnet_group_name    = module.network.db_subnet_group_name
#     redis_subnet_group_name = module.network.redis_subnet_group_name
#     security_group_ids      = [module.network.data_security_group_id]
#   }

output "vpc_id" {
  description = "For whatever creates the cluster."
  value       = aws_vpc.this.id
}

output "private_subnet_ids" {
  description = "Where nodes and the data layer belong. Tagged for internal load balancers."
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "NAT gateways and internet-facing load balancers only. Tagged for the ELB controller."
  value       = aws_subnet.public[*].id
}

output "db_subnet_group_name" {
  description = "Pass to the root module's db_subnet_group_name."
  value       = aws_db_subnet_group.this.name
}

output "redis_subnet_group_name" {
  description = "Pass to the root module's redis_subnet_group_name."
  value       = aws_elasticache_subnet_group.this.name
}

output "data_security_group_id" {
  description = <<-EOT
    Pass to the root module's security_group_ids.

    It admits only the groups named in `node_security_group_ids`. Left empty at
    apply time it admits nothing at all, so the database is unreachable until
    the cluster's own group is supplied — which is the failure worth having.
  EOT
  value       = aws_security_group.data.id
}

output "availability_zones" {
  description = "The zones actually used, resolved if they were not given."
  value       = local.zones
}
