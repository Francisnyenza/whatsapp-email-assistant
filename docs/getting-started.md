# Getting started

Running this against your own WhatsApp Business number and your own Gmail, end to end,
in about forty minutes. Roughly ten of those are waiting for consoles.

This is the walkthrough. [`docs/development.md`](development.md) is the reference for
what each variable means; this is the order to do things in and the traps between them.

Run `pnpm doctor` whenever you are unsure. It calls Meta and Google for real and tells
you which value is wrong, which is faster than reading logs that say nothing happened.

---

## What you need first

- **A Meta Business account with the WhatsApp product added.** A personal Facebook
  account is enough to create one.
- **A Gmail account.** Use one you do not mind sending real mail from — see
  [Before you send anything](#before-you-send-anything).
- **A machine with** Node 22, pnpm 10 and Docker.
- **An OpenAI, Anthropic or Google AI key**, or a decision to run without AI. Everything
  except summaries, drafting, translation and voice notes works without one.

---

## 1. The repository

```bash
git clone https://github.com/Francisnyenza/whatsapp-email-assistant
cd whatsapp-email-assistant
pnpm install
cp .env.example .env

printf 'ENCRYPTION_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
printf 'BLIND_INDEX_KEY=%s\n'       "$(openssl rand -base64 32)" >> .env
printf 'JWT_ACCESS_SECRET=%s\n'     "$(openssl rand -base64 64)" >> .env
printf 'JWT_REFRESH_SECRET=%s\n'    "$(openssl rand -base64 64)" >> .env

pnpm infra:up     # postgres, redis, minio
pnpm db:migrate
```

`ENCRYPTION_MASTER_KEY` wraps every stored OAuth token and message body. Losing it means
losing access to all of them — there is no recovery path, by design. Keep it somewhere
you would keep a password.

---

## 2. A public HTTPS URL

Meta calls your webhook, so it has to reach you. Google's Pub/Sub push would too, if you
set it up — you can skip that entirely, see [step 5](#5-google).

```bash
cloudflared tunnel --url http://localhost:3001
```

> **Use a named tunnel if you can.** A quick tunnel gets a new hostname every time it
> restarts, and that hostname is registered with Meta — so every restart means editing the
> Meta console again. `cloudflared tunnel create wea` and a DNS route costs ten minutes
> once instead of two minutes forever.

Point it at **3001**, the API. Port 3000 is the dashboard; a tunnel aimed there answers
Meta's verification with HTML and the handshake fails in a way that looks like a token
problem. `pnpm doctor` distinguishes the two.

Then, in `.env`:

```
API_BASE_URL=https://<your-tunnel-hostname>
```

---

## 3. Meta

All of this is in the **WhatsApp → API Setup** tab of your app at
[developers.facebook.com](https://developers.facebook.com).

### The number and the token

Copy the **Phone number ID** — Meta's own long numeric id, not the dialable number and
not the WhatsApp Business Account id. All three are on the same screen and mixing them up
is the most common setup mistake after the token.

```
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
WHATSAPP_BUSINESS_ACCOUNT_ID=<WhatsApp Business Account id>
WHATSAPP_ACCESS_TOKEN=<token>
```

> **The token on that tab expires in 24 hours.** It is long enough to finish setup, go to
> bed, and find everything broken with no error anywhere. For anything beyond one sitting:
> Business Settings → System Users → create one → Generate token, with
> `whatsapp_business_messaging` and `whatsapp_business_management`, and no expiry.
> `pnpm doctor` names this specifically when it sees a 190.

`WHATSAPP_BUSINESS_ACCOUNT_ID` is optional but worth setting — it is what lets the doctor
check the subscription in [the next step](#the-webhook), which is otherwise the failure
you cannot see.

### Your app secret

**App settings → Basic → App secret.**

```
WHATSAPP_APP_SECRET=<app secret>
```

Not optional, in any environment. The webhook rejects any request whose
`X-Hub-Signature-256` does not verify — it is a public unauthenticated URL that causes us
to read mailboxes and send mail, and the signature is the only thing standing there.

### The webhook

Pick any random string as a verify token, put it in `.env`:

```
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<any random string>
```

Start the API so there is something to verify against:

```bash
pnpm dev
```

Then **WhatsApp → Configuration → Webhook → Edit**:

- Callback URL: `https://<your-tunnel-hostname>/webhooks/whatsapp`
- Verify token: the same string

Meta calls the URL immediately and saves only if it echoes the challenge.

> **Then subscribe to the `messages` field.** Same screen, **Webhook fields → Manage**.
> This is the step that catches almost everyone: saving the callback URL makes verification
> pass, every screen reads as configured, and **not one webhook is delivered** until the
> app is subscribed to the WhatsApp Business Account. There is no error. Nothing arrives.

### Which numbers can you message

Meta's free test number can only message up to five recipients you pre-register on the API
Setup tab. Add your own number there.

If you are using your real business number, it needs to be added to the WhatsApp Business
Account and verified in the usual way — that is Meta's process, not this project's.

---

## 4. Your own phone

Nothing to configure. Worth knowing how it works, because it is not the usual direction.

You will be shown a code in the dashboard and asked to **send it to the business number
from your phone**, rather than being sent a code. That is deliberate: a business cannot
send a free-form message to a number that has never messaged it — that needs an approved
template — and messaging in first both proves you hold the phone and opens the 24-hour
window the first notification needs anyway.

---

## 5. Google

At [console.cloud.google.com](https://console.cloud.google.com), in a new project.

1. **APIs & Services → Library → Gmail API → Enable.**
2. **OAuth consent screen.** External. Add yourself under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Authorised
   redirect URI:

   ```
   https://<your-tunnel-hostname>/v1/oauth/google/callback
   ```

   Google compares this string exactly — a trailing slash is a mismatch. `pnpm doctor`
   derives the value the API actually serves and prints it ready to paste.

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_REDIRECT_URI=https://<your-tunnel-hostname>/v1/oauth/google/callback
```

> **A consent screen left in Testing issues refresh tokens that expire in seven days.**
> Your mailbox will disconnect a week later and reconnecting takes one click, but it is a
> genuinely confusing thing to hit blind. Gmail's scopes are "restricted", so publishing
> the app properly means Google's verification review — fine to postpone for a trial, worth
> knowing about before you build on it.

### Skip Pub/Sub

Push delivery needs a topic, a push subscription and a role grant to Google's own service
account. It is the longest part of the setup and you do not need it: mailboxes without a
watch are polled every two minutes, which is a supported way to run.

The difference is that mail arrives within about two minutes rather than within seconds.
`pnpm doctor` says which mode you are in, so you are not left judging the product by the
slower one without knowing. Set `GOOGLE_PUBSUB_TOPIC` later if you want the fast path.

---

## 6. AI

```
AI_PRIMARY_PROVIDER=openai
OPENAI_API_KEY=<key>
```

Or `AI_PRIMARY_PROVIDER=none` to run without it, deliberately. Naming a provider with no
key will not boot.

The doctor tries the key rather than looking at it. A key that is valid but on an account
with no credit answers 429 to everything — every summary fails, each one retried as if it
were transient, and the inbox just quietly has no summaries in it.

---

## 7. Check before you start

```bash
pnpm doctor
```

Work down the failures. Each `→` is the thing to change. Warnings are fine to leave:
polling instead of push, and AI switched off, are both supported.

Then:

```bash
pnpm dev
```

---

## 8. The first message

1. Open the dashboard at **http://localhost:3000** and sign up.
2. **Connect Gmail.** You will see Google's unverified-app warning; that is your own
   consent screen in Testing.
3. **Verify your phone.** The dashboard shows a code. Send it to your WhatsApp business
   number from your phone. It replies to confirm.
4. **Send yourself an email** from another account.
5. It arrives in WhatsApp — sender, subject, priority, summary — within seconds on push,
   or about two minutes on polling.
6. **Type a reply.** It goes out from your own address, correctly threaded, and the person
   who receives it sees an ordinary email. No footer, no branding.

Then try `archive`, `forward to sam@example.com`, `snooze until tomorrow 9am`,
`label as invoices`, `search from anna last week`, a photo (it rides along with your next
email), and a voice note.

Anything irreversible asks first, with a button. `undo` takes back the last thing for ten
minutes, and every outgoing email waits fifteen seconds before it is actually sent so
`undo` can still stop it.

---

## Before you send anything

**Outbound mail is real, in every environment.** There is no development mode that
captures it. Replies go through the Gmail API with your own OAuth token, from your own
address, to whoever the original was from.

An earlier version of `docs/development.md` claimed a Mailpit instance caught development
mail. It never did — nothing pointed at it — and the service has been removed rather than
left sitting there looking like a safety net. `pnpm doctor` says this on every run.

Use an address you own for the first few tries. `undo` is the only recall there is, and it
lasts fifteen seconds.

---

## When something does not work

| What you see                           | What it usually is                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Meta will not save the webhook         | The tunnel is down, or aimed at :3000. `pnpm doctor` performs the same handshake Meta does and tells you which. |
| Webhook saved, no messages ever arrive | The app is not subscribed to the `messages` field. Configuration → Webhook fields → Manage.                     |
| Worked yesterday, dead this morning    | The 24-hour token. Use a System User token.                                                                     |
| `redirect_uri_mismatch` from Google    | Exact-string comparison. Run the doctor; it prints the URI the API actually serves.                             |
| Mailbox disconnects after a week       | Consent screen in Testing. Reconnect, or publish the app.                                                       |
| Mail arrives, but no summaries         | AI key rejected or out of credit. The doctor tries the key rather than trusting it.                             |
| Mail takes minutes, not seconds        | Polling, because there is no Pub/Sub topic. Expected.                                                           |
| Everything green, still nothing        | Is the worker running? `pnpm dev` starts it; on its own, the API accepts webhooks and queues work nobody does.  |

Logs are JSON with an `event` field on every line. `pnpm dev 2>&1 | grep whatsapp.` is
usually enough to see what the inbound path did with a message.
