# Inbox on WhatsApp

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
- **Full mailbox control** — archive, delete, forward, mark read/unread/important, search.
- **AI throughout** — summarize, draft, rewrite, translate (10+ languages), classify, detect
  urgency and spam, extract deadlines, invoices, meeting times and action items.
- **Voice** — send a voice note, get an email; have your email read aloud.
- **Attachments** — receive and send PDF, Office documents, images, audio, video and archives.
- **Dashboard** — a web app for setup, analytics, automations, billing and administration.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | System design, data flows, scale and security posture |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| `docs/data-model.md` | Database schema (Phase 3) |
| `docs/security.md` | Threat model and controls (Phase 10) |
| `docs/runbook.md` | Operations (Phase 11) |

## Repository layout

```
apps/
  api/        NestJS — REST, GraphQL, OAuth and webhook ingress (stateless)
  worker/     NestJS — queue consumers: ingest, AI, notify, send, automations
  web/        Next.js dashboard
  mobile/     React Native (Expo)
packages/
  shared/     Types, Zod schemas, constants shared across all apps
  crypto/     Envelope encryption (AES-256-GCM + KMS), blind indexes
  db/         Prisma schema, migrations, generated client
  mail/       Gmail / Microsoft Graph / IMAP adapters, MIME build + parse
  whatsapp/   Cloud API client, message builders, templates
  ai/         LLM provider abstraction, prompts, structured output schemas
  sdk/        Public TypeScript SDK
infra/
  docker/ k8s/ terraform/
```

## Status

Built in phases; each lands complete, documented and tested.

| Phase | | Status |
| --- | --- | --- |
| 1 | Architecture & ADRs | ✅ |
| 2 | Monorepo structure & tooling | — |
| 3 | Database schema | — |
| 4 | Backend core | — |
| 5 | WhatsApp integration | — |
| 6 | Gmail integration | — |
| 7 | Outlook / Microsoft 365 | — |
| 8 | AI layer | — |
| 9 | Frontend dashboard | — |
| 10 | Testing | — |
| 11 | Deployment & ops | — |

## Requirements

Node 20+, pnpm 9+, Docker, PostgreSQL 16 (with `pgvector`), Redis 7.

Setup instructions land with Phase 2.
