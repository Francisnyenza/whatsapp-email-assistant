# ADR 0003 — Thread resolution and invisible replies

**Status:** Accepted · **Date:** 2026-08-04

## Context

The product promise is that a reply typed in WhatsApp is indistinguishable, to the recipient,
from one typed in Gmail. Two problems sit underneath it:

1. **Which email is this reply for?** WhatsApp is a linear chat; a user may receive twenty
   notifications and then type "yes, Friday works".
2. **How do we make the outbound mail look native?** Threading is header-driven and
   unforgiving — get `References` wrong and the reply detaches into a new conversation in the
   recipient's client.

## Decision

### Thread resolution — a confidence ladder, never a guess

| Rank | Signal                                                                            | Confidence                           |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------ |
| 1    | `context.id` on the inbound WhatsApp message (native reply) → our delivery record | Certain                              |
| 2    | `interactive.button_reply.id`, which we mint as `act:reply:<emailMessageId>`      | Certain                              |
| 3    | Active `ConversationState` for the phone number (TTL 30 min)                      | High                                 |
| 4    | NLU match ("reply to Sarah") against the last 20 notified emails                  | Medium                               |
| 5    | Nothing matched                                                                   | **Ask** — numbered list, no guessing |

Rank 5 is the important one. A misrouted reply sends a user's words to the wrong person; that
is unrecoverable and far worse than one extra round trip.

### Invisible replies — rules for the composer

- Send **through the user's own mailbox** via their OAuth grant. Never a relay, never a
  `Sender:` or `On-Behalf-Of` header. This preserves SPF/DKIM/DMARC alignment on the user's own
  domain, and the message lands in their own Sent folder.
- `In-Reply-To` = the original `Message-ID`.
- `References` = original `References` (if any) + original `Message-ID`, in order, deduplicated,
  and truncated from the _middle_ if it exceeds practical header length — keeping the root and
  the most recent ancestors, which is what clients thread on.
- `Subject` = `Re: ` + original subject, without stacking `Re: Re:`.
- Emit `multipart/alternative` (plain + HTML) with the quoted original in both, matching the
  conventions of the user's own client.
- **No** `X-Mailer`, `X-Originating-IP`, custom `X-*`, branding footer, or tracking pixel.
  A CI test asserts the generated MIME contains no header outside an allowlist.

## Consequences

**Good.** Replies thread correctly in Gmail, Outlook, Apple Mail and Thunderbird. Deliverability
inherits the user's existing domain reputation rather than ours. There is no fingerprint to
detect.

**Bad.** We cannot attach tracking or analytics to sent mail — response-time analytics are
derived from received replies instead. Sending through provider APIs means per-user quota
limits apply, so the send queue must handle backpressure and 429s rather than fan out freely.
