'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, type Preferences } from '@/lib/api';

const MODES: Array<[string, string]> = [
  ['instant', 'Every email, as it arrives'],
  ['priority_only', 'Only what looks important'],
  ['digest', 'A summary at set times'],
  ['off', 'Nothing for now'],
];

/**
 * When and how notifications arrive.
 *
 * Every field here can silence notifications, so the screen says what each one
 * does rather than naming the column. "Nothing for now" is a real option and is
 * listed as one — a user who wants quiet will otherwise find a way to get it
 * that we cannot see, like blocking the number.
 *
 * Saves are per-field and partial, which matches the API. A form that PUT the
 * whole object would race with a second tab and silently revert whatever was
 * changed there.
 */
export function SettingsForm() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    endpoints
      .preferences()
      .then(setPrefs)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  async function save(patch: Partial<Preferences>) {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      // The response is the stored row, so the form shows what was actually
      // saved rather than what was typed — which is how a rejected value stops
      // looking accepted.
      setPrefs(await endpoints.updatePreferences(patch));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
      // Re-read, so a rejected change does not linger on screen looking applied.
      load();
    } finally {
      setSaving(false);
    }
  }

  if (prefs === null) return <p>Loading…</p>;

  return (
    <section>
      <h2>Notifications</h2>

      <div className="card">
        <label>
          <span>How you hear about new email</span>
          <select
            value={prefs.notificationMode}
            disabled={saving}
            onChange={(e) => void save({ notificationMode: e.target.value })}
          >
            {MODES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Digest times, comma separated (24-hour, like 08:00)</span>
          <input
            defaultValue={prefs.digestTimes.join(', ')}
            disabled={saving}
            onBlur={(e) =>
              void save({
                digestTimes: e.target.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>

        <label>
          <span>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 8 }}
              checked={prefs.quietHoursEnabled}
              disabled={saving}
              onChange={(e) => void save({ quietHoursEnabled: e.target.checked })}
            />
            Hold notifications overnight
          </span>
        </label>

        {prefs.quietHoursEnabled ? (
          <div className="row" style={{ gap: 12 }}>
            <label style={{ flex: 1 }}>
              <span>From</span>
              <input
                defaultValue={prefs.quietHoursStart}
                disabled={saving}
                onBlur={(e) => void save({ quietHoursStart: e.target.value.trim() })}
              />
            </label>
            <label style={{ flex: 1 }}>
              <span>Until</span>
              <input
                defaultValue={prefs.quietHoursEnd}
                disabled={saving}
                onBlur={(e) => void save({ quietHoursEnd: e.target.value.trim() })}
              />
            </label>
          </div>
        ) : null}

        <label>
          <span>Signature added to replies you send from WhatsApp</span>
          <textarea
            rows={2}
            defaultValue={prefs.signature ?? ''}
            disabled={saving}
            onBlur={(e) => void save({ signature: e.target.value.trim() || null })}
          />
        </label>

        {error ? <p className="error">{error}</p> : null}
        {saved && !error ? <p className="muted">Saved.</p> : null}
      </div>
    </section>
  );
}
