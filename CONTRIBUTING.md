# Contributing to `antigravity-usage`

Pull requests, new DOM selectors (`QUESTION_RE`, `BUSY_RE`, `DONE_RE`), and quota payload updates are welcome!

## Design & Security Constraints

1. **Single-file, zero dependencies, `@grant none`:** The script intercepts `window.fetch`, `XMLHttpRequest`, `WebSocket`, and `Element.prototype.attachShadow` in page context, so it must stay `@grant none` (no sandbox grants).
2. **Never persist auth headers:** Captured replay requests (`memReplayReq`, which may include `Authorization` headers) must stay strictly in tab memory — `localStorage` (`ag_quota_replay_v1`) may only store `{ url, method, body }`.
3. **Validate cross-frame messages:** Keep `okFrameMsg(e)` (`e.source !== window && e.source.top === window`, origin allowlist) and `sanitizeQuotaPayload` / type checks instead of `Object.assign` over untrusted payloads.
4. **Skip SSE & large bodies:** Keep `text/event-stream` and `content-length > 2e6` guards before `clone().text()`.
5. **Version sync:** Keep `// @version` and `const VERSION = '...'` identical (checked by CI).
6. **Shared helper blocks:** `setFav`, `away`, `notify`, `closeN`, `claimOnce`, and Web Audio playback (`ensureAudio` / stale beep rejection) are shared with [`claude-code-usage`](https://github.com/wojtulab/claude-code-usage).

## Before Opening a PR

1. Run syntax and version checks:
   ```bash
   node --check antigravity-quota.user.js
   ```
2. Bump both `// @version` and `const VERSION` so Tampermonkey/Violentmonkey auto-updates pick up the change.
3. Note which browser, userscript manager, and Antigravity UI build you tested on.

## Debugging DOM & Network Patterns

1. Open DevTools (`F12` → Console) on `antigravity.google`.
2. Run `__agDiag()` to verify which frame hostnames detected conversation rows.
3. Run `__agDumpRows()` while an agent is working / asking a question / idle to inspect attributes for `BUSY_RE`, `QUESTION_RE`, and `DONE_RE`.
4. Watch for `[AG Quota] candidate` messages in console if Antigravity changes its network response format.
