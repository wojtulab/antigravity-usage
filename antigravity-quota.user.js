// ==UserScript==
// @name         Antigravity Usage Overlay (Deep Scraper v3)
// @namespace    https://github.com/wojtulab/antigravity-usage
// @version      3.11.2
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
  const hasAnc = !!(location.ancestorOrigins && location.ancestorOrigins.length);
  const isAgFrame = /antigravity/i.test(location.hostname) ||
    (hasAnc ? [...location.ancestorOrigins].some((o) => /antigravity/i.test(o)) : /antigravity/i.test(document.referrer));
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
  const REPLAY_INTERVAL_MS = 60 * 1000;
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
  const VERSION = '3.11.2'; // single version constant in code (alongside @version in header); README does not duplicate it
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
    replayPending: false, replayAuthFailed: false, candidates: [], rpcs: {}
  };
  const recordCand = (url, ct, len, parsed) => {
    const cleanUrl = String(url || '').split('?')[0].slice(0, 140);
    netDiag.candidates.push({ url: cleanUrl, ct: String(ct || '').slice(0, 60), len, parsed, t: new Date().toTimeString().slice(0, 8) });
    if (netDiag.candidates.length > 8) netDiag.candidates.shift();
  };
  const extractRpcName = (req, ct) => {
    const url = (req && req.url) || '';
    const uq = /[?&]\$unique=([^&]+)/i.exec(url);
    if (uq) return decodeURIComponent(uq[1]).slice(0, 60);
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
      try { return { text: s, data: JSON.parse(s) }; } catch (e) {}
    }
    // Multi-line Google batchexecute chunks (length line followed by JSON array line)
    if (/\n[\[{]/.test(s)) {
      for (const line of s.split('\n')) {
        const l = line.trim();
        if (l && (l[0] === '[' || l[0] === '{')) {
          try { return { text: l, data: JSON.parse(l) }; } catch (e) {}
        }
      }
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
    if (/argon/i.test(text)) return 'argon';
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
    if (fam === 'argon' && !out.argonName) {
      const m = /Gemini\s+\d+\s+[A-Za-z]\w*/i.exec(ctxText);
      if (m) out.argonName = m[0].replace(/\s+/g, ' ').trim();
    }
    out[key] = pct + '%';
    const r = fmtResetMs(resetMs);
    out[key + 'Reset'] = r || '';
    out[key + 'ResetTs'] = Number.isFinite(resetMs) ? Math.round(resetMs) : 0;
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
      if (fn === 1 && wt === 5 && v >= 0 && v <= 1) frac = v;
      else if (fn === 2 && wt === 2) { resetMs = pbTsMs(v); if (!Number.isFinite(resetMs)) return null; }
      else return null;
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
            if (gfn === 2 && gwt === 2) { const s = pbStr(gv); if (s == null) return false; gName = s; }
            else if (gfn === 3 && gwt === 2) { const s = pbStr(gv); if (s == null) return false; gDesc = s; }
            else if (gfn === 1 && gwt === 2) gb.push(gv);
            else return false;
          }
          const gCtx = (gName + ' ' + gDesc).trim();
          for (const b of gb) buckets.push([gCtx, b]);
        }
      }
      if (!buckets.length) return false;
      const parsed = [];
      let hasFrac = false;
      for (const [gCtx, bU8] of buckets) {
        const bf = parsePbFields(bU8);
        if (!bf) return false;
        let texts = [], frac = null, amt = null, resetMs = NaN, disabled = false;
        for (const [bfn, bwt, bv] of bf) {
          if ((bfn === 1 || bfn === 2 || bfn === 3 || bfn === 7) && bwt === 2) {
            const s = pbStr(bv); if (s == null) return false; texts.push(s);
          } else if (bfn === 4 && bwt === 5 && bv >= 0 && bv <= 1) { frac = bv; hasFrac = true; }
          else if (bfn === 5 && bwt === 0) amt = bv;
          else if (bfn === 6 && bwt === 2) { resetMs = pbTsMs(bv); if (!Number.isFinite(resetMs)) return false; }
          else if (bfn === 8 && bwt === 0) disabled = !!bv;
          else return false;
        }
        if (!texts.length && frac === null && !Number.isFinite(resetMs)) return false;
        if (!disabled) parsed.push([(gCtx + ' ' + texts.join(' ')).trim(), frac, amt, resetMs]);
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
      if (fl <= 0 || p + 5 + fl > u8.length) break;
      if ((u8[p] & 0x80) === 0) frames.push(u8.subarray(p + 5, p + 5 + fl));
      p += 5 + fl;
    }
    const list = (p === u8.length && frames.length) ? frames : [u8];
    for (const f of list) {
      if (!f.length) continue;
      if ((f[0] === 0x7b || f[0] === 0x5b || f[0] === 0x29) && pbTd) {
        const txt = pbTd.decode(f);
        Object.assign(out, parseQuotaPayload(txt));
      } else {
        parsePbQuota(f, out);
      }
      if (Object.keys(out).length) return;
    }
  }

  function parseQuotaPayload(text) {
    const out = {};
    if (typeof text !== 'string' || !text.length) return out;
    const decoded = decodeCandidateText(text);
    if (!decoded) {
      // Raw base64 (e.g. Connect/gRPC-Web frame wrapped in text/plain)
      const s = text.replace(/^\)\]\}'\s*/, '').trim();
      if (/^[A-Za-z0-9+/=_-]{8,}$/.test(s)) {
        const u8 = b64ToU8(s);
        if (u8) parseBinaryPayload(u8, out);
      }
      return out;
    }
    const { text: cleanText, data } = decoded;
    if (Array.isArray(data)) {
      parseJspbQuota(data, out);
      if (Object.keys(out).length) return out;
    }
    // ProxyCommandResponse ["<b64>", ...] or Byoa { payload: "<b64>" }
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
      if (u8) { parseBinaryPayload(u8, out); if (Object.keys(out).length) return out; }
    }
    if (!/remaining.?(?:fraction|percent|pct)/i.test(cleanText)) return out;
    const LABEL_KEYS = ['displayName', 'display_name', 'label', 'name', 'title', 'refreshWindowLabel',
      'refresh_window_label', 'window', 'bucketId', 'bucket_id', 'quotaType', 'quota_type', 'tokenType',
      'token_type', 'group', 'groupName', 'model', 'modelId', 'model_id', 'modelName', 'description', 'period', 'id'];
    const RESET_KEYS = ['resetTime', 'reset_time', 'nextResetTime', 'next_reset_time', 'quotaResetTime'];
    const REMAIN_RE = /^(?:remaining.?(?:fraction|percent|percentage|pct))$/i;
    const hasExplicit = /"remaining.?(?:fraction|percent|percentage|pct)"\s*:/i.test(cleanText);
    const getResetMs = (obj) => {
      for (const rk of RESET_KEYS) {
        if (obj[rk] != null) { const ms = parseTimestampMs(obj[rk]); if (Number.isFinite(ms)) return ms; }
      }
      return NaN;
    };
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
          assignQuotaBucket(out, here, frac, resetMs);
        } else if (walk(v, here, resetMs)) {
          sawRemain = true;
        }
      }
      // Proto3 JSON omits 0.0 remainingFraction on exhausted buckets that still carry resetTime.
      if (!sawRemain && hasExplicit && Number.isFinite(ownReset) && !Array.isArray(o) &&
          o.disabled !== true && o.remainingAmount == null && o.remaining_amount == null) {
        assignQuotaBucket(out, here, 0, ownReset);
      }
      return sawRemain;
    })(data, '', NaN);
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

  function replayRank(req) {
    const s = ((req && req.url) || '') + ' ' + ((req && req.body) || '').slice(0, 400);
    if (/QuotaSummary|retrieveUserQuota/i.test(s)) return 4;
    if (/GetUserStatus|\/UserStatus/i.test(s)) return 3;
    if (/CascadeModelConfig|CommandModelConfig/i.test(s)) return 2;
    if (/AvailableModels/i.test(s)) return 1;
    return 2;
  }

  // Full request object (with headers, e.g. Authorization) stays in tab memory only — never written to localStorage.
  let memReplayReq = null;
  function saveReplayReq(req) {
    if (!req || (req.method !== 'GET' && req.body == null)) return;
    let curUrl = (memReplayReq && memReplayReq.url) || '';
    let curBody = (memReplayReq && memReplayReq.body) || '';
    if (!curUrl) {
      try { const s = JSON.parse(localStorage.getItem(REPLAY_KEY) || '{}'); curUrl = s.url || ''; curBody = s.body || ''; } catch (e) {}
    }
    if (curUrl && replayRank(req) < replayRank({ url: curUrl, body: curBody })) return;
    memReplayReq = req;
    netDiag.replayAuthFailed = false;
    const safeUrl = sanitizeReplayUrl(req.url);
    const stored = Object.assign({ url: safeUrl, method: req.method, body: req.body }, extractSafeReplayMeta(req.headers));
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
      console.info('[AG Quota] candidate', req && req.url, text.slice(0, 4000));
    }
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
          bodyReady = input.clone().arrayBuffer().then((buf) => bodyToText(buf)).catch(() => null);
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
        let respCt = '', isBin = false;
        p.then((r) => {
          if (!r || !r.ok) return null;
          respCt = (r.headers && r.headers.get('content-type')) || '';
          const cl = parseInt((r.headers && r.headers.get('content-length')) || '', 10);
          if (STATIC_URL_RE.test(r.url || urlStr) || SKIP_CT_RE.test(respCt) || cl > 2e6) return null;
          isBin = BIN_CT_RE.test(respCt) && !/json|text/i.test(respCt);
          return isBin ? r.clone().arrayBuffer() : r.clone().text();
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

  function replayQuotaRequest(manual) {
    if (netDiag.replayPending) return;
    if (!manual && netDiag.lastCaptureAt && Date.now() - netDiag.lastCaptureAt < 50000) return;
    if (!memReplayReq && !manual && netDiag.replayAuthFailed) return;
    let r = memReplayReq;
    if (!r) {
      try {
        const s = JSON.parse(localStorage.getItem(REPLAY_KEY));
        if (s && typeof s.url === 'string') {
          const h = {};
          if (typeof s.contentType === 'string' && s.contentType) h['Content-Type'] = s.contentType;
          else if (typeof s.body === 'string' && /^\s*[\{\[]/.test(s.body)) h['Content-Type'] = 'application/json';
          if (typeof s.userAgent === 'string' && s.userAgent) h['X-User-Agent'] = s.userAgent;
          if (typeof s.quotaProject === 'string' && s.quotaProject) h['X-Goog-User-Project'] = s.quotaProject;
          r = { url: s.url, method: String(s.method || 'GET'), body: typeof s.body === 'string' ? s.body : null, headers: Object.keys(h).length ? h : null };
        }
      } catch (e) {}
    }
    if (!r) return;
    const sendBody = (typeof r.body === 'string' && r.body.startsWith('__b64__:')) ? b64ToU8(r.body.slice(8)) : r.body;
    const hasBody = r.method !== 'GET' && r.method !== 'HEAD' && sendBody != null;
    const opts = { method: r.method, body: hasBody ? sendBody : undefined, credentials: 'include' };
    if (r.headers && typeof r.headers === 'object') opts.headers = r.headers;
    netDiag.replayPending = true;
    netDiag.lastReplayAt = Date.now();
    netDiag.lastReplayUrl = String(r.url).split('?')[0].slice(0, 140);
    let respCt = '';
    origFetch(r.url, opts)
      .then((res) => {
        netDiag.lastReplayStatus = res ? String(res.status) : 'null';
        if (!memReplayReq && res && (res.status === 401 || res.status === 403)) netDiag.replayAuthFailed = true;
        if (!res || !res.ok) return null;
        respCt = (res.headers && res.headers.get('content-type')) || '';
        const cl = parseInt((res.headers && res.headers.get('content-length')) || '', 10);
        if (STATIC_URL_RE.test(r.url) || SKIP_CT_RE.test(respCt) || cl > 2e6) return null;
        const isBin = BIN_CT_RE.test(respCt) && !/json|text/i.test(respCt);
        return isBin ? res.arrayBuffer() : res.text();
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
    'geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h', 'argonWeekly',
    'geminiWeeklyReset', 'gemini5hReset', 'claudeWeeklyReset', 'claude5hReset', 'argonWeeklyReset',
    'argonName', 'custom', 'lastUpdated', 'source'
  ];
  const QUOTA_TS_KEYS = ['geminiWeeklyResetTs', 'gemini5hResetTs', 'claudeWeeklyResetTs', 'claude5hResetTs', 'argonWeeklyResetTs'];
  function sanitizeQuotaPayload(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const clean = {};
    for (const k of QUOTA_STR_KEYS) {
      if (typeof p[k] === 'string') clean[k] = p[k].slice(0, 60);
    }
    for (const k of QUOTA_TS_KEYS) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) clean[k] = Math.round(p[k]);
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
        const k = fam + win;
        const cleanReset = reset ? reset.trim() : '';
        const prevReset = quotaState[k + 'Reset'] || '';
        const prevTs = quotaState[k + 'ResetTs'] || 0;
        const now = Date.now();
        quotaState[k] = pct + '%';
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
      if (fam === 'argon') quotaState.argonName = name;
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
    } else if (hasPartial) {
      checkLow();
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

  let overlayPointerDown = false, pendingRender = false, lastRenderSig = '';
  function makeHeaderBtns() {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:8px;';
    const minBtn = document.createElement('span');
    minBtn.id = 'ag-min-btn';
    minBtn.textContent = cfg.minimized ? '+' : '–';
    minBtn.title = cfg.minimized ? 'Expand' : 'Minimize';
    minBtn.style.cssText = 'cursor:pointer;font-size:13px;font-weight:bold;' + (cfg.minimized ? 'padding:0 3px;color:#ccc;' : 'padding:0 2px;');
    minBtn.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
    minBtn.onclick = (e) => {
      e.stopPropagation();
      cfg.minimized = !cfg.minimized;
      try { localStorage.setItem('ag_quota_cfg_v1', JSON.stringify(cfg)); } catch (err) {}
      renderOverlay();
    };
    const gear = document.createElement('span');
    gear.id = 'ag-cfg-btn';
    gear.textContent = '⚙';
    gear.title = 'Settings';
    gear.style.cssText = 'cursor:pointer;font-size:13px;';
    gear.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
    gear.onclick = (e) => { e.stopPropagation(); askNotifyPermission(); openSettings(); };
    wrap.append(minBtn, gear);
    return wrap;
  }

  function renderOverlay() {
    if (!isTopWindow) return;
    const el = document.getElementById('antigravity-usage-overlay');
    if (!el) return;
    if (overlayPointerDown) { pendingRender = true; return; }

    const keys = ['geminiWeekly', 'gemini5h', 'claudeWeekly', 'claude5h', 'argonWeekly'];
    const fcSig = keys.map((k) => {
      const f = forecast(k);
      return f ? (f.before ? '1:' : '0:') + fmtDur(f.etaMs) + ':' + f.rate.toFixed(1) : '';
    }).join('|');
    const sig = JSON.stringify([
      !!cfg.minimized, quotaState.source, quotaState.lastUpdated, quotaState.argonName,
      quotaState.custom, quotaState.customPct,
      keys.map((k) => [quotaState[k], getResetText(k)]), fcSig
    ]);
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;

    el.style.minWidth = cfg.minimized ? 'auto' : '210px';
    el.style.padding = cfg.minimized ? '5px 10px' : '10px 14px';
    while (el.firstChild) el.removeChild(el.firstChild);

    if (cfg.minimized) {
      // one line like the Claude overlay: Weekly: G C · 5h: G C (letters = Gemini / Claude)
      const pill = document.createElement('div');
      pill.style.cssText = 'display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:11px;';
      const info = document.createElement('span');
      const tag = (t, color) => { const s = document.createElement('span'); s.textContent = t + ' '; s.style.cssText = 'color:' + color + ';font-size:10px;'; return s; };
      info.append('\u{1F4CA} Weekly: ', tag('G', '#8ab4f8'), makeBadge(quotaState.geminiWeekly), ' ', tag('C', '#c58af9'), makeBadge(quotaState.claudeWeekly),
        ' \u00B7 5h: ', tag('G', '#8ab4f8'), makeBadge(quotaState.gemini5h), ' ', tag('C', '#c58af9'), makeBadge(quotaState.claude5h));
      const btns = makeHeaderBtns();
      btns.style.marginLeft = 'auto';
      pill.append(info, btns);
      el.appendChild(pill);
      return;
    }

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:4px;';
    const title = document.createElement('span');
    title.textContent = '🚀 Antigravity Quota';
    const status = document.createElement('span');
    status.style.cssText = 'font-size:9px;color:#888;display:inline-flex;align-items:center;';
    status.textContent = quotaState.source;
    status.appendChild(makeHeaderBtns());
    head.appendChild(title);
    head.appendChild(status);
    el.appendChild(head);

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

    if (quotaState.argonWeekly && quotaState.argonWeekly !== '?') {
      const argonTitle = document.createElement('div');
      argonTitle.style.cssText = 'color:#81c995;font-weight:600;font-size:11px;margin-top:6px;margin-bottom:3px;';
      argonTitle.textContent = (quotaState.argonName || 'Gemini 4 Argon') + ':';
      el.appendChild(argonTitle);
      el.appendChild(renderRow('• Weekly:', quotaState.argonWeekly, getResetText('argonWeekly'), 'argonWeekly'));
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
  const cfg = Object.assign({ minimized: false }, Object.fromEntries(CFG_SCHEMA.map((s) => [s[0], s[3]])));
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('ag_quota_cfg_v1')) || {}); } catch (e) {}
  cfg.minimized = !!cfg.minimized;

  function applyCfg() {
    let st = document.getElementById('antigravity-usage-overlay-cfgstyle');
    if (!st) { st = document.createElement('style'); st.id = 'antigravity-usage-overlay-cfgstyle'; document.head.appendChild(st); }
    st.textContent = `#antigravity-usage-overlay{opacity:${cfg.opacityIdle / 100} !important}#antigravity-usage-overlay:hover{opacity:${cfg.opacityHover / 100} !important}`;
  }

  function openSettings() {
    const old = document.getElementById('antigravity-usage-overlay-cfg');
    if (old) { if (old._close) old._close(); else old.remove(); return; }
    const ov = document.getElementById('antigravity-usage-overlay');
    const r = ov ? ov.getBoundingClientRect() : { left: innerWidth - 16, right: innerWidth - 16, top: innerHeight - 160, bottom: innerHeight - 80 };
    const p = document.createElement('div');
    p.id = 'antigravity-usage-overlay-cfg';
    p.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e1e;color:#e0e0e0;border:1px solid #777;border-radius:8px;padding:10px 12px;font:12px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow-y:auto;';
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

    const close = () => {
      p.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
    };
    p._close = close;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const onOutside = (e) => { if (!p.contains(e.target) && !(ov && ov.contains(e.target))) close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
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
      else if (!busy && !QUESTION_RE.test(s)) { try { const an = getComputedStyle(n).animationName; if (an && an !== 'none') busy = true; } catch (e) {} }
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
  // Another tab raised a low-quota/forecast alert or refreshed quota → sync flags and overlay state immediately.
  window.addEventListener('storage', (e) => {
    try {
      if (e.key === 'ag_quota_low_v1') lowAlerted = JSON.parse(e.newValue) || {};
      else if (e.key === 'ag_quota_state_v3' && e.newValue) {
        const clean = sanitizeQuotaPayload(JSON.parse(e.newValue));
        if (clean) {
          netDiag.lastCaptureAt = Date.now();
          Object.assign(quotaState, clean);
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
        if (cfg.dSound) beep();
        if (cfg.dNotify) notify(title, body, 'ag-' + key);
      });
    };
    LOW_KEYS.forEach(([k, label]) => {
      const v = parseInt(quotaState[k], 10);
      if (isNaN(v)) return;
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

  // Frame-host diagnostics to narrow @match *.google.com safely: `__agDiag()` in AG console prints hosts and network stats.
  const diagFrames = new Map();
  const frameNets = new Map();
  let lastDiagRows = -1, lastDiagAt = 0;
  function getNetDiagObj() {
    let hasStoredReplay = false;
    try { hasStoredReplay = !!localStorage.getItem(REPLAY_KEY); } catch (e) {}
    return {
      source: quotaState.source, lastUpdated: quotaState.lastUpdated, isAgFrame, isAgContent,
      hasMemReplay: !!memReplayReq, hasStoredReplay, replayAuthFailed: netDiag.replayAuthFailed,
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
  }

  if (isTopWindow) {
    window.addEventListener('message', (e) => {
      if (!okFrameMsg(e)) return;
      const d = e.data;
      if (d.type === 'AG_QUOTA_SYNC') {
        const clean = sanitizeQuotaPayload(d.payload);
        if (clean) {
          if (clean.source === 'Network') netDiag.lastCaptureAt = Date.now();
          Object.assign(quotaState, clean);
          try { localStorage.setItem('ag_quota_state_v3', JSON.stringify(quotaState)); } catch (err) {}
          checkLow();
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
        const h = d.host.slice(0, 120);
        recordDiagFrame(h, false, !!d.agFrame, Math.max(0, Math.min(9999, Math.floor(d.rows))));
        if (d.net && typeof d.net === 'object' && !Array.isArray(d.net)) frameNets.set(h, d.net);
      }
    });
  }

  function update() {
    if (!document.hidden) scrapeLimits();
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
    const triggerFrameReplay = () => {
      document.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentWindow) f.contentWindow.postMessage({ type: 'AG_REPLAY_NOW' }, '*'); } catch (e) {}
      });
    };
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
      askNotifyPermission(); update(); replayQuotaRequest(true); triggerFrameReplay();
    };
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
