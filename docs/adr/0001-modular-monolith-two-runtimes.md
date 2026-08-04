# ADR 0001 — Modular monolith with two runtimes, not microservices

**Status:** Accepted · **Date:** 2026-08-04

## Context

The brief calls for "microservice architecture". At target scale (10 M mailboxes) the workload
splits cleanly into fast webhook acknowledgement and slow fallible processing. That is a real
boundary. The boundaries _between_ ingest, AI, notify and send are less real: they share the
same data model, ship together, and are owned by one team.

## Decision

Ship two deployables — `apps/api` (stateless, request/response, webhook ingress) and
`apps/worker` (queue consumers) — from one codebase, internally divided into modules with
enforced boundaries:

- each module is a NestJS module with an explicit public surface;
- cross-module access goes through services, never through another module's repositories;
- shared concerns live in versioned workspace packages (`@wea/db`, `@wea/mail`, `@wea/ai`, …);
- no module imports another module's Prisma queries.

## Consequences

**Good.** One migration path, one deploy, one trace. Local development is `docker compose up`.
Refactoring a boundary is a code change, not a cross-service protocol negotiation. Workers
still scale independently per queue, which is where the scaling pressure actually is.

**Bad.** A single deploy artifact means a bad release affects both runtimes. Mitigated by
independent HPA, canary deploys, and the fact that the API's only job is validate-and-enqueue —
a worker rollback does not drop mail, it delays it.

**Reversible.** Because module boundaries are enforced in code and all inter-stage
communication already goes through queues, extracting `ai` or `send` into its own service is a
build-config change plus a queue connection — not a rewrite. We extract when a module develops
a distinct scaling profile or a distinct owner, not before.
