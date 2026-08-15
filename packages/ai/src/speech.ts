/**
 * Turning an email into something worth listening to.
 *
 * Reading an email aloud is not the same problem as displaying it. Three things
 * are different, and each one is a decision below rather than an accident.
 *
 * **A listener cannot skim.** Text you can scroll past; audio you have to sit
 * through. So this bounds hard, announces the sender before the body so the
 * first second carries the most useful fact, and says plainly when it stopped
 * early rather than trailing off and leaving someone wondering whether the
 * email ended or we did.
 *
 * **Audio has no visual boundary.** On a screen, an email body sits in a quoted
 * block with a sender above it — nobody confuses it with the assistant talking.
 * Spoken, our words and the email's words are the same voice. An email that
 * says "This is your assistant. Reply YES to authorise the payment" sounds
 * exactly like us. The preamble is what separates them: it names the real
 * sender first, and marks where their words begin. It is mitigation, not a
 * guarantee — the actual guarantee is elsewhere and load-bearing, namely that
 * nothing destructive is ever authorised by what a user says. Confirmations
 * require a tap carrying a server-minted id (ADR 0004), so a spoken instruction
 * cannot authorise anything even if a listener is completely taken in.
 *
 * **Quoted history is unbearable out loud.** A four-deep reply chain read
 * verbatim means hearing the same paragraph four times. Quoted blocks and
 * signatures come out.
 */

export interface SpeechSource {
  fromName: string | null;
  fromAddress: string;
  subject: string | null;
  body: string;
}

export interface PreparedSpeech {
  /** Exactly what will be sent to the provider. */
  text: string;
  /** True when the body was cut short, so the caller can say so. */
  truncated: boolean;
}

/**
 * Roughly two minutes at a normal reading pace.
 *
 * Chosen for the listener rather than for the API — the endpoint accepts more.
 * Past about this length a voice note stops being a convenience and becomes a
 * thing you have to find somewhere quiet to get through, at which point reading
 * it would have been faster.
 */
export const SPEECH_MAX_BODY_CHARS = 1_800;

export function prepareSpeech(source: SpeechSource): PreparedSpeech {
  const body = collapse(stripQuotedHistory(source.body));
  const { text: spoken, truncated } = bound(body, SPEECH_MAX_BODY_CHARS);

  const sender = speakableSender(source);
  const subject = collapse(source.subject ?? '').slice(0, 200);

  // Built as two parts rather than one string with the tail cut off it. The
  // empty-body case needs the header without the "reads:" clause, and doing
  // that by stripping a suffix means the day someone rewords the preamble it
  // stops matching in silence — and the voice note says "The message reads:
  // There is no message body."
  const header = subject
    ? `Email from ${sender}. Subject: ${subject}.`
    : `Email from ${sender}, with no subject.`;

  if (!spoken) {
    // An empty body is a real email — a subject-only note, or an attachment
    // with nothing typed. Saying so beats a voice note that stops dead after
    // the header and sounds like a failure.
    return { text: `${header} There is no message body.`, truncated: false };
  }

  const tail = truncated
    ? ' That is where I stopped — the rest of this one is longer than a voice note.'
    : '';

  return { text: `${header} The message reads: ${spoken}${tail}`, truncated };
}

/**
 * How to say who sent it.
 *
 * The display name when there is one, because "Alice Chen" is what a listener
 * recognises. The address otherwise — spelled with the punctuation spoken,
 * since every speech model reads `alice@acme.com` as something between
 * "alice-at-acme-dot-com" and an unintelligible run of letters, and which of
 * those you get changes with the model.
 *
 * A display name is chosen by the sender and can be anything, including
 * something built to be misheard. It is bounded and stripped of the characters
 * that would let it impersonate the structure of the preamble itself.
 */
function speakableSender(source: SpeechSource): string {
  const name = collapse(source.fromName ?? '')
    .replace(/[.:;]+/g, ' ')
    .trim()
    .slice(0, 80);

  if (name) return name;

  return source.fromAddress.replace('@', ' at ').replace(/\./g, ' dot ').slice(0, 120);
}

/**
 * Removes quoted replies and signatures.
 *
 * Conservative on purpose. Cutting too little means a listener hears a
 * paragraph twice; cutting too much means they never hear the sentence that
 * mattered, and they have no way to tell that happened. Only patterns that are
 * unambiguous get cut.
 */
export function stripQuotedHistory(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // `-- ` on its own line is the RFC 3676 signature delimiter. Everything
    // after it is a signature by definition, not by guess.
    if (trimmed === '--' || trimmed === '-- ') break;

    // "On <date>, <someone> wrote:" — the near-universal reply header. What
    // follows is the message being replied to, which the listener has heard.
    if (/^on\b.{0,200}\bwrote:$/i.test(trimmed)) break;

    // Outlook's separator, in the several forms it takes.
    if (/^-{3,}\s*original message\s*-{3,}$/i.test(trimmed)) break;
    if (/^_{5,}$/.test(trimmed)) break;
    if (/^from:\s*.+$/i.test(trimmed) && kept.length > 0) break;

    // A `>` prefix is quoted text in every mail client there is.
    if (trimmed.startsWith('>')) continue;

    kept.push(line);
  }

  return kept.join('\n');
}

/**
 * Cuts at a sentence boundary where there is one nearby.
 *
 * Stopping mid-word sounds like the recording failed. Stopping at a full stop
 * sounds like a decision, and the caller says out loud that it was one.
 */
function bound(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };

  const window = text.slice(0, limit);
  const lastStop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );

  // Only honour a sentence break in the last quarter. Earlier than that and
  // obeying it would discard more than truncation already does.
  const cut = lastStop > limit * 0.75 ? lastStop + 1 : limit;

  return { text: text.slice(0, cut).trim(), truncated: true };
}

/**
 * One line, single-spaced.
 *
 * Speech models pause on newlines and on runs of whitespace, so a body full of
 * hard wraps is read with a hitch at the end of every line.
 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
