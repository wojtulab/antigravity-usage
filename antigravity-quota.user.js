// ==UserScript==
// @name         Antigravity Usage Overlay (Deep Scraper v3)
// @namespace    https://github.com/wojtulab/antigravity-usage
// @version      3.10.2
// @description  Automatic Antigravity quota overlay for Gemini and Claude/GPT with idle/question alerts
// @homepageURL  https://github.com/wojtulab/antigravity-usage
// @supportURL   https://github.com/wojtulab/antigravity-usage/issues
// @updateURL    https://raw.githubusercontent.com/wojtulab/antigravity-usage/main/antigravity-quota.user.js
// @downloadURL  https://raw.githubusercontent.com/wojtulab/antigravity-usage/main/antigravity-quota.user.js
// @match        https://antigravity.google/*
// @match        https://*.antigravity.google/*
// @match        https://antigravity.google.com/*
// @match        https://*.antigravity.google.com/*
// @match        https://*.google.com/*
// @match        https://*.googleusercontent.com/*
// @match        https://*.usercontent.goog/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const isTopWindow = (window.self === window.top);
  const shadowRoots = new Set();
  let onNewRoot = null; // set when detection starts (observe mutations inside Shadow DOM as well)

  // 1. Intercept all Shadow DOM roots (including closed ones: mode === 'closed')
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = origAttachShadow.call(this, init);
      shadowRoots.add(root);
      try { if (onNewRoot) onNewRoot(root); } catch (e) {}
      return root;
    };
  } catch (e) {}

  // 1b. Network sniffer: the Usage panel only fetches limits when its menu is opened.
  // We remember that request and replay it every minute so the overlay refreshes automatically.
  const REPLAY_KEY = 'ag_quota_replay_v1';
  const REPLAY_INTERVAL_MS = 60 * 1000;
  const isAgFrame = /antigravity/i.test(location.hostname) ||
    [...(location.ancestorOrigins || [])].some((o) => /antigravity/i.test(o)) ||
    /antigravity/i.test(document.referrer);
  const origFetch = window.fetch;
  const TAB_ID = Math.random().toString(36).slice(2, 5);
  // Multi-tab coordination: only the tab that wins the claim sends the alert for an event. Write TAB_ID+time to localStorage,
  // read back after ~50 ms (last write visible to all tabs wins); key fresher than ttlMs held by another tab → false.
  // Shared block with claude-usage.user.js: change in one = change in both.
  function claimOnce(key, ttlMs) {
    const k = 'ide_claim_' + key;
    try {
      const cur = JSON.parse(localStorage.getItem(k) || 'null');
      if (cur && cur.id !== TAB_ID && Date.now() - cur.t < ttlMs) return Promise.resolve(false);
      localStorage.setItem(k, JSON.stringify({ id: TAB_ID, t: Date.now() }));
    } catch (e) { return Promise.resolve(true); }
    return new Promise((res) => setTimeout(() => {
      try { const c = JSON.parse(localStorage.getItem(k) || 'null'); res(!c || c.id === TAB_ID); } catch (e) { res(true); }
    }, 50));
  }
  const VERSION = '3.10.2'; // single version constant in code (alongside @version in header); README does not duplicate it
  // Accept cross-frame messages only from child frames of this window on Antigravity/Google origins.
  const okOrigin = (o) => { try { return /(^|\.)(antigravity\.google|google\.com|googleusercontent\.com|usercontent\.goog)$/.test(new URL(o).hostname); } catch (e) { return false; } };
  function okFrameMsg(e) {
    if (!e || !e.source || e.source === window) return false;
    try { if (e.source.top !== window) return false; } catch (err) { return false; }
    return okOrigin(e.origin) && !!e.data && typeof e.data === 'object';
  }

  // Finds objects with remainingFraction in JSON; derives model family (Gemini / Claude+GPT) and window (Weekly / 5h)
  // from labels on the object and its ancestors. Note: works only for named-field JSON;
  // for JSPB/protobuf, candidates are logged to console ([AG Quota] candidate) for extending the parser.
  function parseQuotaPayload(text) {
    const out = {};
    if (typeof text !== 'string' || !/remaining.?fraction/i.test(text)) return out;
    let data;
    try { data = JSON.parse(text.replace(/^\)\]\}'\s*/, '')); } catch (e) { return out; }
    const LABEL_KEYS = ['displayName', 'display_name', 'label', 'name', 'title', 'refreshWindowLabel',
      'refresh_window_label', 'quotaType', 'quota_type', 'tokenType', 'token_type', 'group', 'id'];
    (function walk(o, ctx) {
      if (!o || typeof o !== 'object') return;
      const here = ctx + ' ' + LABEL_KEYS.map((k) => o[k]).filter((v) => typeof v === 'string').join(' ');
      for (const [k, v] of Object.entries(o)) {
        if (/remaining.?fraction/i.test(k) && typeof v === 'number') {
          const fam = /claude|gpt|anthropic|openai/i.test(here) ? 'claude' : (/gemini/i.test(here) ? 'gemini' : null);
          const win = /week|7.?d|seven/i.test(here) ? 'Weekly' : (/5.?h|five|hour/i.test(here) ? '5h' : null);
          const key = fam && win && fam + win;
          if (key && !(key in out)) out[key] = Math.round(v * 100) + '%'; // first group = "... Models"
        } else {
          walk(v, here);
        }
      }
    })(data, '');
    return out;
  }

  // Full request object (with headers, e.g. Authorization) stays in tab memory only — never written to localStorage.
  let memReplayReq = null;
  function saveReplayReq(req) {
    if (!req || (req.method !== 'GET' && req.body == null)) return;
    memReplayReq = req;
    try { localStorage.setItem(REPLAY_KEY, JSON.stringify({ url: req.url, method: req.method, body: req.body })); } catch (e) {}
  }

  function sniff(text, req) {
    if (typeof text !== 'string' || text.length > 2e6) return;
    const q = parseQuotaPayload(text);
    if (Object.keys(q).length) {
      commitState(q, 'Network');
      saveReplayReq(req);
    } else if (isAgFrame && (/quota|remaining.?fraction|refreshWindowLabel/i.test(text) ||
               (/gemini/i.test(text) && /claude/i.test(text)))) {
      console.info('[AG Quota] candidate', req && req.url, text.slice(0, 4000));
    }
  }

  try {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const rawHeaders = (init && init.headers) || (input && typeof input === 'object' && input.headers) || null;
        const req = {
          url: typeof input === 'string' ? input : String(input && input.url),
          method: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
          body: init && typeof init.body === 'string' ? init.body : null,
          headers: rawHeaders ? Object.fromEntries(new Headers(rawHeaders)) : {}
        };
        p.then((r) => {
          if (!r || !r.ok) return null;
          const ct = (r.headers && r.headers.get('content-type')) || '';
          const cl = parseInt((r.headers && r.headers.get('content-length')) || '', 10);
          if (/text\/event-stream/i.test(ct) || cl > 2e6) return null;
          return r.clone().text();
        }).then((t) => { if (t) sniff(t, req); }).catch(() => {});
      } catch (e) {}
      return p;
    };

    const XP = XMLHttpRequest.prototype;
    const xOpen = XP.open, xSend = XP.send, xHeader = XP.setRequestHeader;
    XP.open = function (method, url) {
      this._agReq = { url: String(url), method: String(method).toUpperCase(), body: null, headers: {} };
      return xOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function (k, v) {
      if (this._agReq) this._agReq.headers[k] = v;
      return xHeader.apply(this, arguments);
    };
    XP.send = function (body) {
      if (this._agReq) {
        this._agReq.body = typeof body === 'string' ? body : null;
        this.addEventListener('load', () => {
          if (this.responseType !== '' && this.responseType !== 'text') return;
          const ct = this.getResponseHeader('content-type') || '';
          const cl = parseInt(this.getResponseHeader('content-length') || '', 10);
          if (/text\/event-stream/i.test(ct) || cl > 2e6) return;
          sniff(this.responseText, this._agReq);
        });
      }
      return xSend.apply(this, arguments);
    };

    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => { if (typeof e.data === 'string') sniff(e.data, null); });
      }
    };
  } catch (e) {}

  function replayQuotaRequest() {
    let r = memReplayReq;
    if (!r) {
      try {
        const s = JSON.parse(localStorage.getItem(REPLAY_KEY));
        if (s && typeof s.url === 'string') {
          r = { url: s.url, method: String(s.method || 'GET'), body: typeof s.body === 'string' ? s.body : null };
        }
      } catch (e) {}
    }
    if (!r) return;
    const opts = { method: r.method, body: r.body || undefined, credentials: 'include' };
    if (r.headers && typeof r.headers === 'object') opts.headers = r.headers;
    origFetch(r.url, opts)
      .then((res) => {
        if (!res || !res.ok) return null;
        const ct = (res.headers && res.headers.get('content-type')) || '';
        const cl = parseInt((res.headers && res.headers.get('content-length')) || '', 10);
        if (/text\/event-stream/i.test(ct) || cl > 2e6) return null;
        return res.text();
      })
      .then((t) => { if (t) sniff(t, null); })
      .catch(() => {});
  }
  if (isAgFrame) setInterval(replayQuotaRequest, REPLAY_INTERVAL_MS);

  const QUOTA_STR_KEYS = [
    'geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h', 'argonWeekly',
    'geminiWeeklyReset', 'gemini5hReset', 'claudeWeeklyReset', 'claude5hReset', 'argonWeeklyReset',
    'argonName', 'custom', 'lastUpdated', 'source'
  ];
  function sanitizeQuotaPayload(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const clean = {};
    for (const k of QUOTA_STR_KEYS) {
      if (typeof p[k] === 'string') clean[k] = p[k].slice(0, 60);
    }
    if (typeof p.customPct === 'number' && Number.isFinite(p.customPct)) {
      clean.customPct = Math.max(0, Math.min(1000, p.customPct));
    }
    return Object.keys(clean).length ? clean : null;
  }

  let quotaState = {
    geminiWeekly: '?',
    gemini5h: '?',
    claudeWeekly: '?',
    claude5h: '?',
    argonWeekly: '?',
    argonName: 'Gemini 4 Argon',
    lastUpdated: null,
    source: 'Waiting...'
  };

  // 2. Load cached quota data from localStorage
  try {
    const cached = localStorage.getItem('ag_quota_state_v3');
    if (cached) {
      const clean = sanitizeQuotaPayload(JSON.parse(cached));
      if (clean) Object.assign(quotaState, clean);
      quotaState.source = 'Cached';
    }
  } catch (e) {}

  // Strip invisible Unicode characters (Zero-Width, LTR/RTL isolates) that break RegExp matching
  function normalizeText(str) {
    return (str || '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 3. Build a continuous text stream across DOM, open/closed Shadow DOM, and same-origin iframes
  function getFullTextStream() {
    const chunks = [];
    const visited = new Set();

    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);

      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.id === 'antigravity-usage-overlay') return;

        // Collect ARIA values (in case progress bars lack visible text)
        const ariaLabel = node.getAttribute('aria-label');
        const ariaNow = node.getAttribute('aria-valuenow');
        if (ariaLabel) chunks.push(ariaLabel);
        if (ariaNow) chunks.push(ariaNow + '%');

        if (node.shadowRoot) {
          shadowRoots.add(node.shadowRoot);
          walk(node.shadowRoot);
        }

        if (node.tagName === 'IFRAME') {
          try {
            if (node.contentDocument) walk(node.contentDocument);
          } catch (e) {}
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue;
        if (val && val.trim()) chunks.push(val);
      }

      const children = node.childNodes;
      if (children && children.length) {
        for (let i = 0; i < children.length; i++) {
          walk(children[i]);
        }
      }
    }

    if (document.body) {
      // Also include main body innerText as a continuous block
      chunks.push(document.body.innerText || '');
      walk(document.body);
    }

    // Walk all intercepted ShadowRoots (including closed ones)
    shadowRoots.forEach((root) => {
      walk(root);
    });

    return normalizeText(chunks.join(' '));
  }

  // 4a. "% left" format: sections "Gemini Models", "Claude and GPT models", "Gemini 4 Argon";
  // "Weekly limit / Resets in 1d 5h / 79% left", 5h similarly; Argon shows "98% left Weekly limit, resets in 6d 23h".
  function scrapeLeftFormat(stream) {
    const heads = [...stream.matchAll(/Gemini\s+Models|Claude\s+and\s+GPT\s+models|Gemini\s+\d+\s+[A-Z]\w+/gi)];
    if (!/%\s*left/i.test(stream) || !heads.length) return false;
    const RESET = /resets\s+in\s+((?:\d+\s*[wdhms]\s*)+)/i;
    let found = false;
    heads.forEach((h, i) => {
      const seg = stream.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
      const name = h[0].replace(/\s+/g, ' ').trim();
      const fam = /claude/i.test(name) ? 'claude' : (/models/i.test(name) ? 'gemini' : 'argon');
      const set = (win, pct, reset) => {
        quotaState[fam + win] = pct + '%';
        quotaState[fam + win + 'Reset'] = reset ? reset.trim() : '';
        found = true;
      };
      let hitA = false;
      for (const m of seg.matchAll(/(Weekly|5\s*-?\s*h(?:our)?|Five\s+Hour)\s+limit(.*?)(\d{1,3})\s*[%％]\s*left/gi)) {
        const r = RESET.exec(m[2]);
        set(/week/i.test(m[1]) ? 'Weekly' : '5h', m[3], r && r[1]);
        hitA = true;
      }
      if (!hitA) for (const m of seg.matchAll(/(\d{1,3})\s*[%％]\s*left\s*(Weekly|5\s*-?\s*h(?:our)?)\s+limit,?(.{0,40})/gi)) {
        const r = RESET.exec(m[3]);
        set(/week/i.test(m[2]) ? 'Weekly' : '5h', m[1], r && r[1]);
      }
      if (fam === 'argon') quotaState.argonName = name;
    });
    return found;
  }

  // 4. Parse the continuous text stream
  function scrapeLimits() {
    const stream = getFullTextStream();
    if (!stream) return false;

    // Settings → Customizations: "172 / 20,000 tokens (0.9%)" — rules/skills/MCP budget (used, not remaining)
    const cm = /Customizations\s+([\d,]+)\s*\/\s*([\d,]+)\s*tokens\s*\(([\d.]+)\s*%\)/i.exec(stream);
    if (cm && quotaState.custom !== cm[1] + '/' + cm[2]) {
      quotaState.custom = cm[1] + '/' + cm[2];
      quotaState.customPct = parseFloat(cm[3]);
      commitState({}, quotaState.source);
    }

    if (!/%\s*left/i.test(stream)) return false;

    const foundAny = scrapeLeftFormat(stream);
    if (foundAny) commitState({}, 'Live');

    return foundAny;
  }

  // Persist to localStorage and postMessage only when values change (or every 30s) — Usage panel open reads every 1s.
  let lastSig = '', lastPersist = 0;
  function commitState(partial, source) {
    Object.assign(quotaState, partial);
    quotaState.lastUpdated = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    quotaState.source = source;
    const sig = JSON.stringify(quotaState, (k, v) => (k === 'lastUpdated' ? undefined : v));
    if (sig === lastSig && Date.now() - lastPersist < 30000) return;
    lastSig = sig; lastPersist = Date.now();

    try {
      localStorage.setItem('ag_quota_state_v3', JSON.stringify(quotaState));
    } catch (e) {}

    // If data was scraped inside an iframe, forward it immediately to the top window
    if (!isTopWindow) {
      try {
        window.top.postMessage({ type: 'AG_QUOTA_SYNC', payload: quotaState }, '*');
      } catch (e) {}
    }
    renderOverlay();
  }

  // Draggable overlay with saved position (opacity is managed by applyCfg)
  function makeMovable(el, key) {
    const st = document.createElement('style');
    st.textContent = `#${el.id}{transition:opacity .2s;touch-action:none}`;
    document.head.appendChild(st);

    function place(x, y) {
      x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    }
    try {
      const p = JSON.parse(localStorage.getItem(key));
      if (p) place(p.x, p.y);
    } catch (e) {}

    let drag = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input,label,button')) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return; // normal click
      moved = true;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    el.addEventListener('pointerup', () => {
      if (drag && moved) {
        try { localStorage.setItem(key, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (e) {}
      }
      drag = null;
    });
    // Suppress refresh click after dragging
    el.addEventListener('click', (e) => {
      if (moved) { e.stopImmediatePropagation(); moved = false; }
    }, true);
    window.addEventListener('resize', () => { if (el.style.left) place(el.offsetLeft, el.offsetTop); });
  }

  // 5. UI renderer (top window only)
  function makeBadge(val) {
    const el = document.createElement('b');
    el.textContent = val;
    const num = parseInt(val, 10);
    if (isNaN(num)) el.style.color = '#aaa';
    else if (num > 50) el.style.color = '#4caf50';
    else if (num > 20) el.style.color = '#ff9800';
    else el.style.color = '#f44336';
    return el;
  }

  function renderRow(label, val, reset, key) {
    const row = document.createElement('div');
    const fc = key ? forecast(key) : null;
    if (fc) row.title = 'Rate ' + fc.rate.toFixed(1) + '%/h → limit in ~' + fmtDur(fc.etaMs) + (fc.before ? ' (before reset)' : ' (lasts until reset)');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;font-size:11px;';
    const l = document.createElement('span');
    l.textContent = label;
    row.appendChild(l);
    const right = document.createElement('span');
    if (fc && fc.before) { // show warning only when quota runs out before reset
      const f = document.createElement('small');
      f.style.cssText = 'color:#ff8a80;font-size:9px;margin-right:6px;';
      f.textContent = '⏱ ~' + fmtDur(fc.etaMs);
      right.appendChild(f);
    }
    if (reset) {
      const r = document.createElement('small');
      r.style.cssText = 'color:#888;font-size:9px;margin-right:6px;';
      r.textContent = '↻ ' + reset;
      right.appendChild(r);
    }
    right.appendChild(makeBadge(val));
    row.appendChild(right);
    return row;
  }

  function renderOverlay() {
    if (!isTopWindow) return;
    checkLow();
    const el = document.getElementById('antigravity-usage-overlay');
    if (!el) return;

    while (el.firstChild) el.removeChild(el.firstChild);

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:4px;';
    const title = document.createElement('span');
    title.textContent = '🚀 Antigravity Quota';
    const status = document.createElement('span');
    status.style.cssText = 'font-size:9px;color:#888;';
    const gear = document.createElement('span');
    gear.textContent = '⚙';
    gear.title = 'Settings';
    gear.style.cssText = 'cursor:pointer;font-size:13px;margin-left:8px;';
    gear.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); askNotifyPermission(); openSettings(); };
    status.textContent = quotaState.source;
    head.appendChild(title);
    status.appendChild(gear);
    head.appendChild(status);
    el.appendChild(head);

    const geminiTitle = document.createElement('div');
    geminiTitle.style.cssText = 'color:#8ab4f8;font-weight:600;font-size:11px;margin-bottom:3px;';
    geminiTitle.textContent = 'Gemini Models:';
    el.appendChild(geminiTitle);
    el.appendChild(renderRow('• Weekly:', quotaState.geminiWeekly, quotaState.geminiWeeklyReset, 'geminiWeekly'));
    el.appendChild(renderRow('• 5h:', quotaState.gemini5h, quotaState.gemini5hReset, 'gemini5h'));

    const claudeTitle = document.createElement('div');
    claudeTitle.style.cssText = 'color:#c58af9;font-weight:600;font-size:11px;margin-top:6px;margin-bottom:3px;';
    claudeTitle.textContent = 'Claude & GPT Models:';
    el.appendChild(claudeTitle);
    el.appendChild(renderRow('• Weekly:', quotaState.claudeWeekly, quotaState.claudeWeeklyReset, 'claudeWeekly'));
    el.appendChild(renderRow('• 5h:', quotaState.claude5h, quotaState.claude5hReset, 'claude5h'));

    if (quotaState.argonWeekly && quotaState.argonWeekly !== '?') {
      const argonTitle = document.createElement('div');
      argonTitle.style.cssText = 'color:#81c995;font-weight:600;font-size:11px;margin-top:6px;margin-bottom:3px;';
      argonTitle.textContent = (quotaState.argonName || 'Gemini 4 Argon') + ':';
      el.appendChild(argonTitle);
      el.appendChild(renderRow('• Weekly:', quotaState.argonWeekly, quotaState.argonWeeklyReset, 'argonWeekly'));
    }

    if (quotaState.custom) {
      const row = renderRow('Customizations:', quotaState.custom.replace(/,/g, ''));
      const b = row.lastChild.lastChild; // usage: inverted colors compared to "remaining"
      b.style.color = quotaState.customPct > 80 ? '#f44336' : quotaState.customPct > 50 ? '#ff9800' : '#4caf50';
      b.textContent = quotaState.custom.replace(/,/g, '').replace(/\/(\d+)$/, (m, n) => '/' + (n / 1000) + 'k');
      b.title = 'Rules/skills/MCP tokens: ' + quotaState.customPct + '% of budget (Settings → Customizations)';
      row.style.marginTop = '6px';
      el.appendChild(row);
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'font-size:9px;color:#666;margin-top:6px;border-top:1px solid #333;padding-top:4px;display:flex;justify-content:space-between;';
    const auto = document.createElement('span');
    auto.textContent = 'Live v' + VERSION;
    const time = document.createElement('span');
    time.textContent = quotaState.lastUpdated ? `Status: ${quotaState.lastUpdated}` : 'No data';
    footer.appendChild(auto);
    footer.appendChild(time);
    el.appendChild(footer);
  }

  // Settings: ⚙ panel in overlay header, saved to localStorage (ag_quota_cfg_v1). CFG_SCHEMA entries: [key, label, type, default].
  const CFG_SCHEMA = [
    ['qFrame', 'Question: pulsing border', 'bool', true],
    ['qSound', 'Question: sound', 'bool', true],
    ['qNotify', 'Question: browser notification', 'bool', true],
    ['qTitle', 'Question: ❓ in tab title', 'bool', true],
    ['qRepeatSec', 'Question: repeat every (s, 0 = once)', 'num', 60],
    ['dSound', 'Work done / low quota: sound', 'bool', true],
    ['dNotify', 'Work done / low quota: notification', 'bool', true],
    ['dBlink', 'Work done: blink ✅ in title + green icon (silent)', 'bool', true],
    ['dMinSec', 'Work done: min work time (s)', 'num', 5],
    ['dRepeatSec', 'Work done: repeat every (s, 0 = off)', 'num', 0],
    ['lowPct', 'Low quota: alert below (%, 0 = off)', 'num', 10],
    ['fcMin', 'Forecast: alert if limit ends within (min, 0 = off)', 'num', 30],
    ['hiddenOnly', 'Notifications only when tab is in background', 'bool', true],
    ['opacityIdle', 'Opacity (%)', 'num', 50],
    ['opacityHover', 'Opacity on hover (%)', 'num', 90]
  ];
  const cfg = Object.fromEntries(CFG_SCHEMA.map((s) => [s[0], s[3]]));
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('ag_quota_cfg_v1')) || {}); } catch (e) {}

  function applyCfg() {
    let st = document.getElementById('antigravity-usage-overlay-cfgstyle');
    if (!st) { st = document.createElement('style'); st.id = 'antigravity-usage-overlay-cfgstyle'; document.head.appendChild(st); }
    st.textContent = `#antigravity-usage-overlay{opacity:${cfg.opacityIdle / 100} !important}#antigravity-usage-overlay:hover{opacity:${cfg.opacityHover / 100} !important}`;
  }

  function openSettings() {
    const old = document.getElementById('antigravity-usage-overlay-cfg');
    if (old) { old.remove(); return; }
    const ov = document.getElementById('antigravity-usage-overlay');
    const r = ov ? ov.getBoundingClientRect() : { left: innerWidth - 16, bottom: innerHeight - 80 };
    const p = document.createElement('div');
    p.id = 'antigravity-usage-overlay-cfg';
    p.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e1e;color:#e0e0e0;border:1px solid #777;border-radius:8px;padding:10px 12px;font:12px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:240px;' +
      'right:' + Math.max(8, innerWidth - r.left + 8) + 'px;bottom:' + Math.max(8, innerHeight - r.bottom) + 'px;';
    const h = document.createElement('div');
    h.textContent = '⚙ Antigravity Settings';
    h.style.cssText = 'font-weight:bold;margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:4px;';
    p.appendChild(h);
    CFG_SCHEMA.forEach(([k, label, type]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin:4px 0;cursor:pointer;';
      const t = document.createElement('span'); t.textContent = label;
      const i = document.createElement('input');
      i.type = type === 'bool' ? 'checkbox' : 'number';
      if (type === 'bool') i.checked = !!cfg[k]; else { i.value = cfg[k]; i.style.width = '56px'; }
      i.onchange = () => {
        const n = parseFloat(i.value); // 0 is a valid value (e.g. "0 = once")
        cfg[k] = type === 'bool' ? i.checked : (Number.isFinite(n) && n >= 0 ? n : CFG_SCHEMA.find((s) => s[0] === k)[3]);
        if (type === 'bool' && i.checked && /Notify$/.test(k)) askNotifyPermission();
        try { localStorage.setItem('ag_quota_cfg_v1', JSON.stringify(cfg)); } catch (e) {}
        applyCfg();
      };
      row.append(t, i);
      p.appendChild(row);
    });
    const x = document.createElement('div');
    x.textContent = 'Refresh/threshold changes apply immediately; settings are stored per browser.';
    x.style.cssText = 'font-size:9px;color:#777;margin-top:6px;';
    p.appendChild(x);
    p.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(p);
  }

  // 5. Antigravity question detection: a "?" icon appears in the conversation row (next to `conversation-kebab`).
  // Icon structure unconfirmed — search row elements for keywords in aria-label/title/data-testid/class.
  // If missed: run `__agDumpRows()` in console to inspect row HTML and add patterns to QUESTION_RE.
  const QUESTION_RE = /question|help|awaiting|waiting|needs[-_ ]?(input|attention|approval|response)|pending[-_ ]?(input|approval)|user[-_ ]?input|ask(ing)?[-_ ]user|attention/i;
  let questionActive = false;

  function allRoots() {
    const roots = [document];
    shadowRoots.forEach((r) => roots.push(r));
    document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) roots.push(f.contentDocument); } catch (e) {} });
    return roots;
  }

  function conversationRows() {
    const rows = [];
    allRoots().forEach((root) => {
      root.querySelectorAll('[data-testid="conversation-kebab"]').forEach((k) => {
        rows.push(k.closest('li,[role=treeitem],[role=option],[data-testid*=conversation]:not([data-testid=conversation-kebab])') ||
          (k.parentElement && k.parentElement.parentElement) || k);
      });
    });
    return rows;
  }

  function rowHasQuestion(row) {
    return [...row.querySelectorAll('*')].some((n) => {
      if (n.getAttribute('data-testid') === 'conversation-kebab' || n.closest('[data-testid="conversation-kebab"]')) return false;
      const s = ['aria-label', 'title', 'data-testid', 'data-state', 'class'].map((a) => n.getAttribute(a) || '').join(' ');
      return QUESTION_RE.test(typeof s === 'string' ? s : '');
    });
  }

  window.__agDumpRows = () => conversationRows().forEach((r) => console.log('[AG row]', r.outerHTML));

  let frameQAt = 0; // timestamp of last AG_QUESTION=true from a child frame
  function detectQuestion(rows) {
    let qRow = null;
    try { qRow = rows.find(rowHasQuestion) || null; } catch (e) {}
    const found = !!qRow;
    const qTitle = qRow ? rowTitle(qRow) : '';
    // Top window has no rows when the list lives in an iframe: don't clear frame-reported question while signal is fresh (<3s).
    if (isTopWindow) { if (found || Date.now() - frameQAt > 3000) applyQuestion(found, qTitle); }
    else if (found || questionActive) { try { window.top.postMessage({ type: 'AG_QUESTION', value: found, title: qTitle }, '*'); } catch (e) {} }
    questionActive = found;
  }

  // Work done: conversation row had a "working" indicator (spin/loading/animation) that stopped for >=3s → alert.
  // If a "done" badge appears (dot: DONE_RE), alert immediately. Structure unconfirmed —
  // if missed, run `__agDumpRows()` while working and after completion and extend BUSY_RE / DONE_RE.
  const BUSY_RE = /spin|loading|busy|running|working|progress|generating|thinking/i;
  const DONE_RE = /unread|done|complete|finished|new[-_ ]?(message|reply|response)|status[-_ ]?dot|bg-(blue|sky|indigo)/i;
  const rowBusy = new Map(); // row key → { since, title, idleAt, seen }
  let lastSentBusy = -1;

  // Key = row link href (stable across title updates), or leading text if no link.
  function rowTitle(row) {
    const a = row.querySelector('a[href]') || row.closest('a[href]');
    const src = (a && !a.querySelector('[data-testid="conversation-kebab"]')) ? a : row;
    return (src.textContent || '').trim().slice(0, 80);
  }
  function rowKey(row) {
    const a = row.querySelector('a[href]') || row.closest('a[href]');
    return (a && a.getAttribute('href')) || rowTitle(row).slice(0, 60) || '?';
  }
  function rowState(row) {
    let busy = false, done = false;
    row.querySelectorAll('*').forEach((n) => {
      if (n.closest('[data-testid="conversation-kebab"]')) return;
      const c = n.getAttribute('class');
      const s = (typeof c === 'string' ? c : '') + ' ' + ['data-state', 'aria-label', 'data-testid', 'title'].map((a) => n.getAttribute(a) || '').join(' ');
      if (n.getAttribute('aria-busy') === 'true' || BUSY_RE.test(s)) busy = true;
      else if (DONE_RE.test(s)) done = true; // pulsing "done" dot is not active work
      else { try { const an = getComputedStyle(n).animationName; if (an && an !== 'none') busy = true; } catch (e) {} }
    });
    return { busy, done };
  }
  function detectDone(rows) {
    const now = Date.now();
    rows.forEach((row) => {
      const key = rowKey(row), st = rowState(row);
      let rec = rowBusy.get(key);
      if (st.busy) {
        if (!rec) rowBusy.set(key, rec = { since: now, title: rowTitle(row), idleAt: 0, seen: now });
        rec.idleAt = 0; rec.seen = now; rec.title = rowTitle(row);
        return;
      }
      if (!rec) return;
      rec.seen = now;
      if (!st.done) { // without explicit "done" badge: wait in case spinner flickers between steps
        if (!rec.idleAt) rec.idleAt = now;
        if (now - rec.idleAt < 3000) return;
      }
      rowBusy.delete(key);
      if (now - rec.since < cfg.dMinSec * 1000) return;
      if (isTopWindow) alertDone(rec.title, key);
      else { try { window.top.postMessage({ type: 'AG_DONE', title: rec.title, key }, '*'); } catch (e) {} }
    });
    rowBusy.forEach((rec, k) => { if (now - rec.seen > 30000) rowBusy.delete(k); }); // row disappeared (re-render) for too long
    let busy = 0;
    rowBusy.forEach((r) => { if (!r.idleAt) busy++; });
    if (isTopWindow) localBusy = busy;
    else if (busy !== lastSentBusy) { lastSentBusy = busy; try { window.top.postMessage({ type: 'AG_BUSY', count: busy }, '*'); } catch (e) {} }
  }
  // Colored dot in favicon during alert (static, no timer so not throttled in background).
  // Shared blocks with claude-usage.user.js (change in one = change in both): setFav, away, notify, closeN, claimOnce, audio.
  let favOrig = null, favMade = false, favColor = '';
  function setFav(color) {
    let l = document.querySelector('link[rel~="icon"]');
    if (color) {
      if (favOrig === null) {
        if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); favMade = true; }
        favOrig = l.href || '';
      }
      if (favColor === color && l && l.href.startsWith('data:')) return;
      favColor = color;
      l.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='${encodeURIComponent(color)}'/%3E%3C/svg%3E`;
    } else if (favOrig !== null) {
      if (l) { if (favMade) l.remove(); else l.href = favOrig; }
      favOrig = null; favMade = false; favColor = '';
    }
  }
  const away = () => document.hidden || !document.hasFocus(); // background tab OR unfocused window (second monitor)
  const TITLE_PREFIX_RE = /^(?:(?:🔄\d*|❓|✅) )+/;
  // Background tab title blinking on question (❓ + orange icon) or completion (✅ + green icon); question takes priority.
  let blinkT = 0, blinkOn = false, blinkPrefix = ''; // note: 1s setInterval; Chrome throttles background timers to ~1/min after ~5 min
  let localBusy = 0, frameBusy = 0, qActive = false;
  let donePending = null, doneRepeatT = 0;

  function renderTitle() {
    if (!isTopWindow) return;
    const base = document.title.replace(TITLE_PREFIX_RE, '');
    const busy = localBusy + frameBusy;
    const busyStr = busy ? '🔄' + (busy > 1 ? busy : '') + ' ' : '';
    let alertStr = '';
    if (blinkT) alertStr = blinkOn ? blinkPrefix : '';
    else if (qActive && cfg.qTitle) alertStr = '❓ ';
    const next = busyStr + alertStr + base;
    if (document.title !== next) document.title = next;
  }

  function startBlink(prefix, color) {
    if (!away()) return;
    if (prefix === '✅ ' && (!cfg.dBlink || qActive)) return; // question requires attention more urgently than completion
    if (prefix === '❓ ' && !cfg.qTitle) return;
    if (blinkT && blinkPrefix === prefix) return;
    blinkPrefix = prefix;
    blinkOn = true;
    setFav(color);
    if (!blinkT) blinkT = setInterval(() => { blinkOn = !blinkOn; renderTitle(); }, 1000);
    renderTitle();
  }
  function stopBlink(onlyPrefix) {
    if (onlyPrefix && blinkPrefix !== onlyPrefix) return;
    if (blinkT) { clearInterval(blinkT); blinkT = 0; }
    blinkPrefix = ''; blinkOn = false;
    setFav('');
    if (onlyPrefix === '❓ ' && donePending && cfg.dBlink && away()) {
      startBlink('✅ ', '#22c55e');
    } else {
      renderTitle();
    }
  }
  // Close notifications and stop blinking when returning to the tab (even with dBlink=false).
  const clearOnBack = () => {
    if (away()) return;
    donePending = null;
    if (doneRepeatT) { clearTimeout(doneRepeatT); doneRepeatT = 0; }
    stopBlink();
    closeN();
  };
  document.addEventListener('visibilitychange', clearOnBack);
  ['pointerdown', 'keydown', 'focus'].forEach((ev) => window.addEventListener(ev, clearOnBack, true));

  function fireDoneAlert(title, key) {
    const tag = key ? 'ag-done-' + key : 'ag-done';
    const ttl = cfg.dRepeatSec ? Math.min(10000, Math.max(500, cfg.dRepeatSec * 500)) : 10000;
    claimOnce('done-' + (key || title), ttl).then((ok) => {
      if (!ok) return;
      if (cfg.dSound) beep();
      if (cfg.dNotify) notify('Antigravity finished', title, tag, false, true);
    });
  }
  function scheduleDoneRepeat() {
    if (doneRepeatT) { clearTimeout(doneRepeatT); doneRepeatT = 0; }
    if (!donePending || !cfg.dRepeatSec || !away()) return;
    doneRepeatT = setTimeout(() => {
      doneRepeatT = 0;
      if (!donePending || !cfg.dRepeatSec || !away()) return;
      donePending.at = Date.now();
      fireDoneAlert(donePending.title, donePending.key);
      scheduleDoneRepeat();
    }, cfg.dRepeatSec * 1000);
  }
  function alertDone(title, key) {
    donePending = { title, key, at: Date.now() };
    startBlink('✅ ', '#22c55e'); // title blinking is local per tab; sound & notification only from the claiming tab
    fireDoneAlert(title, key);
    scheduleDoneRepeat();
  }

  // Low-quota alert: once when dropping below threshold, re-armed only after rising back above it (e.g. after reset).
  const LOW_KEYS = [['geminiWeekly', 'Gemini weekly'], ['gemini5h', 'Gemini 5h'], ['claudeWeekly', 'Claude/GPT weekly'],
    ['claude5h', 'Claude/GPT 5h'], ['argonWeekly', 'Argon weekly']];
  let lowAlerted = {};
  try { lowAlerted = JSON.parse(localStorage.getItem('ag_quota_low_v1')) || {}; } catch (e) {}

  // Exhaustion forecast: "remaining %" history in localStorage, burn rate window (5h: 45 min, weekly: 6h).
  // Remaining % increase = window reset → clear history. Heartbeat every 5 min, so idle gaps dilute burn rate.
  let hist = {};
  try { hist = JSON.parse(localStorage.getItem('ag_quota_hist_v1')) || {}; } catch (e) {}
  // Another tab raised a low-quota/forecast alert → sync flags instead of reading once on startup.
  window.addEventListener('storage', (e) => {
    try { if (e.key === 'ag_quota_low_v1') lowAlerted = JSON.parse(e.newValue) || {}; } catch (err) {}
  });
  function parseDur(str) { // "1d 5h", "2h 3m" → ms
    let ms = 0;
    String(str || '').replace(/(\d+)\s*([wdhms])/gi, (m, n, u) => { ms += n * { w: 6048e5, d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[u.toLowerCase()]; });
    return ms || null;
  }
  function recordHist() {
    const now = Date.now();
    // Another tab may have appended points: storage is a superset of memory (we write after every change), so reload before editing.
    try { const d = JSON.parse(localStorage.getItem('ag_quota_hist_v1')); if (d && typeof d === 'object') hist = d; } catch (e) {}
    let changed = false;
    LOW_KEYS.forEach(([k]) => {
      const v = parseInt(quotaState[k], 10);
      if (isNaN(v)) return;
      const h = hist[k] || (hist[k] = []);
      const last = h[h.length - 1];
      if (last && v > last.v) h.length = 0;
      if (!h.length || v !== h[h.length - 1].v || now - h[h.length - 1].t > 300000) { h.push({ t: now, v }); changed = true; }
      while (h.length && now - h[0].t > 7 * 3600e3) h.shift();
    });
    if (changed) try { localStorage.setItem('ag_quota_hist_v1', JSON.stringify(hist)); } catch (e) {}
  }
  function forecast(k) {
    const now = Date.now(), win = /Weekly$/.test(k) ? 6 * 3600e3 : 45 * 60e3;
    const pts = (hist[k] || []).filter((p) => now - p.t <= win);
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1], drop = a.v - b.v, dt = (b.t - a.t) / 3600e3;
    if (drop < 2 || dt < 3 / 60) return null; // too little change (1% rounding) or measurement window too short
    const rate = drop / dt, etaMs = Math.max(0, (b.v / rate) * 3600e3 - (now - b.t));
    const reset = parseDur(quotaState[k + 'Reset']);
    return { rate, etaMs, before: reset != null && etaMs < reset };
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return m + 'm';
    if (m < 2880) return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(m / 1440) + 'd';
  }

  // Alerts: once when dropping below threshold and once when forecast shows exhaustion before reset within fcMin minutes;
  // re-armed only after rising back above threshold / forecast clears.
  function checkLow() {
    recordHist();
    try { lowAlerted = JSON.parse(localStorage.getItem('ag_quota_low_v1')) || lowAlerted; } catch (e) {} // merge state from other tabs
    let changed = false;
    const arm = (key, on, title, body) => {
      if (!on) { if (lowAlerted[key]) { delete lowAlerted[key]; changed = true; } return; }
      if (lowAlerted[key]) return;
      lowAlerted[key] = 1; changed = true;
      claimOnce('low-' + key, 120000).then((ok) => {
        if (!ok) return;
        if (cfg.dSound) beep();
        if (cfg.dNotify) notify(title, body, 'ag-' + key);
      });
    };
    LOW_KEYS.forEach(([k, label]) => {
      const v = parseInt(quotaState[k], 10);
      if (isNaN(v)) return;
      const reset = quotaState[k + 'Reset'];
      if (cfg.lowPct) arm('low-' + k, v <= cfg.lowPct, 'Antigravity: low quota',
        label + ': ' + v + '% (threshold ' + cfg.lowPct + '%)' + (reset ? ', resets in ' + reset : ''));
      const f = cfg.fcMin ? forecast(k) : null;
      const soon = !!(f && f.before && f.etaMs <= cfg.fcMin * 60e3);
      const calm = !f || !f.before || f.etaMs > cfg.fcMin * 120e3; // hysteresis: re-arm only when clearly safe
      if (soon) arm('fc-' + k, true, 'Antigravity: quota running out',
        label + ': ~' + fmtDur(f.etaMs) + ' left at ' + f.rate.toFixed(1) + '%/h' + (reset ? ' (resets in ' + reset + ')' : ''));
      else if (calm) arm('fc-' + k, false);
    });
    if (changed) try { localStorage.setItem('ag_quota_low_v1', JSON.stringify(lowAlerted)); } catch (e) {}
  }

  // Notification permission may only be requested from a user gesture (click on overlay/⚙/checkbox), never from a timer.
  function askNotifyPermission() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
  }
  const openNs = new Set(); // open sticky notifications; closeN closes all of them
  function closeN() { openNs.forEach((n) => { try { n.close(); } catch (e) {} }); openNs.clear(); }
  function notify(title, body, tag, force, sticky, onClick) {
    if (cfg.hiddenOnly && !away() && !force) return;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body, tag, requireInteraction: !!sticky });
        if (sticky) openNs.add(n);
        n.onclick = () => { window.focus(); try { if (onClick) onClick(); } catch (e) {} n.close(); openNs.delete(n); };
      }
    } catch (e) {}
  }

  // Single shared AudioContext; unlocked on first user gesture (autoplay policy) so background-tab alerts
  // don't wait until return. Drop signals delayed >1.5s (context resumed only on return): stale alert is worse than silence.
  let actx = null;
  function ensureAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!actx) actx = new AudioCtx();
      if (actx.state !== 'running') actx.resume().catch(() => {});
      return actx;
    } catch (e) { return null; }
  }
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, ensureAudio, true));
  function beep() {
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = Date.now();
    const go = () => {
      if (Date.now() - t0 > 1500) return;
      try {
        [880, 1175].forEach((f, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = f; g.gain.value = 0.15;
          o.connect(g); g.connect(ctx.destination);
          o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.15);
        });
      } catch (e) {}
    };
    if (ctx.state === 'running') go(); else ctx.resume().then(go, () => {});
  }

  // Called every 1s (or via postMessage from iframe). Alerts when question appears and repeats every cfg.qRepeatSec.
  let qSeen = false, qLastAlert = 0, qLastTitle = '';
  function applyQuestion(on, title) {
    qActive = on;
    if (title) qLastTitle = title;
    const el = document.getElementById('antigravity-usage-overlay');
    if (el) el.classList.toggle('ag-question', on && cfg.qFrame);
    if (!on) { qSeen = false; qLastTitle = ''; stopBlink('❓ '); return; }
    startBlink('❓ ', '#f97316');
    renderTitle();
    const now = Date.now();
    if (qSeen && (!cfg.qRepeatSec || now - qLastAlert < cfg.qRepeatSec * 1000)) return;
    qSeen = true; qLastAlert = now;
    const body = qLastTitle || 'Question waiting in conversation';
    claimOnce('question', 5000).then((ok) => {
      if (!ok) return;
      if (cfg.qSound) beep();
      if (cfg.qNotify) notify('Antigravity asks', body, 'ag-q', false, true);
    });
  }

  // Frame-host diagnostics to narrow @match *.google.com safely: `__agDiag()` in AG console prints hosts where rows were found.
  const diagFrames = new Map();
  let lastDiagRows = -1, lastDiagAt = 0;
  function recordDiagFrame(host, top, agFrame, rows) {
    diagFrames.set(host + '|' + (top ? 'top' : 'sub'), {
      host, top, agFrame, rows, t: new Date().toTimeString().slice(0, 8)
    });
  }
  window.__agDiag = () => {
    const list = [...diagFrames.values()];
    try { console.table(list); } catch (e) {}
    return list;
  };

  if (isTopWindow) {
    window.addEventListener('message', (e) => {
      if (!okFrameMsg(e)) return;
      const d = e.data;
      if (d.type === 'AG_QUOTA_SYNC') {
        const clean = sanitizeQuotaPayload(d.payload);
        if (clean) {
          Object.assign(quotaState, clean);
          try { localStorage.setItem('ag_quota_state_v3', JSON.stringify(quotaState)); } catch (err) {}
          renderOverlay();
        }
      } else if (d.type === 'AG_QUESTION' && typeof d.value === 'boolean') {
        frameQAt = d.value ? Date.now() : 0;
        applyQuestion(d.value, typeof d.title === 'string' ? d.title.slice(0, 120) : '');
      } else if (d.type === 'AG_DONE' && typeof d.title === 'string') {
        alertDone(d.title.slice(0, 120), typeof d.key === 'string' ? d.key.slice(0, 200) : '');
      } else if (d.type === 'AG_BUSY' && typeof d.count === 'number' && Number.isFinite(d.count)) {
        frameBusy = Math.max(0, Math.min(999, Math.floor(d.count)));
        renderTitle();
      } else if (d.type === 'AG_DIAG' && typeof d.host === 'string' && typeof d.rows === 'number') {
        recordDiagFrame(d.host.slice(0, 120), false, !!d.agFrame, Math.max(0, Math.min(9999, Math.floor(d.rows))));
      }
    });
  }

  function update() {
    scrapeLimits();
    let rows = [];
    try { rows = conversationRows(); } catch (e) {}
    if (rows.length > 0) {
      recordDiagFrame(location.hostname, isTopWindow, isAgFrame, rows.length);
      if (!isTopWindow && (rows.length !== lastDiagRows || Date.now() - lastDiagAt > 10000)) {
        lastDiagRows = rows.length; lastDiagAt = Date.now();
        try { window.top.postMessage({ type: 'AG_DIAG', host: location.hostname, agFrame: isAgFrame, rows: rows.length }, '*'); } catch (e) {}
      }
    }
    detectQuestion(rows);
    try { detectDone(rows); } catch (e) {}
    renderTitle();
    renderOverlay();
  }

  function initOverlay() {
    // Run loop only in Antigravity (and its usercontent iframes) — not on Gmail/Docs matched by *.google.com.
    if (isAgFrame || (!isTopWindow && /usercontent\.goog|googleusercontent\.com/.test(location.hostname))) {
      setInterval(update, 1000);
      // Event-driven detection: MutationObserver is not throttled in background tabs (setInterval is, ~1/min),
      // and a one-shot setTimeout from its callback is not chained, so idle confirmation fires on time.
      let detT = 0;
      const schedDet = (ms) => { if (!detT) detT = setTimeout(runDet, ms); };
      function runDet() {
        detT = 0;
        update();
        if ([...rowBusy.values()].some((r) => r.idleAt)) schedDet(3100);
      }
      const obsOpts = { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-label', 'aria-busy', 'data-state', 'data-testid', 'title'] };
      const mo = new MutationObserver((recs) => {
        if (!recs.some((m) => !(m.target.closest && m.target.closest('#antigravity-usage-overlay')))) return; // skip our own renders
        schedDet(500);
      });
      const watch = (root) => { try { mo.observe(root, obsOpts); } catch (e) {} };
      const startObs = () => { if (document.body) watch(document.body); shadowRoots.forEach(watch); onNewRoot = watch; };
      if (document.body) startObs(); else document.addEventListener('DOMContentLoaded', startObs);
    }

    // Render widget only in top window and only on Antigravity domain
    if (!isTopWindow || !/antigravity/i.test(location.hostname)) return;
    if (document.getElementById('antigravity-usage-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'antigravity-usage-overlay';
    overlay.style.cssText = `
      position:fixed; bottom:80px; right:16px; z-index:2147483647;
      background:#1e1e1e; color:#e0e0e0; padding:10px 14px;
      border-radius:8px; font-size:12px; border:1px solid #444;
      min-width:210px; line-height:1.4; cursor:pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5); user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    const qs = document.createElement('style');
    qs.textContent = '@keyframes agq{0%,100%{border-color:#444;box-shadow:0 4px 12px rgba(0,0,0,.5)}50%{border-color:#ff9800;box-shadow:0 0 14px 3px #ff9800}}' +
      '#antigravity-usage-overlay.ag-question{border:2px solid #ff9800;animation:agq 1s ease-in-out infinite}';
    document.head.appendChild(qs);
    overlay.title = 'Click to refresh; drag to move';
    overlay.onclick = () => { askNotifyPermission(); update(); replayQuotaRequest(); };
    document.body.appendChild(overlay);
    applyCfg();

    update();
    // SPA updates <title> on its own — re-apply our prefix
    try { new MutationObserver(renderTitle).observe(document.head, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    makeMovable(overlay, 'ag_quota_pos_v1');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverlay);
  } else {
    initOverlay();
  }
})();
