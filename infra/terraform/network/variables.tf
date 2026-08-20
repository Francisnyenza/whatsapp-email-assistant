variable "environment" {
  description = "Which environment this is. Drives the NAT layout and whether flow logs are kept."
  type        = string

  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment must be development, staging or production."
  }
}

variable "name_prefix" {
  description = "Prefix for every resource name. Match the root module's, or nothing lines up in the console."
  type        = string
  default     = "wea"
}

variable "cidr_block" {
  description = "The VPC's address range. /16 leaves room for a /20 per subnet across three zones with most of the space still free."
  type        = string
  default     = "10.60.0.0/16"
}

variable "availability_zones" {
  description = <<-EOT
    Zones to spread across. Empty means "the first three the region offers".

    Three rather than two: an RDS multi-AZ failover and an ElastiCache failover
    can land in the same zone, and a two-zone layout has nowhere left to go when
    that zone is the one having the incident.
  EOT
  type        = list(string)
  default     = []
}

variable "single_nat_gateway" {
  description = <<-EOT
    One NAT gateway for the whole VPC instead of one per zone.

    A NAT gateway is the most expensive thing in this file by a wide margin, and
    outside production the saving is worth more than the redundancy. In
    production it is a single point of failure for all outbound traffic — which
    is every Meta, Google and model-provider call the system makes — so the
    default follows the environment rather than a fixed value.
  EOT
  type        = bool
  default     = null
}

variable "node_security_group_ids" {
  description = <<-EOT
    Security groups belonging to whatever runs the workload — EKS node groups,
    Fargate profiles, an EC2 host.

    The data-layer security group admits these and nothing else. Left empty, the
    group is created with no ingress at all, which is the safe direction to be
    wrong in: the database is unreachable and someone notices immediately.
  EOT
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}
