# WhatsApp message templates

Outside Meta's 24-hour customer service window a free-form message is **accepted by the API
and then never delivered**. No error, no bounce — the user simply does not hear from us.
Templates are the only way to reach someone who has not messaged us recently, which for a
notification product is most of the time.

Templates are submitted in Meta Business Manager, reviewed by a human, and approved against
a fixed **name**, **language** and **placeholder count**. `packages/whatsapp/src/templates.ts`
declares what was approved. **The two must match exactly** — a name that was never approved,
or the wrong number of placeholders, fails 100% of sends.

---

## Submitting these

For each template below, in Business Manager → **WhatsApp Manager → Message templates →
Create template**:

1. **Category: Utility.** Not Marketing. These notify a user about activity on their own
   connected mailbox, which is what Utility is for — and Marketing templates are rate-limited
   per user per day, which would silently drop notifications.
2. **Name:** exactly as given. Lower case, underscores only; Meta enforces this.
3. **Body:** copy the text verbatim, including punctuation. The placeholder numbering matters.
4. **Add every language** listed. Meta treats `en` and `en_GB` as **separate templates**,
   each approved separately. A language that is not approved fails the send rather than
   falling back, which is why `resolveTemplateLanguage` falls back in code instead.

Approval usually takes minutes but can take a day. Until then, sends of that template fail.

---

## `new_email_notification`

Sent when an email arrives and the user has not messaged us in the last 24 hours.

**Category:** Utility
**Placeholders:** 2

```
New email from {{1}}: {{2}}

Reply to this message to read it, answer it, or file it away.
```

| Placeholder | Value                                      | Example      |
| ----------- | ------------------------------------------ | ------------ |
| `{{1}}`     | Sender display name, or address if no name | `Sarah Chen` |
| `{{2}}`     | Subject, or `(no subject)`                 | `Q3 report`  |

Sample values for the approval form: `Sarah Chen`, `Q3 report`.

## `email_digest_notification`

Sent when several emails are waiting and the window is closed.

**Category:** Utility
**Placeholders:** 1

```
You have {{1}} new emails waiting.

Reply to this message to see them.
```

| Placeholder | Value                | Example |
| ----------- | -------------------- | ------- |
| `{{1}}`     | Number of new emails | `4`     |

---

## Languages

Both templates are declared for: `en`, `en_GB`, `es`, `fr`, `pt_BR`, `de`, `ar`, `hi`, `sw`,
`zh_CN`. `en` is the fallback.

A user whose locale has no approved template gets the fallback rather than a failed send —
English in the wrong language is worse than English, and both are far better than silence.

---

## Why the template says so little

Its text is fixed at approval time. It cannot carry a summary, cannot carry buttons that do
anything, and cannot be varied per message beyond the placeholders. So it is deliberately a
**nudge**: its whole job is to get the user to reply, because their reply reopens the
24-hour window — and once open, the real notification card can be sent with everything on it.

That also means a parameter must never carry content we would not want fixed in a
pre-approved frame. Sender and subject are the user's own mail arriving in their own
mailbox; anything richer belongs in the card that follows.

---

## Parameter rules Meta enforces

`templateParameter()` applies all of these. They are not stylistic:

- **No newlines, tabs, or four-plus consecutive spaces.** Meta rejects the whole message,
  not just the parameter. An email subject with a line break in it is entirely ordinary.
- **No empty parameters.** An absent value becomes a readable placeholder instead.
- **Length.** Capped at 200 characters, well below Meta's limit — a 900-character subject
  would be truncated on the device anyway, and a template that fails to render tells the
  user nothing at all.
