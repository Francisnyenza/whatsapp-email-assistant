# Inbox on WhatsApp

[![CI](https://github.com/Francisnyenza/whatsapp-email-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/Francisnyenza/whatsapp-email-assistant/actions/workflows/ci.yml)

Manage your email entirely from WhatsApp. Connect Gmail, Outlook or Microsoft 365 once — every
new email arrives as a WhatsApp message with an AI summary, and every reply you type in
WhatsApp goes out as a normal, correctly-threaded email from your own address.

The person you reply to sees an ordinary email. There is no footer, no branding, no header that
gives it away.

---

## What it does

- **Instant delivery** — new email → WhatsApp in under 5 seconds, with sender, subject, time,
  priority, category, AI summary and attachments.
- **Reply from WhatsApp** — replies are threaded correctly (`In-Reply-To`, `References`) and
  sent through your own mailbox, so they land in your Sent folder and in the recipient's
  existing conversation.
- **Full mailbox control** — compose, archive, delete, forward, mark read/unread/important,
  search, label, move between folders, snooze, report spam, CC, Bcc and reply-all. Anything
  irreversible — a delete, a forward, a brand-new email — asks first, with a button, and
  `undo` takes back the last thing for ten minutes afterwards. Every outgoing message
  waits fifteen seconds before it is sent, so `undo` can stop it.
- **AI throughout** — summarize, draft, rewrite, translate (10+ languages), classify, detect
  urgency and spam, extract deadlines, invoices, meeting times and action items.
- **Attachments both ways** — ask for an email's files and they arrive in the chat; send a
  photo or a document and the next email you send carries it. The bytes are never stored:
  they pass through on their way to the recipient.
- **Voice** — have any email read aloud, as a voice note; send one and it is transcribed and
  acted on, with what we heard echoed back so a mishearing is visible.
- **Dashboard** — a web app for setup, analytics, automations, billing and administration.

## Documentation

| Document                                       | Contents                                              |
| ---------------------------------------------- | ----------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | System design, data flows, scale and security posture |
| [`docs/adr/`](docs/adr/)                       | Architecture decision records                         |
| [`docs/development.md`](docs/development.md)   | Local setup, credentials, conventions                 |
| [`docs/status.md`](docs/status.md)             | What is built and verified, and what is not           |
| [`docs/data-model.md`](docs/data-model.md)     | Schema design, tenant isolation, retention            |
| `docs/security.md`                             | Threat model and controls (Phase 10)                  |
| `docs/runbook.md`                              | Operations (Phase 11)                                 |

## Repository layout

Entries marked _(planned)_ are the intended shape, not directories that exist. Everything
else is on disk and tested.

```
apps/
  api/        NestJS — REST, OAuth and webhook ingress (stateless)
  worker/     NestJS — queue consumers: ingest, AI, notify, send, automations
  web/        Next.js dashboard — sign-in, mailboxes, phone, settings
  mobile/     React Native (Expo)                                    (planned)
packages/
  shared/     Types, Zod schemas, constants shared across all apps
  crypto/     Envelope encryption (AES-256-GCM + KMS), blind indexes
  db/         Prisma schema, migrations, generated client
  mail/       Gmail / Microsoft Graph adapters, MIME build + parse
              (IMAP is planned)
  whatsapp/   Cloud API client, message builders, templates
  ai/         LLM provider abstraction, prompts, structured output schemas
  sdk/        Public TypeScript SDK                                  (planned)
infra/
  docker/     Local Postgres, Redis and MinIO
  k8s/        Deployments, Service, PDBs, HPA, migration Job,
              KEDA autoscaler, Prometheus scrape targets and alerts
  terraform/  RDS + pgvector, ElastiCache, KMS, S3, Secrets Manager
```

## Status

Built in phases; each lands complete, documented and tested.
**1 863 tests passing** (1 491 unit + 372 integration against real Postgres). See
[`docs/status.md`](docs/status.md) for an honest accounting of what is and is not built —
including what these ticks do not cover.

| Phase |                              | Status                                |
| ----- | ---------------------------- | ------------------------------------- |
| 1     | Architecture & ADRs          | ✅                                    |
| 2     | Monorepo structure & tooling | ✅                                    |
| 3     | Database schema              | ✅                                    |
| 4     | Backend core                 | ✅                                    |
| 5     | WhatsApp integration         | ✅                                    |
| 6     | Gmail integration            | ✅                                    |
| 7     | Outlook / Microsoft 365      | ✅                                    |
| 8     | AI layer                     | ✅                                    |
| 9     | Frontend dashboard           | 🔨 setup and settings; no mail views  |
| 10    | Testing                      | 🔨 unit, integration and CI; no E2E   |
| 11    | Deployment & ops             | 🔨 images, k8s, alerts, data-layer TF |

## Requirements

Node 20+, pnpm 9+, Docker, PostgreSQL 16 (with `pgvector`), Redis 7.

See [`docs/development.md`](docs/development.md) to get running locally.
