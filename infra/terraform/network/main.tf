# The network the root module takes as given.
#
# `infra/terraform` deliberately does not create a cluster, and it also does not
# create the VPC the cluster lives in — it asks for a DB subnet group, an
# ElastiCache subnet group and a set of security groups, on the reasoning that
# an organisation with Kubernetes already has an opinion about its networking.
#
# That reasoning holds and this does not contradict it. What it leaves out is
# everyone else: someone standing this up for the first time has no VPC to name,
# and "bring your own network" is not an answer to "I have none". So this is a
# separate module rather than part of the root — apply it if you need a network,
# skip it and pass your own if you have one. Its outputs are named to match the
# root module's inputs exactly, so wiring the two together is four lines.
#
# What it deliberately does not do is create the cluster either. The subnets
# carry the tags EKS looks for when it places load balancers, so an EKS created
# by any means will use them correctly, and that is the whole of the coupling.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.name_prefix}-${var.environment}"

  zones = length(var.availability_zones) > 0 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, 3)

  # One NAT per zone in production, one for the whole VPC elsewhere. See the
  # variable's comment for why this follows the environment by default.
  single_nat = var.single_nat_gateway != null ? var.single_nat_gateway : var.environment != "production"

  nat_count = local.single_nat ? 1 : length(local.zones)

  # /20 per subnet out of a /16: 4 094 usable addresses each, which is far more
  # than pods will ever need but leaves the arithmetic obvious. Public subnets
  # take the first block, private the second, so the two never interleave and a
  # future third tier has somewhere contiguous to go.
  public_cidrs  = [for index, _ in local.zones : cidrsubnet(var.cidr_block, 4, index)]
  private_cidrs = [for index, _ in local.zones : cidrsubnet(var.cidr_block, 4, index + 8)]

  tags = merge(var.tags, {
    Application = "wea"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

# ---------------------------------------------------------------------------
# The VPC itself
# ---------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block = var.cidr_block

  # Both required for RDS and ElastiCache endpoints to resolve inside the VPC.
  # Without them the application gets a public IP for its own database, routes
  # to it over the NAT gateway, and pays for the privilege of a slower path.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = local.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = local.name })
}

# ---------------------------------------------------------------------------
# Subnets
# ---------------------------------------------------------------------------

# Public: the NAT gateways and any internet-facing load balancer. Nothing that
# holds data goes here.
resource "aws_subnet" "public" {
  count = length(local.zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.zones[count.index]

  # Deliberately false. A subnet is public because of its route table, not
  # because its instances get an address — and auto-assignment is how something
  # meant to be internal quietly acquires one.
  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "${local.name}-public-${local.zones[count.index]}"
    # The tag EKS reads when placing an internet-facing load balancer. Without
    # it, a Service of type LoadBalancer stays in `pending` with an event
    # nobody thinks to look for.
    "kubernetes.io/role/elb" = "1"
  })
}

# Private: the nodes, the database, the cache. Outbound through NAT, inbound
# from nowhere.
resource "aws_subnet" "private" {
  count = length(local.zones)

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.zones[count.index]

  tags = merge(local.tags, {
    Name                              = "${local.name}-private-${local.zones[count.index]}"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

# ---------------------------------------------------------------------------
# Egress
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  count = local.nat_count

  domain = "vpc"
  tags   = merge(local.tags, { Name = "${local.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  # Without this the gateway can be created before the VPC has a route to the
  # internet, and comes up unable to reach anything.
  depends_on = [aws_internet_gateway.this]

  tags = merge(local.tags, { Name = "${local.name}-${count.index}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${local.name}-public" })
}

resource "aws_route_table_association" "public" {
  count = length(local.zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One route table per private subnet even when they share a NAT gateway, so
# switching `single_nat_gateway` off later changes a route rather than replacing
# every association.
resource "aws_route_table" "private" {
  count = length(local.zones)

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[local.single_nat ? 0 : count.index].id
  }

  tags = merge(local.tags, { Name = "${local.name}-private-${local.zones[count.index]}" })
}

resource "aws_route_table_association" "private" {
  count = length(local.zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# S3 through a gateway endpoint rather than the NAT.
#
# Attachments are the highest-volume traffic this system has, and every byte of
# them would otherwise be billed twice — once for NAT processing and once for
# transfer. A gateway endpoint costs nothing and keeps the traffic off the
# public path entirely.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(local.tags, { Name = "${local.name}-s3" })
}

data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# Subnet groups
# ---------------------------------------------------------------------------

# Private only. `aws_db_instance` in the root module sets
# `publicly_accessible = false`, and a DB subnet group spanning public subnets
# would make that the only thing standing between the database and the internet.
resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-postgres"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.tags, { Name = "${local.name}-postgres" })
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name}-redis"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.tags, { Name = "${local.name}-redis" })
}

# ---------------------------------------------------------------------------
# Who may reach the data layer
# ---------------------------------------------------------------------------

resource "aws_security_group" "data" {
  name        = "${local.name}-data"
  description = "Postgres and Redis, reachable only from the workload"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${local.name}-data" })

  lifecycle {
    create_before_destroy = true
  }
}

# A rule per source group per port, rather than a CIDR covering the VPC.
#
# A CIDR rule would admit anything that happens to be in the VPC — a bastion, a
# CI runner, a lambda someone attached last month. Naming the source group means
# the set of things that can reach the database is the set of things running the
# application, and stays that way without anyone maintaining it.
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  count = length(var.node_security_group_ids)

  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = var.node_security_group_ids[count.index]
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from the workload"

  tags = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  count = length(var.node_security_group_ids)

  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = var.node_security_group_ids[count.index]
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from the workload"

  tags = local.tags
}

# Egress is unrestricted from the data group and that is not an oversight:
# nothing in it initiates a connection, so the rule has no traffic to permit.
# It exists because a security group with no egress rule at all denies the
# return path on some managed services.
resource "aws_vpc_security_group_egress_rule" "data" {
  security_group_id = aws_security_group.data.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Unrestricted; nothing here dials out"

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Flow logs
# ---------------------------------------------------------------------------

# Production only. They are the record of who reached what, which is the first
# thing an incident asks for and a thing that cannot be turned on retroactively.
# Elsewhere they are a bill for data nobody reads.
resource "aws_cloudwatch_log_group" "flow" {
  count = var.environment == "production" ? 1 : 0

  name              = "/aws/vpc/${local.name}"
  retention_in_days = 90

  tags = local.tags
}

resource "aws_flow_log" "this" {
  count = var.environment == "production" ? 1 : 0

  vpc_id               = aws_vpc.this.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow[0].arn
  iam_role_arn         = aws_iam_role.flow[0].arn

  tags = local.tags
}

# REJECT only, deliberately. ACCEPT is the overwhelming majority of the volume
# and says little — the traffic that was allowed is the traffic the rules were
# written for. Rejections are what a misconfiguration and a probe both look like.
resource "aws_iam_role" "flow" {
  count = var.environment == "production" ? 1 : 0

  name = "${local.name}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "flow" {
  count = var.environment == "production" ? 1 : 0

  name = "write-flow-logs"
  role = aws_iam_role.flow[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow[0].arn}:*"
    }]
  })
}
