import type { CheckLevel, CheckResult } from './types.js';

/**
 * The report, as text.
 *
 * Rendering is separated from checking for the ordinary reason — it can be
 * tested — and kept deliberately plain. No colour library, no spinner: this
 * output is as likely to be pasted into an issue or captured by CI as read on a
 * terminal, and escape codes make it worse in both.
 */

export interface ReportSection {
  title: string;
  results: CheckResult[];
}

const SYMBOL: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };

const RANK: Record<CheckLevel, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst thing found, which is what the exit code is about. */
export function worstLevel(results: CheckResult[]): CheckLevel {
  return results.reduce<CheckLevel>(
    (worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst),
    'ok',
  );
}

/**
 * Non-zero only on `fail`.
 *
 * A warning must not fail a script. Polling instead of push and AI switched off
 * are both supported ways to run, and an exit code that treats them as broken
 * makes the check unusable in the one place it is most useful — the step before
 * a deploy.
 */
export function exitCodeFor(level: CheckLevel): number {
  return level === 'fail' ? 1 : 0;
}

/** One line per check, with the fix indented beneath the ones that have one. */
function renderResult(result: CheckResult, width: number): string[] {
  const head = `  ${SYMBOL[result.level]} ${result.name.padEnd(width)}  ${result.detail}`;
  if (!result.fix) return [head];

  // Indented to the detail column so the eye follows one check down rather than
  // reading the fix as a new row.
  return [head, `    ${' '.repeat(width)}  \u2192 ${result.fix}`];
}

export function renderReport(sections: ReportSection[]): string {
  const width = Math.max(0, ...sections.flatMap((s) => s.results.map((r) => r.name.length)));

  const lines: string[] = [];

  for (const section of sections) {
    if (section.results.length === 0) continue;
    lines.push('', section.title);
    for (const result of section.results) lines.push(...renderResult(result, width));
  }

  const all = sections.flatMap((s) => s.results);
  const failed = all.filter((r) => r.level === 'fail').length;
  const warned = all.filter((r) => r.level === 'warn').length;

  lines.push('');
  if (failed > 0) {
    lines.push(
      `${failed} check${failed === 1 ? '' : 's'} failed. Each → above is the thing to change.`,
    );
  } else if (warned > 0) {
    lines.push(
      `Ready. ${warned} warning${warned === 1 ? '' : 's'} — none of them stop it working, but read them before you judge what you see.`,
    );
  } else {
    lines.push('Ready.');
  }

  return `${lines.join('\n')}\n`;
}
