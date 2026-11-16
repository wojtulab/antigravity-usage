## Summary
<!-- What does this PR fix or add? -->

## Checklist
- [ ] `node --check antigravity-quota.user.js` passes
- [ ] Bumped both `// @version` in the header and `const VERSION` in the code identically
- [ ] Kept `@grant none` (needed for `fetch`/`XHR` interception without Tampermonkey sandbox)
- [ ] Request headers stay in tab memory only (never saved to `localStorage`) and `postMessage` keeps `okFrameMsg` / schema validation
- [ ] Tested on live `antigravity.google` (or described how it was verified)
- [ ] Attached screenshot if UI / overlay layout changed
