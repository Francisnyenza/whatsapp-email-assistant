# Engine inspector

A self-contained page that runs the shipped engine in a browser, so the parts that
are hardest to reason about can be prodded at directly:

- `parseCommand` — deterministic intent parsing
- `buildEmailNotification` — the WhatsApp card, clamped to Meta's limits
- `buildReplyHeaders` + `composeMime` — threading and RFC 5322 composition
- `decideDelivery` — the 24-hour messaging window and notification policy

**Nothing here is reimplemented for the browser.** `entry.ts` imports from each
package's compiled `dist/`, so a change to the real logic changes the page.

Two Node built-ins need substitutes in a browser, both narrow and both verified:

| Shim             | Why                                                                                                        | Verification                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `crypto-shim.js` | `randomBytes` for MIME boundaries; `createHash` is synchronous by design and WebCrypto's `digest` is async | SHA-256 checked against the FIPS 180-4 `"abc"` vector |
| `buffer-shim.js` | `Buffer` for utf8/base64 conversion in bodies and encoded-words                                            | Round-trips through the composer in the browser test  |

## Building

```bash
pnpm -r build                        # packages must be built first
./build.sh                           # bundles and writes page.html
```

`page.html` is generated — edit `index.html` and rebuild.
