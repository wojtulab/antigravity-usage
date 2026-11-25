// ==UserScript==
// @name         Antigravity Usage Overlay (Deep Scraper v3)
// @namespace    https://github.com/wojtulab/antigravity-usage
// @version      3.11.24
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

  // R11 storage shim (change in one = change in both): shadows window.localStorage for the whole script. Blocked or full storage falls back
  // to per-tab memory (cross-tab sharing off) instead of throwing; a key whose write failed stays memory-only so reads never return stale data.
  const localStorage = (() => {
    const mem = new Map(), memOnly = new Set();
    let real = null;
    try { real = window.localStorage; real.getItem('ide_probe'); } catch (e) { real = null; }
    const ok = (k) => real && !memOnly.has(k);
    return {
      getItem(k) { try { if (ok(k)) return real.getItem(k); } catch (e) {} return mem.has(k) ? mem.get(k) : null; },
      setItem(k, v) {
        v = String(v);
        try { if (real) { real.setItem(k, v); memOnly.delete(k); mem.delete(k); return; } } catch (e) {}
        mem.set(k, v); memOnly.add(k);
      },
      removeItem(k) { mem.delete(k); memOnly.delete(k); try { if (real) real.removeItem(k); } catch (e) {} },
      get length() { try { if (real) return real.length; } catch (e) {} return mem.size; },
      key(i) { try { if (real) return real.key(i); } catch (e) {} return [...mem.keys()][i] || null; }
    };
  })();
  // end R11 storage shim

  const isTopWindow = (window.self === window.top);
  const hasAnc = !!(location.ancestorOrigins && location.ancestorOrigins.length);
  const isAgFrame = /antigravity/i.test(location.hostname) ||
    (hasAnc ? [...location.ancestorOrigins].some((o) => /antigravity/i.test(o)) : (!isTopWindow && /antigravity/i.test(document.referrer))); // referrer fallback only for frames: top-level *.google.com opened from AG must stay untouched
  const isAgContent = isAgFrame || (!hasAnc && !isTopWindow && /usercontent\.goog|googleusercontent\.com/.test(location.hostname));
  if (!isAgContent) return;

  const shadowRoots = new Set();
  let onNewRoot = null; // set when detection starts (observe mutations inside Shadow DOM as well)

  // 1. Intercept all Shadow DOM roots (including closed ones: mode === 'closed')
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = origAttachShadow.call(this, init);
      try { if (this && this.isConnected) root._agSeenConnected = true; } catch (e) {}
      shadowRoots.add(root);
      try { if (onNewRoot) onNewRoot(root); } catch (e) {}
      return root;
    };
  } catch (e) {}

  // 1b. Network sniffer: the Usage panel only fetches limits when its menu is opened.
  // We remember that request and replay it every minute so the overlay refreshes automatically.
  const REPLAY_KEY = 'ag_quota_replay_v1';
  const REPLAY401_KEY = 'ag_quota_replay401_v1'; // stored copy has no auth headers: after a 401 do not repeat it until the app sends a fresh request
  const REPLAY_INTERVAL_MS = 60 * 1000;
  const origFetch = window.fetch;
  const TAB_ID = Math.random().toString(36).slice(2, 5);
  // Multi-tab coordination: only the tab that wins the claim sends the alert for an event. Write TAB_ID+time to localStorage,
  // read back after ~50 ms (last write visible to all tabs wins); key fresher than ttlMs held by another tab → false.
  // Shared block with claude-usage.user.js: change in one = change in both.
  // Key = readable prefix + hash of the rest: no chat titles in localStorage key names. Claims older than 1 h are removed at start.
  function claimOnce(key, ttlMs) {
    let hh = 5381; for (let i = 0; i < key.length; i++) hh = ((hh << 5) + hh + key.charCodeAt(i)) | 0;
    const k = 'ide_claim_' + key.split('-')[0] + '_' + (hh >>> 0).toString(36);
    try {
      const cur = JSON.parse(localStorage.getItem(k) || 'null');
      if (cur && cur.id !== TAB_ID && Date.now() - cur.t < ttlMs) return Promise.resolve(false);
      localStorage.setItem(k, JSON.stringify({ id: TAB_ID, t: Date.now() }));
    } catch (e) { return Promise.resolve(true); }
    return new Promise((res) => setTimeout(() => {
      try { const c = JSON.parse(localStorage.getItem(k) || 'null'); res(!c || c.id === TAB_ID); } catch (e) { res(true); }
    }, 50));
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const ck = localStorage.key(i);
      if (ck && ck.startsWith('ide_claim_')) {
        try { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (!c || !(Date.now() - c.t < 3600e3)) localStorage.removeItem(ck); }
        catch (e) { localStorage.removeItem(ck); }
      }
    }
  } catch (e) {}
  const VERSION = '3.11.24'; // single version constant in code (alongside @version in header); README does not duplicate it
  // Accept cross-frame messages only from child frames of this window on Antigravity/Google origins.
  const okOrigin = (o) => { try { return /(^|\.)(antigravity\.google|google\.com|googleusercontent\.com|usercontent\.goog)$/.test(new URL(o).hostname); } catch (e) { return false; } };
  function okFrameMsg(e) {
    if (!e || !e.source || e.source === window) return false;
    try { if (e.source.top !== window) return false; } catch (err) { return false; }
    return okOrigin(e.origin) && !!e.data && typeof e.data === 'object';
  }

  // Finds quota values in JSON, JSPB arrays, ProxyCommand/Byoa wrappers, Connect/gRPC-Web binary protobuf frames
  // (RetrieveUserQuotaSummary, GetUserStatus, GetCascadeModelConfigs, ListAvailableModels), WebSocket & WebRTC DataChannel.
  const netDiag = {
    lastCaptureAt: 0, lastCaptureUrl: '', lastReplayAt: 0, lastReplayStatus: '', lastReplayUrl: '',
    replayPending: false, replayAuthFailed: false, replayBackoffMs: 0, replayBlockedUntil: 0, candidates: [], rpcs: {}
  };
  const recordCand = (url, ct, len, parsed) => {
    const cleanUrl = String(url || '').split('?')[0].slice(0, 140);
    netDiag.candidates.push({ url: cleanUrl, ct: String(ct || '').slice(0, 60), len, parsed, t: new Date().toTimeString().slice(0, 8) });
    if (netDiag.candidates.length > 8) netDiag.candidates.shift();
  };
  const extractRpcName = (req, ct) => {
    const url = (req && req.url) || '';
    const uq = /[?&]\$unique=([^&]+)/i.exec(url);
    if (uq) { try { return decodeURIComponent(uq[1]).slice(0, 60); } catch (e) { return uq[1].slice(0, 60); } }
    if (req && typeof req.body === 'string' && req.body[0] === '[') {
      const m = /"\/[^"]*\/([A-Za-z0-9_]+)"/.exec(req.body.slice(0, 300));
      if (m) return m[1].slice(0, 60);
    }
    const pm = /\/([A-Za-z0-9_:.-]+)(?:[?#]|$)/.exec(url);
    if (pm) return pm[1].slice(0, 60);
    return String(ct || '').slice(0, 40) || '?';
  };
  const recordRpc = (req, ct, len, keys) => {
    const url = (req && req.url) || '';
    if (!/\$rpc|ProxyCommand|language_server|v1internal/i.test(url) && !/^(?:websocket|webrtc:)/i.test(ct || '')) return;
    const m = extractRpcName(req, ct);
    const e = netDiag.rpcs[m] || (netDiag.rpcs[m] = { n: 0, b: 0, k: '' });
    e.n++; e.b = len; if (keys) e.k = keys;
    const all = Object.keys(netDiag.rpcs);
    if (all.length > 40) delete netDiag.rpcs[all[0]];
  };

  const b64ToU8 = (str) => {
    try {
      const norm = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
      const bin = atob(norm);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    } catch (e) { return null; }
  };
  const u8ToB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  function decodeCandidateText(text) {
    if (typeof text !== 'string' || !text.length) return null;
    const stripXssi = (s) => s.replace(/^\)\]\}'\s*/, '').trim();
    let s = stripXssi(text);
    if (s && s[0] !== '{' && s[0] !== '[' && /^[A-Za-z0-9+/=_-]{8,}$/.test(s)) {
      try {
        const b64 = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
        const b = stripXssi(b64);
        if (b && (b[0] === '{' || b[0] === '[')) s = b;
      } catch (e) {}
    }
    if (!s) return null;
    if (s[0] === '{' || s[0] === '[') {
      try { return [{ text: s, data: JSON.parse(s) }]; } catch (e) {}
    }
    // Multi-line Google batchexecute chunks (length line followed by JSON array/object line): collect ALL valid chunks
    if (/\n[\[{]/.test(s)) {
      const list = [];
      for (const line of s.split('\n')) {
        const l = line.trim();
        if (l && (l[0] === '[' || l[0] === '{')) {
          try { list.push({ text: l, data: JSON.parse(l) }); } catch (e) {}
        }
      }
      if (list.length) return list;
    }
    return null;
  }

  function parseTimestampMs(ts) {
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      return Number.isFinite(ms) && ms > 1e12 ? ms : NaN;
    }
    const sec = Array.isArray(ts) ? Number(ts[0]) : (ts && typeof ts === 'object' && ts.seconds != null ? Number(ts.seconds) : NaN);
    const nanos = Array.isArray(ts) ? Number(ts[1] || 0) : (ts && typeof ts === 'object' ? Number(ts.nanos || 0) : 0);
    if (!Number.isFinite(sec) || sec <= 1e9 || sec >= 1e11) return NaN;
    return sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
  }

  function fmtResetMs(ms) {
    const diff = ms - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return '';
    const d = Math.floor(diff / 86400e3);
    const h = Math.floor((diff % 86400e3) / 3600e3);
    const m = Math.floor((diff % 3600e3) / 60e3);
    if (d > 0) return d + 'd' + (h > 0 ? ' ' + h + 'h' : '');
    if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
    return (m > 0 ? m : 1) + 'm';
  }

  function classifyFamily(text) {
    if (/argon/i.test(text)) return null; // separate Argon bucket removed from Antigravity Usage; ignore so it cannot pollute Gemini
    if (/claude|gpt|anthropic|openai|sonnet|opus|haiku/i.test(text)) return 'claude';
    if (/gemini/i.test(text)) return 'gemini';
    return null;
  }

  function classifyWindow(text, resetMs) {
    if (/week|7\s*-?\s*d(?:ays?)?|seven|168\s*h|604800/i.test(text)) return 'Weekly';
    if (/5\s*-?\s*h(?:ours?|r)?|five|hour|18000/i.test(text)) return '5h';
    if (Number.isFinite(resetMs) && resetMs > Date.now()) {
      return (resetMs - Date.now()) > 7 * 3600e3 ? 'Weekly' : '5h';
    }
    return null;
  }

  function assignQuotaBucket(out, ctxText, frac, resetMs) {
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) return;
    const fam = classifyFamily(ctxText);
    const win = classifyWindow(ctxText, resetMs);
    const key = fam && win && (fam + win);
    if (!key) return;
    const pct = Math.round(frac * 100);
    if ((key in out) && !(pct < parseInt(out[key], 10))) return;
    out[key] = pct + '%';
    const r = fmtResetMs(resetMs);
    out[key + 'Reset'] = r || '';
    out[key + 'ResetTs'] = Number.isFinite(resetMs) ? Math.round(resetMs) : 0;
  }

  function mergeMinBucket(out, parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    for (const key of ['geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h']) {
      if (!(key in parsed)) continue;
      const pct = parseInt(parsed[key], 10);
      if (isNaN(pct)) continue;
      if ((key in out) && !(pct < parseInt(out[key], 10))) continue;
      out[key] = parsed[key];
      if ((key + 'Reset') in parsed) out[key + 'Reset'] = parsed[key + 'Reset'];
      if ((key + 'ResetTs') in parsed) out[key + 'ResetTs'] = parsed[key + 'ResetTs'];
    }
  }

  function parseJspbQuota(data, out) {
    const validTs = (ts) => Number.isFinite(parseTimestampMs(ts));
    const isBucket = (b) => {
      if (!Array.isArray(b) || b.length < 3 || b.length > 20) return false;
      const texts = [b[0], b[1], b[2], b[6]];
      if (!texts.some((x) => typeof x === 'string' && x.length)) return false;
      if (texts.some((x) => x != null && typeof x !== 'string')) return false;
      if (b[3] != null && (typeof b[3] !== 'number' || b[3] < 0 || b[3] > 1)) return false;
      if (b[5] != null && !validTs(b[5])) return false;
      return typeof b[3] === 'number' || b[4] != null || (b[5] != null && !b[7]);
    };
    const isGroup = (g) => Array.isArray(g) && typeof g[1] === 'string' && (!g[0] || (Array.isArray(g[0]) && (!g[0].length || g[0].some(isBucket))));
    const findSummary = (node, depth) => {
      if (!Array.isArray(node) || depth > 5) return null;
      const b0 = Array.isArray(node[0]) && node[0].some(isBucket);
      const g1 = Array.isArray(node[1]) && node[1].some(isGroup);
      if (b0 || g1) return node;
      for (let i = 0; i < Math.min(node.length, 4); i++) {
        const hit = findSummary(node[i], depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const sumNode = findSummary(data, 0);
    if (sumNode) {
      const buckets = [];
      if (Array.isArray(sumNode[1])) {
        for (const g of sumNode[1]) {
          if (!isGroup(g) || !Array.isArray(g[0])) continue;
          const gCtx = [g[1], g[2]].filter((x) => typeof x === 'string').join(' ');
          for (const b of g[0]) if (isBucket(b)) buckets.push([gCtx, b]);
        }
      }
      if (Array.isArray(sumNode[0])) {
        for (const b of sumNode[0]) if (isBucket(b)) buckets.push(['', b]);
      }
      const hasAnyFrac = buckets.some(([, b]) => typeof b[3] === 'number');
      for (const [gCtx, b] of buckets) {
        if (b[7] === true) continue; // disabled
        const bCtx = [gCtx, b[0], b[1], b[2], b[6]].filter((x) => typeof x === 'string').join(' ');
        const resetMs = parseTimestampMs(b[5]);
        let frac = typeof b[3] === 'number' ? b[3] : NaN;
        if (isNaN(frac) && b[4] == null && (hasAnyFrac || (classifyFamily(bCtx) && Number.isFinite(resetMs)))) {
          frac = 0; // proto3/JSPB omits 0.0 float values
        }
        if (Number.isFinite(frac)) assignQuotaBucket(out, bCtx, frac, resetMs);
      }
      if (Object.keys(out).length) return;
    }
    // Fallback: ListAvailableModelsResponse [models[]], each model [enum, displayName, desc, isDefault, [frac, ts], modelId]
    const findModels = (node, depth) => {
      if (!Array.isArray(node) || depth > 4) return null;
      if (node.some((m) => Array.isArray(m) && (m[0] == null || typeof m[0] === 'number') && typeof m[1] === 'string' &&
          Array.isArray(m[4]) && (typeof m[4][0] === 'number' || validTs(m[4][1])))) {
        return node;
      }
      for (let i = 0; i < Math.min(node.length, 3); i++) {
        const hit = findModels(node[i], depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const models = findModels(data, 0);
    if (models) {
      for (const m of models) {
        if (!Array.isArray(m) || !Array.isArray(m[4])) continue;
        const resetMs = parseTimestampMs(m[4][1]);
        const frac = typeof m[4][0] === 'number' ? m[4][0] : (Number.isFinite(resetMs) ? 0 : NaN);
        const ctx = [m[1], m[2], m[5]].filter((x) => typeof x === 'string').join(' ');
        if (Number.isFinite(frac)) assignQuotaBucket(out, ctx, frac, resetMs);
      }
    }
  }

  function parsePbFields(u8) {
    if (!(u8 instanceof Uint8Array) || !u8.length) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let pos = 0;
    const readVar = () => {
      let v = 0, mult = 1, n = 0;
      while (pos < u8.length && n++ < 10) {
        const b = u8[pos++];
        v += (b & 0x7f) * mult;
        if (!(b & 0x80)) return v;
        mult *= 128;
      }
      return NaN;
    };
    while (pos < u8.length) {
      const key = readVar();
      if (!Number.isFinite(key) || key <= 0) return null;
      const fn = Math.floor(key / 8), wt = key % 8;
      if (fn <= 0) return null;
      if (wt === 0) {
        const v = readVar();
        if (!Number.isFinite(v)) return null;
        out.push([fn, wt, v]);
      } else if (wt === 1) {
        if (pos + 8 > u8.length) return null;
        out.push([fn, wt, u8.subarray(pos, pos + 8)]);
        pos += 8;
      } else if (wt === 2) {
        const len = readVar();
        if (!Number.isFinite(len) || len < 0 || pos + len > u8.length) return null;
        out.push([fn, wt, u8.subarray(pos, pos + len)]);
        pos += len;
      } else if (wt === 5) {
        if (pos + 4 > u8.length) return null;
        out.push([fn, wt, dv.getFloat32(pos, true)]);
        pos += 4;
      } else {
        return null;
      }
    }
    return out;
  }

  const pbTd = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
  function pbStr(val) {
    if (!(val instanceof Uint8Array) || val.length > 4096 || !pbTd) return null;
    const s = pbTd.decode(val);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) ? null : s;
  }

  function pbTsMs(u8) {
    const fs = parsePbFields(u8);
    if (!fs || !fs.length) return NaN;
    let sec = NaN, nanos = 0;
    for (const [fn, wt, v] of fs) {
      if (wt !== 0 || (fn !== 1 && fn !== 2)) return NaN;
      if (fn === 1) sec = v;
      else nanos = v;
    }
    return Number.isFinite(sec) && sec > 1.5e9 && sec < 3e9 ? sec * 1000 + nanos / 1e6 : NaN;
  }

  function parsePbQuotaInfo(u8) {
    const fs = parsePbFields(u8);
    if (!fs) return null;
    let frac = null, resetMs = NaN;
    for (const [fn, wt, v] of fs) {
      if (fn === 1) { if (wt !== 5 || v < 0 || v > 1) return null; frac = v; }
      else if (fn === 2) { if (wt !== 2) return null; resetMs = pbTsMs(v); if (!Number.isFinite(resetMs)) return null; }
      // tolerate unknown future protobuf fields (fn > 2) for forward compatibility
    }
    if (frac === null && !Number.isFinite(resetMs)) return null;
    return { frac: frac !== null ? frac : 0, resetMs };
  }

  function parsePbQuota(u8, out) {
    const root = parsePbFields(u8);
    if (!root || !root.length) return;
    // 1) RetrieveUserQuotaSummaryResponse (wrapper field 1 -> v1internal field 1 buckets / field 2 groups)
    const trySummary = (fs) => {
      const buckets = [];
      for (const [fn, wt, v] of fs) {
        if (fn === 1 && wt === 2) buckets.push(['', v]);
        else if (fn === 2 && wt === 2) {
          const gf = parsePbFields(v);
          if (!gf) return false;
          let gName = '', gDesc = '';
          const gb = [];
          for (const [gfn, gwt, gv] of gf) {
            if (gfn === 2) { if (gwt !== 2) return false; const s = pbStr(gv); if (s == null) return false; gName = s; }
            else if (gfn === 3) { if (gwt !== 2) return false; const s = pbStr(gv); if (s == null) return false; gDesc = s; }
            else if (gfn === 1) { if (gwt !== 2) return false; gb.push(gv); }
            // ignore unknown future group fields (gfn > 3)
          }
          if (!gb.length) continue;
          const gCtx = classifyFamily(gName) ? gName : (gName + ' ' + gDesc).trim();
          for (const b of gb) buckets.push([gCtx, b]);
        }
      }
      if (!buckets.length) return false;
      const parsed = [];
      let hasFrac = false;
      for (const [gCtx, bU8] of buckets) {
        const bf = parsePbFields(bU8);
        if (!bf) return false;
        let coreTexts = [], descText = '', frac = null, amt = null, resetMs = NaN, disabled = false;
        for (const [bfn, bwt, bv] of bf) {
          if (bfn === 1 || bfn === 2 || bfn === 3) {
            if (bwt !== 2) return false;
            const s = pbStr(bv); if (s == null) return false; coreTexts.push(s);
          } else if (bfn === 7) {
            if (bwt !== 2) return false;
            const s = pbStr(bv); if (s == null) return false; descText = s;
          } else if (bfn === 4) { if (bwt !== 5 || bv < 0 || bv > 1) return false; frac = bv; hasFrac = true; }
          else if (bfn === 5) { if (bwt !== 0) return false; amt = bv; }
          else if (bfn === 6) { if (bwt !== 2) return false; resetMs = pbTsMs(bv); if (!Number.isFinite(resetMs)) return false; }
          else if (bfn === 8) { if (bwt !== 0) return false; disabled = !!bv; }
          // ignore unknown future bucket fields (bfn > 8)
        }
        if (!coreTexts.length && !descText && frac === null && !Number.isFinite(resetMs)) return false;
        const baseCtx = (gCtx + ' ' + coreTexts.join(' ')).trim();
        const fullCtx = (classifyFamily(baseCtx) && classifyWindow(baseCtx, resetMs)) ? baseCtx : (baseCtx + ' ' + descText).trim();
        if (!disabled) parsed.push([fullCtx, frac, amt, resetMs]);
      }
      for (const [ctx, frac, amt, resetMs] of parsed) {
        const f = frac !== null ? frac : (amt == null && (hasFrac || (classifyFamily(ctx) && Number.isFinite(resetMs))) ? 0 : NaN);
        if (Number.isFinite(f)) assignQuotaBucket(out, ctx, f, resetMs);
      }
      return Object.keys(out).length > 0;
    };
    if (trySummary(root)) return;
    const f1 = root.find(([fn, wt]) => fn === 1 && wt === 2);
    const f1Fields = f1 ? parsePbFields(f1[2]) : null;
    if (f1Fields && trySummary(f1Fields)) return;

    // 2) ClientModelConfig list: GetUserStatusResponse (1->33->1,4) & GetCascade/CommandModelConfigs (1,4)
    const best = {};
    const collectModel = (ctx, frac, resetMs) => {
      const fam = classifyFamily(ctx), win = classifyWindow(ctx, resetMs);
      const key = fam && win && (fam + win);
      if (!key) return;
      if (!best[key] || frac < best[key].frac) best[key] = { ctx, frac, resetMs };
    };
    const scanClientModels = (fs) => {
      for (const [fn, wt, v] of fs) {
        if ((fn !== 1 && fn !== 4) || wt !== 2) continue;
        const mf = parsePbFields(v);
        if (!mf) continue;
        let label = '', desc = '', modelId = '', disabled = false, qi = null;
        for (const [mfn, mwt, mv] of mf) {
          if (mfn === 1 && mwt === 2) { const s = pbStr(mv); if (s != null) label = s; }
          else if (mfn === 14 && mwt === 2) { const s = pbStr(mv); if (s != null) desc = s; }
          else if (mfn === 21 && mwt === 2) { const s = pbStr(mv); if (s != null) modelId = s; }
          else if (mfn === 4 && mwt === 0) disabled = !!mv;
          else if (mfn === 15 && mwt === 2) qi = parsePbQuotaInfo(mv);
        }
        if (!disabled && qi && (label || modelId)) collectModel([label, desc, modelId].join(' '), qi.frac, qi.resetMs);
      }
    };
    scanClientModels(root);
    if (!Object.keys(best).length && f1Fields) {
      const cmc = f1Fields.find(([fn, wt]) => fn === 33 && wt === 2);
      const cmcf = cmc && parsePbFields(cmc[2]);
      if (cmcf) scanClientModels(cmcf);
    }
    // 3) FetchAvailableModelsResponse (models map field 1: entry -> field 1 key, field 2 ModelDetails)
    const scanAvail = (afs) => {
      for (const [fn, wt, v] of afs) {
        if (fn !== 1 || wt !== 2) continue;
        const ef = parsePbFields(v);
        if (!ef || ef.length > 2) continue;
        const kF = ef.find(([k, w]) => k === 1 && w === 2), vF = ef.find(([k, w]) => k === 2 && w === 2);
        if (!kF || !vF) continue;
        const modKey = pbStr(kF[2]) || '';
        const df = parsePbFields(vF[2]);
        if (!df) continue;
        let dName = '', desc = '', disabled = false, qi = null, beyond = '';
        for (const [dfn, dwt, dv] of df) {
          if (dfn === 1 && dwt === 2) dName = pbStr(dv) || '';
          else if (dfn === 14 && dwt === 2) desc = pbStr(dv) || '';
          else if (dfn === 13 && dwt === 0) disabled = !!dv;
          else if (dfn === 10 && dwt === 2) qi = parsePbQuotaInfo(dv);
          else if (dfn === 44 && dwt === 2) {
            const bf = parsePbFields(dv);
            if (bf) beyond = bf.filter(([, w]) => w === 2).map(([, , x]) => pbStr(x) || '').join(' ');
          }
        }
        if (!disabled && qi && (dName || modKey || beyond)) collectModel([beyond, dName, desc, modKey].join(' '), qi.frac, qi.resetMs);
      }
    };
    if (!Object.keys(best).length) {
      scanAvail(root);
      if (!Object.keys(best).length && f1Fields) scanAvail(f1Fields);
    }
    for (const key of Object.keys(best)) assignQuotaBucket(out, best[key].ctx, best[key].frac, best[key].resetMs);
  }

  function decodeChunkedHttp(u8) {
    // Strip HTTP response header and optional Transfer-Encoding: chunked framing (for WebRTC tcp: tunnels)
    if (u8.length < 16 || !pbTd) return u8;
    if (!/^HTTP\/1\.[01]\s+\d{3}/i.test(pbTd.decode(u8.subarray(0, 16)))) return u8;
    let sep = -1;
    const maxHdr = Math.min(u8.length - 3, 4096);
    for (let i = 0; i < maxHdr; i++) {
      if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) { sep = i; break; }
    }
    if (sep === -1) return u8;
    const hdr = pbTd.decode(u8.subarray(0, sep));
    const body = u8.subarray(sep + 4);
    if (!/transfer-encoding:\s*chunked/i.test(hdr)) return body;
    const parts = [];
    let p = 0, total = 0;
    while (p < body.length) {
      let nl = p;
      while (nl + 1 < body.length && !(body[nl] === 13 && body[nl + 1] === 10)) nl++;
      if (nl + 1 >= body.length) break;
      const sz = parseInt(pbTd.decode(body.subarray(p, nl)).split(';')[0].trim(), 16);
      if (!Number.isFinite(sz) || sz <= 0) break;
      const start = nl + 2;
      if (start + sz > body.length) break;
      parts.push(body.subarray(start, start + sz));
      total += sz;
      p = start + sz + 2;
    }
    if (!parts.length) return body;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of parts) { merged.set(c, off); off += c.length; }
    return merged;
  }

  function parseBinaryPayload(rawU8, out) {
    if (!(rawU8 instanceof Uint8Array) || !rawU8.length || rawU8.length > 2e6) return;
    const u8 = decodeChunkedHttp(rawU8);
    if (!u8.length) return;
    const frames = [];
    let p = 0;
    while (p + 5 <= u8.length && (u8[p] === 0 || u8[p] === 2 || u8[p] === 0x80)) {
      const fl = ((u8[p + 1] << 24) >>> 0) + (u8[p + 2] << 16) + (u8[p + 3] << 8) + u8[p + 4];
      if (fl < 0 || p + 5 + fl > u8.length) break;
      if (fl > 0 && (u8[p] & 0x80) === 0) frames.push(u8.subarray(p + 5, p + 5 + fl));
      p += 5 + fl;
    }
    const list = (p === u8.length && frames.length) ? frames : [u8];
    for (const f of list) {
      if (!f.length) continue;
      if ((f[0] === 0x7b || f[0] === 0x5b || f[0] === 0x29) && pbTd) {
        const txt = pbTd.decode(f);
        mergeMinBucket(out, parseQuotaPayload(txt));
      } else {
        parsePbQuota(f, out);
      }
      // no early return: every data frame is merged (assignQuotaBucket / mergeMinBucket keeps the minimum per bucket)
    }
  }

  function parseQuotaPayload(text) {
    const out = {};
    if (typeof text !== 'string' || !text.length) return out;
    const chunks = decodeCandidateText(text);
    if (!chunks) {
      // Raw base64 (e.g. Connect/gRPC-Web frame wrapped in text/plain)
      const s = text.replace(/^\)\]\}'\s*/, '').trim();
      if (/^[A-Za-z0-9+/=_-]{8,}$/.test(s)) {
        const u8 = b64ToU8(s);
        if (u8) parseBinaryPayload(u8, out);
      }
      return out;
    }
    const LABEL_KEYS = ['displayName', 'display_name', 'label', 'name', 'title', 'refreshWindowLabel',
      'refresh_window_label', 'window', 'bucketId', 'bucket_id', 'quotaType', 'quota_type', 'tokenType',
      'token_type', 'group', 'groupName', 'model', 'modelId', 'model_id', 'modelName', 'description', 'period', 'id'];
    const RESET_KEYS = ['resetTime', 'reset_time', 'nextResetTime', 'next_reset_time', 'quotaResetTime'];
    const REMAIN_RE = /^(?:remaining.?(?:fraction|percent|percentage|pct))$/i;
    const getResetMs = (obj) => {
      for (const rk of RESET_KEYS) {
        if (obj[rk] != null) { const ms = parseTimestampMs(obj[rk]); if (Number.isFinite(ms)) return ms; }
      }
      return NaN;
    };
    for (const { text: cleanText, data } of chunks) {
      const part = {};
      if (Array.isArray(data)) {
        parseJspbQuota(data, part);
        if (Object.keys(part).length) { mergeMinBucket(out, part); continue; }
      }
      // ProxyCommandResponse ["<b64>", ...] or Byoa { payload: "<b64>" } — merge all valid base64 payloads
      const b64Candidates = [];
      const collectB64 = (v, depth) => {
        if (depth > 2 || v == null) return;
        if (typeof v === 'string' && v.length >= 8 && /^[A-Za-z0-9+/=_-]+$/.test(v)) b64Candidates.push(v);
        else if (Array.isArray(v)) { for (let i = 0; i < Math.min(v.length, 4); i++) collectB64(v[i], depth + 1); }
        else if (typeof v === 'object' && typeof v.payload === 'string') collectB64(v.payload, depth + 1);
      };
      collectB64(data, 0);
      for (const b64 of b64Candidates) {
        const u8 = b64ToU8(b64);
        if (u8) parseBinaryPayload(u8, part);
      }
      if (Object.keys(part).length) { mergeMinBucket(out, part); continue; }
      if (!/remaining.?(?:fraction|percent|pct)/i.test(cleanText)) continue;
      const hasExplicit = /"remaining.?(?:fraction|percent|percentage|pct)"\s*:/i.test(cleanText);
      (function walk(o, ctx, parentResetMs) {
        if (!o || typeof o !== 'object') return false;
        const here = ctx + ' ' + LABEL_KEYS.map((k) => o[k]).filter((v) => typeof v === 'string').join(' ');
        const ownReset = getResetMs(o);
        const resetMs = Number.isFinite(ownReset) ? ownReset : parentResetMs;
        let sawRemain = false;
        for (const [k, v] of Object.entries(o)) {
          if (REMAIN_RE.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim())))) {
            sawRemain = true;
            const num = typeof v === 'number' ? v : parseFloat(v);
            const frac = /percent|pct/i.test(k) ? num / 100 : num;
            assignQuotaBucket(part, here, frac, resetMs);
          } else if (walk(v, here, resetMs)) {
            sawRemain = true;
          }
        }
        // Proto3 JSON omits 0.0 remainingFraction on exhausted buckets that still carry resetTime.
        if (!sawRemain && hasExplicit && Number.isFinite(ownReset) && !Array.isArray(o) &&
            o.disabled !== true && o.remainingAmount == null && o.remaining_amount == null) {
          assignQuotaBucket(part, here, 0, ownReset);
        }
        return sawRemain;
      })(data, '', NaN);
      mergeMinBucket(out, part);
    }
    return out;
  }

  function bodyToText(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    try {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        if ((body.byteLength || 0) <= 65536) {
          const u8 = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
          try {
            const s = new TextDecoder('utf-8', { fatal: true }).decode(u8);
            if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return s;
          } catch (e) {}
          return '__b64__:' + u8ToB64(u8);
        }
      }
    } catch (e) {}
    return null;
  }

  function sanitizeReplayUrl(urlStr) {
    try {
      if (!/\$httpHeaders=/i.test(urlStr)) return urlStr;
      const u = new URL(urlStr, location.href);
      const raw = u.searchParams.get('$httpHeaders');
      if (raw != null) {
        const safeLines = raw.split(/\r?\n/).filter((line) => line && !/^(authorization|cookie|set-cookie|.*(?:token|key|secret|session|credential|auth).*)\s*:/i.test(line));
        if (safeLines.length) u.searchParams.set('$httpHeaders', safeLines.join('\r\n') + '\r\n');
        else u.searchParams.delete('$httpHeaders');
      }
      return u.toString();
    } catch (e) { return urlStr; }
  }

  // localStorage copy only (memReplayReq keeps the original): drop credential-looking query params and body fields.
  // ponytail: name-based; binary/protobuf bodies can't be inspected — verify on the live page whether GetUserStatus carries an API key.
  const SECRET_NAME_RE = /token|key|secret|session|credential|auth|signature|password|^sig$/i;
  function redactSecretParams(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      [...u.searchParams.keys()].forEach((k) => { if (SECRET_NAME_RE.test(k) && k !== '$httpHeaders') u.searchParams.delete(k); });
      return u.toString();
    } catch (e) { return urlStr; }
  }
  const SECRET_BODY_KEYS = '(?:api[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|session[_-]?id|credential|signature)';
  function redactSecretBody(body) {
    if (typeof body !== 'string' || body.startsWith('__b64__:')) return body;
    // Redact quoted values first (handles spaces, e.g. "Bearer eyJ..."), then unquoted form/query values
    const s = body.replace(new RegExp('(' + SECRET_BODY_KEYS + '["\']?\\s*[:=]\\s*)(["\'])[^"\']*\\2', 'gi'), '$1$2$2');
    return s.replace(new RegExp('(' + SECRET_BODY_KEYS + '\\s*[:=]\\s*)[^"\'&,\\s}]+', 'gi'), '$1');
  }

  function extractSafeReplayMeta(headers) {
    const meta = {};
    if (!headers || typeof headers !== 'object') return meta;
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== 'string') continue;
      const kl = k.toLowerCase();
      if (kl === 'content-type') meta.contentType = v.slice(0, 120);
      else if (kl === 'x-user-agent') meta.userAgent = v.slice(0, 120);
      else if (kl === 'x-goog-user-project') meta.quotaProject = v.slice(0, 120);
    }
    return meta;
  }

  function isSafeReplayUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      if (u.protocol !== 'https:') return false;
      return u.origin === location.origin || /(^|\.)(antigravity\.google|google\.com|googleapis\.com|googleusercontent\.com|usercontent\.goog)$/.test(u.hostname);
    } catch (e) { return false; }
  }

  function replayRank(req) {
    const url = (req && req.url) || '';
    const s = url + ' ' + ((req && req.body) || '').slice(0, 400);
    if (/QuotaSummary|retrieveUserQuota/i.test(s)) return 4;
    if (/GetUserStatus|\/UserStatus/i.test(s)) return 3;
    if (/CascadeModelConfig|CommandModelConfig/i.test(s)) return 2;
    if (/AvailableModels/i.test(s)) return 1;
    if (/(?:^|[/?&_.-])(?:quota|usage|limit)s?(?:$|[/?&_.-])/i.test(url) || (req && req.method === 'GET')) return 1;
    return 0; // unknown mutating POST must not be replayed automatically
  }

  // Full request object (with headers, e.g. Authorization) stays in tab memory only — never written to localStorage.
  let memReplayReq = null;
  // Live ApiService auth headers (e.g. SAPISIDHASH + X-Goog-Api-Key from ListInstances / ProxyCommand):
  // kept in tab memory ONLY (never localStorage), refreshed continuously so replays never expire or 401 after reload.
  let memApiAuth = null, lastAutoSummaryAt = 0;
  const API_SERVICE_RE = /\/\$rpc\/devtools_jetski_boq_api_proto\.ApiService\//i;
  function mergeHeaders(base, override, skipKeys) {
    const out = {};
    const skip = new Set((skipKeys || []).map((k) => k.toLowerCase()));
    const add = (src, useSkip) => {
      if (!src || typeof src !== 'object') return;
      for (const [k, v] of Object.entries(src)) {
        if (typeof v !== 'string') continue;
        const kl = k.toLowerCase();
        if (useSkip && skip.has(kl)) continue;
        for (const ek of Object.keys(out)) if (ek.toLowerCase() === kl) delete out[ek];
        out[k] = v;
      }
    };
    add(base, false);
    add(override, true);
    return out;
  }
  function isProtoProxyTuple(arr) {
    return Array.isArray(arr) && arr.length >= 4 && typeof arr[0] === 'string' && arr[0].length >= 8 &&
      typeof arr[1] === 'string' && /\/exa\.language_server_pb\.LanguageServerService\/[A-Za-z0-9_]+$/i.test(arr[1]) &&
      Array.isArray(arr[3]) && arr[3].some((kv) => Array.isArray(kv) && String(kv[0]).toLowerCase() === 'content-type' && /application\/proto\b/i.test(String(kv[1])));
  }
  function toQuotaSummaryProxyReq(req) {
    if (!req || !/\/ProxyCommand(?:[?#]|$)/i.test(req.url || '') || typeof req.body !== 'string') return null;
    let arr;
    try { arr = JSON.parse(req.body); } catch (e) { return null; }
    if (!isProtoProxyTuple(arr)) return null;
    const a2 = arr.slice();
    a2[1] = arr[1].replace(/[^/]+$/, 'RetrieveUserQuotaSummary');
    a2[2] = ''; // application/proto empty RetrieveUserQuotaSummaryRequest
    let nextUrl = req.url;
    try {
      const u = new URL(req.url, location.href);
      u.searchParams.set('$unique', 'RetrieveUserQuotaSummary');
      nextUrl = u.toString();
    } catch (e) {}
    return {
      url: nextUrl,
      method: 'POST',
      body: JSON.stringify(a2),
      headers: mergeHeaders(req.headers, memApiAuth && memApiAuth.headers, ['content-type'])
    };
  }
  function captureApiServiceReq(req) {
    if (!req || !API_SERVICE_RE.test(req.url || '')) return;
    const hdrs = req.headers;
    if (hdrs && typeof hdrs === 'object') {
      const hasAuth = Object.keys(hdrs).some((k) => /^(?:authorization|x-goog-api-key)$/i.test(k));
      if (hasAuth) {
        const wasFailed = netDiag.replayAuthFailed;
        memApiAuth = { headers: Object.assign({}, hdrs), at: Date.now() };
        if (wasFailed) {
          netDiag.replayAuthFailed = false;
          try { localStorage.removeItem(REPLAY401_KEY); } catch (e) {}
        }
        const needBootstrap = wasFailed || !isFresh('geminiWeekly') || !isFresh('claudeWeekly');
        if (needBootstrap && Date.now() - lastAutoSummaryAt > 20000) {
          const hasTarget = !!memReplayReq || !!localStorage.getItem(REPLAY_KEY);
          if (hasTarget) {
            lastAutoSummaryAt = Date.now();
            setTimeout(() => replayQuotaRequest(false, true), 400);
          }
        }
      }
    }
    // Synthesize RetrieveUserQuotaSummary from any live application/proto ProxyCommand (e.g. GetUserStatus / ListProjects)
    const synth = toQuotaSummaryProxyReq(req);
    if (synth) {
      saveReplayReq(synth);
      if ((!isFresh('geminiWeekly') || !isFresh('claudeWeekly')) && Date.now() - lastAutoSummaryAt > 20000) {
        lastAutoSummaryAt = Date.now();
        setTimeout(() => replayQuotaRequest(false, true), 400);
      }
    }
  }
  function saveReplayReq(req) {
    if (!req || (req.method !== 'GET' && req.body == null)) return;
    const rank = replayRank(req);
    if (rank <= 0 || !isSafeReplayUrl(req.url)) return;
    let curUrl = (memReplayReq && memReplayReq.url) || '';
    let curBody = (memReplayReq && memReplayReq.body) || '';
    if (!curUrl) {
      try { const s = JSON.parse(localStorage.getItem(REPLAY_KEY) || '{}'); curUrl = s.url || ''; curBody = s.body || ''; } catch (e) {}
    }
    if (curUrl && rank < replayRank({ url: curUrl, body: curBody })) return;
    memReplayReq = req;
    netDiag.replayAuthFailed = false;
    netDiag.replayBackoffMs = 0;
    netDiag.replayBlockedUntil = 0;
    try { localStorage.removeItem(REPLAY401_KEY); } catch (e) {}
    const safeUrl = redactSecretParams(sanitizeReplayUrl(req.url));
    const stored = Object.assign({ url: safeUrl, method: req.method, body: redactSecretBody(req.body) }, extractSafeReplayMeta(req.headers));
    try { localStorage.setItem(REPLAY_KEY, JSON.stringify(stored)); } catch (e) {}
  }

  function commitCaptured(q, req, ct, byteLen) {
    const keys = Object.keys(q).join(',');
    netDiag.lastCaptureAt = Date.now();
    if (req && req.url) netDiag.lastCaptureUrl = String(req.url).split('?')[0].slice(0, 140);
    recordRpc(req, ct, byteLen, keys);
    recordCand(req && req.url, ct, byteLen, keys);
    commitState(q, 'Network');
    saveReplayReq(req);
  }

  function sniff(text, req, ct) {
    if (typeof text !== 'string' || text.length > 2e6) return;
    const q = parseQuotaPayload(text);
    const keys = Object.keys(q);
    if (keys.length) {
      commitCaptured(q, req, ct, text.length);
      return;
    }
    recordRpc(req, ct, text.length, '');
    const hint = (req && ((req.url || '') + ' ' + (req.body || '').slice(0, 300))) || '';
    if (isAgContent && (/quota|remaining.?fraction|refreshWindowLabel|GetUserQuotaSummary|ListAvailableModels|GetUserStatus|CascadeModelConfig/i.test(text + ' ' + hint) ||
        (/gemini/i.test(text) && /claude/i.test(text)))) {
      recordCand(req && req.url, ct, text.length, '');
      if (window.__agDebug) console.info('[AG Quota] candidate', req && String(req.url || '').split('?')[0], text.slice(0, 4000));
    }
  }

  async function readBodyCapped(stream, maxBytes, asText) {
    if (!stream || typeof stream.getReader !== 'function') return null;
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) { try { reader.cancel(); } catch (e) {} return null; }
        chunks.push(value);
      }
    } catch (e) { return null; }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return asText ? (pbTd ? pbTd.decode(merged) : null) : merged.buffer;
  }

  function sniffAny(data, req, ct) {
    if (typeof data === 'string') return sniff(data, req, ct);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!u8.length || u8.length > 2e6) return;
      const out = {};
      parseBinaryPayload(u8, out);
      if (Object.keys(out).length) commitCaptured(out, req, ct, u8.length);
      else recordRpc(req, ct, u8.length, '');
    } else if (typeof Blob !== 'undefined' && data instanceof Blob && data.size <= 2e6) {
      data.arrayBuffer().then((buf) => sniffAny(buf, req, ct)).catch(() => {});
    }
  }

  const STATIC_URL_RE = /\.(?:woff2?|ttf|wasm|png|jpe?g|gif|svg|css|js)(?:\?|$)/i;
  const SKIP_CT_RE = /^(?:text\/event-stream|(?:image|audio|video|font)\b)/i;
  const BIN_CT_RE = /application\/(?:grpc-web|x-protobuf|protobuf|octet-stream)/i;

  try {
    window.fetch = function (input, init) {
      const urlStr = typeof input === 'string' ? input : (input && input.url ? String(input.url) : String(input || ''));
      const methodStr = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const hasInitBody = !!(init && init.body !== undefined && init.body !== null);
      let bodyReady = Promise.resolve(hasInitBody ? bodyToText(init.body) : null);
      try {
        if (hasInitBody && typeof Blob !== 'undefined' && init.body instanceof Blob && init.body.size <= 65536) {
          bodyReady = init.body.arrayBuffer().then((buf) => bodyToText(buf)).catch(() => null);
        } else if (!hasInitBody && methodStr !== 'GET' && methodStr !== 'HEAD' &&
            typeof Request !== 'undefined' && input instanceof Request && input.body != null) {
          const rc = input.clone();
          bodyReady = (rc.body ? readBodyCapped(rc.body, 65536, false) : rc.arrayBuffer()).then((buf) => buf ? bodyToText(buf) : null).catch(() => null);
        }
      } catch (e) {}
      const p = origFetch.apply(this, arguments);
      try {
        if (STATIC_URL_RE.test(urlStr)) return p;
        const rawHeaders = (init && init.headers) || (input && typeof input === 'object' && input.headers) || null;
        const req = {
          url: urlStr,
          method: methodStr,
          body: null,
          headers: rawHeaders ? Object.fromEntries(new Headers(rawHeaders)) : {}
        };
        if (API_SERVICE_RE.test(urlStr)) bodyReady.then((b) => { req.body = b; captureApiServiceReq(req); }).catch(() => {});
        let respCt = '', isBin = false;
        p.then((r) => {
          if (!r || !r.ok) return null;
          respCt = (r.headers && r.headers.get('content-type')) || '';
          const cl = parseInt((r.headers && r.headers.get('content-length')) || '', 10);
          if (STATIC_URL_RE.test(r.url || urlStr) || SKIP_CT_RE.test(respCt) || cl > 2e6) return null;
          isBin = BIN_CT_RE.test(respCt) && !/json|text/i.test(respCt);
          const cloned = r.clone();
          return cloned.body ? readBodyCapped(cloned.body, 2e6, !isBin) : (isBin ? cloned.arrayBuffer() : cloned.text());
        }).then(async (d) => {
          if (!d) return;
          req.body = await bodyReady;
          sniffAny(d, req, respCt);
        }).catch(() => {});
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
        this._agReq.body = bodyToText(body);
        captureApiServiceReq(this._agReq);
        this.addEventListener('load', () => {
          if (this.status && (this.status < 200 || this.status >= 300)) return;
          const ct = this.getResponseHeader('content-type') || '';
          const cl = parseInt(this.getResponseHeader('content-length') || '', 10);
          if (/text\/event-stream/i.test(ct) || cl > 2e6) return;
          const rt = this.responseType;
          try {
            if (rt === '' || rt === 'text') {
              if (this.responseText) sniff(this.responseText, this._agReq, ct);
            } else if (rt === 'json' && this.response != null) {
              sniff(JSON.stringify(this.response), this._agReq, ct);
            } else if (rt === 'arraybuffer' && this.response instanceof ArrayBuffer && this.response.byteLength <= 2e6) {
              if (!/\.(?:woff2?|ttf|wasm|png|jpe?g|bin)(?:\?|$)/i.test(this._agReq.url)) {
                sniffAny(this.response, this._agReq, ct);
              }
            } else if (rt === 'blob' && typeof Blob !== 'undefined' && this.response instanceof Blob) {
              sniffAny(this.response, this._agReq, ct);
            }
          } catch (e) {}
        });
      }
      return xSend.apply(this, arguments);
    };

    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (e) => sniffAny(e.data, null, 'websocket'));
      }
    };

    const PC = window.RTCPeerConnection;
    if (PC) {
      const hookDC = (dc) => {
        if (!dc || dc._agHooked) return;
        dc._agHooked = true;
        dc.addEventListener('message', (e) => sniffAny(e.data, null, 'webrtc:' + (dc.label || 'dc')));
      };
      const origCDC = PC.prototype.createDataChannel;
      PC.prototype.createDataChannel = function () {
        const dc = origCDC.apply(this, arguments);
        hookDC(dc);
        return dc;
      };
      window.RTCPeerConnection = function (...args) {
        const pc = new PC(...args);
        pc.addEventListener('datachannel', (e) => hookDC(e.channel));
        return pc;
      };
      window.RTCPeerConnection.prototype = PC.prototype;
    }
  } catch (e) {}

  const parseRetryAfter = (raw) => {
    if (!raw) return 0;
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    const dt = Date.parse(raw);
    return Number.isFinite(dt) ? Math.max(0, dt - Date.now()) : 0;
  };
  function replayQuotaRequest(manual, allowEarly) {
    if (netDiag.replayPending) return;
    if (!manual && Date.now() < netDiag.replayBlockedUntil) return;
    if (!manual && !allowEarly && netDiag.lastCaptureAt && Date.now() - netDiag.lastCaptureAt < 50000) return;
    if (!memReplayReq && !(memApiAuth && memApiAuth.headers) && netDiag.replayAuthFailed) return;
    let r = memReplayReq;
    if (!r) {
      try {
        const s = JSON.parse(localStorage.getItem(REPLAY_KEY));
        if (s && typeof s.url === 'string' && isSafeReplayUrl(s.url)) {
          const hasLiveAuth = API_SERVICE_RE.test(s.url) && !!(memApiAuth && memApiAuth.headers);
          if (!hasLiveAuth) {
            const f = JSON.parse(localStorage.getItem(REPLAY401_KEY) || 'null');
            if (f && f.url === s.url && Date.now() - f.t < 6 * 3600e3) { netDiag.replayAuthFailed = true; return; }
          }
          const m = String(s.method || 'GET').toUpperCase();
          if (m !== 'GET' && m !== 'POST') return;
          const h = {};
          if (typeof s.contentType === 'string' && s.contentType) h['Content-Type'] = s.contentType;
          else if (typeof s.body === 'string' && /^\s*[\{\[]/.test(s.body)) h['Content-Type'] = 'application/json';
          if (typeof s.userAgent === 'string' && s.userAgent) h['X-User-Agent'] = s.userAgent;
          if (typeof s.quotaProject === 'string' && s.quotaProject) h['X-Goog-User-Project'] = s.quotaProject;
          r = { url: s.url, method: m, body: typeof s.body === 'string' ? s.body : null, headers: Object.keys(h).length ? h : null };
        }
      } catch (e) {}
    }
    if (!r || !isSafeReplayUrl(r.url)) return;
    // Upgrade legacy stored GetUserStatus ProxyCommand (application/proto) to RetrieveUserQuotaSummary (all 5 limits)
    const upgraded = toQuotaSummaryProxyReq(r);
    if (upgraded && upgraded.body !== r.body) { r = upgraded; saveReplayReq(r); }
    // Attach freshest live ApiService auth headers (e.g. SAPISIDHASH from ListInstances) so replay never expires or 401s after F5
    let finalHeaders = r.headers && typeof r.headers === 'object' ? Object.assign({}, r.headers) : null;
    if (API_SERVICE_RE.test(r.url) && memApiAuth && memApiAuth.headers) {
      finalHeaders = mergeHeaders(finalHeaders || { 'Content-Type': 'application/json+protobuf' }, memApiAuth.headers, ['content-type']);
    }
    const sendBody = (typeof r.body === 'string' && r.body.startsWith('__b64__:')) ? b64ToU8(r.body.slice(8)) : r.body;
    const hasBody = r.method !== 'GET' && r.method !== 'HEAD' && sendBody != null;
    const opts = { method: r.method, body: hasBody ? sendBody : undefined, credentials: 'include', signal: AbortSignal.timeout(15000) }; // hung replay must release replayPending
    if (finalHeaders && Object.keys(finalHeaders).length) opts.headers = finalHeaders;
    netDiag.replayPending = true;
    netDiag.lastReplayAt = Date.now();
    netDiag.lastReplayUrl = String(r.url).split('?')[0].slice(0, 140);
    let respCt = '';
    origFetch(r.url, opts)
      .then((res) => {
        netDiag.lastReplayStatus = res ? String(res.status) : 'null';
        if (res && (res.status === 401 || res.status === 403)) {
          // Stored copy has no auth headers, or in-memory auth expired: stop repeating 401 until the app sends a fresh authenticated request
          const usedLiveAuth = !!(API_SERVICE_RE.test(r.url) && memApiAuth);
          memReplayReq = null;
          if (usedLiveAuth) { memApiAuth = null; lastAutoSummaryAt = Date.now() + 60000; }
          netDiag.replayAuthFailed = true;
          try { localStorage.setItem(REPLAY401_KEY, JSON.stringify({ url: redactSecretParams(sanitizeReplayUrl(r.url)), t: Date.now() })); } catch (e) {}
        } else if (res && (res.status === 429 || res.status >= 500)) {
          const ra = parseRetryAfter(res.headers && res.headers.get('retry-after'));
          netDiag.replayBackoffMs = Math.min(600000, Math.max(netDiag.replayBackoffMs ? netDiag.replayBackoffMs * 2 : REPLAY_INTERVAL_MS * 2, ra));
          netDiag.replayBlockedUntil = Date.now() + netDiag.replayBackoffMs;
        }
        if (!res || !res.ok) return null;
        netDiag.replayBackoffMs = 0;
        netDiag.replayBlockedUntil = 0;
        respCt = (res.headers && res.headers.get('content-type')) || '';
        const cl = parseInt((res.headers && res.headers.get('content-length')) || '', 10);
        if (STATIC_URL_RE.test(r.url) || SKIP_CT_RE.test(respCt) || cl > 2e6) return null;
        const isBin = BIN_CT_RE.test(respCt) && !/json|text/i.test(respCt);
        return res.body ? readBodyCapped(res.body, 2e6, !isBin) : (isBin ? res.arrayBuffer() : res.text());
      })
      .then((d) => { if (d) sniffAny(d, null, respCt); })
      .catch((err) => { netDiag.lastReplayStatus = 'err:' + ((err && err.name) || 'fetch'); })
      .finally(() => { netDiag.replayPending = false; });
  }
  if (isAgContent) {
    setInterval(() => replayQuotaRequest(false), REPLAY_INTERVAL_MS);
    setTimeout(() => replayQuotaRequest(false), 1500);
  }

  const QUOTA_STR_KEYS = [
    'geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h',
    'geminiWeeklyReset', 'gemini5hReset', 'claudeWeeklyReset', 'claude5hReset',
    'custom', 'lastUpdated', 'source'
  ];
  const LIMIT_KEYS = ['geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h'];
  // observedAt per limit: <key>At = when the value was last read. Old data must not look fresh (history, forecast, alerts).
  const QUOTA_TS_KEYS = LIMIT_KEYS.flatMap((k) => [k + 'ResetTs', k + 'At']);
  const STALE_MS = 10 * 60 * 1000;
  const isFresh = (k) => Date.now() - (quotaState[k + 'At'] || 0) <= STALE_MS;
  const staleAny = () => LIMIT_KEYS.some((k) => /\d/.test(quotaState[k]) && !isFresh(k));
  // Merge a payload from another tab/frame: a limit older than ours is dropped (a stale cache must not overwrite fresh data).
  function mergeQuota(clean) {
    let anyLimit = false, acceptedLimit = false;
    LIMIT_KEYS.forEach((k) => {
      if (k in clean || (k + 'At') in clean) anyLimit = true;
      if ((clean[k + 'At'] || 0) < (quotaState[k + 'At'] || 0)) ['', 'Reset', 'ResetTs', 'At'].forEach((x) => delete clean[k + x]);
      else if (k in clean) acceptedLimit = true;
    });
    if (anyLimit && !acceptedLimit) {
      delete clean.source;
      delete clean.lastUpdated;
    }
    if (!Object.keys(clean).length) return false;
    Object.assign(quotaState, clean);
    return acceptedLimit || !anyLimit;
  }
  function sanitizeQuotaPayload(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const clean = {};
    for (const k of QUOTA_STR_KEYS) {
      if (typeof p[k] === 'string') clean[k] = p[k].slice(0, 60);
    }
    for (const k of QUOTA_TS_KEYS) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) clean[k] = Math.round(p[k]);
    }
    for (const k of LIMIT_KEYS) { // limit = '?' or 0–100%; anything else is dropped together with its reset/timestamps
      const v = clean[k];
      if (v !== undefined && !(v === '?' || (/^\d{1,3}%$/.test(v) && parseInt(v, 10) <= 100))) ['', 'Reset', 'ResetTs', 'At'].forEach((x) => delete clean[k + x]);
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

  function isElHidden(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return true;
    if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) {
      if (typeof getComputedStyle !== 'function' || getComputedStyle(node).display !== 'contents') return true;
      for (let p = node.parentElement || (node.getRootNode && node.getRootNode().host) || null; p; p = p.parentElement || (p.getRootNode && p.getRootNode().host) || null) {
        if (p.hidden || p.getAttribute('aria-hidden') === 'true') return true;
        if (typeof p.checkVisibility === 'function' && !p.checkVisibility() && getComputedStyle(p).display !== 'contents') return true;
      }
    }
    return false;
  }

  function getConnectedShadowRoots() {
    const list = [];
    shadowRoots.forEach((root) => {
      if (!root.host || !root.host.isConnected) {
        if (root._agSeenConnected || root.mode === 'open') shadowRoots.delete(root);
        return;
      }
      try { root._agSeenConnected = true; } catch (e) {}
      list.push(root);
    });
    return list;
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
        if (/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(node.tagName)) return;
        if (isElHidden(node)) return;

        // Collect ARIA values (in case progress bars lack visible text)
        const ariaLabel = node.getAttribute('aria-label');
        const ariaNow = node.getAttribute('aria-valuenow');
        if (ariaLabel) chunks.push(ariaLabel);
        if (ariaNow) chunks.push(ariaNow + '%');

        if (node.shadowRoot) {
          try { if (node.isConnected) node.shadowRoot._agSeenConnected = true; } catch (e) {}
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
      walk(document.body);
    }

    // Walk all connected intercepted ShadowRoots (including closed ones)
    getConnectedShadowRoots().forEach((root) => {
      if (!isElHidden(root.host)) walk(root);
    });

    return normalizeText(chunks.join(' '));
  }

  // 4a. "% left" format: sections "Gemini Models" and "Claude and GPT models";
  // "Weekly limit / Resets in 6d 2h / 44% left" and "5h limit / Resets in 2h 2m / 98% left".
  function scrapeLeftFormat(stream) {
    const heads = [...stream.matchAll(/Gemini\s+Models|Claude\s+and\s+GPT\s+models/g)];
    if (!/%\s*left/i.test(stream) || !heads.length) return false;
    const RESET = /resets\s+in\s+((?:\d+\s*[wdhms]\s*)+)/i;
    let found = false;
    heads.forEach((h, i) => {
      const seg = stream.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined);
      const name = h[0].replace(/\s+/g, ' ').trim();
      const fam = /claude/i.test(name) ? 'claude' : 'gemini';
      const set = (win, pct, reset) => {
        if (parseInt(pct, 10) > 100) return; // invalid percentage: keep the previous reading
        const k = fam + win;
        const cleanReset = reset ? reset.trim() : '';
        const prevReset = quotaState[k + 'Reset'] || '';
        const prevTs = quotaState[k + 'ResetTs'] || 0;
        const now = Date.now();
        quotaState[k] = pct + '%';
        quotaState[k + 'At'] = now;
        quotaState[k + 'Reset'] = cleanReset;
        if (!cleanReset) {
          quotaState[k + 'ResetTs'] = 0;
        } else if (prevReset !== cleanReset || !prevTs || prevTs <= now) {
          const dur = parseDur(cleanReset);
          quotaState[k + 'ResetTs'] = dur ? Math.round(now + dur) : 0;
        }
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
    });
    return found;
  }

  // 4. Parse the continuous text stream
  function scrapeLimits() {
    const stream = getFullTextStream();
    if (!stream) return false;

    // Settings → Customizations: "172 / 20,000 tokens (0.9%)" — rules/skills/MCP budget (used, not remaining)
    const cm = /Customizations\s+([\d,]+)\s*\/\s*([\d,]+)\s*tokens\s*\(\s*([\d.]+)\s*%\s*\)/i.exec(stream);
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
    const hasPartial = !!(partial && Object.keys(partial).length);
    Object.assign(quotaState, partial);
    LIMIT_KEYS.forEach((k) => { if (partial && k in partial) quotaState[k + 'At'] = Date.now(); });
    quotaState.lastUpdated = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    quotaState.source = source;
    const sig = JSON.stringify(quotaState, (k, v) => (k === 'lastUpdated' || /At$/.test(k) ? undefined : v));
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
    } else if (hasPartial) {
      checkLow();
    }
    renderOverlay();
  }

  // Anchor default position to the right side of Antigravity's model selector row (before mic/send buttons).
  function findModelBarPos(el) {
    let btn = null;
    const roots = [document, ...getConnectedShadowRoots()];
    for (const root of roots) {
      for (const cand of root.querySelectorAll('button[data-testid="model-selector-trigger"]')) {
        const r = cand.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) { btn = cand; break; }
      }
      if (btn) break;
    }
    if (!btn) return null;
    const br = btn.getBoundingClientRect();
    let row = null;
    for (let p = btn.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
      const cls = typeof p.className === 'string' ? p.className : '';
      if (/\bflex-1\b/.test(cls) || p.querySelector('button[aria-label="Add context"]')) { row = p; break; }
    }
    const rr = row ? row.getBoundingClientRect() : null;
    const ow = el.offsetWidth || 200, oh = el.offsetHeight || 28;
    const rightEdge = (rr && rr.width > br.width + 20) ? rr.right - 6 : window.innerWidth - 16;
    const x = rightEdge - ow;
    const y = cfg.minimized ? (br.top + (br.height - oh) / 2) : (br.bottom - oh);
    return { x, y };
  }

  // Draggable overlay with saved position and optional docking to the model selector bar (opacity is managed by applyCfg)
  function makeMovable(el, key, anchorFn) {
    const st = document.createElement('style');
    st.textContent = `#${el.id}{transition:opacity .2s;touch-action:none}`;
    document.head.appendChild(st);

    const defPos = { left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom };
    let hasSavedPos = false, docked = false, drag = null, moved = false;
    function place(x, y) {
      x = Math.max(0, Math.min(Math.round(x), Math.max(0, window.innerWidth - el.offsetWidth)));
      y = Math.max(0, Math.min(Math.round(y), Math.max(0, window.innerHeight - el.offsetHeight)));
      if (el.style.left === x + 'px' && el.style.top === y + 'px' && el.style.right === 'auto' && el.style.bottom === 'auto') return;
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    }
    function syncPos() {
      if (drag || hasSavedPos) return;
      if (cfg.dockModelBar && anchorFn) {
        const pos = anchorFn(el);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) { docked = true; place(pos.x, pos.y); return; }
      }
      if (docked) { docked = false; Object.assign(el.style, defPos); }
    }
    el._syncPos = syncPos;
    el._resetPos = () => { try { localStorage.removeItem(key); } catch (e) {} hasSavedPos = false; docked = false; Object.assign(el.style, defPos); syncPos(); };
    el._clampPos = () => {
      if (!hasSavedPos && docked) { syncPos(); return; }
      if (el.style.left && el.style.left !== 'auto') place(el.offsetLeft, el.offsetTop);
    };
    try {
      const p = JSON.parse(localStorage.getItem(key));
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { hasSavedPos = true; place(p.x, p.y); }
    } catch (e) {}
    if (!hasSavedPos) { syncPos(); requestAnimationFrame(syncPos); }

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input,label,button,#ag-cfg-btn,#ag-min-btn')) return;
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
        hasSavedPos = true; docked = false;
        try { localStorage.setItem(key, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (e) {}
      }
      drag = null;
    });
    // Suppress refresh click after dragging
    el.addEventListener('click', (e) => {
      if (moved) { e.stopImmediatePropagation(); moved = false; }
    }, true);
    window.addEventListener('resize', () => { if (hasSavedPos) { if (el.style.left) place(el.offsetLeft, el.offsetTop); } else syncPos(); });
    setInterval(() => { if (!document.hidden && !hasSavedPos && cfg.dockModelBar) syncPos(); }, 500);
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

  function getResetText(key) {
    const ts = quotaState[key + 'ResetTs'];
    return ts > 0 ? fmtResetMs(ts) : (quotaState[key + 'Reset'] || '');
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
    const dynReset = key ? getResetText(key) : reset;
    if (dynReset) {
      const r = document.createElement('small');
      r.style.cssText = 'color:#888;font-size:9px;margin-right:6px;';
      r.textContent = '↻ ' + dynReset;
      right.appendChild(r);
    }
    right.appendChild(makeBadge(val));
    row.appendChild(right);
    return row;
  }

  function triggerFrameReplay() {
    document.querySelectorAll('iframe').forEach((f) => {
      try { if (f.contentWindow) f.contentWindow.postMessage({ type: 'AG_REPLAY_NOW' }, '*'); } catch (e) {}
    });
  }
  function refreshNow() {
    askNotifyPermission();
    lastDomScrapeAt = 0;
    update();
    replayQuotaRequest(true);
    triggerFrameReplay();
  }

  let overlayPointerDown = false, pendingRender = false, lastRenderSig = '';
  function makeHeaderBtns() {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:8px;';
    const BR = 'background:none;border:0;color:inherit;font-family:inherit;line-height:1;';
    if (snoozed()) {
      const m = document.createElement('span');
      m.textContent = '🔕';
      m.title = 'Alerts muted (snooze / quiet hours)';
      m.style.fontSize = '11px';
      wrap.appendChild(m);
    }
    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.id = 'ag-min-btn';
    minBtn.textContent = cfg.minimized ? '+' : '–';
    minBtn.title = cfg.minimized ? 'Expand' : 'Minimize';
    minBtn.setAttribute('aria-label', minBtn.title);
    minBtn.style.cssText = BR + 'cursor:pointer;font-size:13px;font-weight:bold;' + (cfg.minimized ? 'padding:0 3px;color:#ccc;' : 'padding:0 2px;');
    minBtn.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
    minBtn.onclick = (e) => {
      e.stopPropagation();
      cfg.minimized = !cfg.minimized;
      try { localStorage.setItem('ag_quota_cfg_v1', JSON.stringify(cfg)); } catch (err) {}
      renderOverlay();
    };
    const ref = document.createElement('button');
    ref.type = 'button';
    ref.id = 'ag-refresh-btn';
    ref.textContent = '⟳';
    ref.title = 'Refresh now';
    ref.setAttribute('aria-label', 'Refresh now');
    ref.style.cssText = BR + 'cursor:pointer;font-size:13px;';
    ref.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
    ref.onclick = (e) => { e.stopPropagation(); refreshNow(); };
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.id = 'ag-cfg-btn';
    gear.textContent = '⚙';
    gear.title = 'Settings';
    gear.setAttribute('aria-label', 'Settings');
    gear.style.cssText = BR + 'cursor:pointer;font-size:13px;';
    gear.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
    gear.onclick = (e) => { e.stopPropagation(); askNotifyPermission(); openSettings(); };
    wrap.append(...(cfg.minimized ? [minBtn, gear] : [ref, minBtn, gear]));
    return wrap;
  }

  function renderOverlay() {
    if (!isTopWindow) return;
    renderTitle();
    const el = document.getElementById('antigravity-usage-overlay');
    if (!el) return;
    if (overlayPointerDown) { pendingRender = true; return; }

    const keys = LIMIT_KEYS;
    const fcSig = keys.map((k) => {
      const f = forecast(k);
      return f ? (f.before ? '1:' : '0:') + fmtDur(f.etaMs) + ':' + f.rate.toFixed(1) : '';
    }).join('|');
    const sig = JSON.stringify([
      !!cfg.minimized, cfg.miniSrc, quotaState.source, quotaState.lastUpdated,
      quotaState.custom, quotaState.customPct, staleAny(), snoozed(),
      keys.map((k) => [quotaState[k], getResetText(k)]), fcSig
    ]);
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;

    el.style.minWidth = cfg.minimized ? 'auto' : '210px';
    el.style.padding = cfg.minimized ? '5px 10px' : '10px 14px';
    const fid = el.contains(document.activeElement) ? document.activeElement.id : ''; // rebuild must not drop keyboard focus
    const restoreFocus = () => { if (el._clampPos) el._clampPos(); if (fid) { const n = document.getElementById(fid); if (n) n.focus(); } };
    while (el.firstChild) el.removeChild(el.firstChild);

    if (cfg.minimized) {
      const pickMini = (gVal, cVal) => {
        if (cfg.miniSrc === 'claude') return cVal;
        if (cfg.miniSrc === 'min') {
          const gn = parseInt(gVal, 10), cn = parseInt(cVal, 10);
          if (!isNaN(gn) && !isNaN(cn)) return gn <= cn ? gVal : cVal;
          return isNaN(gn) ? cVal : gVal;
        }
        return gVal;
      };
      const pill = document.createElement('div');
      pill.style.cssText = 'display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:11px;';
      const info = document.createElement('span');
      info.append('\u{1F4CA} Weekly: ', makeBadge(pickMini(quotaState.geminiWeekly, quotaState.claudeWeekly)),
        ' \u00B7 5h: ', makeBadge(pickMini(quotaState.gemini5h, quotaState.claude5h)), staleAny() ? ' \u231B' : '');
      const btns = makeHeaderBtns();
      btns.style.marginLeft = 'auto';
      pill.append(info, btns);
      el.appendChild(pill);
      restoreFocus();
      return;
    }

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:4px;';
    const title = document.createElement('span');
    title.textContent = '🚀 Antigravity Quota';
    const status = document.createElement('span');
    status.style.cssText = 'font-size:9px;color:#888;display:inline-flex;align-items:center;';
    status.textContent = quotaState.source + (staleAny() ? ' · stale' : '');
    status.appendChild(makeHeaderBtns());
    head.appendChild(title);
    head.appendChild(status);
    el.appendChild(head);
    const sess = document.createElement('div');
    sess.id = 'ag-sessions';
    sess.setAttribute('role', 'status');
    sess.style.cssText = 'font-size:10px;color:#f97316;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;display:none;';
    el.appendChild(sess);
    renderTitle();

    const geminiTitle = document.createElement('div');
    geminiTitle.style.cssText = 'color:#8ab4f8;font-weight:600;font-size:11px;margin-bottom:3px;';
    geminiTitle.textContent = 'Gemini Models:';
    el.appendChild(geminiTitle);
    el.appendChild(renderRow('• Weekly:', quotaState.geminiWeekly, getResetText('geminiWeekly'), 'geminiWeekly'));
    el.appendChild(renderRow('• 5h:', quotaState.gemini5h, getResetText('gemini5h'), 'gemini5h'));

    const claudeTitle = document.createElement('div');
    claudeTitle.style.cssText = 'color:#c58af9;font-weight:600;font-size:11px;margin-top:6px;margin-bottom:3px;';
    claudeTitle.textContent = 'Claude & GPT Models:';
    el.appendChild(claudeTitle);
    el.appendChild(renderRow('• Weekly:', quotaState.claudeWeekly, getResetText('claudeWeekly'), 'claudeWeekly'));
    el.appendChild(renderRow('• 5h:', quotaState.claude5h, getResetText('claude5h'), 'claude5h'));

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
    restoreFocus();
  }

  // Settings: ⚙ panel in overlay header, saved to localStorage (ag_quota_cfg_v1). CFG_SCHEMA entries: [key, label, type, default].
  const CFG_SCHEMA = [
    ['qFrame', 'Question: pulsing border', 'bool', true],
    ['qSound', 'Question: sound', 'bool', true],
    ['qNotify', 'Question: browser notification', 'bool', true],
    ['qTitle', 'Question: ❓ in tab title', 'bool', true],
    ['qRepeatSec', 'Question: repeat every (s, 0 = once)', 'num', 60, [0, 3600]],
    ['dSound', 'Work done: sound', 'bool', true],
    ['dNotify', 'Work done: notification', 'bool', true],
    ['lowSound', 'Low quota: sound', 'bool', true],
    ['lowNotify', 'Low quota: notification', 'bool', true],
    ['dBlink', 'Work done: blink ✅ in title + green icon (silent)', 'bool', true],
    ['dMinSec', 'Work done: min work time (s)', 'num', 5, [0, 3600]],
    ['dRepeatSec', 'Work done: repeat every (s, 0 = off)', 'num', 0, [0, 3600]],
    ['lowPct', 'Low quota: alert below (%, 0 = off)', 'num', 10, [0, 100]],
    ['fcMin', 'Forecast: alert if limit ends within (min, 0 = off)', 'num', 30, [0, 1440]],
    ['miniSrc', 'Mini-mode shows', 'select', 'gemini', [['gemini', 'Gemini'], ['claude', 'Claude'], ['min', 'Lowest (min)']]],
    ['startMin', 'Start minimized on page load', 'bool', true],
    ['dockModelBar', 'Dock to model bar (default position)', 'bool', true],
    ['titlePct', 'Tab title %', 'select', 'gemini5h', [['gemini5h', 'Gemini 5h'], ['geminiWeekly', 'Gemini Weekly'], ['claude5h', 'Claude 5h'], ['claudeWeekly', 'Claude Weekly'], ['off', 'Off']]],
    ['hiddenOnly', 'Notifications only when tab is in background', 'bool', true],
    ['volume', 'Alert volume (%, 0 = silent)', 'num', 100, [0, 100]],
    ['reduceMotion', 'Reduce motion (no pulsing, static blink)', 'bool', false],
    ['quietFrom', 'Quiet hours: from (h, same as to = off)', 'num', 0, [0, 23]],
    ['quietTo', 'Quiet hours: to (h)', 'num', 0, [0, 23]],
    ['opacityIdle', 'Opacity (%)', 'num', 50, [10, 100]],
    ['opacityHover', 'Opacity on hover (%)', 'num', 90, [10, 100]]
  ];
  const cfg = Object.assign({ minimized: false }, Object.fromEntries(CFG_SCHEMA.map((s) => [s[0], s[3]])));
  try {
    const saved = JSON.parse(localStorage.getItem('ag_quota_cfg_v1')) || {};
    Object.assign(cfg, saved);
    // F3 migration (idempotent, presence-based — safe across rollback): low-quota alerts used to share dSound/dNotify.
    if (!('lowSound' in saved)) cfg.lowSound = cfg.dSound;
    if (!('lowNotify' in saved)) cfg.lowNotify = cfg.dNotify;
  } catch (e) {}
  // Types and ranges from the schema (num: 5th element [min, max]); applied at start, on change and on sync from another tab.
  function normCfg() {
    CFG_SCHEMA.forEach(([k, , type, def, opt]) => {
      if (type === 'num') { const n = typeof cfg[k] === 'number' ? cfg[k] : NaN; const [lo, hi] = opt || [0, 1e6]; cfg[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
      else if (type === 'bool') { if (typeof cfg[k] !== 'boolean') cfg[k] = def; }
      else if (type === 'select' && !opt.some(([v]) => v === cfg[k])) cfg[k] = def;
    });
  }
  normCfg();
  cfg.minimized = cfg.startMin ? true : !!cfg.minimized;

  function applyCfg() {
    let st = document.getElementById('antigravity-usage-overlay-cfgstyle');
    if (!st) { st = document.createElement('style'); st.id = 'antigravity-usage-overlay-cfgstyle'; document.head.appendChild(st); }
    st.textContent = `#antigravity-usage-overlay{opacity:${cfg.opacityIdle / 100} !important}#antigravity-usage-overlay:hover,#antigravity-usage-overlay:focus-within{opacity:${cfg.opacityHover / 100} !important}${cfg.reduceMotion ? '#antigravity-usage-overlay{animation:none !important}' : ''}`;
  }

  function syncPanelInputs() {
    const p = document.getElementById('antigravity-usage-overlay-cfg');
    if (!p) return;
    p.querySelectorAll('[data-cfg-key]').forEach((inp) => {
      const k = inp.dataset.cfgKey;
      if (!(k in cfg)) return;
      if (inp.type === 'checkbox') inp.checked = !!cfg[k];
      else inp.value = cfg[k];
    });
  }

  // F1: "Connection & data" block in settings: source and age of each limit, replay state, redacted diagnostics to clipboard.
  function diagReport() {
    const ageSec = (k) => (quotaState[k + 'At'] ? Math.round((Date.now() - quotaState[k + 'At']) / 1000) : null);
    const limits = {};
    LIMIT_KEYS.forEach((k) => { if (quotaState[k] && quotaState[k] !== '?') limits[k] = { value: quotaState[k], ageSec: ageSec(k), fresh: isFresh(k) }; });
    return { version: VERSION, at: new Date().toISOString(), limits, net: getNetDiagObj(), frames: frames.size };
  }
  function fmtAge(sec) { return sec == null ? 'no timestamp' : sec < 90 ? sec + ' s ago' : Math.round(sec / 60) + ' min ago'; }
  function buildDataBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Connection & data'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    box.appendChild(h);
    const rep = diagReport();
    const lines = ['Source: ' + quotaState.source + (quotaState.lastUpdated ? ' · ' + quotaState.lastUpdated : '')];
    LIMIT_KEYS.forEach((k) => { const l = rep.limits[k]; if (l) lines.push(k + ': ' + l.value + ' · ' + fmtAge(l.ageSec) + (l.fresh ? '' : ' (stale)')); });
    const n = rep.net;
    lines.push('Replay: ' + (n.lastReplayStatus || 'none yet') + (n.replayAuthFailed ? ' — waiting for the app\'s own request (stored copy has no auth)' : '') + (n.hasMemReplay ? ' · live request in memory' : '') + (n.hasLiveAuth ? ' · live auth ready' : ''));
    lines.push('Last capture: ' + (n.lastCaptureAt || 'none') + ' · frames: ' + rep.frames);
    lines.forEach((t) => { const d = document.createElement('div'); d.textContent = t; box.appendChild(d); });
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Copy diagnostics';
    b.style.cssText = 'margin-top:4px;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
    b.onclick = () => {
      let ok = false;
      try { navigator.clipboard.writeText(JSON.stringify(diagReport(), null, 2)).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); ok = true; } catch (e) {}
      if (!ok) b.textContent = 'Copy failed';
    };
    box.appendChild(b);
    return box;
  }

  const IDE_KIND = 'ag', CFG_KEY = 'ag_quota_cfg_v1', OVERLAY_ID = 'antigravity-usage-overlay';
  // F4: settings export/import (preferences only: no account data, no replay requests) and resets from the UI.
  function buildToolsBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Settings backup & reset'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('div'); note.style.cssText = 'min-height:12px;color:#8ab4f8;margin-top:2px;';
    const mk = (label, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = fn; return b;
    };
    const ta = document.createElement('textarea'); ta.placeholder = 'Paste exported settings JSON here'; ta.rows = 2;
    ta.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:3px;background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:4px;font-size:10px;';
    const save = () => {
      normCfg();
      cfg.minimized = !!cfg.minimized;
      try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
      syncPanelInputs();
      applyCfg();
      const o = document.getElementById(OVERLAY_ID);
      if (o && o._syncPos) o._syncPos();
      renderOverlay();
    };
    const exportJson = () => JSON.stringify({ ide: IDE_KIND, v: 1, cfg: Object.fromEntries([...CFG_SCHEMA.map((x) => x[0]), 'minimized'].map((k) => [k, cfg[k]])) }, null, 2);
    box.append(h,
      mk('Copy settings', () => { try { navigator.clipboard.writeText(exportJson()).then(() => { note.textContent = 'Settings copied'; }, () => { note.textContent = 'Copy failed'; }); } catch (e) { note.textContent = 'Copy failed'; } }),
      mk('Reset settings', () => { CFG_SCHEMA.forEach((x) => { cfg[x[0]] = x[3]; }); cfg.minimized = false; save(); note.textContent = 'Settings reset (history and position kept)'; }),
      mk('Reset position', () => { const o = document.getElementById(OVERLAY_ID); if (o && o._resetPos) o._resetPos(); note.textContent = 'Position reset'; }),
      ta,
      mk('Import settings', () => {
        let d; try { d = JSON.parse(ta.value); } catch (e) { note.textContent = 'Invalid JSON'; return; }
        if (!d || d.ide !== IDE_KIND || d.v !== 1 || !d.cfg || typeof d.cfg !== 'object') { note.textContent = 'Not a ' + IDE_KIND + ' settings export'; return; }
        const keys = [...CFG_SCHEMA.map((x) => x[0]), 'minimized'].filter((k) => k in d.cfg);
        keys.forEach((k) => { if (k === 'minimized') { if (typeof d.cfg.minimized === 'boolean') cfg.minimized = d.cfg.minimized; } else cfg[k] = d.cfg[k]; });
        save(); note.textContent = 'Imported ' + keys.length + ' settings (invalid values reset to allowed ranges)';
      }), note);
    return box;
  }

  // F3: alert presets — one click sets the per-category sound/notification toggles (no extra stored state, so rollback-safe).
  // Visual signals (frame, title, favicon) are never touched; only sound and system notifications.
  const PRESET_GROUPS = { q: ['qSound', 'qNotify'], d: ['dSound', 'dNotify'], l: ['lowSound', 'lowNotify'] };
  function buildPresetBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Alert presets (sound + notifications)'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('span'); note.style.cssText = 'margin-left:4px;color:#8ab4f8;';
    const apply = (label, on) => {
      Object.keys(PRESET_GROUPS).forEach((g) => PRESET_GROUPS[g].forEach((k) => { cfg[k] = on.includes(g); }));
      normCfg();
      try { localStorage.setItem('ag_quota_cfg_v1', JSON.stringify(cfg)); } catch (e) {}
      syncPanelInputs();
      if (on.length) askNotifyPermission();
      applyCfg(); renderOverlay();
      note.textContent = label + ' applied';
    };
    const mk = (label, on) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = () => apply(label, on);
      return b;
    };
    const testBtn = document.createElement('button'); testBtn.type = 'button'; testBtn.textContent = '🔊 Test sound';
    testBtn.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
    testBtn.onclick = () => { if (!cfg.volume) { note.textContent = 'volume is 0%'; return; } playDoneBeep(true); note.textContent = 'test played'; };
    box.append(h, mk('All alerts', ['q', 'd', 'l']), mk('Questions only', ['q']), mk('Silent (visual only)', []), testBtn, note);
    return box;
  }

  // F3: snooze sound + system notifications (visual signals stay); shared between tabs through localStorage.
  function buildSnoozeBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Snooze alerts (sound + notifications)'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('span'); note.style.cssText = 'margin-left:4px;color:#8ab4f8;';
    const show = () => {
      let u = 0; try { u = +localStorage.getItem('ide_snooze_until') || 0; } catch (e) {}
      note.textContent = u > Date.now() ? '🔕 until ' + new Date(u).toTimeString().slice(0, 5) : 'alerts on';
    };
    const mk = (label, min) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = () => { try { if (min) localStorage.setItem('ide_snooze_until', String(Date.now() + min * 60000)); else localStorage.removeItem('ide_snooze_until'); } catch (e) {} show(); renderOverlay(); };
      return b;
    };
    box.append(h, mk('15 min', 15), mk('60 min', 60), mk('Off', 0), note);
    show();
    return box;
  }

  function openSettings() {
    const old = document.getElementById('antigravity-usage-overlay-cfg');
    if (old) { if (old._close) old._close(); else old.remove(); return; }
    const ov = document.getElementById('antigravity-usage-overlay');
    const r = ov ? ov.getBoundingClientRect() : { left: innerWidth - 16, right: innerWidth - 16, top: innerHeight - 160, bottom: innerHeight - 80 };
    const p = document.createElement('div');
    p.id = 'antigravity-usage-overlay-cfg';
    p.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e1e;color:#e0e0e0;border:1px solid #777;border-radius:8px;padding:10px 12px;font:12px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;overflow-y:auto;';
    const h = document.createElement('div');
    h.textContent = '⚙ Antigravity Settings';
    h.style.cssText = 'font-weight:bold;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;';
    p.appendChild(h);
    const fWrap = document.createElement('div');
    fWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:6px;';
    const fInp = document.createElement('input');
    fInp.type = 'search'; fInp.id = 'ag-cfg-filter'; fInp.placeholder = 'Filter settings…';
    fInp.setAttribute('aria-label', 'Filter settings');
    fInp.style.cssText = 'flex:1;min-width:0;background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:4px;padding:3px 6px;font-size:11px;outline:none;';
    const fCnt = document.createElement('span');
    fCnt.style.cssText = 'font-size:10px;color:#888;white-space:nowrap;display:none;';
    const fClr = document.createElement('button');
    fClr.type = 'button'; fClr.textContent = '×'; fClr.title = 'Clear filter'; fClr.setAttribute('aria-label', 'Clear filter');
    fClr.style.cssText = 'background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:12px;line-height:1.2;cursor:pointer;display:none;';
    fWrap.append(fInp, fCnt, fClr);
    p.appendChild(fWrap);
    const rows = [];
    CFG_SCHEMA.forEach(([k, label, type, def, opts]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin:4px 0;cursor:pointer;';
      row.dataset.filterText = (k + ' ' + label + (type === 'select' ? ' ' + opts.map((o) => o[0] + ' ' + o[1]).join(' ') : '')).toLowerCase();
      const t = document.createElement('span'); t.textContent = label;
      let i;
      if (type === 'select') {
        i = document.createElement('select');
        i.style.cssText = 'background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:4px;padding:1px 4px;font-size:11px;';
        opts.forEach(([val, txt]) => { const o = document.createElement('option'); o.value = val; o.textContent = txt; i.appendChild(o); });
        i.value = cfg[k];
      } else {
        i = document.createElement('input');
        i.type = type === 'bool' ? 'checkbox' : 'number';
        if (type === 'bool') i.checked = !!cfg[k]; else { i.value = cfg[k]; i.style.width = '56px'; }
      }
      i.dataset.cfgKey = k;
      i.onchange = () => {
        if (type === 'select') cfg[k] = opts.some(([v]) => v === i.value) ? i.value : def;
        else if (type === 'bool') cfg[k] = i.checked;
        else { const n = parseFloat(i.value); cfg[k] = Number.isFinite(n) ? n : def; } // 0 is a valid value; range from schema (normCfg)
        normCfg(); if (type === 'num') i.value = cfg[k];
        if (type === 'bool' && i.checked && /Notify$/.test(k)) askNotifyPermission();
        try { localStorage.setItem('ag_quota_cfg_v1', JSON.stringify(cfg)); } catch (e) {}
        applyCfg();
        if (k === 'dockModelBar' && ov && ov._syncPos) ov._syncPos();
        renderOverlay();
      };
      row.append(t, i);
      rows.push(row);
      p.appendChild(row);
    });
    const boxes = [buildDataBox(), buildPresetBox(), buildSnoozeBox(), buildToolsBox()];
    boxes.forEach((b) => { b.dataset.filterText = (b.textContent || '').toLowerCase(); p.appendChild(b); });
    const fEmpty = document.createElement('div');
    fEmpty.textContent = 'No matching settings';
    fEmpty.style.cssText = 'display:none;color:#888;font-size:11px;padding:6px 0;text-align:center;';
    p.appendChild(fEmpty);
    const applyFilter = () => {
      const terms = fInp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0, boxShown = 0;
      rows.forEach((row) => {
        const ok = !terms.length || terms.every((w) => row.dataset.filterText.includes(w));
        row.style.display = ok ? 'flex' : 'none';
        if (ok) shown++;
      });
      boxes.forEach((b) => {
        const ok = !terms.length || terms.every((w) => b.dataset.filterText.includes(w));
        b.style.display = ok ? '' : 'none';
        if (ok) boxShown++;
      });
      fClr.style.display = terms.length ? '' : 'none';
      fCnt.style.display = terms.length ? '' : 'none';
      fCnt.textContent = shown + '/' + rows.length;
      fEmpty.style.display = (terms.length && !shown && !boxShown) ? '' : 'none';
    };
    fInp.oninput = applyFilter;
    fClr.onclick = () => { fInp.value = ''; applyFilter(); fInp.focus(); };
    const x = document.createElement('div');
    x.textContent = 'Refresh/threshold changes apply immediately; settings are stored per browser.';
    x.style.cssText = 'font-size:9px;color:#777;margin-top:6px;';
    p.appendChild(x);
    p.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(p);

    const pr = p.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    if (cx < innerWidth / 2) {
      const leftPx = (r.right + 8 + pr.width <= innerWidth - 8) ? r.right + 8 : Math.min(r.left, innerWidth - pr.width - 8);
      p.style.left = Math.max(8, leftPx) + 'px';
    } else {
      const rightPx = (r.left - 8 - pr.width >= 8) ? innerWidth - r.left + 8 : Math.min(innerWidth - r.right, innerWidth - pr.width - 8);
      p.style.right = Math.max(8, rightPx) + 'px';
    }
    if (cy < innerHeight / 2) {
      const topPx = (r.top + pr.height <= innerHeight - 8) ? r.top : Math.min(r.bottom + 6, innerHeight - pr.height - 8);
      p.style.top = Math.max(8, topPx) + 'px';
    } else {
      const botPx = (r.bottom - pr.height >= 8) ? innerHeight - r.bottom : Math.min(innerHeight - r.top + 6, innerHeight - pr.height - 8);
      p.style.bottom = Math.max(8, botPx) + 'px';
    }

    const close = (back) => {
      p.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      if (back) { const g = document.getElementById('ag-cfg-btn'); if (g) g.focus(); } // keyboard user returns to the gear
    };
    p._close = close;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Antigravity settings');
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (fInp.value) { fInp.value = ''; applyFilter(); fInp.focus(); return; }
        close(true);
      }
    };
    const onOutside = (e) => { if (!p.contains(e.target) && !(ov && ov.contains(e.target))) close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    const first = p.querySelector('input, select'); if (first) first.focus();
  }

  // 5. Antigravity question detection: a "?" icon appears in the conversation row (next to `conversation-kebab`).
  // Icon structure unconfirmed — search row elements for keywords in aria-label/title/data-testid/class.
  // If missed: run `__agDumpRows()` in console to inspect row HTML and add patterns to QUESTION_RE.
  const QUESTION_RE = /question|help|awaiting|waiting|needs[-_ ]?(input|attention|approval|response)|pending[-_ ]?(input|approval)|user[-_ ]?input|ask(ing)?[-_ ]user|attention/i;
  let questionActive = false;

  function allRoots() {
    const roots = [document];
    getConnectedShadowRoots().forEach((r) => roots.push(r));
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

  // R2: per-frame state keyed by WindowProxy (e.source) — one scalar let the last message overwrite every other frame.
  const frames = new Map(); // WindowProxy → { busy, q, title, at }
  let lastHiddenAt = document.hidden ? Date.now() : 0;
  function liveFrames() {
    const now = Date.now();
    if (document.hidden) lastHiddenAt = now;
    const qTtl = (document.hidden || now - lastHiddenAt < 5000) ? 75000 : 3000; // keep grace window briefly after returning from hidden tab so throttled frames don't drop & re-alert
    frames.forEach((s, w) => {
      let closed = false; try { closed = w.closed; } catch (e) { closed = true; }
      if (closed) frames.delete(w);
      else if (s.q && now - s.at > qTtl) s.q = false; // question heartbeat (sent every tick while found) went silent
    });
    return [...frames.values()];
  }
  const frameBusyTotal = () => liveFrames().reduce((n, s) => n + s.busy, 0);
  const frameQuestion = () => liveFrames().find((s) => s.q) || null;
  function detectQuestion(rows) {
    let qRow = null;
    try { qRow = rows.find(rowHasQuestion) || null; } catch (e) {}
    const found = !!qRow;
    const qTitle = qRow ? rowTitle(qRow) : '';
    // Top window has no rows when the list lives in an iframe: question = own row OR any live frame.
    if (isTopWindow) { const fq = found ? null : frameQuestion(); applyQuestion(found || !!fq, found ? qTitle : fq ? fq.title : ''); }
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
      else if (!busy && !QUESTION_RE.test(s) && n.childElementCount <= 2) { try { const an = getComputedStyle(n).animationName; if (an && an !== 'none') busy = true; } catch (e) {} }
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
        rec.idleAt = 0; rec.q = false; rec.seen = now; rec.title = rowTitle(row);
        return;
      }
      if (!rec) return;
      rec.seen = now;
      if (rowHasQuestion(row)) { rec.idleAt = 0; rec.q = true; return; } // working → question is not "done" (same guard as claude-usage)
      rec.q = false;
      if (!st.done) { // without explicit "done" badge: wait in case spinner flickers between steps
        if (!rec.idleAt) rec.idleAt = now;
        if (now - rec.idleAt < 3000) return;
      }
      rowBusy.delete(key);
      const dur = now - rec.since;
      if (isTopWindow) { if (dur >= cfg.dMinSec * 1000) alertDone(rec.title, key); }
      else { try { window.top.postMessage({ type: 'AG_DONE', title: rec.title, key, dur }, '*'); } catch (e) {} } // threshold = top cfg (frame has its own localStorage)
    });
    rowBusy.forEach((rec, k) => { if (now - rec.seen > 30000) rowBusy.delete(k); }); // row disappeared (re-render) for too long
    let busy = 0;
    rowBusy.forEach((r) => { if (!r.idleAt && !r.q) busy++; });
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
  const TITLE_PREFIX_RE = /^(?:(?:🔄\d*|❓|✅) )*(?:\d{1,3}% · )?/;
  // Background tab title blinking on question (❓ + orange icon) or completion (✅ + green icon); question takes priority.
  let blinkT = 0, blinkOn = false, blinkPrefix = ''; // note: 1s setInterval; Chrome throttles background timers to ~1/min after ~5 min
  let localBusy = 0, qActive = false, qLastTitle = '';
  let donePending = null, doneRepeatT = 0;

  function renderTitle() {
    if (!isTopWindow) return;
    const base = document.title.replace(TITLE_PREFIX_RE, '');
    const busy = localBusy + (isTopWindow ? frameBusyTotal() : 0);
    const busyStr = busy ? '🔄' + (busy > 1 ? busy : '') + ' ' : '';
    let alertStr = '';
    if (blinkT) alertStr = blinkOn ? blinkPrefix : '';
    else if (qActive && cfg.qTitle) alertStr = '❓ ';
    const rawPct = cfg.titlePct !== 'off' ? quotaState[cfg.titlePct] : '';
    const mPct = typeof rawPct === 'string' && rawPct.match(/^(\d{1,3})%?$/);
    const pctStr = mPct ? mPct[1] + '% · ' : '';
    const next = alertStr + busyStr + pctStr + base;
    if (document.title !== next) document.title = next;
    // F2: sessions summary in overlay (AG frames expose only counts and the asking conversation's title)
    const se = document.getElementById('ag-sessions');
    if (se) {
      const t = (qActive ? '❓ ' + (qLastTitle || 'question waiting') + (busy ? ' · ' : '') : '') + (busy ? '🔄 ' + busy + ' working' : '');
      if (se.textContent !== t) se.textContent = t;
      se.style.display = t ? '' : 'none';
    }
  }

  function startBlink(prefix, color) {
    if (!away()) return;
    if (prefix === '✅ ' && (!cfg.dBlink || qActive)) return; // question requires attention more urgently than completion
    if (prefix === '❓ ' && !cfg.qTitle) return;
    if (blinkT && blinkPrefix === prefix) return;
    blinkPrefix = prefix;
    blinkOn = true;
    setFav(color);
    if (!blinkT) blinkT = setInterval(() => { blinkOn = cfg.reduceMotion || !blinkOn; renderTitle(); }, 1000);
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
    if (!donePending && !blinkT && !openNs.size && !doneRepeatT) return;
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
      if (cfg.dSound) playDoneBeep();
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
    ['claude5h', 'Claude/GPT 5h']];
  let lowAlerted = {};
  try { lowAlerted = JSON.parse(localStorage.getItem('ag_quota_low_v1')) || {}; } catch (e) {}

  // Exhaustion forecast: "remaining %" history in localStorage, burn rate window (5h: 45 min, weekly: 6h).
  // Remaining % increase = window reset → clear history. Heartbeat every 5 min, so idle gaps dilute burn rate.
  let hist = {};
  try { hist = JSON.parse(localStorage.getItem('ag_quota_hist_v1')) || {}; } catch (e) {}
  // Another tab raised a low-quota/forecast alert, changed settings/snooze, or refreshed quota → sync immediately.
  window.addEventListener('storage', (e) => {
    try {
      if (e.key === 'ag_quota_low_v1') lowAlerted = JSON.parse(e.newValue) || {};
      else if (e.key === 'ide_snooze_until') {
        renderOverlay();
      }
      else if (e.key === 'ag_quota_cfg_v1' && e.newValue) {
        const c = JSON.parse(e.newValue);
        if (c && typeof c === 'object') {
          Object.assign(cfg, c);
          normCfg();
          cfg.minimized = !!cfg.minimized;
          syncPanelInputs();
          applyCfg();
          renderTitle();
          renderOverlay();
        }
      }
      else if (e.key === 'ag_quota_state_v3' && e.newValue) {
        const clean = sanitizeQuotaPayload(JSON.parse(e.newValue));
        if (clean && mergeQuota(clean)) {
          netDiag.lastCaptureAt = Date.now();
          checkLow();
          renderTitle();
          renderOverlay();
        }
      }
    } catch (err) {}
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
      if (isNaN(v) || !isFresh(k)) return;
      const h = hist[k] || (hist[k] = []);
      const last = h[h.length - 1];
      if (last && v > last.v) h.length = 0;
      if (!h.length || v !== h[h.length - 1].v || now - h[h.length - 1].t > 300000) { h.push({ t: now, v }); changed = true; }
      while (h.length && now - h[0].t > 7 * 3600e3) h.shift();
    });
    if (changed) try { localStorage.setItem('ag_quota_hist_v1', JSON.stringify(hist)); } catch (e) {}
  }
  function forecast(k) {
    if (!isFresh(k)) return null;
    const now = Date.now(), win = /Weekly$/.test(k) ? 6 * 3600e3 : 45 * 60e3;
    const pts = (hist[k] || []).filter((p) => now - p.t <= win);
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1], drop = a.v - b.v, dt = (b.t - a.t) / 3600e3;
    if (drop < 2 || dt < 3 / 60) return null; // too little change (1% rounding) or measurement window too short
    const rate = drop / dt, etaMs = Math.max(0, (b.v / rate) * 3600e3 - (now - b.t));
    const ts = quotaState[k + 'ResetTs'];
    const reset = ts > 0 ? Math.max(0, ts - now) : parseDur(quotaState[k + 'Reset']);
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
        if (cfg.lowSound) playLowBeep();
        if (cfg.lowNotify) notify(title, body, 'ag-' + key);
      });
    };
    LOW_KEYS.forEach(([k, label]) => {
      const v = parseInt(quotaState[k], 10);
      if (isNaN(v) || !isFresh(k)) return;
      const reset = getResetText(k);
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
  const openNs = new Map(); // open sticky notifications (Notification → tag); closeN closes all or matching tag prefix
  function closeN(prefix) { openNs.forEach((t, n) => { if (!prefix || t.startsWith(prefix)) { try { n.close(); } catch (e) {} openNs.delete(n); } }); }
  const snoozed = () => { try { if (Date.now() < (+localStorage.getItem('ide_snooze_until') || 0)) return true; } catch (e) {} const f = cfg.quietFrom, t = cfg.quietTo, h = new Date().getHours(); return f !== t && (f < t ? h >= f && h < t : h >= f || h < t); }; // F3: sound and system notifications muted until ts (visual signals stay)
  // R10: one persistent visually-hidden live region (outside the rebuilt overlay), updated only on alert events (change in one = change in both).
  function announce(text) {
    try {
      let n = document.getElementById('ide-live');
      if (!n) {
        n = document.createElement('div'); n.id = 'ide-live';
        n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
        n.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
        document.body.appendChild(n);
      }
      n.textContent = '';
      setTimeout(() => { n.textContent = String(text).slice(0, 200); }, 50); // empty first: identical consecutive text is announced again
    } catch (e) {}
  }
  function notify(title, body, tag, force, sticky, onClick) {
    announce(title + (body ? ': ' + body : ''));
    if (snoozed()) return;
    if (cfg.hiddenOnly && !away() && !force) return;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body, tag, requireInteraction: !!sticky });
        if (sticky) openNs.set(n, tag || '');
        n.onclick = () => { window.focus(); try { if (onClick) onClick(); } catch (e) {} n.close(); openNs.delete(n); };
      }
    } catch (e) {}
  }

  // Single shared AudioContext; unlocked on first user gesture (autoplay policy) so background-tab alerts
  // don't wait until return. Drop signals delayed >1.5s (context resumed only on return): stale alert is worse than silence.
  let actx = null;
  function ensureAudio() {
    if (actx && actx.state === 'running') return actx;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!actx) actx = new AudioCtx();
      if (actx.state !== 'running') actx.resume().catch(() => {});
      return actx;
    } catch (e) { return null; }
  }
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, ensureAudio, true));
  function playTones(notes, ignoreSnooze) {
    if ((!ignoreSnooze && snoozed()) || !cfg.volume) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = Date.now();
    const go = () => {
      if (Date.now() - t0 > 1500) return;
      try {
        notes.forEach(({ freq, start, duration, type = 'sine', gainVal = 0.12 }) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
          gain.gain.setValueAtTime(Math.max(0.002, gainVal * cfg.volume / 100), ctx.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + duration);
        });
      } catch (e) {}
    };
    if (ctx.state === 'running') go(); else ctx.resume().then(go, () => {});
  }
  const playQuestionBeep = (ignoreSnooze) => playTones([
    { freq: 880, start: 0, duration: 0.14, type: 'sine', gainVal: 0.12 },
    { freq: 1175, start: 0.18, duration: 0.15, type: 'sine', gainVal: 0.12 }
  ], ignoreSnooze);
  const playDoneBeep = (ignoreSnooze) => playTones([
    { freq: 698.46, start: 0, duration: 0.12, type: 'triangle', gainVal: 0.11 },
    { freq: 1046.50, start: 0.14, duration: 0.22, type: 'triangle', gainVal: 0.11 }
  ], ignoreSnooze);
  const playLowBeep = (ignoreSnooze) => playTones([
    { freq: 659.25, start: 0, duration: 0.15, type: 'triangle', gainVal: 0.11 },
    { freq: 440, start: 0.18, duration: 0.24, type: 'triangle', gainVal: 0.11 }
  ], ignoreSnooze);

  // Called every 1s (or via postMessage from iframe). Alerts when question appears and repeats every cfg.qRepeatSec.
  let qSeen = false, qLastAlert = 0;
  function applyQuestion(on, title) {
    qActive = on;
    if (title) qLastTitle = title;
    const el = document.getElementById('antigravity-usage-overlay');
    if (el) el.classList.toggle('ag-question', on && cfg.qFrame);
    if (!on) { qSeen = false; qLastTitle = ''; closeN('ag-q'); stopBlink('❓ '); renderTitle(); return; }
    startBlink('❓ ', '#f97316');
    renderTitle();
    const now = Date.now();
    if (qSeen && (!cfg.qRepeatSec || now - qLastAlert < cfg.qRepeatSec * 1000)) return;
    qSeen = true; qLastAlert = now;
    const body = qLastTitle || 'Question waiting in conversation';
    const qTtl = cfg.qRepeatSec ? Math.min(5000, Math.max(500, cfg.qRepeatSec * 500)) : 5000;
    claimOnce('question', qTtl).then((ok) => {
      if (!ok) return;
      if (cfg.qSound) playQuestionBeep();
      if (cfg.qNotify) notify('Antigravity asks', body, 'ag-q', false, true);
    });
  }

  // Frame-host diagnostics to narrow @match *.google.com safely: `__agDiag()` in AG console prints hosts and network stats.
  const diagFrames = new Map();
  const frameNets = new Map();
  let lastDiagRows = -1, lastDiagAt = 0;
  function getNetDiagObj() {
    let hasStoredReplay = false;
    try { hasStoredReplay = !!localStorage.getItem(REPLAY_KEY); } catch (e) {}
    return {
      source: quotaState.source, lastUpdated: quotaState.lastUpdated, isAgFrame, isAgContent,
      hasMemReplay: !!memReplayReq, hasLiveAuth: !!(memApiAuth && memApiAuth.headers), hasStoredReplay, replayAuthFailed: netDiag.replayAuthFailed,
      lastCaptureAt: netDiag.lastCaptureAt ? new Date(netDiag.lastCaptureAt).toTimeString().slice(0, 8) : '',
      lastCaptureUrl: netDiag.lastCaptureUrl, lastReplayStatus: netDiag.lastReplayStatus,
      lastReplayUrl: netDiag.lastReplayUrl, rpcs: netDiag.rpcs, candidates: netDiag.candidates
    };
  }
  function recordDiagFrame(host, top, agFrame, rows) {
    diagFrames.set(host + '|' + (top ? 'top' : 'sub'), {
      host, top, agFrame, rows, t: new Date().toTimeString().slice(0, 8)
    });
  }
  window.__agDiag = () => {
    const list = [...diagFrames.values()];
    try {
      console.table(list);
      console.info('[AG Quota] netDiag', getNetDiagObj());
      frameNets.forEach((v, k) => console.info('[AG Quota] subNetDiag', k, v));
    } catch (e) {}
    return list;
  };

  if (!isTopWindow && isAgContent) {
    window.addEventListener('message', (e) => {
      if (!e || e.source !== window.top || !okOrigin(e.origin) || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'AG_REPLAY_NOW') replayQuotaRequest(true);
    });
    window.addEventListener('pagehide', () => { try { window.top.postMessage({ type: 'AG_FRAME_UNLOAD' }, '*'); } catch (e) {} });
  }

  if (isTopWindow) {
    window.addEventListener('message', (e) => {
      if (!okFrameMsg(e)) return;
      const d = e.data;
      if (d.type === 'AG_QUOTA_SYNC') {
        const clean = sanitizeQuotaPayload(d.payload);
        if (clean && mergeQuota(clean)) {
          if (clean.source === 'Network') netDiag.lastCaptureAt = Date.now();
          try { localStorage.setItem('ag_quota_state_v3', JSON.stringify(quotaState)); } catch (err) {}
          checkLow();
          renderOverlay();
        }
      } else if (d.type === 'AG_QUESTION' && typeof d.value === 'boolean') {
        const fs = frames.get(e.source) || { busy: 0, q: false, title: '', at: 0 };
        Object.assign(fs, { q: d.value, title: typeof d.title === 'string' ? d.title.slice(0, 120) : '', at: Date.now() });
        frames.set(e.source, fs);
        const fq = frameQuestion();
        applyQuestion(questionActive || !!fq, questionActive ? '' : fq ? fq.title : '');
      } else if (d.type === 'AG_DONE' && typeof d.title === 'string') {
        if (Number.isFinite(d.dur) && d.dur < cfg.dMinSec * 1000) return;
        alertDone(d.title.slice(0, 120), typeof d.key === 'string' ? d.key.slice(0, 200) : '');
      } else if (d.type === 'AG_BUSY' && typeof d.count === 'number' && Number.isFinite(d.count)) {
        const fs = frames.get(e.source) || { busy: 0, q: false, title: '', at: 0 };
        fs.busy = Math.max(0, Math.min(999, Math.floor(d.count)));
        frames.set(e.source, fs);
        renderTitle();
      } else if (d.type === 'AG_FRAME_UNLOAD') {
        if (frames.delete(e.source)) {
          const fq = frameQuestion();
          applyQuestion(questionActive || !!fq, questionActive ? '' : fq ? fq.title : '');
          renderTitle();
        }
      } else if (d.type === 'AG_DIAG' && typeof d.host === 'string' && typeof d.rows === 'number') {
        const h = d.host.slice(0, 120);
        recordDiagFrame(h, false, !!d.agFrame, Math.max(0, Math.min(9999, Math.floor(d.rows))));
        if (d.net && typeof d.net === 'object' && !Array.isArray(d.net)) frameNets.set(h, d.net);
      }
    });
  }

  let lastDomScrapeAt = 0, lastDomFound = false;
  function update() {
    const now = Date.now();
    if (!document.hidden && (lastDomFound || now - lastDomScrapeAt >= 3000)) {
      lastDomScrapeAt = now;
      lastDomFound = scrapeLimits();
    }
    let rows = [];
    try { rows = conversationRows(); } catch (e) {}
    if (rows.length > 0) {
      recordDiagFrame(location.hostname, isTopWindow, isAgFrame, rows.length);
      if (!isTopWindow && (rows.length !== lastDiagRows || Date.now() - lastDiagAt > 10000)) {
        lastDiagRows = rows.length; lastDiagAt = Date.now();
        try { window.top.postMessage({ type: 'AG_DIAG', host: location.hostname, agFrame: isAgFrame, rows: rows.length, net: getNetDiagObj() }, '*'); } catch (e) {}
      }
    } else if (!isTopWindow && isAgContent && (Object.keys(netDiag.rpcs).length || netDiag.candidates.length) && Date.now() - lastDiagAt > 10000) {
      lastDiagAt = Date.now();
      try { window.top.postMessage({ type: 'AG_DIAG', host: location.hostname, agFrame: isAgFrame, rows: 0, net: getNetDiagObj() }, '*'); } catch (e) {}
    }
    detectQuestion(rows);
    try { detectDone(rows); } catch (e) {}
    if (isTopWindow) checkLow();
    renderTitle();
    renderOverlay();
  }

  function initOverlay() {
    // Run loop only in Antigravity (and its usercontent iframes) — not on Gmail/Docs matched by *.google.com.
    if (isAgContent) {
      setInterval(update, 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) lastHiddenAt = Date.now();
        else { lastDomScrapeAt = 0; update(); }
      });
      // Event-driven detection: MutationObserver is not throttled in background tabs (setInterval is, ~1/min),
      // and a one-shot setTimeout from its callback is not chained, so idle confirmation fires on time.
      let detT = 0;
      const schedDet = (ms) => { if (!detT) detT = setTimeout(runDet, ms); };
      function runDet() {
        detT = 0;
        let rows = [];
        try { rows = conversationRows(); } catch (e) {}
        detectQuestion(rows);
        try { detectDone(rows); } catch (e) {}
        renderTitle();
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
    const prev = document.getElementById('antigravity-usage-overlay');
    if (prev) {
      if (prev.dataset.ver !== VERSION && !document.getElementById('ag-usage-dup-warn')) {
        const w = document.createElement('div');
        w.id = 'ag-usage-dup-warn';
        w.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483647;background:#3a1f1b;color:#ffd0c7;border:1px solid #ff6b6b;border-radius:6px;padding:6px 10px;font:11px/1.35 sans-serif;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,.6);cursor:pointer;';
        w.textContent = `⚠️ Duplicate Antigravity script in Tampermonkey (${prev.dataset.ver || '≤3.11.20'} blocks v${VERSION}). Remove the older copy in Tampermonkey Dashboard.`;
        w.title = 'Click to dismiss';
        w.onclick = () => w.remove();
        document.body.appendChild(w);
      }
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'antigravity-usage-overlay';
    overlay.dataset.ver = VERSION;
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
      '#antigravity-usage-overlay.ag-question{border:2px solid #ff9800;animation:agq 1s ease-in-out infinite}' +
      '#antigravity-usage-overlay button:focus-visible,#antigravity-usage-overlay-cfg :focus-visible{outline:2px solid #8ab4f8;outline-offset:1px}' +
      '@media (prefers-reduced-motion:reduce){#antigravity-usage-overlay.ag-question{animation:none}}';
    document.head.appendChild(qs);
    overlay.title = 'Click to refresh; drag to move';
    overlay.addEventListener('pointerdown', () => { overlayPointerDown = true; }, true);
    const clearPointerDown = () => {
      if (!overlayPointerDown) return;
      overlayPointerDown = false;
      if (pendingRender) {
        pendingRender = false;
        setTimeout(() => { if (!overlayPointerDown) renderOverlay(); }, 0);
      }
    };
    ['pointerup', 'pointercancel', 'mouseleave'].forEach((ev) => overlay.addEventListener(ev, clearPointerDown));
    ['pointerup', 'pointercancel'].forEach((ev) => window.addEventListener(ev, clearPointerDown));
    overlay.onclick = (e) => {
      if (e && e.target && e.target.closest('#ag-cfg-btn, #ag-min-btn, button, input, label')) return;
      refreshNow();
    };
    document.body.appendChild(overlay);
    applyCfg();

    update();
    // SPA updates <title> on its own — re-apply our prefix (ignore <style>/<link> edits in <head>)
    try {
      new MutationObserver((recs) => {
        if (recs.some((m) => m.target.nodeName === 'TITLE' || (m.target.parentNode && m.target.parentNode.nodeName === 'TITLE') ||
            [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeName === 'TITLE'))) renderTitle();
      }).observe(document.head, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
    makeMovable(overlay, 'ag_quota_pos_v1', findModelBarPos);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverlay);
  } else {
    initOverlay();
  }
})();
