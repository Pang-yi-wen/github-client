'use strict';

/* ============================================================
   GitHub 本地客户端（单文件版）
   唯一数据源：api.github.com —— 本机唯一可达的 GitHub 端点
   不经过任何第三方服务器，凭据只留在本机 localStorage
   ============================================================ */

/* ============================================================
   通道层
   ------------------------------------------------------------
   三条通路，按可用性与延迟自动切换：
     1. 直连 api.github.com      —— 最快，凭据不外流
     2. 公共中转 gh-proxy.org    —— 零配置兜底，凭据会经过第三方
     3. 自建中转（Worker/Nginx）  —— 用户自己部署，长期最稳
   探测端点用 /rate_limit：不消耗额度。
   ============================================================ */

const API_HOST = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
};

const CH_DIRECT = {
  id: 'direct',
  label: '直连',
  api: API_HOST,
  raw: RAW_HOST,
  trust: true,
  note: '官方接口，速度最快，凭据不经过第三方'
};

const CH_PUBLIC = [
  {
    id: 'ghproxy-org',
    label: 'gh-proxy.org',
    api: 'https://gh-proxy.org/' + API_HOST,
    raw: 'https://gh-proxy.org/' + RAW_HOST,
    trust: false,
    note: '公共中转，官方新域名；额度由该站共享，可能被用尽'
  },
  {
    id: 'ghproxy-com',
    label: 'gh-proxy.com',
    api: 'https://gh-proxy.com/' + API_HOST,
    raw: 'https://gh-proxy.com/' + RAW_HOST,
    trust: false,
    note: '公共中转，旧域名，作备用'
  }
];

/** 用户自建中转：模板里可含 {url}，否则视为前缀 */
function chCustom() {
  const tpl = String(LS.get('ghl_proxy', '') || '').trim();
  if (!tpl) return null;
  return {
    id: 'custom',
    label: '自建',
    tpl,
    trust: true,
    note: '自建中转，凭据经过你自己的服务器'
  };
}

function allChannels() {
  const list = [CH_DIRECT, ...CH_PUBLIC];
  const c = chCustom();
  if (c) list.push(c);
  return list;
}

function joinApi(ch, path) {
  if (ch.id === 'custom') {
    const full = API_HOST + path;
    return ch.tpl.indexOf('{url}') >= 0
      ? ch.tpl.replace('{url}', encodeURIComponent(full))
      : ch.tpl.replace(/\/+$/, '') + '/' + full;
  }
  return ch.api + path;
}

function joinRaw(ch, o, r, ref, p) {
  const seg = encodeURIComponent(o) + '/' + encodeURIComponent(r) + '/' +
              encodeURIComponent(ref) + '/' + encPath(p);
  if (ch.id === 'custom') {
    const full = RAW_HOST + '/' + seg;
    return ch.tpl.indexOf('{url}') >= 0
      ? ch.tpl.replace('{url}', encodeURIComponent(full))
      : ch.tpl.replace(/\/+$/, '') + '/' + full;
  }
  return ch.raw + '/' + seg;
}

/** 所有能取到同一个 raw 的地址，按实测速度排序，供图片逐级降级 */
function rawSources(o, r, ref, p) {
  return rawMirrorList(o, r, ref, p);
}

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');

/* ---------------------------- 图标 ---------------------------- */

const ICON = {
  folder: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#54aeff" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" opacity=".55" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Z"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>',
  fork: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>',
  eye: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.9a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2Zm0 2.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5Z"/></svg>',
  issue: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>',
  pr: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
  tag: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/></svg>',
  comment: '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/></svg>',
  branch: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z"/></svg>',
  lock: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"/></svg>',
  link: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path fill="currentColor" d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/></svg>',
  back: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z"/></svg>',
  key: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="m4.5 8a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM1 10.5a3.5 3.5 0 1 1 6.13 2.32l1.05 1.05a.75.75 0 0 1-1.06 1.06l-.53-.53-.72.72a.75.75 0 0 1-1.06 0l-.53-.53-.53.53a.75.75 0 0 1-1.06-1.06l3.28-3.28A3.5 3.5 0 0 1 1 10.5Z"/></svg>'
};

/* ---------------------------- 基础工具 ---------------------------- */

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtNum(n) {
  if (n === null || n === undefined) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
  if (s < 31536000) return Math.floor(s / 2592000) + ' 个月前';
  return Math.floor(s / 31536000) + ' 年前';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function b64ToText(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选中'); }
    ta.remove();
  }
}

const loading = () => { app.innerHTML = '<div class="loading-block"><div class="spinner"></div></div>'; };

function errorBox(title, detail, hint) {
  return `<div class="err-box"><h3>${esc(title)}</h3>
    <p>${esc(detail || '')}</p>${hint ? `<p style="margin-top:8px">${hint}</p>` : ''}
    <button class="btn" onclick="location.reload()">重试</button></div>`;
}

/* ---------------------------- 凭据 ---------------------------- */

let TOKEN = '';
try { TOKEN = localStorage.getItem('ghl_token') || ''; } catch (_) {}
let meCache = null;

function saveToken(t) {
  TOKEN = (t || '').trim();
  meCache = null;
  // 换了身份，旧缓存可能是另一批可见范围的内容
  clearCache();
  try {
    if (TOKEN) localStorage.setItem('ghl_token', TOKEN);
    else localStorage.removeItem('ghl_token');
  } catch (_) {}
  updateAuthBadge();
}

function updateAuthBadge() {
  const b = $('#auth');
  if (!b) return;
  if (TOKEN) { b.textContent = '已授权'; b.classList.add('ok'); }
  else { b.textContent = '未授权'; b.classList.remove('ok'); }
}

/* ---------------------------- API ---------------------------- */

const rate = { remaining: null, limit: null, reset: null };

/* ---------- 通道探测与调度 ---------- */

let channelOrder = [];
const channelStatus = {};
let activeChannel = null;

function probeChannel(ch) {
  // 直连多数时候一秒内就有结果，给它短一些的宽限，避免首屏被拖住
  const limit = ch.id === 'direct' ? 2600 : 6000;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limit);
  return fetch(joinApi(ch, '/rate_limit'), {
    signal: ctrl.signal,
    cache: 'no-store',
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  }).then(res => {
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json().then(j => {
      const core = j && j.resources && j.resources.core;
      return {
        ch,
        ms: Math.round(performance.now() - t0),
        quota: core ? core.remaining : 0,
        limit: core ? core.limit : 0
      };
    });
  }).catch(() => {
    clearTimeout(timer);
    return null;
  });
}

async function initChannels() {
  const list = allChannels();
  const results = await Promise.all(list.map(probeChannel));
  list.forEach((ch, i) => { channelStatus[ch.id] = results[i]; });

  const alive = results.filter(Boolean);
  const usable = alive.filter(x => x.quota > 0);
  const pooled = alive.filter(x => x.quota <= 0);
  const pick = (arr, id) => arr.find(x => x.ch.id === id);
  const bySpeed = (a, b) => a.ms - b.ms;

  channelOrder = [];
  // 有余量的通道按「直连 → 自建 → 其他」排；额度已耗尽的垫底，留作最后尝试
  const direct = pick(usable, 'direct');
  const custom = pick(usable, 'custom');
  if (direct) channelOrder.push(direct.ch);
  if (custom) channelOrder.push(custom.ch);
  channelOrder = channelOrder.concat(
    usable.filter(x => x.ch.id !== 'direct' && x.ch.id !== 'custom').sort(bySpeed).map(x => x.ch)
  );
  channelOrder = channelOrder.concat(pooled.sort(bySpeed).map(x => x.ch));

  if (!channelOrder.length) channelOrder = [CH_DIRECT];

  activeChannel = channelOrder[0];
  updateChannelBadge();
  return channelOrder;
}

let channelsReady = null;
function ensureChannels() {
  if (!channelsReady) channelsReady = initChannels();
  return channelsReady;
}

function updateChannelBadge() {
  const el = $('#ch');
  if (!el) return;
  const ch = activeChannel;
  if (!ch) { el.textContent = '—'; return; }
  const st = channelStatus[ch.id];
  el.textContent = ch.label + (st ? ' ' + st.ms + 'ms' : '');
  el.title = '当前通道：' + ch.label + '\n' + ch.note +
    (!ch.trust && TOKEN ? '\n\n注意：访问令牌正经由此服务转发，它可读取你名下的全部仓库' : '') +
    '\n点击查看全部通道';
  el.classList.toggle('warn', !ch.trust);
}

function readRateHeaders(h) {
  const rem = h.get('x-ratelimit-remaining');
  const lim = h.get('x-ratelimit-limit');
  if (rem === null) return;
  rate.remaining = Number(rem);
  rate.limit = Number(lim || 0);
  rate.reset = h.get('x-ratelimit-reset') ? Number(h.get('x-ratelimit-reset')) : null;
  const el = $('#rate');
  if (el) {
    el.textContent = rate.remaining + '/' + rate.limit;
    el.title = 'API 剩余额度' + (rate.reset
      ? '，' + new Date(rate.reset * 1000).toLocaleTimeString('zh-CN') + ' 重置'
      : '');
    el.classList.toggle('low', rate.remaining < 60);
  }
}

/** 单通道请求 */
async function fetchVia(ch, path, opts) {
  const url = joinApi(ch, path);
  const method = opts.method || 'GET';
  const headers = {
    'Accept': opts.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    // 明文令牌只发给直连或自建通道
    if (!ch.trust) throw new Error('写请求不允许经过公共中转');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  const init = { headers: headers, signal: ctrl.signal, method: method };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? '通道超时' : '通道无响应');
    err.channelFail = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  readRateHeaders(res.headers);

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.clone().json();
      if (j && j.message) msg = j.message;
    } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    // 服务端故障、限流、额度耗尽都值得换一条通路再试
    err.channelFail = res.status >= 500 || res.status === 429 ||
      (res.status === 403 && rate.remaining === 0);
    if (res.status === 401) err.message = '凭据无效或已过期，请重新设置令牌';
    else if (res.status === 403 && rate.remaining === 0) {
      err.message = 'API 额度已用尽' + (rate.reset
        ? '，' + new Date(rate.reset * 1000).toLocaleTimeString('zh-CN') + ' 重置'
        : '');
    } else if (res.status === 403) {
      err.message = '请求被拒绝：' + msg;
    } else if (res.status === 404) {
      err.message = '未找到该资源（可能不存在，或私有内容需要授权）';
    } else if (res.status === 422) {
      err.message = '请求参数不被接受：' + msg;
    }
    throw err;
  }

  if (opts.blob) return res.blob();
  if (opts.text) return res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('json') >= 0) return res.json();
  return res.text();
}

/* ---------- 本地缓存：命中就不发请求，直接省掉一次配额 ---------- */

const CACHE_PREFIX = 'ghc:';
const CACHE_MAX = 90;
const CACHE_MAX_BYTES = 200 * 1024;

/** 不同资源的有效期。目录和代码变化快，给短一点；仓库信息给长一点 */
function ttlFor(path) {
  const p = path.split('?')[0];
  if (p.indexOf('/search/') === 0) return 10 * 60 * 1000;
  if (p === '/user') return 2 * 60 * 1000;
  if (p.indexOf('/user/') === 0) return 3 * 60 * 1000;
  if (p.indexOf('/readme') > 0) return 30 * 60 * 1000;
  if (p.indexOf('/contents/') > 0) return 5 * 60 * 1000;
  if (p.indexOf('/releases') > 0) return 15 * 60 * 1000;
  if (p.indexOf('/branches') > 0) return 15 * 60 * 1000;
  if (p.indexOf('/commits') > 0) return 5 * 60 * 1000;
  if (p.indexOf('/issues') > 0 || p.indexOf('/pulls') > 0) return 4 * 60 * 1000;
  if (p.indexOf('/users/') === 0) return 20 * 60 * 1000;
  return 8 * 60 * 1000;
}

function cacheCount() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) n++;
    }
  } catch (_) {}
  return n;
}

function clearCache() {
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    return drop.length;
  } catch (_) {
    return 0;
  }
}

function cacheGet(path) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.t !== 'number') return null;
    if (Date.now() - rec.t > rec.ttl) {
      localStorage.removeItem(CACHE_PREFIX + path);
      return null;
    }
    return rec.v;
  } catch (_) {
    return null;
  }
}

function cacheSet(path, val, ttl) {
  try {
    const body = JSON.stringify({ t: Date.now(), ttl: ttl, v: val });
    if (body.length > CACHE_MAX_BYTES) return;
    if (cacheCount() >= CACHE_MAX) clearCache();
    localStorage.setItem(CACHE_PREFIX + path, body);
  } catch (_) {
    // 配额满或被禁用就静默放弃，不影响功能
  }
}

/** 统一入口：缓存优先，未命中再走通道降级 */
async function gh(path, opts) {
  opts = opts || {};

  // 二进制、纯文本、显式禁用的不走缓存
  const cacheable = !opts.blob && !opts.text && opts.cache !== false;
  const ttl = cacheable ? ttlFor(path) : 0;

  if (cacheable) {
    const hit = cacheGet(path);
    if (hit !== null) return hit;
  }

  const out = await ghFetch(path, opts);
  if (cacheable && out !== null && typeof out === 'object') cacheSet(path, out, ttl);
  return out;
}

/** 真正的请求：按通道顺序尝试，失败自动降级并记住可用的那条 */
async function ghFetch(path, opts) {
  await ensureChannels();

  let lastErr = null;
  for (let i = 0; i < channelOrder.length; i++) {
    const ch = channelOrder[i];
    try {
      const out = await fetchVia(ch, path, opts);
      if (i > 0) {
        channelOrder.splice(i, 1);
        channelOrder.unshift(ch);
        if (activeChannel !== ch) toast('已切换到「' + ch.label + '」通道');
        activeChannel = ch;
        updateChannelBadge();
      } else {
        activeChannel = ch;
      }
      return out;
    } catch (e) {
      if (!e.channelFail) throw e;
      lastErr = e;
    }
  }
  throw new Error('所有通道都无法连接 GitHub' +
    (lastErr ? '（最后一次：' + lastErr.message + '）' : '') +
    '。可在右上角的通道菜单里换用别的通路，或配置自建中转。');
}

async function me() {
  if (meCache) return meCache;
  if (!TOKEN) throw new Error('尚未设置访问令牌');
  meCache = await gh('/user');
  return meCache;
}

/* ---------- 仓库信息缓存：同一仓库只在页面存活期内请求一次 ---------- */

const repoCache = new Map();

function getRepo(o, r) {
  const key = o + '/' + r;
  if (repoCache.has(key)) return repoCache.get(key);
  const p = gh('/repos/' + o + '/' + r);
  repoCache.set(key, p);
  p.catch(() => repoCache.delete(key));
  return p;
}

/* ---------- 直接读 raw：不消耗 API 额度 ---------- */

async function fetchRawBytes(o, r, ref, path) {
  const urls = rawMirrorList(o, r, ref, path);
  const ctrls = urls.map(() => new AbortController());
  // 并行竞速：第一个成功返回的通道胜出，其余立即取消，避免顺序等待死代理
  return await new Promise((resolve, reject) => {
    let done = false, pending = urls.length, lastErr = null;
    urls.forEach((url, i) => {
      const t = setTimeout(() => ctrls[i].abort(), 15000);
      fetch(url, { signal: ctrls[i].signal })
        .then(async res => {
          clearTimeout(t);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = new Uint8Array(await res.arrayBuffer());
          if (done) return;
          done = true;
          ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve(buf);
        })
        .catch(e => {
          clearTimeout(t);
          lastErr = e;
          if (--pending === 0 && !done) reject(lastErr || new Error('raw 不可用'));
        });
    });
    setTimeout(() => {
      if (!done) { done = true; ctrls.forEach(c => c.abort()); reject(lastErr || new Error('raw 不可用')); }
    }, 16000);
  });
}

/** 同一 raw 的全部镜像地址，按「自建 → 直连 → jsDelivr CDN → 公共中转」排序。
 *  jsDelivr 是面向国内的快速 CDN；其余公共中转作为兜底。 */
function rawMirrorList(o, r, ref, p) {
  const seg = encodeURIComponent(o) + '/' + encodeURIComponent(r) + '/' +
              encodeURIComponent(ref) + '/' + encPath(p);
  const raw = RAW_HOST + '/' + seg;
  const list = [];
  const c = chCustom();
  if (c) list.push(joinRaw(c, o, r, ref, p));
  list.push(raw);
  list.push('https://cdn.jsdelivr.net/gh/' + encodeURIComponent(o) + '/' +
            encodeURIComponent(r) + '@' + encodeURIComponent(ref) + '/' + encPath(p).replace(/^\/+/, ''));
  list.push('https://ghproxy.net/' + raw);
  list.push('https://mirror.ghproxy.com/' + raw);
  list.push('https://github.moeyy.xyz/' + raw);
  list.push('https://raw.gitmirror.com/' + seg);
  list.push('https://gh-proxy.org/' + raw);
  list.push('https://gh-proxy.com/' + raw);
  list.push('https://ghfast.top/' + raw);
  return list;
}

function mirrorLabel(url) {
  if (url.includes('jsdelivr.net')) return 'jsDelivr CDN';
  if (url.includes('ghproxy.net')) return 'ghproxy.net';
  if (url.includes('mirror.ghproxy.com')) return 'mirror.ghproxy';
  if (url.includes('moeyy.xyz')) return 'moeyy.xyz';
  if (url.includes('gitmirror.com')) return 'gitmirror';
  if (url.includes('gh-proxy.org')) return 'gh-proxy.org';
  if (url.includes('gh-proxy.com')) return 'gh-proxy.com';
  if (url.includes('ghfast.top')) return 'ghfast.top';
  if (url.includes('raw.githubusercontent.com')) return '直连 raw';
  if (url.includes('workers.dev') || url.includes('{url}')) return '自建中转';
  return '中转';
}

/** 用极小的 Range 请求并行探速，挑第一个响应的可用通道，供下载时交给原生下载器 */
async function pickBestRawUrl(o, r, ref, path) {
  const urls = rawMirrorList(o, r, ref, path);
  const labels = urls.map(mirrorLabel);
  const ctrls = urls.map(() => new AbortController());
  return await new Promise(resolve => {
    let done = false, pending = urls.length;
    urls.forEach((url, i) => {
      const t0 = performance.now();
      const t = setTimeout(() => ctrls[i].abort(), 12000);
      fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrls[i].signal })
        .then(res => {
          clearTimeout(t);
          if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
          const ms = Math.round(performance.now() - t0);
          if (done) return;
          done = true;
          ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve({ url, label: labels[i], ms });
        })
        .catch(() => {
          clearTimeout(t);
          if (--pending === 0 && !done) resolve(null);
        });
    });
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, 13000);
  });
}

/** 并行向所有镜像发起完整 GET，返回第一个校验通过的内容；全部失败返回 null。
 *  用于版本自检与页面热更新：首响即胜，其余立即取消，避免顺序等待慢死的直连源。 */
async function fetchFirst(seg, validate, timeoutMs) {
  const urls = rawBaseUrls(seg);
  const ctrls = urls.map(() => new AbortController());
  return await new Promise(resolve => {
    let finished = false, remaining = urls.length;
    const stop = () => ctrls.forEach(c => { try { c.abort(); } catch (_) {} });
    urls.forEach((url, i) => {
      const t = setTimeout(() => ctrls[i].abort(), timeoutMs || 20000);
      fetch(url, { signal: ctrls[i].signal })
        .then(async res => {
          clearTimeout(t);
          if (finished) return;
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          if (validate && !validate(text)) throw new Error('validate');
          finished = true; stop(); resolve(text);
        })
        .catch(() => {
          clearTimeout(t);
          if (--remaining === 0 && !finished) { finished = true; resolve(null); }
        });
    });
  });
}

/** 带进度回调的字节下载，用于桌面端在页面内显示速度/百分比 */
function xhrBytes(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    let lastT = performance.now(), lastL = 0;
    xhr.onprogress = e => {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      const speed = dt > 0 ? (e.loaded - lastL) / dt : 0;
      lastT = now; lastL = e.loaded;
      onProgress && onProgress(e.loaded, e.lengthComputable ? e.total : 0, speed);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(new Uint8Array(xhr.response));
      else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send();
  });
}

function bytesToText(buf) {
  return new TextDecoder('utf-8').decode(buf);
}

const looksBinary = (buf) => buf.subarray(0, 8192).indexOf(0) !== -1;

/* ---------------------------- 自动更新 ---------------------------- */

/** 本客户端的来源仓库。读取其中的 VERSION 与最新构建产物 */
const SELF_REPO = { owner: 'Pang-yi-wen', repo: 'github-client', branch: 'main' };

/** 自动检查的最小间隔；手动检查不受限 */
const UPD_INTERVAL = 6 * 3600 * 1000;

const updEnabled = () => {
  // 客户端内用原生持久化开关；网页版用 localStorage
  try {
    if (window.Android && typeof window.Android.autoUpdateEnabled === 'function') {
      return !!window.Android.autoUpdateEnabled();
    }
  } catch (_) {}
  return LS.get('ghl_upd_on', '1') !== '0';
};

/** 更新源：默认 SELF_REPO，可用 ghl_upd_repo（owner/repo）覆盖，供 fork 使用 */
function updRepo() {
  const m = String(LS.get('ghl_upd_repo', '') || '').trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2], branch: 'main' } : SELF_REPO;
}

/** 版本号按点分段逐段数值比较，返回 -1 / 0 / 1 */
function cmpVer(a, b) {
  const pa = String(a || '0').split('.'), pb = String(b || '0').split('.');
  for (let i = 0, n = Math.max(pa.length, pb.length); i < n; i++) {
    const x = parseInt(pa[i] || '0', 10) || 0;
    const y = parseInt(pb[i] || '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** raw 通道的全部候选地址，自建中转优先 */
function rawBaseUrls(seg) {
  // 更新路径（VERSION / GitHub.html）会被反复覆盖，排除 jsDelivr 这类强缓存 CDN：
  // 缓存未刷新时会拿到旧版本，表现为“更新成功却仍提示新版本”
  const parts = seg.split('/');
  if (parts.length < 4) return [RAW_HOST + '/' + seg];
  const [owner, repo, ref] = parts;
  const path = parts.slice(3).join('/');
  return rawMirrorList(owner, repo, ref, path).filter(u => !u.includes('jsdelivr.net'));
}

/** 读取来源仓库的 VERSION：先走 raw 并行竞速（不耗额度），全部失败再走 API */
async function fetchRemoteVersion() {
  const { owner, repo, branch } = updRepo();
  const seg = owner + '/' + repo + '/' + branch + '/VERSION';
  const text = await fetchFirst(seg, null, 12000);
  if (text) {
    const line = text.trim().split('\n')[0].trim();
    if (line) return line;
  }
  try {
    const j = await gh('/repos/' + owner + '/' + repo + '/contents/VERSION?ref=' + branch, { cache: false });
    if (j && j.content) return b64ToText(j.content).trim().split('\n')[0].trim();
  } catch (_) {}
  return null;
}

let updAvailable = null;

function setUpdBadge(ver) {
  const b = $('#upd');
  if (!b) return;
  if (ver) {
    b.textContent = '↑ ' + ver;
    b.hidden = false;
    b.title = '发现新版本 ' + ver + '，点击更新';
  } else {
    b.hidden = true;
  }
}

/**
 * 检查更新。force 为 true 时忽略间隔限制（设置面板的手动检查）。
 * 自动检查失败不提示，避免打扰；仅在确实发现新版本时给出徽标与提示。
 */
async function checkUpdate(force) {
  if (!force && !updEnabled()) return updAvailable;
  // 客户端内页面与安装包都由原生检查，避免和原生弹窗重复
  if (!force && window.Android) return updAvailable;
  const last = Number(LS.get('ghl_upd_last', '0') || 0);
  if (!force && Date.now() - last < UPD_INTERVAL) return updAvailable;
  LS.set('ghl_upd_last', String(Date.now()));

  let remote = null;
  try {
    remote = await fetchRemoteVersion();
  } catch (_) {}
  if (!remote) return updAvailable;

  if (cmpVer(remote, APP_VERSION) > 0) {
    updAvailable = { version: remote };
    setUpdBadge(remote);
    toast('发现新版本 ' + remote + '，点击顶栏箭头更新', 6000);
  } else {
    updAvailable = null;
    setUpdBadge(null);
    if (force) toast('已是最新版本（' + APP_VERSION + '）');
  }
  return updAvailable;
}

/** 获取最新构建产物：http(s) 页面热替换文档，file:// 页面下载文件 */
async function applyUpdate() {
  if (!updAvailable) return;
  const { owner, repo, branch } = updRepo();
  const seg = owner + '/' + repo + '/' + branch + '/GitHub.html';
  const btn = $('#upd');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }

  // 客户端内由原生下载、写入页面并重载，不需要用户手动替换文件
  if (window.Android && typeof window.Android.updatePage === 'function') {
    try {
      window.Android.updatePage(updAvailable.version);
      toast('正在更新页面到 ' + updAvailable.version + '，完成后自动重载', 5000);
      setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = label; } }, 12000);
      return;
    } catch (_) {}
  }
  if (window.Android) {
    // 旧安装包没有 updatePage；WebView 里 <a download> 不会落盘，改用手动下载安装包
    toast('当前安装包不含页面更新接口，请先下载安装包', 6000);
    if (btn) { btn.disabled = false; btn.textContent = label; }
    openApkDownloadDialog();
    return;
  }

  try {
    const html = await fetchFirst(seg, t => {
      if (!(t.length > 50000 && t.indexOf('GitHub') >= 0)) return false;
      const m = t.match(/APP_VERSION\s*=\s*'([^']+)'/);
      return !!m && cmpVer(m[1], updAvailable.version) >= 0;
    }, 30000);
    if (!html) throw new Error('无法获取新版本文件');

    if (location.protocol === 'file:') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = 'GitHub.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('新版本 ' + updAvailable.version + ' 已下载为 GitHub.html，在浏览器下载目录；用它替换原文件后重新打开', 7000);
    } else {
      toast('正在切换到 ' + updAvailable.version);
      document.open();
      document.write(html);
      document.close();
    }
  } catch (e) {
    toast('更新失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/** 读取安装包版本清单，用于在设置里区分“页面版本”和“安装包版本” */
async function fetchApkMeta() {
  const { owner, repo, branch } = SELF_REPO;   // 安装包固定来自本客户端仓库
  const seg = owner + '/' + repo + '/' + branch + '/android/apk/version.json';
  const txt = await fetchFirst(seg, t => {
    try { const j = JSON.parse(t); return !!(j && j.versionName); } catch (_) { return false; }
  }, 10000);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) { return null; }
}

/** 安装包是多通道可下的公开文件（文件名带版本号，内容不变），可放心走 CDN */
function apkDownloadChannels(apkName) {
  const { owner, repo, branch } = SELF_REPO;
  const raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/android/apk/' + apkName;
  return [
    { label: 'jsDelivr CDN', url: 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + branch + '/android/apk/' + apkName },
    { label: 'ghproxy.net', url: 'https://ghproxy.net/' + raw },
    { label: 'gh-proxy.org', url: 'https://gh-proxy.org/' + raw },
    { label: 'ghfast.top', url: 'https://ghfast.top/' + raw },
    { label: '直连 raw', url: raw }
  ];
}

/**
 * 手动下载安装包：不依赖原生桥，列出多个通道，交给系统浏览器下载。
 * 用于旧壳（没有 updatePage / checkApkUpdate 接口）或自动提示被跳过的情况。
 */
async function openApkDownloadDialog() {
  const mask = $('#modal');
  if (!mask || !mask.hidden) return;
  const sv = (window.Android && window.Android.shellVersion) ? (window.Android.shellVersion() || '') : '';
  mask.hidden = false;
  mask.innerHTML = '<div class="modal-card"><h3>下载安装包</h3><p class="hint">正在读取版本清单…</p></div>';
  const close = () => { mask.hidden = true; mask.innerHTML = ''; mask.onclick = null; };
  mask.onclick = (e) => { if (e.target === mask) close(); };

  let meta = null;
  try { meta = await fetchApkMeta(); } catch (_) {}
  if (!meta || !meta.apk) {
    mask.innerHTML = '<div class="modal-card"><h3>下载安装包</h3>'
      + '<p class="hint">读取版本清单失败，请检查网络后重试。</p>'
      + '<div class="modal-actions"><button class="btn sm" id="apkClose">关闭</button></div></div>';
    $('#apkClose').onclick = close;
    return;
  }
  const upToDate = sv && cmpVer(sv, meta.versionName) >= 0;
  const chans = apkDownloadChannels(meta.apk);
  mask.innerHTML = `
    <div class="modal-card">
      <h3>下载安装包 ${esc(meta.versionName)}</h3>
      <p class="hint">${upToDate
        ? '当前安装包 ' + esc(sv) + '，已是最新。仍可重新下载。'
        : '当前安装包 ' + (esc(sv) || '未知') + '，可升级到 ' + esc(meta.versionName) +
          '。选一个通道，用系统浏览器下载后安装（覆盖安装，无需卸载）。'}</p>
      <div class="apk-chans">
        ${chans.map((c, i) => `<button class="btn sm" data-ch="${i}">${esc(c.label)}</button>`).join('')}
      </div>
      <div class="modal-actions" style="margin-top:12px">
        <span class="dim" style="font-size:11.5px">文件：${esc(meta.apk)}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" id="apkClose">关闭</button>
      </div>
    </div>`;
  mask.querySelectorAll('[data-ch]').forEach(b => {
    b.onclick = () => {
      const u = chans[Number(b.dataset.ch)].url;
      if (window.Android) location.href = u;          // 触发系统浏览器
      else window.open(u, '_blank', 'noopener');
    };
  });
  $('#apkClose').onclick = close;
}

/* ------------------------- 发行版附件下载 ------------------------- */

/** 发行版附件/源码包的可用通道（实测：ghfast.top、gh-proxy.org 可用；ghproxy.com 已失效） */
function releaseChannels(url, kind) {
  const list = [];
  if (kind === 'zip') {
    // codeload 只有 gh-proxy.org 能转发，其余代理返回 403
    list.push({ label: 'gh-proxy.org', url: 'https://gh-proxy.org/' + url });
  } else {
    list.push({ label: 'ghfast.top', url: 'https://ghfast.top/' + url });
    list.push({ label: 'gh-proxy.org', url: 'https://gh-proxy.org/' + url });
    list.push({ label: 'ghproxy.net', url: 'https://ghproxy.net/' + url });
  }
  list.push({ label: '直连（可能较慢）', url: url });
  return list;
}

/**
 * 发行版附件下载：先选通道，再交给系统下载器（后台、通知栏进度、断点续传）。
 * 几十 MB 的文件不要走浏览器直连——objects.githubusercontent.com 在国内通常很慢。
 */
function openAssetDownloadDialog(name, size, url, kind) {
  const mask = $('#modal');
  if (!mask || !mask.hidden) return;
  const chans = releaseChannels(url, kind);
  const useNative = !!(window.Android && typeof window.Android.downloadFile === 'function');
  mask.hidden = false;
  mask.innerHTML = `
    <div class="modal-card">
      <h3>下载 ${esc(name)}</h3>
      <p class="hint">${size ? '大小 ' + fmtSize(size) + '。' : ''}${
        useNative ? '选一个通道后交给系统下载器：后台下载、通知栏显示进度、支持断点续传。'
                  : '选一个通道后在浏览器中下载。'}</p>
      <div class="apk-chans">
        ${chans.map((c, i) => `<button class="btn sm" data-ch="${i}">${esc(c.label)}</button>`).join('')}
      </div>
      <div class="modal-actions" style="margin-top:12px">
        <span class="dim" style="font-size:11px;word-break:break-all">${esc(url)}</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" id="asClose">关闭</button>
      </div>
    </div>`;
  const close = () => { mask.hidden = true; mask.innerHTML = ''; mask.onclick = null; };
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#asClose').onclick = close;
  mask.querySelectorAll('[data-ch]').forEach(b => {
    b.onclick = () => {
      const u = chans[Number(b.dataset.ch)].url;
      close();
      if (useNative) {
        try { window.Android.downloadFile(u, name); toast('已交给系统下载器：' + name, 5000); return; } catch (_) {}
      }
      if (window.Android) location.href = u;
      else window.open(u, '_blank', 'noopener');
    };
  });
}

/* ---------------------------- Markdown ---------------------------- */

const mdRenderer = new marked.Renderer();

mdRenderer.code = function (code, infostring) {
  const lang = ((infostring || '').trim().split(/\s+/)[0] || '').toLowerCase();
  let html;
  if (lang && window.hljs && hljs.getLanguage(lang)) {
    try { html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; }
    catch (_) { html = esc(code); }
  } else {
    html = esc(code);
  }
  return '<pre><code class="hljs' + (lang ? ' language-' + esc(lang) : '') + '">' + html + '</code></pre>';
};

marked.setOptions({ renderer: mdRenderer, gfm: true, breaks: false, headerIds: true, mangle: false });

function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script,iframe,object,embed,style,form,input,button,link,meta,base').forEach(n => n.remove());
  tpl.content.querySelectorAll('*').forEach(n => {
    for (const a of Array.from(n.attributes)) {
      if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      if ((a.name === 'href' || a.name === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) {
        n.removeAttribute(a.name);
      }
    }
  });
  return tpl.innerHTML;
}

function resolvePath(baseDir, rel) {
  const parts = String(baseDir || '').split('/').filter(Boolean);
  String(rel || '').split('/').forEach(seg => {
    if (seg === '' || seg === '.') return;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  });
  return parts.join('/');
}

function isRelative(u) {
  return !!u && !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u) && u[0] !== '#' && u[0] !== '/';
}

function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

/* ---------- 站内链接 ---------- */

function link(o, r, kind, ref, p) {
  let s = '#/r/' + encodeURIComponent(o) + '/' + encodeURIComponent(r);
  if (kind) s += '/' + kind;
  if (ref) s += '/' + encodeURIComponent(ref);
  if (p) s += '/' + encPath(p);
  return s;
}

/* ---------- 识别粘贴进来的 GitHub 链接 ---------- */

/**
 * 把 github.com / raw.githubusercontent.com 的网址翻译成站内路由。
 * 认不出就返回 null，交给普通搜索。
 */
function parseGithubUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 800) return null;

  // 补全协议
  if (/^(?:www\.)?github\.com\//i.test(s)) s = 'https://' + s;
  else if (/^raw\.githubusercontent\.com\//i.test(s)) s = 'https://' + s;
  if (!/^https?:\/\//i.test(s)) return null;

  let u;
  try { u = new URL(s); } catch (_) { return null; }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let seg;
  try {
    seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch (_) {
    seg = u.pathname.split('/').filter(Boolean);
  }

  if (host === 'raw.githubusercontent.com') {
    const [o, r, ref, ...rest] = seg;
    if (!o || !r || !ref) return null;
    return {
      hash: link(o, r, 'blob', ref, rest.join('/')),
      label: o + '/' + r + ' · ' + (rest.join('/') || ref)
    };
  }

  if (host !== 'github.com') return null;

  const [owner, repo, kind, ...rest] = seg;
  if (!owner) return null;

  // github.com/<user>
  if (!repo) {
    return { hash: '#/u/' + encodeURIComponent(owner), label: owner };
  }

  // github.com/<owner>/<repo>
  if (!kind) {
    return { hash: link(owner, repo), label: owner + '/' + repo };
  }

  switch (kind) {
    case 'blob': {
      const ref = rest[0], path = rest.slice(1).join('/');
      if (!ref) return null;
      return { hash: link(owner, repo, 'blob', ref, path), label: owner + '/' + repo + ' · ' + (path || ref) };
    }
    case 'tree':
    case 'raw': {
      const ref = rest[0], path = rest.slice(1).join('/');
      if (!ref) return null;
      return {
        hash: path ? link(owner, repo, 'tree', ref, path) : link(owner, repo),
        label: owner + '/' + repo + ' · ' + (path || ref)
      };
    }
    case 'issues':
      if (rest[0] && /^\d+$/.test(rest[0])) {
        return { hash: link(owner, repo, 'issue', rest[0]), label: owner + '/' + repo + ' #' + rest[0] };
      }
      return { hash: link(owner, repo, 'issues'), label: owner + '/' + repo + ' · Issues' };
    case 'pull':
    case 'pulls':
      if (kind === 'pull' && rest[0] && /^\d+$/.test(rest[0])) {
        return { hash: link(owner, repo, 'pull', rest[0]), label: owner + '/' + repo + ' #' + rest[0] };
      }
      return { hash: link(owner, repo, 'pulls'), label: owner + '/' + repo + ' · Pull requests' };
    case 'releases':
      return { hash: link(owner, repo, 'releases'), label: owner + '/' + repo + ' · 发行版' };
    case 'commits': {
      const ref = rest[0] || '';
      return { hash: link(owner, repo, 'commits', ref), label: owner + '/' + repo + ' · 提交' };
    }
    case 'commit':
      if (!rest[0]) return null;
      return { hash: link(owner, repo, 'commit', rest[0]), label: owner + '/' + repo + ' @' + rest[0].slice(0, 7) };
    case 'branches':
      return { hash: link(owner, repo, 'branches'), label: owner + '/' + repo + ' · 分支' };
    case 'archive':
      return { hash: link(owner, repo, 'tools'), label: owner + '/' + repo + ' · 下载' };
    default:
      // 认不出的子路径，退回仓库首页
      return { hash: link(owner, repo), label: owner + '/' + repo };
  }
}

/* ---------- 图片：多个 raw 源逐级降级，最后回落 API 二进制 ---------- */

/** 依次尝试所有 raw 源，全部失败再把图片经 API 取回本地 Blob */
function attachImgChain(img, o, r, ref, p) {
  const sources = rawSources(o, r, ref, p);
  let i = 0;
  img.src = sources[0];
  img.addEventListener('error', function onErr() {
    i++;
    if (i < sources.length) {
      img.src = sources[i];
    } else {
      img.removeEventListener('error', onErr);
      loadImageViaApi(img, o, r, ref, p);
    }
  });
}

async function loadImageViaApi(img, o, r, ref, p) {
  if (img.dataset.tried === '1') return;
  img.dataset.tried = '1';
  try {
    const blob = await gh(
      '/repos/' + o + '/' + r + '/contents/' + encPath(p) + '?ref=' + encodeURIComponent(ref),
      { accept: 'application/vnd.github.raw', blob: true }
    );
    img.src = URL.createObjectURL(blob);
  } catch (_) {
    img.style.opacity = '.2';
  }
}

/* ---------- 重写 Markdown 里的链接与图片 ---------- */

function rewriteLinks(root, ctx) {
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href) return;
    if (href[0] === '#') return;

    // github.com 链接 → 站内
    const m = href.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(blob|tree|issues|pull|releases|commits)\/([^/?#]+)(?:\/([^?#]*))?)?/);
    if (m) {
      const o2 = m[1], r2 = m[2], kind = m[3], ref = m[4], rest = m[5] || '';
      if (kind) {
        a.setAttribute('href', link(o2, r2, kind, decodeURIComponent(ref), rest));
      } else {
        a.setAttribute('href', link(o2, r2));
      }
      return;
    }

    // raw.githubusercontent.com → 站内 blob 视图
    const rm = href.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (rm) {
      a.setAttribute('href', link(rm[1], rm[2], 'blob', decodeURIComponent(rm[3]), rm[4]));
      return;
    }

    // 相对路径
    if (isRelative(href)) {
      const hashIdx = href.indexOf('#');
      const frag = hashIdx >= 0 ? href.slice(hashIdx) : '';
      const clean = href.split('#')[0].split('?')[0];
      const target = resolvePath(ctx.baseDir, clean);
      a.setAttribute('href', link(ctx.owner, ctx.repo, 'blob', ctx.ref, target) + frag);
      return;
    }

    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  root.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (!src) return;

    // GitHub 的 raw/blob 链接
    const ghRaw = src.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/([^/]+)\/(.+?)(?:\?raw=true)?$/);
    if (ghRaw) {
      attachImgChain(img, ghRaw[1], ghRaw[2], decodeURIComponent(ghRaw[3]), ghRaw[4]);
      return;
    }

    const rawGh = src.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (rawGh) {
      attachImgChain(img, rawGh[1], rawGh[2], decodeURIComponent(rawGh[3]), rawGh[4]);
      return;
    }

    // 相对路径 → 仓库内文件
    if (isRelative(src)) {
      const p = resolvePath(ctx.baseDir, src.split('?')[0].split('#')[0]);
      img.setAttribute('loading', 'lazy');
      attachImgChain(img, ctx.owner, ctx.repo, ctx.ref, p);
      return;
    }

    // 绝对地址（avatars / user-images / camo / 外链）直接加载
    img.setAttribute('loading', 'lazy');
    img.addEventListener('error', () => { img.style.opacity = '.25'; }, { once: true });
  });
}

function renderMarkdown(text, ctx) {
  const box = document.createElement('div');
  box.className = 'markdown-body';
  box.innerHTML = sanitize(marked.parse(text || ''));
  if (ctx) rewriteLinks(box, ctx);
  return box;
}

/* ---------------------------- 通用片段 ---------------------------- */

function avatar(url, size) {
  const s = size || 32;
  if (!url) return '<span class="avatar avatar-fallback" style="width:' + s + 'px;height:' + s + 'px"></span>';
  return '<img class="avatar" src="' + esc(url) + (url.indexOf('?') >= 0 ? '&' : '?') + 's=' + (s * 2) +
    '" width="' + s + '" height="' + s + '" alt="" loading="lazy" ' +
    'onerror="this.style.visibility=\'hidden\'">';
}

/** 当前页面对应的 GitHub 原地址，可打开也可复制 */
function srcLink(url) {
  if (!url) return '';
  return '<div class="gh-src">' + ICON.link +
    '<a href="' + esc(url) + '" target="_blank" rel="noopener" title="在新标签页打开">' +
    esc(String(url).replace(/^https:\/\//, '')) + '</a>' +
    '<button type="button" class="gh-src-cp" data-url="' + esc(url) + '" title="复制原网址">复制</button>' +
    '</div>';
}

function bindSrcLinks(scope) {
  (scope || app).querySelectorAll('.gh-src-cp').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      copyText(b.getAttribute('data-url'));
    });
  });
}

/** 由当前路由推导出对应的 GitHub 原地址 */
function githubUrlFromRoute() {
  let seg, q;
  try {
    const parsed = parseHash();
    seg = parsed.seg;
    q = parsed.q;
  } catch (_) {
    return '';
  }

  if (seg[0] === 'u' && seg[1]) return 'https://github.com/' + seg[1];
  if (seg[0] !== 'r' || !seg[1] || !seg[2]) return '';

  const o = seg[1], r = seg[2], kind = seg[3];
  const base = 'https://github.com/' + o + '/' + r;
  if (!kind) return base;

  if (kind === 'tree' || kind === 'blob') {
    const ref = seg[4] || '';
    const p = seg.slice(5).join('/');
    return base + '/' + kind + '/' + ref + (p ? '/' + p : '');
  }
  if (kind === 'issues') {
    if (seg[4]) return base + '/issues/' + seg[4];
    return base + '/issues' + (q.get('state') === 'closed' ? '?q=is%3Aissue+is%3Aclosed' : '');
  }
  if (kind === 'pulls') {
    if (seg[4]) return base + '/pull/' + seg[4];
    return base + '/pulls' + (q.get('state') === 'closed' ? '?q=is%3Apr+is%3Aclosed' : '');
  }
  if (kind === 'issue') return base + '/issues/' + (seg[4] || '');
  if (kind === 'pull') return base + '/pull/' + (seg[4] || '');
  if (kind === 'commit') return base + '/commit/' + (seg[4] || '');
  if (kind === 'commits') return base + '/commits' + (seg[4] ? '/' + seg[4] : '');
  if (kind === 'releases') return base + '/releases';
  if (kind === 'branches') return base + '/branches';
  return base;
}

function repoHeader(repo, tab, srcUrl) {
  const o = repo.owner.login, r = repo.name;
  if (srcUrl === undefined) srcUrl = githubUrlFromRoute();
  const tabs = [
    ['code', '代码', link(o, r)],
    ['issues', 'Issues', link(o, r, 'issues')],
    ['pulls', 'Pull requests', link(o, r, 'pulls')],
    ['commits', '提交', link(o, r, 'commits', repo.default_branch)],
    ['releases', '发行版', link(o, r, 'releases')],
    ['branches', '分支', link(o, r, 'branches')],
    ['tools', '下载', link(o, r, 'tools', repo.default_branch)]
  ];
  return `
  <div class="repo-head">
    <h1 class="repo-title">
      ${avatar(repo.owner.avatar_url, 20)}
      <span class="owner"><a href="#/u/${encodeURIComponent(o)}">${esc(o)}</a></span>
      <span class="sep-slash">/</span>
      <span class="name">${esc(r)}</span>
      ${repo.private ? '<span class="badge">' + ICON.lock + ' 私有</span>' : ''}
      ${repo.fork ? '<span class="badge">fork</span>' : ''}
      ${repo.archived ? '<span class="badge">已归档</span>' : ''}
    </h1>
    ${repo.description ? `<div class="repo-desc">${esc(repo.description)}</div>` : ''}
    <div class="repo-meta">
      <span>${ICON.star} <b>${fmtNum(repo.stargazers_count)}</b></span>
      <span>${ICON.fork} <b>${fmtNum(repo.forks_count)}</b></span>
      <span>${ICON.eye} <b>${fmtNum(repo.subscribers_count || repo.watchers_count)}</b></span>
      <span>${ICON.issue} <b>${fmtNum(repo.open_issues_count)}</b></span>
      ${repo.language ? `<span><i class="dot"></i>${esc(repo.language)}</span>` : ''}
      ${repo.license ? `<span>${esc(repo.license.spdx_id || repo.license.name)}</span>` : ''}
      <span>${ICON.clock} ${timeAgo(repo.pushed_at)}</span>
      ${repo.homepage ? `<span>${ICON.link}<a href="${esc(repo.homepage)}" target="_blank" rel="noopener">${esc(repo.homepage)}</a></span>` : ''}
    </div>
    ${srcLink(srcUrl)}
    ${writeBlock(o, r, repo)}
  </div>
  <div class="repo-tabs">
    ${tabs.map(([k, label, href]) =>
      `<a href="${href}" class="${tab === k ? 'on' : ''}">${label}</a>`).join('')}
  </div>`;
}

function repoHeaderLite(o, r) {
  return `<div class="repo-head"><h1 class="repo-title">
    <span class="owner"><a href="#/u/${encodeURIComponent(o)}">${esc(o)}</a></span>
    <span class="sep-slash">/</span><span class="name">${esc(r)}</span></h1></div>`;
}

function repoCard(r) {
  return `<div class="repo-card">
    <div class="rc-name"><a href="${link(r.owner.login, r.name)}">${esc(r.owner.login)} / ${esc(r.name)}</a>
      ${r.private ? '<span class="badge">私有</span>' : ''}</div>
    ${r.description ? `<div class="rc-desc">${esc(r.description)}</div>` : ''}
    <div class="rc-meta">
      ${r.language ? `<span><i class="dot"></i>${esc(r.language)}</span>` : ''}
      <span>${ICON.star} ${fmtNum(r.stargazers_count)}</span>
      <span>${ICON.fork} ${fmtNum(r.forks_count)}</span>
      <span>${ICON.clock} ${timeAgo(r.pushed_at)}</span>
    </div>
  </div>`;
}

function fileRow(o, r, ref, c) {
  const isDir = c.type === 'dir' || c.type === 'submodule';
  const href = isDir ? link(o, r, 'tree', ref, c.path) : link(o, r, 'blob', ref, c.path);
  return `<div class="file-row${isDir ? ' dir' : ''}" data-href="${esc(href)}">
    ${isDir ? ICON.folder : ICON.file}
    <span class="fname-wrap"><span class="fname">${esc(c.name)}</span></span>
    <span class="fmsg"></span>
    <span class="fsize">${isDir ? '' : fmtSize(c.size)}</span>
  </div>`;
}

function bindFileRows(scope) {
  (scope || app).querySelectorAll('.file-row[data-href]').forEach(el => {
    el.addEventListener('click', () => { location.hash = el.getAttribute('data-href'); });
  });
}

/* ---------------------------- 首页 ---------------------------- */

async function viewHome() {
  document.title = 'GitHub 本地客户端';
  app.innerHTML = `
    <div class="hero">
      <h1>一个更轻的 GitHub 入口。</h1>
      <p>只读官方接口，不依赖网页前端，也不经过本站服务器。网络不佳时会自动换一条通路。</p>
    </div>
    ${TOKEN ? '' : authBanner()}
    <div class="quick-links">
      <a class="btn" href="#/tools">通路与下载</a>
      <a class="btn" href="#/me">我的仓库</a>
      <a class="btn" href="#/search?q=stars:%3E10000&type=repositories">热门仓库</a>
      <button class="btn" id="fromClip">从剪贴板打开</button>
    </div>
    <p class="hero-tip">点开上方搜索会展开整个面板：挑好类型与条件再一次提交，粘 github.com 链接则直接跳到对应页面。</p>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head">近期热门</div>
        <div id="hot" class="spin-slot"><div class="spinner"></div></div>
      </div>
      <div class="panel">
        <div class="panel-head">${TOKEN ? '我最近更新' : '示例：常见工具仓库'}</div>
        <div id="mine" class="spin-slot"><div class="spinner"></div></div>
      </div>
    </div>`;
  bindAuthBanner();

  const d = new Date(Date.now() - 86400000 * 45).toISOString().slice(0, 10);
  gh('/search/repositories?q=stars:%3E8000+pushed:%3E' + d + '&sort=stars&order=desc&per_page=8')
    .then(res => { $('#hot').innerHTML = res.items.map(repoCard).join('') || '<div class="empty">无结果</div>'; })
    .catch(e => { $('#hot').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });

  if (TOKEN) {
    gh('/user/repos?sort=pushed&per_page=8&affiliation=owner,collaborator,organization_member')
      .then(list => { $('#mine').innerHTML = list.map(repoCard).join('') || '<div class="empty">还没有仓库</div>'; })
      .catch(e => { $('#mine').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  } else {
    $('#mine').innerHTML = [
      ['microsoft', 'vscode'], ['torvalds', 'linux'], ['facebook', 'react'],
      ['rust-lang', 'rust'], ['golang', 'go'], ['vuejs', 'core']
    ].map(([o, r]) => `<div class="file-row" data-href="${link(o, r)}">
        ${ICON.folder}<span class="fname-wrap"><span class="fname">${o} / ${r}</span></span>
        <span class="fmsg"></span></div>`).join('');
    bindFileRows($('#mine'));
  }
}

function authBanner() {
  return `<div class="empty-state">
    <h3>开始使用</h3>
    <p class="hint">未登录时可以浏览公开内容，匿名调用每小时 60 次；填入令牌后提升到 5000 次/小时，并能查看自己的仓库与收藏。</p>
    <div class="empty-actions">
      <button class="btn primary" id="esBrowse">浏览公开仓库</button>
      <button class="btn" id="openToken">设置令牌</button>
      <button class="btn ghost" id="esSignup">注册账号</button>
    </div>
    <button class="link-btn" id="esGuide">查看 3 步新手指引 →</button>
  </div>`;
}

function bindAuthBanner() {
  const b = $('#openToken');
  if (b) b.addEventListener('click', openSettings);
  const clip = $('#fromClip');
  if (clip) clip.addEventListener('click', openFromClipboard);
  const browse = $('#esBrowse');
  if (browse) browse.addEventListener('click', () => { location.hash = link('microsoft', 'vscode'); });
  const signup = $('#esSignup');
  if (signup) signup.addEventListener('click', () => openWebPage('https://github.com/signup'));
  const guide = $('#esGuide');
  if (guide) guide.addEventListener('click', () => openGuide(0));
}

/* ---------------------------- 新手指引 ---------------------------- */

let guideOpen = false;

const GUIDE = [
  {
    t: '设置访问令牌',
    d: '令牌决定配额与权限。只读公开内容勾 public_repo；看私有仓库加 repo；改账号资料加 user。令牌只保存在本机，请求时直接发给 GitHub。',
    btn: '去设置令牌',
    act: (close) => { close(); openSettings(); }
  },
  {
    t: '打开一个仓库',
    d: '仓库页可以查看文件、提交、Issues 与 Releases。先用一个公开仓库熟悉结构，左侧文件树可以直接进入子目录。',
    btn: '打开 microsoft/vscode',
    act: (close) => { close(); location.hash = link('microsoft', 'vscode'); }
  },
  {
    t: '搜索与下载',
    d: '顶部搜索支持类型与条件组合；「通路与下载」里可以下载单个文件，并查看下载位置与下载记录。',
    btn: '打开搜索',
    act: (close) => { close(); openSearchPanel({ q: '' }); }
  }
];

function openGuide(step) {
  const mask = $('#modal');
  if (!mask) return;
  if (!mask.hidden && !guideOpen) return;   // 其它弹窗占用时不抢
  step = Math.max(0, Math.min(GUIDE.length - 1, step || 0));
  const g = GUIDE[step];
  guideOpen = true;
  mask.hidden = false;
  mask.innerHTML = `
    <div class="modal-card">
      <div class="guide-dots">${GUIDE.map((_, i) => `<span class="${i === step ? 'on' : ''}"></span>`).join('')}</div>
      <h3>${step + 1}. ${esc(g.t)}</h3>
      <p class="hint">${esc(g.d)}</p>
      <div class="modal-actions">
        <button class="btn ghost sm" id="gdSkip">跳过</button>
        <span class="spacer"></span>
        ${step > 0 ? '<button class="btn sm ghost" id="gdPrev">上一步</button>' : ''}
        ${step < GUIDE.length - 1
          ? '<button class="btn sm" id="gdNext">下一步</button>'
          : '<button class="btn sm ghost" id="gdDone">完成</button>'}
        <button class="btn primary sm" id="gdAct">${esc(g.btn)}</button>
      </div>
    </div>`;
  const close = () => {
    guideOpen = false;
    mask.hidden = true;
    mask.innerHTML = '';
    mask.onclick = null;
    LS.set('ghl_guide_done', '1');
  };
  $('#gdSkip').onclick = close;
  $('#gdDone').onclick = close;
  if ($('#gdPrev')) $('#gdPrev').onclick = () => openGuide(step - 1);
  if ($('#gdNext')) $('#gdNext').onclick = () => openGuide(step + 1);
  $('#gdAct').onclick = () => g.act(close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

/** 首次进入先走三步引导；已看过则按 24 小时冷却提示令牌 */
function maybeOnboard() {
  if (LS.get('ghl_guide_done', '') === '1') { maybePromptAuth(); return; }
  if (TOKEN) { LS.set('ghl_guide_done', '1'); return; }   // 已登录的老用户不打扰
  setTimeout(() => openGuide(0), 900);
}

/* ---------------------------- 未登录引导 ---------------------------- */

/** 未设置令牌时，进入客户端给一次引导；24 小时内不重复打扰 */
function maybePromptAuth() {
  if (TOKEN) return;
  const last = Number(LS.get('ghl_auth_prompt_at', '0') || 0);
  if (Date.now() - last < 24 * 3600 * 1000) return;
  LS.set('ghl_auth_prompt_at', String(Date.now()));
  setTimeout(openAuthPrompt, 900);
}

function openAuthPrompt() {
  const mask = $('#modal');
  if (!mask || !mask.hidden) return;   // 已有弹窗时不抢
  mask.hidden = false;
  mask.innerHTML = `
    <div class="modal-card">
      <h3>先设置访问令牌</h3>
      <p class="hint">未登录时每小时只能调用 60 次，浏览几个仓库就会用完；填入令牌后提升到 5000 次/小时。</p>
      <ul class="auth-points">
        <li>令牌只保存在本机，请求时直接发给 GitHub，不经过第三方。</li>
        <li>只读公开内容勾 <code>public_repo</code>；看私有仓库加 <code>repo</code>；改账号资料加 <code>user</code>。</li>
        <li>还没有账号可以先注册，注册页在客户端内打开。</li>
      </ul>
      <div class="modal-actions">
        <button class="btn ghost sm" id="authLater">稍后</button>
        <span class="spacer"></span>
        <button class="btn sm ghost" id="authSignup">注册账号</button>
        <button class="btn primary sm" id="authGo">去设置令牌</button>
      </div>
    </div>`;
  const close = () => {
    mask.hidden = true;
    mask.innerHTML = '';
    mask.onclick = null;
  };
  $('#authLater').onclick = close;
  $('#authGo').onclick = () => { close(); openSettings(); };
  $('#authSignup').onclick = () => openWebPage('https://github.com/signup');
  mask.onclick = (e) => { if (e.target === mask) close(); };
}

/* ---------------------------- 翻译 ---------------------------- */

/**
 * 两条翻译通道：
 *   1. 浏览器内置 Translator API（Chrome 138+ / Edge）—— 本地模型，不限量，内容不出本机
 *   2. MyMemory 公共接口 —— 无需配置，但 500 字符/次、约 5000 字符/天
 * 结果按「仓库@分支」缓存在 localStorage，翻一次就够。
 */

const TR_CACHE = 'ghtr:';
let browserTr;   // undefined=未探测, null=不支持, 否则是 Translator 实例

/** 粗略判断是否以英文为主：剔除代码、链接、标签后，汉字占比低于 10% 才算 */
function looksEnglish(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');          // 代码块
  t = t.replace(/`[^`\n]*`/g, ' ');                // 行内代码
  t = t.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ');    // 图片与链接（含 URL）
  t = t.replace(/https?:\/\/\S+/g, ' ');           // 裸链接
  t = t.replace(/<[^>]+>/g, ' ');                  // HTML 标签

  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const total = cjk + latin;
  if (total < 120) return false;                   // 太短不判断
  return cjk / total < 0.10;
}

/** 按代码围栏把 markdown 切成「代码」与「待译文本」 */
function splitMd(md) {
  const out = [];
  const re = /```[\s\S]*?```/g;
  let last = 0, m;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) out.push({ code: false, text: md.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

/** 拆出行首标记，翻译只作用于标记之后的部分 */
function splitLinePrefix(line) {
  let m;
  if ((m = line.match(/^(#{1,6}[ \t]+)/))) return [m[1], line.slice(m[1].length)];
  if ((m = line.match(/^(\s*[-*+][ \t]+)/))) return [m[1], line.slice(m[1].length)];
  if ((m = line.match(/^(\s*\d+\.[ \t]+)/))) return [m[1], line.slice(m[1].length)];
  if ((m = line.match(/^(>[ \t]*)/))) return [m[1], line.slice(m[1].length)];
  if ((m = line.match(/^(\s*\|)/))) return [m[1], line.slice(m[1].length)];
  return ['', line];
}

/** 这些行不需要翻译 */
function skipLine(line) {
  const s = line.trim();
  if (!s) return true;
  if (/^\|?[\s:|-]+\|?$/.test(s)) return true;            // 表格分隔线
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(s)) return true;       // 纯图片
  if (/^\[[^\]]+\]:\s*\S+/.test(s)) return true;           // 链接定义
  if (/^<[^>]+>$/.test(s)) return true;                    // 单行 HTML
  if (/^https?:\/\/\S+$/.test(s)) return true;             // 裸链接
  if (!/[A-Za-z]/.test(s)) return true;                    // 没有英文
  return false;
}

async function getBrowserTranslator() {
  if (browserTr !== undefined) return browserTr;
  if (typeof self.Translator !== 'object' || !self.Translator) { browserTr = null; return null; }
  try {
    if (self.Translator.availability) {
      const st = await self.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
      if (st === 'unavailable') { browserTr = null; return null; }
      if (st === 'downloadable') { browserTr = null; return null; }  // 需要下载模型，不擅自触发
    }
    browserTr = await self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
  } catch (_) {
    browserTr = null;
  }
  return browserTr;
}

/** MyMemory：单次 500 字符上限 */
async function myMemoryTranslate(text) {
  const url = 'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' +
    encodeURIComponent(text.slice(0, 480));
  const res = await fetch(url);
  if (res.status === 429) throw new Error('MyMemory 触发限流或当日额度已用尽');
  if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
  const j = await res.json();
  const out = j && j.responseData && j.responseData.translatedText;
  if (!out) throw new Error('MyMemory 无返回');

  if (/MYMEMORY WARNING/i.test(out)) {
    if (/USED ALL AVAILABLE FREE TRANSLATIONS/i.test(out)) {
      const m = out.match(/NEXT AVAILABLE IN\s+([0-9]+\s+HOURS?[^.]*)/i);
      throw new Error('MyMemory 免费额度已用尽' + (m ? '，约 ' + m[1].replace(/\s+/g, ' ').trim() + ' 后恢复' : ''));
    }
    throw new Error('MyMemory 返回警告：' + out.slice(0, 80));
  }
  if (/QUERY LENGTH LIMIT/i.test(out)) throw new Error('文本超过 MyMemory 单次上限');
  return out;
}

/** 用户自建 LibreTranslate（设置里可选） */
async function libreTranslate(text) {
  const base = String(LS.get('ghl_translate', '') || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 LibreTranslate 地址');
  const key = String(LS.get('ghl_translate_key', '') || '').trim();

  const body = { q: text, source: 'en', target: 'zh', format: 'text' };
  if (key) body.api_key = key;

  const res = await fetch(base + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('LibreTranslate HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.translatedText) throw new Error('LibreTranslate 无返回');
  return j.translatedText;
}

/** 腾讯翻译：无需密钥，支持批量，单次可处理数千字符 */
async function tencentTranslate(list) {
  const res = await fetch('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-110.0.0-Mac OS' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'en', text_list: list },
      target: { lang: 'zh' }
    })
  });
  if (!res.ok) throw new Error('腾讯翻译 HTTP ' + res.status);
  const j = await res.json();
  if (j && j.header && j.header.ret_code !== 'succ') {
    throw new Error('腾讯翻译：' + (j.message || j.header.ret_code));
  }
  const out = (j && j.auto_translation) || [];
  if (!Array.isArray(out) || out.length !== list.length) {
    throw new Error('腾讯翻译返回条数不符');
  }
  return out;
}

/** B 站 Index-Translate：OpenAI 兼容接口，免密钥，单条可处理长文本 */
async function bilibiliTranslate(text) {
  const res = await fetch('https://index-translate.bilibili.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer index'
    },
    body: JSON.stringify({
      model: 'Index-Translate-35B-A3B',
      messages: [
        { role: 'system', content: '你是翻译引擎。把用户文本译成简体中文，保留 Markdown 结构与换行，只输出译文。' },
        { role: 'user', content: text }
      ],
      temperature: 0,
      stream: false
    })
  });
  if (res.status === 429) throw new Error('B站翻译限流');
  if (!res.ok) throw new Error('B站翻译 HTTP ' + res.status);
  const j = await res.json();
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('B站翻译无返回');
  return String(out).trim();
}

/** Pollinations：免密钥的文本生成接口，用作翻译通道。慢，适合兜底 */
async function pollinationsTranslate(text) {
  const q = 'Translate the following English text into Simplified Chinese. ' +
    'Output only the translation, without explanation or quotes:\n\n' + text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://text.pollinations.ai/' + encodeURIComponent(q), {
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('Pollinations HTTP ' + res.status);
    let out = (await res.text()).trim();
    if (!out) throw new Error('Pollinations 无返回');
    // 去掉模型常见的引导语
    out = out.replace(/^(?:以下是|译文|翻译|翻译结果)\s*[:：]\s*/, '')
             .replace(/^(?:Sure|Here is the translation)[,，:：\s]*/i, '')
             .replace(/^["“]([\s\S]*)["”]$/, '$1');
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** MyMemory 单次上限 500 字符，超长先按句切开 */
async function myMemoryLong(s) {
  if (s.length <= 460) return myMemoryTranslate(s);
  const segs = splitSentences(s, 460);
  const parts = [];
  for (const seg of segs) parts.push(await myMemoryTranslate(seg));
  return parts.join('');
}

let lastTrErr = null;

/** 通道顺序：选定的提到最前，其余仍作兜底 */
const TR_MODES = {
  auto: ['browser', 'tencent', 'bilibili', 'pollinations', 'libre', 'mymemory'],
  browser: ['browser', 'tencent', 'bilibili', 'pollinations', 'libre', 'mymemory'],
  tencent: ['tencent', 'bilibili', 'browser', 'pollinations', 'libre', 'mymemory'],
  bilibili: ['bilibili', 'tencent', 'browser', 'pollinations', 'libre', 'mymemory'],
  pollinations: ['pollinations', 'tencent', 'bilibili', 'browser', 'libre', 'mymemory'],
  libre: ['libre', 'tencent', 'bilibili', 'browser', 'pollinations', 'mymemory'],
  mymemory: ['mymemory', 'tencent', 'bilibili', 'browser', 'pollinations', 'libre']
};

function trOrder() {
  const m = String(LS.get('ghl_tr_mode', 'auto') || 'auto');
  return TR_MODES[m] || TR_MODES.auto;
}

/** 单通道翻译一批，失败抛错，部分成功时返回 null 占位 */
async function viaChannel(ch, list) {
  if (ch === 'browser') {
    const bt = await getBrowserTranslator();
    if (!bt) throw new Error('浏览器无内置翻译模型');
    const out = [];
    for (const s of list) {
      try { out.push(await bt.translate(s)); }
      catch (e) { lastTrErr = e; out.push(null); }
    }
    return out;
  }

  if (ch === 'tencent') return tencentTranslate(list);

  if (ch === 'bilibili') {
    const out = [];
    for (const s of list) out.push(await bilibiliTranslate(s));
    return out;
  }

  if (ch === 'pollinations') {
    const out = [];
    for (const s of list) out.push(await pollinationsTranslate(s));
    return out;
  }

  if (ch === 'libre') {
    const out = [];
    for (const s of list) out.push(await libreTranslate(s));
    return out;
  }

  if (ch === 'mymemory') {
    const out = [];
    for (const s of list) out.push(await myMemoryLong(s));
    return out;
  }

  throw new Error('未知翻译通道：' + ch);
}

/** 批量翻译，逐通道补齐缺失项，返回与 items 等长的数组 */
async function translateBatch(items) {
  const out = new Array(items.length).fill(null);
  lastTrErr = null;

  for (const ch of trOrder()) {
    const pending = [];
    out.forEach((v, i) => { if (v === null) pending.push(i); });
    if (!pending.length) break;

    try {
      const res = await viaChannel(ch, pending.map((i) => items[i]));
      res.forEach((t, k) => {
        if (t !== null && t !== undefined && String(t).trim()) out[pending[k]] = t;
      });
    } catch (e) {
      lastTrErr = e;
    }
  }

  if (out.every((v) => v === null)) throw (lastTrErr || new Error('翻译接口均不可用'));
  return out;
}

/* ---------- 行内受保护片段 ---------- */

/** 行内代码、链接、图片不参与翻译，先换成占位符 */
function protectInline(s) {
  const map = [];
  const text = String(s).replace(
    /`[^`\n]+`|https?:\/\/[^\s)\]}>,，。"']+|!\[[^\]]*\]\([^)]*\)/g,
    (m) => {
      let body = m;
      let tail = '';
      // URL 末尾的标点要留在占位符外面，否则会吃掉句子边界
      if (/^https?:/i.test(m)) {
        const t = m.match(/[.,;:!?]+$/);
        if (t) { tail = t[0]; body = m.slice(0, -tail.length); }
      }
      map.push(body);
      return '[[' + (map.length - 1) + ']]' + tail;
    }
  );
  return { text: text, map: map };
}

function restoreInline(s, map) {
  if (!map || !map.length) return s;
  return String(s).replace(/\[\[\s*(\d+)\s*\]\]/g, (m, i) => {
    const v = map[Number(i)];
    return v === undefined ? m : v;
  });
}

/** 按句末标点切分；单句仍超限的再硬切 */
function splitSentences(text, max) {
  if (text.length <= max) return [text];
  const segs = text.split(/(?<=[.!?。！？])\s+/);
  const out = [];
  let cur = '';
  for (const seg of segs) {
    if (cur && (cur + ' ' + seg).length > max) { out.push(cur); cur = seg; }
    else cur = cur ? cur + ' ' + seg : seg;
  }
  if (cur) out.push(cur);

  const final = [];
  for (const p of out) {
    if (p.length <= max) { final.push(p); continue; }
    for (let i = 0; i < p.length; i += max) final.push(p.slice(i, i + max));
  }
  return final;
}

/**
 * 逐行翻译一段 markdown。
 * 批次上限随通道变化：浏览器内置模型给到 1800 字符，MyMemory 只有 500，
 * 因此短行合批；超长段落按句子切开单独翻译，避免被接口截断。
 */
async function translateBlock(text, onTick) {
  const bt = await getBrowserTranslator();
  const maxChars = bt ? 1600 : 1200;

  const lines = text.split('\n');
  const jobs = [];
  lines.forEach((line, i) => {
    if (skipLine(line)) return;
    const [prefix, body] = splitLinePrefix(line);
    if (!body.trim()) return;
    const g = protectInline(body);
    if (!g.text.trim()) return;
    jobs.push({ idx: i, prefix: prefix, guarded: g.text, map: g.map });
  });
  if (!jobs.length) return text;

  // 超长行按句切成多条；切出的片段共用同一行的前缀与占位符表
  const units = [];
  jobs.forEach((j) => {
    const segs = splitSentences(j.guarded, maxChars);
    segs.forEach((s, k) => {
      units.push({ job: j, text: s, first: k === 0 });
    });
  });

  const out = lines.slice();
  const idxOf = new Map();
  jobs.forEach((j) => idxOf.set(j.idx, j));
  const bufs = new Map();
  let ok = 0;

  // 合批：字符数与条数双限
  const batches = [];
  let cur = [];
  let len = 0;
  units.forEach((u) => {
    const add = u.text.length + 2;
    if (cur.length && (len + add > maxChars || cur.length >= 8)) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(u);
    len += add;
  });
  if (cur.length) batches.push(cur);

  let done = 0;
  for (const batch of batches) {
    const res = await translateBatch(batch.map((u) => u.text));
    batch.forEach((u, k) => {
      const t = res[k];
      if (t === null || t === undefined || !String(t).trim()) return;
      const key = u.job.idx;
      if (!bufs.has(key)) bufs.set(key, []);
      bufs.get(key).push({ first: u.first, text: t });
      ok++;
    });
    done += batch.length;
    if (onTick) onTick(done, units.length);
  }

  bufs.forEach((arr, idx) => {
    const job = idxOf.get(idx);
    let s = '';
    arr.forEach((piece) => {
      if (piece.first) s += job.prefix;
      s += piece.text;
    });
    out[idx] = restoreInline(s, job.map);
  });

  if (!ok) throw (lastTrErr || new Error('翻译接口未返回结果'));
  return out.join('\n');
}


async function translateMarkdown(md, onTick) {
  const parts = splitMd(md);
  const texts = parts.filter((p) => !p.code);
  let idx = 0;
  const out = [];

  for (const p of parts) {
    if (p.code) { out.push(p.text); continue; }
    idx++;
    out.push(await translateBlock(p.text, (a, b) => {
      if (onTick) onTick(idx, texts.length, a, b);
    }));
  }
  return out.join('');
}

function trCacheGet(key) {
  try {
    const raw = localStorage.getItem(TR_CACHE + key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || Date.now() - rec.t > 7 * 864e5) return null;
    return rec.v;
  } catch (_) { return null; }
}

function trCacheSet(key, val) {
  try {
    localStorage.setItem(TR_CACHE + key, JSON.stringify({ t: Date.now(), v: val }));
  } catch (_) {}
}

/**
 * 给 markdown 块挂上翻译开关（README / issue / 评论 / Release）。
 * original：原文 markdown；bodyEl：渲染容器；render：把 markdown 变 HTML 的方法
 */
function bindTranslate(btn, bodyEl, original, ctx, cacheKey) {
  let translated = trCacheGet(cacheKey);
  let showing = false;

  const paint = (md) => {
    const box = renderMarkdown(md, ctx);
    bodyEl.innerHTML = box.innerHTML;
  };

  const label = () => {
    if (showing) btn.textContent = '看原文';
    else if (translated) btn.textContent = '看译文';
    else btn.textContent = '译成中文';
  };
  label();

  btn.addEventListener('click', async () => {
    if (showing) {
      showing = false;
      paint(original);
      label();
      return;
    }
    if (translated) {
      showing = true;
      paint(translated);
      label();
      return;
    }

    btn.disabled = true;
    btn.textContent = '翻译中…';
    try {
      const bt = await getBrowserTranslator();
      if (!bt) {
        toast('当前浏览器无内置翻译模型，改用公共接口：单次 500 字符，每日约 5000 字符', 4500);
      }
      const out = await translateMarkdown(original, (a, b) => {
        btn.textContent = '翻译中 ' + a + '/' + b;
      });
      if (!out || out === original) throw new Error('未产生译文');
      translated = out;
      trCacheSet(cacheKey, out);
      showing = true;
      paint(out);
      toast('已译为中文');
    } catch (e) {
      toast('翻译失败：' + e.message + '。可在设置里填自建 LibreTranslate 地址', 6000);
    } finally {
      btn.disabled = false;
      label();
    }
  });
}

/** 文本块达到这个规模才挂翻译按钮，避免短句也冒按钮 */
const TR_BLOCK_MIN = 400;

/**
 * 给任意 markdown 块挂翻译按钮：README / issue 与 PR 正文 / 评论 / Release 说明。
 * 容器必须是 markdown 渲染出来的元素，bindTranslate 会用同样的 ctx 重绘。
 */
function attachBlockTranslate(container, text, ctx, cacheKey) {
  if (!container || !text) return;
  const t = String(text).trim();
  if (t.length < TR_BLOCK_MIN && t.split('\n').length < 12) return;
  if (container.dataset.trBound === '1') return;
  container.dataset.trBound = '1';
  const head = document.createElement('div');
  head.className = 'tr-head';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn sm ghost';
  btn.textContent = '译成中文';
  head.appendChild(btn);
  container.parentNode.insertBefore(head, container);
  bindTranslate(btn, container, text, ctx, cacheKey);
}

/* ---------------------------- 仓库概览 ---------------------------- */

/* 语言配色沿用 GitHub linguist 的习惯用色 */
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219',
  Go: '#00ADD8', Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  PHP: '#4F5D95', Ruby: '#701516', Swift: '#F05138', Kotlin: '#A97BFF',
  Dart: '#00B4AB', Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c',
  Vue: '#41b883', SCSS: '#c6538c', Lua: '#000080', R: '#198CE7',
  'Jupyter Notebook': '#DA5B0B', Dockerfile: '#384d54', Makefile: '#427819',
  CMake: '#DA3434', 'Objective-C': '#438eff', Haskell: '#5e5086', Elixir: '#6e4a7e',
  Scala: '#c22d40', Perl: '#0298c3', Assembly: '#6E4C13', TeX: '#3D6117',
  PowerShell: '#012456', 'Vim Script': '#199f4b', Nix: '#7e7eff'
};

/** 语言占比条，照 GitHub 仓库页右栏的样子做 */
function langBar(langs) {
  const entries = Object.keys(langs || {})
    .map((k) => [k, langs[k]])
    .filter((e) => e[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  if (!total) return '';

  const top = entries.slice(0, 6);
  const color = (n) => LANG_COLORS[n] || 'var(--fg-subtle)';

  const segs = top.map(([n, v]) =>
    '<span style="width:' + (v / total * 100).toFixed(2) + '%;background:' + color(n) +
    '" title="' + esc(n) + ' ' + (v / total * 100).toFixed(1) + '%"></span>').join('');

  const legend = top.map(([n, v]) =>
    '<span class="lg"><i style="background:' + color(n) + '"></i><b>' + esc(n) + '</b> ' +
    (v / total * 100).toFixed(1) + '%</span>').join('');

  return '<div class="lang-box">' +
    '<div class="lang-bar">' + segs + '</div>' +
    '<div class="lang-legend">' + legend + '</div>' +
    '</div>';
}

/** 右侧「关于」栏 */
function aboutPanel(repo, langs) {
  const rows = [];

  if (repo.archived) rows.push('<div class="about-warn">此仓库已归档，只读</div>');
  if (repo.description) rows.push('<p class="about-desc">' + esc(repo.description) + '</p>');

  if (repo.homepage) {
    rows.push('<div class="about-link">' + ICON.link +
      '<a href="' + esc(repo.homepage) + '" target="_blank" rel="noopener">' +
      esc(String(repo.homepage).replace(/^https?:\/\//, '')) + '</a></div>');
  }

  if (repo.topics && repo.topics.length) {
    rows.push('<div class="topics">' + repo.topics.slice(0, 12).map((t) =>
      '<a class="topic" href="#/search?q=' + encodeURIComponent('topic:' + t) +
      '&type=repositories">' + esc(t) + '</a>').join('') + '</div>');
  }

  const bar = langs ? langBar(langs) : '';
  if (bar) rows.push(bar);

  rows.push('<div class="about-stats">' +
    '<span>' + ICON.star + '<b>' + fmtNum(repo.stargazers_count) + '</b> stars</span>' +
    '<span>' + ICON.eye + '<b>' + fmtNum(repo.subscribers_count || repo.watchers_count) + '</b> watching</span>' +
    '<span>' + ICON.fork + '<b>' + fmtNum(repo.forks_count) + '</b> forks</span>' +
    '</div>');

  const facts = [];
  if (repo.license) facts.push(esc(repo.license.spdx_id || repo.license.name) + ' 许可');
  if (repo.fork && repo.parent) facts.push('Fork 自 ' + esc(repo.parent.full_name));
  facts.push('更新于 ' + timeAgo(repo.pushed_at));
  rows.push('<div class="about-row">' + facts.join(' · ') + '</div>');

  return '<div class="panel about-panel">' +
    '<div class="panel-head">关于</div>' +
    '<div class="about-body">' + rows.join('') + '</div>' +
    '</div>';
}

async function viewRepo(o, r) {
  loading();
  let repo, contents, readme, commit, langs;
  try {
    repo = await getRepo(o, r);
    [contents, readme, commit, langs] = await Promise.all([
      gh('/repos/' + o + '/' + r + '/contents/').catch(() => []),
      gh('/repos/' + o + '/' + r + '/readme').catch(() => null),
      gh('/repos/' + o + '/' + r + '/commits?per_page=1').catch(() => null),
      gh('/repos/' + o + '/' + r + '/languages').catch(() => null)
    ]);
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取仓库', e.message);
    return;
  }
  document.title = o + '/' + r;

  const ref = repo.default_branch;
  const ctx = {
    owner: o, repo: r, ref,
    baseDir: readme ? readme.path.split('/').slice(0, -1).join('/') : ''
  };

  let readmeHtml = '';
  let readmeSrc = null;
  if (readme && readme.content) {
    try {
      const raw = b64ToText(readme.content);
      const md = renderMarkdown(raw, ctx);
      const needTr = looksEnglish(raw);
      readmeSrc = { text: raw, needTr: needTr };
      readmeHtml = `<div class="panel"><div class="panel-head">
          ${ICON.file}<span class="path-crumb">${esc(readme.path)}</span>
          ${needTr ? '<button class="btn sm ghost" id="trBtn" title="把介绍译成中文">译成中文</button>' : ''}
          <span class="spacer"></span>
          <a class="btn sm ghost" href="${link(o, r, 'blob', ref, readme.path)}">源码</a>
        </div><div class="readme-box markdown-body" id="readmeBody">${md.innerHTML}</div></div>`;
    } catch (_) {}
  }

  const commitBar = (commit && commit[0]) ? `<div class="panel commit-bar">
      <div class="panel-head" style="border-bottom:none">
        ${avatar(commit[0].author ? commit[0].author.avatar_url : '', 20)}
        <b class="strong">${esc(commit[0].commit.author.name)}</b>
        <span class="ellipsis">${esc(commit[0].commit.message.split('\n')[0])}</span>
        <span class="spacer"></span>
        <span class="mono dim">${esc(commit[0].sha.slice(0, 7))}</span>
        <span class="dim">${timeAgo(commit[0].commit.author.date)}</span>
      </div>
    </div>` : '';

  app.innerHTML = repoHeader(repo, 'code') + commitBar + `
    <div class="repo-layout">
      <div class="repo-main">
        <div class="panel">
          <div class="panel-head">
            <a class="btn sm ghost" href="${link(o, r, 'branches')}">${ICON.branch} ${esc(ref)}</a>
            <span class="spacer"></span>
            <a class="btn sm" href="${link(o, r, 'tools', ref)}">${ICON.download} 下载</a>
          </div>
          ${contents.length
            ? contents.map(c => fileRow(o, r, ref, c)).join('')
            : '<div class="empty">这是一个空仓库</div>'}
        </div>
        ${readmeHtml}
      </div>
      <aside class="repo-side">${aboutPanel(repo, langs)}</aside>
    </div>`;

  bindFileRows();

  if (readmeSrc && readmeSrc.needTr) {
    const trBtn = $('#trBtn');
    const trBody = $('#readmeBody');
    if (trBtn && trBody) {
      bindTranslate(trBtn, trBody, readmeSrc.text, ctx, o + '/' + r + '@' + ref);
    }
  }
}

/* ---------------------------- 目录 ---------------------------- */

async function viewTree(o, r, ref, path) {
  loading();
  let repo, contents;
  try {
    repo = await getRepo(o, r);
    contents = await gh('/repos/' + o + '/' + r + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(ref));
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取目录', e.message);
    return;
  }
  if (!Array.isArray(contents)) { location.hash = link(o, r, 'blob', ref, path); return; }

  document.title = path + ' · ' + o + '/' + r;
  const crumbs = path.split('/').filter(Boolean);
  const crumbHtml = ['<a href="' + link(o, r) + '">' + esc(r) + '</a>']
    .concat(crumbs.map((seg, i) => {
      const p = crumbs.slice(0, i + 1).join('/');
      return i === crumbs.length - 1
        ? '<b>' + esc(seg) + '</b>'
        : '<a href="' + link(o, r, 'tree', ref, p) + '">' + esc(seg) + '</a>';
    })).join(' <span class="dim">/</span> ');

  app.innerHTML = repoHeader(repo, 'code') + `
    <div class="panel">
      <div class="panel-head">
        <a class="btn sm ghost" href="${link(o, r, 'branches')}">${ICON.branch} ${esc(ref)}</a>
        <span class="path-crumb">${crumbHtml}</span>
        <span class="spacer"></span>
        ${crumbs.length > 1 ? `<a class="btn sm ghost" href="${link(o, r, 'tree', ref, crumbs.slice(0, -1).join('/'))}">${ICON.back} 上级</a>` : ''}
      </div>
      ${contents.length ? contents.map(c => fileRow(o, r, ref, c)).join('') : '<div class="empty">空目录</div>'}
    </div>`;
  bindFileRows();
}

/* ---------------------------- 文件 ---------------------------- */

const LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'stylus',
  json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql', lua: 'lua', dart: 'dart', swift: 'swift', r: 'r',
  pl: 'perl', pm: 'perl', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  asm: 'x86asm', s: 'x86asm', vim: 'vim', diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', makefile: 'makefile', cmake: 'cmake', proto: 'protobuf',
  graphql: 'graphql', gql: 'graphql', tf: 'hcl', hcl: 'hcl'
};

const MAX_HL = 512 * 1024;

async function viewBlob(o, r, ref, path) {
  loading();

  const name = path.split('/').pop() || path;
  const base = name.toLowerCase();
  const ext = base.indexOf('.') >= 0 ? base.split('.').pop() : base;
  const lang = LANG_MAP[ext] ||
    (base === 'makefile' ? 'makefile' :
     base.indexOf('dockerfile') === 0 ? 'dockerfile' :
     base === 'cmakelists.txt' ? 'cmake' : '');

  const crumbs = path.split('/').filter(Boolean);
  const dir = crumbs.slice(0, -1).join('/');
  const crumbHtml = ['<a href="' + link(o, r) + '">' + esc(r) + '</a>']
    .concat(crumbs.map((seg, i) => {
      const p = crumbs.slice(0, i + 1).join('/');
      return i === crumbs.length - 1
        ? '<b>' + esc(seg) + '</b>'
        : '<a href="' + link(o, r, 'tree', ref, p) + '">' + esc(seg) + '</a>';
    })).join(' <span class="dim">/</span> ');

  let repo = null;
  try { repo = await getRepo(o, r); } catch (_) {}

  let text = null;
  let size = null;
  let isBinary = false;

  // 一、raw 通道：不消耗 API 额度，多数情况下一次成功
  try {
    const buf = await fetchRawBytes(o, r, ref, path);
    size = buf.length;
    if (looksBinary(buf)) isBinary = true;
    else text = bytesToText(buf);
  } catch (_) {
    // 二、回退 contents API（目录、私有仓库、raw 全不可用时走这里）
    try {
      const file = await gh('/repos/' + o + '/' + r + '/contents/' + encPath(path) +
        '?ref=' + encodeURIComponent(ref));
      if (Array.isArray(file)) { location.hash = link(o, r, 'tree', ref, path); return; }
      size = file.size;
      if (file.encoding === 'base64' && file.content) {
        text = b64ToText(file.content);
      } else if (file.sha && file.size <= 2097152) {
        try {
          text = await gh('/repos/' + o + '/' + r + '/git/blobs/' + file.sha,
            { accept: 'application/vnd.github.raw' });
        } catch (_) {}
      }
      if (text === null) isBinary = true;
    } catch (e) {
      app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取文件', e.message);
      return;
    }
  }

  document.title = name + ' · ' + o + '/' + r;
  if (text !== null && text.indexOf('\u0000') !== -1) { text = null; isBinary = true; }

  let body;
  if (text !== null) {
    let highlighted;
    if (text.length > MAX_HL) {
      highlighted = esc(text);
    } else if (lang && window.hljs && hljs.getLanguage(lang)) {
      try { highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
      catch (_) { highlighted = esc(text); }
    } else {
      highlighted = esc(text);
    }
    const lines = text.split('\n').length;
    body = '<div class="code-view">' +
      '<div class="gutter">' + Array.from({ length: lines }, (_, i) => i + 1).join('\n') + '</div>' +
      '<pre><code class="hljs">' + highlighted + '</code></pre></div>';
  } else {
    body = '<div class="binary-note">' +
      '二进制文件' + (size !== null ? '（' + fmtSize(size) + '）' : '') + '，无法直接预览。<br><br>' +
      '<button class="btn primary" id="dlFile">' + ICON.download + ' 下载文件</button></div>';
  }

  const isMd = /\.(md|markdown|mdx)$/i.test(name);

  app.innerHTML = (repo ? repoHeader(repo, 'code') : repoHeaderLite(o, r)) + `
    <div class="panel">
      <div class="panel-head">
        <a class="btn sm ghost" href="${link(o, r, 'branches')}">${ICON.branch} ${esc(ref)}</a>
        <span class="path-crumb">${crumbHtml}</span>
        <span class="spacer"></span>
        <span class="mono dim">${size !== null ? fmtSize(size) : ''}</span>
        ${isMd && text !== null ? '<button class="btn sm ghost" id="mdToggle">预览</button>' : ''}
        <button class="btn sm" id="dlFile">${ICON.download} 下载</button>
      </div>
      <div id="fileBody">${body}</div>
    </div>`;

  $('#dlFile').addEventListener('click', () => downloadOne(o, r, ref, path, name));

  if (isMd && text !== null) {
    $('#mdToggle').addEventListener('click', (ev) => {
      const box = $('#fileBody');
      if (box.dataset.preview === '1') {
        box.innerHTML = body;
        box.dataset.preview = '0';
        ev.target.textContent = '预览';
      } else {
        const md = renderMarkdown(text, { owner: o, repo: r, ref, baseDir: dir });
        box.innerHTML = '<div class="readme-box markdown-body">' + md.innerHTML + '</div>';
        box.dataset.preview = '1';
        ev.target.textContent = '源码';
      }
    });
  }
}

/* ------------------------- 下载进度面板 ------------------------- */

function showDlPanel(msg) {
  let p = document.getElementById('dlPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'dlPanel';
    p.className = 'dl-panel';
    p.innerHTML = '<div class="dl-card">' +
      '<div class="dl-title" id="dlMsg"></div>' +
      '<div class="dl-bar"><div class="dl-fill" id="dlFill"></div></div>' +
      '<div class="dl-meta" id="dlMeta"></div></div>';
    document.body.appendChild(p);
  }
  p.hidden = false;
  updateDlPanel(msg, 0, null, null);
}
function updateDlPanel(msg, pct, loaded, speed) {
  const p = document.getElementById('dlPanel');
  if (!p) return;
  document.getElementById('dlMsg').textContent = msg;
  document.getElementById('dlFill').style.width = (pct || 0) + '%';
  let m = '';
  if (loaded != null) m += fmtSize(loaded);
  if (speed != null) m += (m ? ' · ' : '') + fmtSize(speed) + '/s';
  document.getElementById('dlMeta').textContent = m;
}
function hideDlPanel() {
  const p = document.getElementById('dlPanel');
  if (p) p.hidden = true;
}

/** 从粘贴的链接或简写解析出 owner/repo/ref/path */
function parseGithubFileUrl(str) {
  if (!str) return null;
  str = str.trim();
  let m = str.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/);
  if (m) return { o: m[1], r: m[2], ref: decodeURIComponent(m[3]), path: m[4] };
  m = str.match(/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/);
  if (m) return { o: m[1], r: m[2], ref: decodeURIComponent(m[3]), path: m[4] };
  m = str.match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/(.+)$/);
  if (m) return { o: m[1], r: m[2], ref: m[3], path: m[4] };
  return null;
}

async function downloadOne(o, r, ref, path, name) {
  name = name || path.split('/').pop() || 'file';
  if (!ref || ref === 'HEAD') ref = 'main';
  // 旧版安装包没有文件保存接口：安卓 WebView 里 <a download> 是空操作，会静默丢文件
  if (window.Android && typeof window.Android.downloadFile !== 'function') {
    showDlPanel('无法保存文件');
    updateDlPanel('当前安装包缺少文件保存接口，文件只在内存里下载，不会落盘。请先在设置中更新安装包（1.0.8 起支持）。', 0, null, null);
    toast('当前安装包版本过旧，文件不会保存，请先更新安装包', 6000);
    setTimeout(hideDlPanel, 7000);
    return;
  }
  showDlPanel('正在选择最快通道…');
  let pick = null;
  try { pick = await pickBestRawUrl(o, r, ref, path); } catch (_) {}
  if (!pick) {
    const list = rawMirrorList(o, r, ref, path);
    hideDlPanel();
    window.open(list[list.length - 1], '_blank');
    toast('未能自动选通，已在浏览器打开');
    return;
  }
  updateDlPanel('已选定通道：' + pick.label + '（' + pick.ms + ' ms）', 0, null, null);

  // 移动端：交给系统下载管理器，原生带通知栏进度并可靠落盘
  if (window.Android && typeof window.Android.downloadFile === 'function') {
    window.Android.downloadFile(pick.url, name);
    updateDlPanel('已交给系统下载管理器，进度见通知栏：' + name, 100, null, null);
    setTimeout(hideDlPanel, 1800);
    return;
  }

  // 桌面端：XHR 带进度，下载完用 blob 落地
  try {
    const buf = await xhrBytes(pick.url, (loaded, total, speed) => {
      const pct = total ? Math.round(loaded / total * 100) : Math.min(95, Math.round(loaded / 1048576 * 2));
      updateDlPanel('下载中（' + pick.label + '）', pct, loaded, speed);
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    updateDlPanel('已开始下载：' + name, 100, null, null);
    setTimeout(hideDlPanel, 1500);
  } catch (e) {
    hideDlPanel();
    toast('下载失败：' + (e.message || e));
  }
}

/* ------------------------- 下载位置与记录 ------------------------- */

function renderDlWhere() {
  const hint = $('#dlWhereHint');
  const A = window.Android;
  if (hint) {
    if (A && typeof A.downloadDir === 'function') {
      let dir = '';
      try { dir = A.downloadDir() || ''; } catch (_) {}
      hint.innerHTML = '文件保存在系统下载目录：<code>' + esc(dir || '内部存储/Download') +
        '</code>。文件名与原文件一致，重名时系统会自动加后缀。';
    } else {
      hint.innerHTML = '网页版由浏览器保存到默认下载目录：Chrome/Edge 一般在“下载”列表，Windows 默认在“下载”文件夹。';
    }
  }
  const openDir = $('#dlOpenDir');
  if (openDir) openDir.onclick = () => {
    if (A && typeof A.openDownloadsFolder === 'function') A.openDownloadsFolder();
    else toast('网页版请到浏览器的下载列表查看');
  };
  const refresh = $('#dlRefresh');
  if (refresh) refresh.onclick = renderDlList;
  renderDlList();
}

function renderDlList() {
  const list = $('#dlList');
  if (!list) return;
  const A = window.Android;
  if (!A || typeof A.listDownloads !== 'function') { list.innerHTML = ''; return; }
  let arr = [];
  try { arr = JSON.parse(A.listDownloads() || '[]'); } catch (_) {}
  if (!arr || !arr.length) {
    list.innerHTML = '<div class="dim" style="font-size:12px;margin-top:8px">还没有下载记录</div>';
    return;
  }
  list.innerHTML = arr.map(it => {
    const t = Number(it.time) ? new Date(Number(it.time)).toLocaleString('zh-CN') : '';
    const st = it.failed ? '失败' : (it.done ? '已完成' : '下载中');
    return `<div class="dl-row">
      <div class="dl-row-main">
        <b>${esc(it.name || '')}</b>
        <span class="dim mono">${esc(t)}${t ? ' · ' : ''}${st}</span>
      </div>
      <button class="btn sm ghost" data-open="${Number(it.id) || 0}">打开</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => {
      try { A.openDownload(Number(b.dataset.open)); } catch (e) { toast('无法打开：' + e.message); }
    };
  });
}

/* ---------------------------- Issues / PR ---------------------------- */

async function viewIssues(o, r, kind, params) {
  loading();
  params = params || new URLSearchParams();

  const isPR = kind === 'pulls';
  const state = params.get('state') === 'closed' ? 'closed' : 'open';
  const sort = params.get('sort') || 'updated';
  const dir = params.get('dir') || 'desc';
  const label = isPR ? '' : (params.get('label') || '');
  const page = Math.max(1, Number(params.get('page') || 1));
  const per = 40;

  document.title = (isPR ? 'Pull requests' : 'Issues') + ' · ' + o + '/' + r;

  let repo, list, labels = [];
  try {
    repo = await getRepo(o, r);
    const jobs = [
      gh('/repos/' + o + '/' + r + '/' + (isPR ? 'pulls' : 'issues') +
        '?state=' + state + '&per_page=' + per + '&page=' + page +
        '&sort=' + sort + '&direction=' + dir +
        (label ? '&labels=' + encodeURIComponent(label) : ''))
    ];
    if (!isPR) jobs.push(gh('/repos/' + o + '/' + r + '/labels?per_page=100').catch(() => []));
    const out = await Promise.all(jobs);
    list = out[0];
    labels = out[1] || [];
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取列表', e.message);
    return;
  }

  const items = isPR ? list : list.filter((x) => !x.pull_request);
  const base = link(o, r, isPR ? 'pulls' : 'issues');

  const mk = (patch) => {
    const cur = { state: state, sort: sort, dir: dir, label: label, page: page > 1 ? String(page) : '' };
    Object.keys(patch).forEach((k) => { cur[k] = patch[k]; });
    const np = new URLSearchParams();
    Object.keys(cur).forEach((k) => { if (cur[k]) np.set(k, cur[k]); });
    return base + '?' + np.toString();
  };

  const hasNext = list.length >= per;
  const pager = (page > 1 || hasNext) ? '<div class="pager">' +
    (page > 1
      ? '<a class="btn sm" href="' + mk({ page: page > 2 ? String(page - 1) : '' }) + '">上一页</a>'
      : '<span class="btn sm ghost disabled">上一页</span>') +
    '<span class="dim">第 ' + page + ' 页</span>' +
    (hasNext
      ? '<a class="btn sm" href="' + mk({ page: String(page + 1) }) + '">下一页</a>'
      : '<span class="btn sm ghost disabled">下一页</span>') +
    '</div>' : '';

  const sortSel = '<label class="filt"><span>排序</span><select id="i-sort">' +
    [['updated', '最近更新'], ['created', '最新创建'], ['comments', '评论最多']]
      .map(([v, t]) => '<option value="' + v + '"' + (v === sort ? ' selected' : '') + '>' + t + '</option>')
      .join('') + '</select></label>' +
    '<label class="filt"><span>顺序</span><select id="i-dir">' +
    [['desc', '降序'], ['asc', '升序']]
      .map(([v, t]) => '<option value="' + v + '"' + (v === dir ? ' selected' : '') + '>' + t + '</option>')
      .join('') + '</select></label>';

  const labelSel = isPR ? '' :
    '<label class="filt"><span>标签</span><select id="i-label"><option value="">全部</option>' +
    labels.slice(0, 80).map((l) =>
      '<option value="' + esc(l.name) + '"' + (l.name === label ? ' selected' : '') + '>' +
      esc(l.name) + '</option>').join('') + '</select></label>';

  app.innerHTML = repoHeader(repo, isPR ? 'pulls' : 'issues') + `
    <div class="panel">
      <div class="panel-head">
        <a class="btn sm ${state === 'open' ? 'primary' : 'ghost'}" href="${mk({ state: 'open', page: '' })}">打开</a>
        <a class="btn sm ${state === 'closed' ? 'primary' : 'ghost'}" href="${mk({ state: 'closed', page: '' })}">已关闭</a>
        ${canWrite() ? '<button type="button" class="btn sm" id="newIt">' + (isPR ? '新建 PR' : '新建 Issue') + '</button>' : ''}
        <span class="spacer"></span>
        <span class="dim">${items.length} 条</span>
      </div>
      <div class="filter-bar">${sortSel}${labelSel}</div>
      ${items.length ? items.map((it) => issueRow(it, isPR)).join('') : '<div class="empty">没有记录</div>'}
    </div>
    ${pager}`;

  app.querySelectorAll('.issue-row[data-href]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = el.getAttribute('data-href'); });
  });

  const apply = (key, val) => {
    const patch = {};
    patch[key] = val;
    if (key !== 'page') patch.page = '';
    location.hash = mk(patch);
  };
  const s1 = $('#i-sort');
  if (s1) s1.addEventListener('change', () => apply('sort', s1.value));
  const s2 = $('#i-dir');
  if (s2) s2.addEventListener('change', () => apply('dir', s2.value));
  const s3 = $('#i-label');
  if (s3) s3.addEventListener('change', () => apply('label', s3.value));

  const ni = $('#newIt');
  if (ni) {
    ni.addEventListener('click', () => {
      if (isPR) openNewPrDialog(o, r, repo.default_branch);
      else openNewIssueDialog(o, r);
    });
  }
}

function issueRow(it, isPR) {
  const merged = it.pull_request && it.pull_request.merged_at;
  const color = it.state === 'open' ? 'var(--green)' : (merged ? 'var(--purple)' : 'var(--fg-subtle)');
  const fo = it.html_url.replace('https://github.com/', '').split('/');
  const href = link(fo[0], fo[1], isPR ? 'pull' : 'issue', it.number);
  return `<div class="issue-row" data-href="${esc(href)}">
    <span class="i-ico" style="color:${color}">${isPR ? ICON.pr : ICON.issue}</span>
    <div class="i-main">
      <div class="i-title">${esc(it.title)}
        ${(it.labels || []).slice(0, 4).map(l =>
          `<span class="label-chip" style="background:#${esc(l.color)}1f;color:#${esc(l.color)};border-color:#${esc(l.color)}55">${esc(l.name)}</span>`
        ).join('')}
      </div>
      <div class="i-sub">#${it.number} · ${esc(it.user ? it.user.login : '?')} 更新于 ${timeAgo(it.updated_at)}</div>
    </div>
    ${it.comments ? `<span class="i-count">${ICON.comment} ${it.comments}</span>` : ''}
  </div>`;
}

async function viewIssue(o, r, n, isPR) {
  loading();
  const base = '/repos/' + o + '/' + r + '/' + (isPR ? 'pulls' : 'issues') + '/' + n;
  let repo, issue, comments;
  try {
    repo = await getRepo(o, r);
    [issue, comments] = await Promise.all([
      gh(base),
      gh(base + '/comments?per_page=100')
    ]);
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取', e.message);
    return;
  }
  document.title = '#' + n + ' ' + issue.title;

  const ctx = { owner: o, repo: r, ref: repo.default_branch, baseDir: '' };
  const merged = !!issue.merged_at;
  const stateCls = issue.state === 'open' ? 'open' : (merged ? 'merged' : 'closed');
  const stateTxt = issue.state === 'open' ? 'Open' : (merged ? 'Merged' : 'Closed');

  let filesPanel = '';
  if (isPR) {
    try {
      const files = await gh(base + '/files?per_page=100');
      const headSha = issue.head ? issue.head.sha : repo.default_branch;
      filesPanel = `<div class="panel"><div class="panel-head">改动文件 ${files.length} 个</div>
        ${files.map(f => `<div class="file-row" data-href="${link(o, r, 'blob', headSha, f.filename)}">
          ${ICON.file}<span class="fname-wrap"><span class="fname">${esc(f.filename)}</span></span>
          <span class="fmsg"></span>
          <span class="fsize"><span style="color:var(--green)">+${f.additions}</span> <span style="color:var(--red)">−${f.deletions}</span></span>
        </div>`).join('')}</div>`;
    } catch (_) {}
  }

  const commentsHtml = comments.map((c, i) => `
    <div class="timeline-item">
      <div class="t-avatar">${avatar(c.user ? c.user.avatar_url : '', 32)}</div>
      <div class="t-body">
        <div class="t-head"><b>${esc(c.user ? c.user.login : '?')}</b> 评论于 ${fmtDate(c.created_at)}
          <a class="t-link" href="${esc(c.html_url)}" target="_blank" rel="noopener">#${i + 1}</a></div>
        <div class="t-content markdown-body" data-cmt="${i}"></div>
      </div>
    </div>`).join('');

  app.innerHTML = repoHeader(repo, isPR ? 'pulls' : 'issues') + `
    <div class="issue-head">
      <h1>${esc(issue.title)} <span class="dim" style="font-weight:300">#${n}</span></h1>
      <div class="issue-sub">
        <span class="badge ${stateCls}">${stateTxt}</span>
        ${(issue.labels || []).map(l =>
          `<span class="label-chip" style="background:#${esc(l.color)}1f;color:#${esc(l.color)};border-color:#${esc(l.color)}55">${esc(l.name)}</span>`
        ).join('')}
        <span class="dim">${esc(issue.user ? issue.user.login : '?')} 创建于 ${fmtDate(issue.created_at)} · ${issue.comments} 条评论</span>
      </div>
    </div>
    <div class="timeline-item">
      <div class="t-avatar">${avatar(issue.user ? issue.user.avatar_url : '', 32)}</div>
      <div class="t-body">
        <div class="t-head"><b>${esc(issue.user ? issue.user.login : '?')}</b> 发表于 ${fmtDate(issue.created_at)}</div>
        <div class="t-content markdown-body" id="issueBody">${renderMarkdown(issue.body || '_（无正文）_', ctx).innerHTML}</div>
      </div>
    </div>
    ${commentsHtml}${filesPanel}
    ${issueWriteBox(issue, n)}`;

  attachBlockTranslate($('#issueBody'), issue.body || '', ctx, 'issue:' + o + '/' + r + '#' + n);

  comments.forEach((c, i) => {
    const el = app.querySelector('[data-cmt="' + i + '"]');
    if (el) {
      el.innerHTML = renderMarkdown(c.body || '', ctx).innerHTML;
      attachBlockTranslate(el, c.body || '', ctx, 'cmt:' + (c.id || o + '/' + r + '#' + n + ':' + i));
    }
  });
  bindFileRows();
  bindIssueWrite(o, r, n, issue);
}

/* ---------------------------- Releases / Commits / Branches ---------------------------- */

async function viewReleases(o, r) {
  loading();
  let repo, rels;
  try {
    repo = await getRepo(o, r);
    rels = await gh('/repos/' + o + '/' + r + '/releases?per_page=30');
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取发行版', e.message);
    return;
  }
  document.title = '发行版 · ' + o + '/' + r;
  const ctx = { owner: o, repo: r, ref: repo.default_branch, baseDir: '' };

  app.innerHTML = repoHeader(repo, 'releases') + `
    <div class="panel">
      <div class="panel-head">共 ${rels.length} 个发行版
        <span class="spacer"></span>
        ${canWrite() ? '<button type="button" class="btn sm primary" id="newRel">新建发行版</button>' : ''}
      </div>
      ${rels.length ? rels.map(rel => `
        <div class="release-item">
          <div class="rel-head">
            <span class="rel-ico">${ICON.tag}</span>
            <b>${esc(rel.name || rel.tag_name)}</b>
            ${rel.prerelease ? '<span class="badge">预发行</span>' : ''}
            ${rel.draft ? '<span class="badge draft">草稿</span>' : ''}
            <span class="spacer"></span>
            <span class="dim">${fmtDate(rel.published_at)}</span>
            <a class="btn sm ghost" href="${link(o, r, 'tree', rel.tag_name, '')}">浏览代码</a>
            <button type="button" class="btn sm primary rel-zip"
              data-url="https://codeload.github.com/${o}/${r}/zip/${encodeURIComponent(rel.tag_name)}"
              data-name="${esc(o + '-' + r + '-' + rel.tag_name + '.zip')}">${ICON.download} ZIP</button>
            ${canWrite() ? `<button type="button" class="btn sm ghost rel-del" data-id="${rel.id}" data-name="${esc(rel.name || rel.tag_name)}">删除</button>` : ''}
          </div>
          ${rel.body ? `<div class="rel-body markdown-body" data-rel="${rel.id}">${renderMarkdown(rel.body, ctx).innerHTML}</div>` : ''}
          ${(rel.assets || []).length ? `<div class="rel-assets">
            ${rel.assets.map(a => `<button type="button" class="asset" data-asset
              data-url="${esc(a.browser_download_url)}" data-name="${esc(a.name)}" data-size="${a.size || 0}">
              ${ICON.download} ${esc(a.name)} <span class="dim">${fmtSize(a.size)} · ${fmtNum(a.download_count)} 次</span></button>`).join('')}
          </div>` : ''}
        </div>`).join('') : '<div class="empty">暂无发行版</div>'}
    </div>`;

  rels.forEach((rel) => {
    const el = app.querySelector('[data-rel="' + rel.id + '"]');
    if (el) {
      attachBlockTranslate(el, rel.body || '',
        { owner: o, repo: r, ref: rel.tag_name || repo.default_branch, baseDir: '' },
        'rel:' + rel.id);
    }
  });

  const nrel = $('#newRel');
  if (nrel) {
    nrel.addEventListener('click', () => openNewReleaseDialog(o, r, repo.default_branch));
  }
  app.querySelectorAll('.rel-del').forEach((b) => {
    b.addEventListener('click', () => deleteRelease(o, r, b.getAttribute('data-id'), b.getAttribute('data-name'), b));
  });
  app.querySelectorAll('[data-asset]').forEach((b) => {
    b.addEventListener('click', () => {
      openAssetDownloadDialog(b.dataset.name, Number(b.dataset.size) || 0, b.dataset.url, 'asset');
    });
  });
  app.querySelectorAll('.rel-zip').forEach((b) => {
    b.addEventListener('click', () => {
      openAssetDownloadDialog(b.dataset.name, 0, b.dataset.url, 'zip');
    });
  });
}

async function viewCommits(o, r, ref, page) {
  loading();
  page = Math.max(1, Number(page || 1));
  const per = 50;

  let repo, commits;
  try {
    repo = await getRepo(o, r);
    commits = await gh('/repos/' + o + '/' + r + '/commits?per_page=' + per + '&page=' + page +
      (ref ? '&sha=' + encodeURIComponent(ref) : ''));
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取提交', e.message);
    return;
  }
  document.title = '提交 · ' + o + '/' + r;

  const branch = ref || repo.default_branch;
  const base = link(o, r, 'commits', branch);
  const mk = (p) => base + (p > 1 ? '?page=' + p : '');
  const hasNext = commits.length >= per;
  const pager = (page > 1 || hasNext) ? '<div class="pager">' +
    (page > 1
      ? '<a class="btn sm" href="' + mk(page - 1) + '">上一页</a>'
      : '<span class="btn sm ghost disabled">上一页</span>') +
    '<span class="dim">第 ' + page + ' 页</span>' +
    (hasNext
      ? '<a class="btn sm" href="' + mk(page + 1) + '">下一页</a>'
      : '<span class="btn sm ghost disabled">下一页</span>') +
    '</div>' : '';

  app.innerHTML = repoHeader(repo, 'commits') + `
    <div class="panel">
      <div class="panel-head">${ICON.branch} ${esc(branch)} · 本页 ${commits.length} 次提交</div>
      ${commits.map(c => `<div class="commit-row" data-href="${link(o, r, 'commit', c.sha)}">
        ${avatar(c.author ? c.author.avatar_url : '', 26)}
        <div class="cm-main">
          <div class="cm-msg">${esc(c.commit.message.split('\n')[0])}</div>
          <div class="cm-sub">${esc(c.commit.author.name)} · ${timeAgo(c.commit.author.date)}</div>
        </div>
        <span class="mono dim">${esc(c.sha.slice(0, 7))}</span>
      </div>`).join('')}
    </div>${pager}`;

  app.querySelectorAll('.commit-row').forEach(el => {
    el.addEventListener('click', () => { location.hash = el.getAttribute('data-href'); });
  });
}

function viewCommit(o, r, sha) {
  loading();
  return gh('/repos/' + o + '/' + r + '/commits/' + sha).then(c => {
    return getRepo(o, r).then(repo => {
      document.title = sha.slice(0, 7) + ' · ' + o + '/' + r;
      app.innerHTML = repoHeader(repo, 'commits') + `
        <div class="panel">
          <div class="panel-head">
            ${avatar(c.author ? c.author.avatar_url : '', 22)}
            <b class="strong">${esc(c.commit.author.name)}</b>
            <span class="dim">${timeAgo(c.commit.author.date)}</span>
            <span class="spacer"></span>
            <span class="mono dim">${esc(c.sha)}</span>
          </div>
          <div class="readme-box"><pre class="commit-msg">${esc(c.commit.message)}</pre></div>
        </div>
        <div class="panel">
          <div class="panel-head">改动 ${(c.files || []).length} 个文件</div>
          ${(c.files || []).map(f => `<div class="file-row" style="cursor:default">
            ${ICON.file}<span class="fname-wrap"><span class="fname">${esc(f.filename)}</span></span>
            <span class="fmsg">${esc(f.status || '')}</span>
            <span class="fsize"><span style="color:var(--green)">+${f.additions}</span> <span style="color:var(--red)">−${f.deletions}</span></span>
          </div>`).join('')}
        </div>`;
    });
  }).catch(e => {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取提交', e.message);
  });
}

async function viewBranches(o, r) {
  loading();
  let repo, branches;
  try {
    repo = await getRepo(o, r);
    branches = await gh('/repos/' + o + '/' + r + '/branches?per_page=100');
  } catch (e) {
    app.innerHTML = repoHeaderLite(o, r) + errorBox('无法读取分支', e.message);
    return;
  }
  document.title = '分支 · ' + o + '/' + r;

  app.innerHTML = repoHeader(repo, 'branches') + `
    <div class="panel">
      <div class="panel-head">共 ${branches.length} 个分支</div>
      ${branches.map(b => `<div class="file-row" data-href="${link(o, r, 'tree', b.name, '')}">
        ${ICON.branch}
        <span class="fname-wrap"><span class="fname">${esc(b.name)}${b.name === repo.default_branch ? ' <span class="badge">默认</span>' : ''}</span></span>
        <span class="fmsg mono dim">${esc(b.commit.sha.slice(0, 7))}</span>
      </div>`).join('')}
    </div>`;
  bindFileRows();
}

/* ---------------------------- 用户 ---------------------------- */

async function viewUser(login) {
  loading();
  let u, repos;

  // 先看是不是本人：本人要走 /user/repos，否则 /users/... 只返回公开仓库
  let isMe = false;
  if (TOKEN) {
    try {
      const m = await me();
      isMe = String(m.login).toLowerCase() === String(login).toLowerCase();
    } catch (_) {}
  }

  try {
    u = await gh('/users/' + encodeURIComponent(login));
    repos = isMe
      ? await gh('/user/repos?sort=pushed&per_page=100&affiliation=owner')
      : await gh('/users/' + encodeURIComponent(login) + '/repos?sort=pushed&per_page=100');
  } catch (e) {
    app.innerHTML = errorBox('无法读取用户', e.message);
    return;
  }
  document.title = u.login + ' · GitHub';
  repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  app.innerHTML = `
    <div class="profile">
      ${avatar(u.avatar_url, 104)}
      <div class="p-info">
        <h1>${esc(u.name || u.login)}</h1>
        <div class="login">${esc(u.login)}${isMe ? ' <span class="badge">本人</span>' : ''}</div>
        ${u.bio ? `<div class="p-bio">${esc(u.bio)}</div>` : ''}
        <div class="p-stats">
          <span><b>${fmtNum(u.public_repos)}</b> 仓库</span>
          <span><b>${fmtNum(u.followers)}</b> 关注者</span>
          <span><b>${fmtNum(u.following)}</b> 正在关注</span>
          ${u.location ? `<span>${esc(u.location)}</span>` : ''}
          ${u.blog ? `<span>${ICON.link}<a href="${esc(u.blog)}" target="_blank" rel="noopener">${esc(u.blog)}</a></span>` : ''}
          <span>加入于 ${fmtDate(u.created_at)}</span>
        </div>
        ${srcLink('https://github.com/' + encodeURIComponent(u.login))}
        ${isMe && canWrite() ? '<div class="repo-actions"><button type="button" class="btn primary" id="newRepo">新建仓库</button></div>' : ''}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">${isMe ? '我的仓库' : '公开仓库'} · ${repos.length}</div>
      ${repos.length ? repos.map(repoCard).join('') : '<div class="empty">' + (isMe ? '没有仓库' : '没有公开仓库') + '</div>'}
    </div>`;

  const nr = $('#newRepo');
  if (nr) nr.addEventListener('click', openNewRepoDialog);
}

/* ---------------------------- 搜索 ---------------------------- */

/* ---------------------------- 搜索 ---------------------------- */

const SEARCH_LANGS = [
  ['', '任意语言'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
  ['python', 'Python'], ['java', 'Java'], ['go', 'Go'], ['rust', 'Rust'],
  ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['php', 'PHP'], ['ruby', 'Ruby'],
  ['swift', 'Swift'], ['kotlin', 'Kotlin'], ['dart', 'Dart'], ['shell', 'Shell'],
  ['html', 'HTML'], ['css', 'CSS'], ['vue', 'Vue'], ['lua', 'Lua'], ['r', 'R']
];

/** 相对时间 → 具体日期，用于 pushed:>= 限定 */
function pushedDate(v) {
  if (!v) return '';
  const d = new Date();
  if (v === 'week') d.setDate(d.getDate() - 7);
  else if (v === 'month') d.setMonth(d.getMonth() - 1);
  else if (v === 'year') d.setFullYear(d.getFullYear() - 1);
  else return '';
  return d.toISOString().slice(0, 10);
}

/** 把界面上的筛选条件拼成 GitHub 的检索语法 */
function composeSearchQuery(base, type, f) {
  const src = String(base || '').trim();
  const has = (k) => new RegExp('(^|\\s)' + k + ':', 'i').test(src);
  const out = [src];
  const add = (k, v) => {
    if (v && !has(k)) out.push(k + ':' + v);
  };

  if (type === 'repositories' || type === 'code') add('language', f.lang);

  if (type === 'repositories') {
    // GitHub 没有“有 APK”限定符，用 topic 近似：android-app / f-droid / android
    if (f.android) add('topic', f.android);
    if (f.stars) add('stars', '>=' + f.stars);
    const d = pushedDate(f.pushed);
    if (d) add('pushed', '>=' + d);
  }

  if (type === 'code') {
    if (f.repo.trim()) add('repo', f.repo.trim());
    if (f.path.trim()) add('path', f.path.trim());
  }

  if (type === 'users') {
    add('type', f.utype);
    if (f.repos) add('repos', '>=' + f.repos);
  }

  if (type === 'issues') {
    add('state', f.state);
    if (f.kind === 'issue') add('is', 'issue');
    if (f.kind === 'pr') add('is', 'pr');
    if (f.label.trim()) out.push('label:"' + f.label.trim().replace(/"/g, '') + '"');
  }

  return out.filter(Boolean).join(' ');
}

function searchFilterBar(type, f, prefix) {
  const p = prefix || 'f-';
  const opt = (v, t, cur) =>
    '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>';
  const box = (label, control) =>
    '<label class="filt"><span>' + label + '</span>' + control + '</label>';
  const select = (name, pairs, cur) =>
    '<select id="' + p + name + '">' + pairs.map(([v, t]) => opt(v, t, cur)).join('') + '</select>';
  const input = (name, ph, cur) =>
    '<input id="' + p + name + '" type="text" placeholder="' + esc(ph) + '" value="' + esc(cur) + '">';

  const parts = [];

  if (type === 'repositories') {
    parts.push(box('排序', select('sort', [
      ['', '最佳匹配'], ['stars', 'Star 最多'], ['forks', 'Fork 最多'],
      ['updated', '最近更新'], ['help-wanted-issues', '待协助最多']
    ], f.sort)));
    parts.push(box('语言', select('lang', SEARCH_LANGS, f.lang)));
    parts.push(box('Android', select('android', [
      ['', '不限'], ['android-app', 'Android 应用'], ['f-droid', 'F-Droid 应用'], ['android', 'Android 项目']
    ], f.android)));
    parts.push(box('Star', select('stars', [
      ['', '不限'], ['50', '≥ 50'], ['500', '≥ 500'], ['5000', '≥ 5000'], ['20000', '≥ 2 万']
    ], f.stars)));
    parts.push(box('更新', select('pushed', [
      ['', '不限'], ['week', '一周内'], ['month', '一月内'], ['year', '一年内']
    ], f.pushed)));
  } else if (type === 'code') {
    parts.push(box('语言', select('lang', SEARCH_LANGS, f.lang)));
    parts.push(box('限定仓库', input('repo', 'owner/repo', f.repo)));
    parts.push(box('路径', input('path', 'src/components', f.path)));
  } else if (type === 'users') {
    parts.push(box('排序', select('sort', [
      ['', '最佳匹配'], ['followers', '关注者最多'], ['repositories', '仓库最多'], ['joined', '最近加入']
    ], f.sort)));
    parts.push(box('类型', select('utype', [
      ['', '不限'], ['user', '用户'], ['org', '组织']
    ], f.utype)));
    parts.push(box('仓库数', select('repos', [
      ['', '不限'], ['10', '≥ 10'], ['50', '≥ 50'], ['200', '≥ 200']
    ], f.repos)));
  } else if (type === 'issues') {
    parts.push(box('排序', select('sort', [
      ['', '最佳匹配'], ['comments', '评论最多'], ['created', '最新创建'], ['updated', '最近更新']
    ], f.sort)));
    parts.push(box('状态', select('state', [
      ['', '不限'], ['open', '打开'], ['closed', '已关闭']
    ], f.state)));
    parts.push(box('类型', select('kind', [
      ['', '议题和 PR'], ['issue', '仅议题'], ['pr', '仅 PR']
    ], f.kind)));
    parts.push(box('标签', input('label', 'bug', f.label)));
  }

  return '<div class="filter-bar">' + parts.join('') + '</div>';
}

/** 筛选控件改动后写回 URL，交给路由重绘 */
function bindSearchFilters() {
  const map = {
    'f-sort': 'sort', 'f-lang': 'lang', 'f-android': 'android', 'f-stars': 'stars', 'f-pushed': 'pushed',
    'f-repo': 'repo', 'f-path': 'path', 'f-utype': 'utype', 'f-repos': 'repos',
    'f-state': 'state', 'f-kind': 'kind', 'f-label': 'label'
  };
  Object.keys(map).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const apply = () => {
      const raw = location.hash.replace(/^#/, '');
      const idx = raw.indexOf('?');
      const params = new URLSearchParams(idx >= 0 ? raw.slice(idx + 1) : '');
      const v = String(el.value || '').trim();
      if (v) params.set(map[id], v);
      else params.delete(map[id]);
      params.delete('page');
      location.hash = '#/search?' + params.toString();
    };
    el.addEventListener('change', apply);
    if (el.tagName === 'INPUT') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); }
      });
    }
  });
}

/** 从检索式里取出裸关键词，用于命中高亮 */
function searchTerms(q) {
  return String(q || '').split(/\s+/)
    .filter((t) => t && t.indexOf(':') < 0 && t.length >= 2)
    .slice(0, 5);
}

function highlightTerms(text, terms) {
  let s = esc(text);
  (terms || []).forEach((t) => {
    const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      s = s.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
    } catch (_) {}
  });
  return s;
}

/** 搜索结果分页。GitHub 检索最多能翻到第 1000 条 */
function searchPager(params, page, total) {
  const per = 30;
  const maxPage = Math.min(34, Math.max(1, Math.ceil(Math.min(total, 1000) / per)));
  if (maxPage <= 1) return '';

  const mk = (p) => {
    const np = new URLSearchParams(params.toString());
    np.set('page', String(p));
    return '#/search?' + np.toString();
  };
  const prev = page > 1
    ? '<a class="btn sm" href="' + mk(page - 1) + '">上一页</a>'
    : '<span class="btn sm ghost disabled">上一页</span>';
  const next = page < maxPage
    ? '<a class="btn sm" href="' + mk(page + 1) + '">下一页</a>'
    : '<span class="btn sm ghost disabled">下一页</span>';

  return '<div class="pager">' + prev +
    '<span class="dim">第 ' + page + ' / ' + maxPage + ' 页</span>' + next + '</div>';
}

async function viewSearch(q, type, params) {
  type = type || 'repositories';
  if (!q) { location.hash = '#/'; return; }
  params = params || new URLSearchParams();

  const f = {
    sort: params.get('sort') || '',
    order: params.get('order') || 'desc',
    lang: params.get('lang') || '',
    android: params.get('android') || '',
    stars: params.get('stars') || '',
    pushed: params.get('pushed') || '',
    repo: params.get('repo') || '',
    path: params.get('path') || '',
    label: params.get('label') || '',
    utype: params.get('utype') || '',
    repos: params.get('repos') || '',
    state: params.get('state') || '',
    kind: params.get('kind') || ''
  };
  const page = Math.max(1, Number(params.get('page') || 1));

  document.title = q + ' · 搜索';
  loading();

  const query = composeSearchQuery(q, type, f);
  const per = 30;
  const qs = '?q=' + encodeURIComponent(query) + '&per_page=' + per + '&page=' + page;
  const sortQs = f.sort ? '&sort=' + encodeURIComponent(f.sort) + '&order=' + f.order : '';

  let body = '';
  let total = 0;

  try {
    if (type === 'code') {
      if (!TOKEN) throw new Error('代码搜索需要授权令牌');
      const res = await gh('/search/code' + qs + sortQs,
        { accept: 'application/vnd.github.text-match+json' });
      total = res.total_count;
      const terms = searchTerms(q);
      body = '<div class="panel"><div class="panel-head">' + fmtNum(total) + ' 个文件</div>' +
        (res.items.map((it) => {
          const parts = it.repository.full_name.split('/');
          const frag = (it.text_matches || [])[0];
          return '<div class="code-hit" data-href="' +
            link(parts[0], parts[1], 'blob', 'HEAD', it.path) + '">' +
            '<div class="ch-top">' + ICON.file + '<b>' + esc(it.name) + '</b>' +
            '<span class="dim">' + esc(it.repository.full_name) + ' · ' + esc(it.path) + '</span></div>' +
            (frag ? '<pre class="ch-frag">' +
              highlightTerms(String(frag.fragment || '').slice(0, 400), terms) + '</pre>' : '') +
            '</div>';
        }).join('') || '<div class="empty">没有结果</div>') + '</div>';
    } else if (type === 'users') {
      const res = await gh('/search/users' + qs + sortQs);
      total = res.total_count;
      body = '<div class="panel"><div class="panel-head">' + fmtNum(total) + ' 个用户</div>' +
        (res.items.map((u) => '<div class="file-row" data-href="#/u/' + encodeURIComponent(u.login) + '">' +
          avatar(u.avatar_url, 26) +
          '<span class="fname-wrap"><span class="fname">' + esc(u.login) + '</span></span>' +
          '<span class="fmsg">' + esc(u.type || '') + '</span></div>').join('') ||
          '<div class="empty">没有结果</div>') + '</div>';
    } else if (type === 'issues') {
      const res = await gh('/search/issues' + qs + sortQs);
      total = res.total_count;
      body = '<div class="panel"><div class="panel-head">' + fmtNum(total) + ' 个议题</div>' +
        (res.items.map((it) => {
          const fo = it.repository_url.split('/').slice(-2);
          return '<div class="file-row" data-href="' +
            link(fo[0], fo[1], it.pull_request ? 'pull' : 'issue', it.number) + '">' +
            (it.pull_request ? ICON.pr : ICON.issue) +
            '<span class="fname-wrap"><span class="fname">' + esc(it.title) + '</span></span>' +
            '<span class="fmsg">' + esc(fo[0] + '/' + fo[1]) + ' #' + it.number + '</span>' +
            '<span class="badge ' + (it.state === 'open' ? 'open' : 'closed') + '">' +
            esc(it.state === 'open' ? '打开' : '已关闭') + '</span></div>';
        }).join('') || '<div class="empty">没有结果</div>') + '</div>';
    } else {
      const res = await gh('/search/repositories' + qs + sortQs);
      total = res.total_count;
      body = '<div class="panel"><div class="panel-head">' + fmtNum(total) + ' 个仓库</div>' +
        (res.items.map(repoCard).join('') || '<div class="empty">没有结果</div>') + '</div>';
    }
  } catch (e) {
    body = errorBox('搜索失败', e.message);
  }

  const tabs = [['repositories', '仓库'], ['code', '代码'], ['users', '用户'], ['issues', '议题']];
  const tabHtml = '<div class="repo-tabs">' + tabs.map(([k, label]) => {
    const np = new URLSearchParams(params.toString());
    np.set('type', k);
    np.delete('page');
    return '<a href="#/search?' + np.toString() + '" class="' + (type === k ? 'on' : '') + '">' +
      label + '</a>';
  }).join('') + '</div>';

  app.innerHTML =
    '<h2 class="page-title">“' + esc(q) + '” 的搜索结果</h2>' +
    '<div class="search-summary dim">实际检索：<code>' + esc(query) + '</code></div>' +
    tabHtml + searchFilterBar(type, f) + body + searchPager(params, page, total);

  bindFileRows();
  app.querySelectorAll('.code-hit').forEach((el) => {
    el.addEventListener('click', () => { location.hash = el.getAttribute('data-href'); });
  });
  bindSearchFilters();
}

/* ---------------------------- 我的 ---------------------------- */

async function viewMe() {
  loading();
  if (!TOKEN) {
    app.innerHTML = errorBox('未设置访问令牌', '要查看自己的仓库与收藏，需要先填入 GitHub Token。', '')
      .replace(/<button class="btn" onclick="location.reload\(\)">重试<\/button>/,
        '<button class="btn primary" onclick="openSettings()">立即设置</button>');
    return;
  }
  try {
    const u = await me();
    const [repos, starred] = await Promise.all([
      gh('/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member'),
      gh('/user/starred?per_page=40').catch(() => [])
    ]);
    document.title = u.login + ' · 我的';
    app.innerHTML = `
      <div class="profile">
        ${avatar(u.avatar_url, 72)}
        <div class="p-info">
          <h1>${esc(u.name || u.login)}</h1>
          <div class="login">${esc(u.login)}</div>
          <div class="p-stats">
            <span><b>${fmtNum(u.public_repos)}</b> 公开仓库</span>
            <span><b>${fmtNum(u.followers)}</b> 关注者</span>
            <a href="#/u/${encodeURIComponent(u.login)}">公开主页 →</a>
          </div>
          ${canWrite() ? '<div class="repo-actions"><button type="button" class="btn primary" id="newRepo">新建仓库</button></div>' : ''}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">我的仓库 · ${repos.length}</div>
        ${repos.length ? repos.map(repoCard).join('') : '<div class="empty">没有仓库</div>'}
      </div>
      <div class="panel">
        <div class="panel-head">已 Star · ${starred.length}</div>
        ${starred.length ? starred.map(repoCard).join('') : '<div class="empty">还没有收藏</div>'}
      </div>`;

    const nr = $('#newRepo');
    if (nr) nr.addEventListener('click', openNewRepoDialog);
  } catch (e) {
    app.innerHTML = errorBox('无法读取账户', e.message);
  }
}

/* ---------------------------- 下载与加速 ---------------------------- */

async function viewTools(o, r, ref) {
  document.title = '通路与下载';
  if (!channelOrder.length) {
    loading();
    await ensureChannels();
  }
  const has = !!(o && r);
  const f = ref || 'HEAD';
  const repoUrl = has ? `https://github.com/${o}/${r}` : 'https://github.com/OWNER/REPO';
  const rawBase = `https://raw.githubusercontent.com/${has ? o + '/' + r : 'OWNER/REPO'}/${f}/PATH`;

  const row = (tag, val, extra) => `
    <div class="copy-row">
      <span class="tag">${tag}</span>
      <input readonly value="${esc(val)}">
      <button class="btn" data-copy>复制</button>${extra || ''}
    </div>`;

  const chRows = allChannels().map(ch => {
    const st = channelStatus[ch.id];
    const dot = !st ? 'var(--fg-subtle)' : (st.quota > 0 ? 'var(--green)' : 'var(--yellow)');
    const tail = !st ? '不可用'
      : st.ms + ' ms · ' + (st.quota > 0 ? '余 ' + st.quota : '额度已耗尽');
    return `<div class="ch-row">
      <span class="ch-dot" style="background:${dot}"></span>
      <b>${esc(ch.label)}</b>
      <span class="dim">${esc(ch.note)}</span>
      <span class="spacer"></span>
      <span class="mono dim">${esc(tail)}</span>
    </div>`;
  }).join('');

  app.innerHTML = `
  <h2 class="page-title">通路与下载</h2>
  <p class="lead">同一个请求有多条通路可选，客户端会挑当前能用的那条，并记住结果。</p>

  <div class="tool-card">
    <h3>通道路由</h3>
    <p class="hint">按「直连 → 自建中转 → 公共中转」的优先级探测，任一失败自动换下一条。</p>
    ${chRows}
    <div class="copy-row" style="margin-top:10px">
      <button class="btn" id="reprobe">重新探测</button>
      <button class="btn" id="gotoSettings">配置自建中转</button>
    </div>
  </div>

  <div class="tool-card">
    <h3>归档包</h3>
    <p class="hint">官方 codeload 通道通常最快；不通时可走中转前缀。</p>
    ${row('ZIP', has ? `https://codeload.github.com/${o}/${r}/zip/${f}` : 'https://codeload.github.com/OWNER/REPO/zip/HEAD',
      has ? `<a class="btn primary" href="https://codeload.github.com/${o}/${r}/zip/${encodeURIComponent(f)}">下载</a>` : '')}
    ${row('ZIP 中转', `https://gh-proxy.org/https://github.com/${has ? o + '/' + r : 'OWNER/REPO'}/archive/refs/heads/${f}.zip`)}
    ${row('TAR.GZ', has ? `https://codeload.github.com/${o}/${r}/tar.gz/${f}` : 'https://codeload.github.com/OWNER/REPO/tar.gz/HEAD')}
  </div>

  <div class="tool-card">
    <h3>git clone</h3>
    <p class="hint">GitHub 的 git 端点在部分网络下不可达，可加前缀。国内网络建议第一条。</p>
    ${row('中转 1', `git clone https://gh-proxy.org/${repoUrl}.git`)}
    ${row('中转 2', `git clone https://ghfast.top/${repoUrl}.git`)}
    ${row('原地址', `git clone ${repoUrl}.git`)}
  </div>

  <div class="tool-card">
    <h3>下载指定文件</h3>
    <p class="hint">粘贴文件链接（github.com 的 blob 页或 raw 链接），或手动填下方字段，客户端会并行探测并挑最快通道下载到本机。</p>
    <div class="dl-form">
      <input id="dlUrl" type="text" placeholder="粘贴文件链接，或 owner/repo@ref/path" spellcheck="false">
      <button class="btn" id="dlParse">解析</button>
    </div>
    <div class="dl-form">
      <input id="dlOwn" type="text" placeholder="owner/repo" spellcheck="false" value="${has ? esc(o + '/' + r) : ''}">
      <input id="dlRef" type="text" placeholder="分支/标签（默认 main）" spellcheck="false" value="${has ? esc(f) : ''}">
      <input id="dlPath" type="text" placeholder="文件路径，如 src/app.js" spellcheck="false">
    </div>
    <div class="dl-form">
      <input id="dlName" type="text" placeholder="保存文件名（留空取路径末段）" spellcheck="false">
      <button class="btn primary" id="dlGo">下载文件</button>
    </div>
    <div id="dlTip" class="dim" style="font-size:12px;margin-top:6px"></div>
    ${row('直连', rawBase)}
  </div>

  <div class="tool-card">
    <h3>下载位置</h3>
    <p class="hint" id="dlWhereHint" style="margin-bottom:8px">正在读取…</p>
    <div class="modal-actions" style="margin-top:0">
      <button class="btn sm" id="dlOpenDir">打开下载目录</button>
      <button class="btn sm ghost" id="dlRefresh">刷新记录</button>
    </div>
    <div id="dlList" class="dl-list"></div>
  </div>

  <div class="tool-card">
    <h3>Release 附件</h3>
    <p class="hint">发行版资源走 objects.githubusercontent.com，多数网络可直接下载；若失败，把链接前面加上中转前缀即可。</p>
  </div>

  <div class="tool-card plain">
    <h3>为什么需要这些</h3>
    <p class="hint" style="margin:0">
      页面只读取 <code>api.github.com</code> 的公开数据，不抓取网页，因此不受页面改版影响，也不用密钥之外的任何权限。
      归档下载走 <code>codeload.github.com</code>，图片与原始文件走 raw 或中转。
      所有通路都在浏览器里直接连接，没有经过本站的服务器——这个页面本身只是一堆静态文件。
    </p>
  </div>`;

  app.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      if (input) copyText(input.value);
    });
  });
  $('#reprobe').addEventListener('click', async () => {
    toast('正在探测各通道…', 4000);
    await initChannels();
    viewTools(o, r, ref);
    toast('探测完成');
  });
  $('#gotoSettings').addEventListener('click', openSettings);

  const dlParse = $('#dlParse');
  if (dlParse) dlParse.addEventListener('click', () => {
    const v = $('#dlUrl').value.trim();
    const p = parseGithubFileUrl(v);
    if (!p) { $('#dlTip').textContent = '无法识别该链接'; return; }
    $('#dlOwn').value = p.o + '/' + p.r;
    $('#dlRef').value = p.ref;
    $('#dlPath').value = p.path;
    $('#dlTip').textContent = '已解析：' + p.o + '/' + p.r + ' @ ' + p.ref + ' / ' + p.path;
  });
  const dlGo = $('#dlGo');
  if (dlGo) dlGo.addEventListener('click', () => {
    const own = $('#dlOwn').value.trim();
    const mm = own.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!mm) { $('#dlTip').textContent = 'owner/repo 格式不正确'; return; }
    const ref = $('#dlRef').value.trim() || 'main';
    const path = $('#dlPath').value.trim();
    if (!path) { $('#dlTip').textContent = '请填写文件路径'; return; }
    const name = $('#dlName').value.trim() || path.split('/').pop();
    downloadOne(mm[1], mm[2], ref, path, name);
  });

  renderDlWhere();
}

/* ---------------------------- 账号面板 ---------------------------- */

/** 网页专属操作在客户端内用弹窗 WebView 打开；网页版退回新标签页 */
function openWebPage(url) {
  try {
    if (window.Android && typeof window.Android.openWeb === 'function') {
      window.Android.openWeb(url);
      return;
    }
  } catch (_) {}
  window.open(url, '_blank', 'noopener');
}

const ACCT_WEB = [
  { t: '注册新账号', u: 'https://github.com/signup' },
  { t: '密码 / 两步验证', u: 'https://github.com/settings/security' },
  { t: '用户名 / 注销账号', u: 'https://github.com/settings/admin' },
  { t: '访问令牌', u: 'https://github.com/settings/tokens' }
];

async function renderAccount() {
  const box = $('#acctBox');
  if (!box) return;
  if (!TOKEN) {
    box.innerHTML = '<p class="hint" style="margin:0 0 8px">未设置令牌。注册或登录后可查看资料。</p>'
      + '<div class="modal-actions" style="margin-top:0">'
      + '<button class="btn sm" id="acSignup">注册 GitHub 账号</button>'
      + '<button class="btn sm ghost" id="acLogin">网页登录</button></div>'
      + '<div class="hint" style="font-size:11.5px;margin-top:8px">注册与登录只在 GitHub 网页提供，点按钮在客户端内打开；打不开时点弹窗右上角「浏览器」，或换到能访问 github.com 的网络。账号页不能走第三方代理。</div>';
    const s = $('#acSignup'); if (s) s.onclick = () => openWebPage('https://github.com/signup');
    const l = $('#acLogin'); if (l) l.onclick = () => openWebPage('https://github.com/login');
    return;
  }
  box.textContent = '读取中…';
  try {
    const u = await gh('/user', { cache: false });
    meCache = u;
    const facts = [];
    if (u.company) facts.push('公司 ' + u.company);
    if (u.location) facts.push('位置 ' + u.location);
    if (u.blog) facts.push('主页 ' + u.blog);
    if (u.created_at) facts.push('加入于 ' + String(u.created_at).slice(0, 10));
    box.innerHTML = `
      <div class="acct-head">
        <img class="acct-avatar" src="${esc(u.avatar_url || '')}" alt="">
        <div class="acct-id">
          <b>${esc(u.name || u.login)}</b>
          <span class="dim mono">@${esc(u.login)}</span>
          ${u.bio ? `<p class="hint" style="margin:4px 0 0">${esc(u.bio)}</p>` : ''}
        </div>
      </div>
      <div class="acct-stats">
        <span><b>${u.public_repos || 0}</b> 仓库</span>
        <span><b>${u.followers || 0}</b> 关注者</span>
        <span><b>${u.following || 0}</b> 正在关注</span>
      </div>
      ${facts.length ? `<div class="hint" style="font-size:11.5px;margin-top:8px">${esc(facts.join(' · '))}</div>` : ''}
      <div class="modal-actions" style="margin-top:10px">
        <button class="btn sm" id="acEdit">编辑资料</button>
      </div>
      <div class="acct-web">${ACCT_WEB.map(b => `<button class="btn sm ghost" data-web="${b.u}">${b.t}</button>`).join('')}</div>
      <div class="hint" style="font-size:11.5px;margin-top:8px">
        改密码、两步验证、改用户名、注销账号、管理令牌只在 GitHub 网页提供，上面的按钮在客户端内打开对应页面。账号页涉及密码与 Cookie，不能走第三方代理；打不开时点弹窗右上角「浏览器」或换网络。
      </div>`;
    $('#acEdit').onclick = () => acctEditForm(u);
    box.querySelectorAll('[data-web]').forEach(b => { b.onclick = () => openWebPage(b.dataset.web); });
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  }
}

function acctEditForm(u) {
  const box = $('#acctBox');
  if (!box) return;
  box.innerHTML = `
    <div class="acct-form">
      <label>昵称<input id="acName" type="text" value="${esc(u.name || '')}" placeholder="显示名称"></label>
      <label>简介<input id="acBio" type="text" value="${esc(u.bio || '')}" placeholder="一句话介绍"></label>
      <label>公司<input id="acCo" type="text" value="${esc(u.company || '')}"></label>
      <label>位置<input id="acLoc" type="text" value="${esc(u.location || '')}"></label>
      <label>主页<input id="acBlog" type="text" value="${esc(u.blog || '')}" placeholder="https://"></label>
      <label>Twitter<input id="acTw" type="text" value="${esc(u.twitter_username || '')}"></label>
    </div>
    <div class="modal-actions" style="margin-top:10px">
      <span class="dim" id="acMsg" style="font-size:11.5px"></span>
      <span class="spacer"></span>
      <button class="btn sm ghost" id="acCancel">取消</button>
      <button class="btn primary sm" id="acSave">保存</button>
    </div>
    <div class="hint" style="font-size:11.5px;margin-top:8px">
      修改资料需要令牌带 <code>user</code> 作用域；只有 <code>repo</code> 的令牌会提示权限不足。
    </div>`;
  $('#acCancel').onclick = renderAccount;
  $('#acSave').onclick = async () => {
    const body = {
      name: $('#acName').value.trim(),
      bio: $('#acBio').value.trim(),
      company: $('#acCo').value.trim(),
      location: $('#acLoc').value.trim(),
      blog: $('#acBlog').value.trim(),
      twitter_username: $('#acTw').value.trim()
    };
    $('#acMsg').textContent = '保存中…';
    try {
      const r = await gh('/user', { method: 'PATCH', body: body, cache: false });
      meCache = r;
      toast('资料已更新');
      renderAccount();
    } catch (e) {
      const hint = (e.status === 403 || e.status === 404)
        ? '令牌缺少 user 作用域，无法修改资料。请重新生成带 user 的令牌。'
        : e.message;
      $('#acMsg').innerHTML = '<span style="color:var(--red)">' + esc(hint) + '</span>';
    }
  };
}

/* ---------------------------- 设置面板 ---------------------------- */

async function openSettings() {
  if (!channelOrder.length) await ensureChannels();
  const mask = $('#modal');
  mask.hidden = false;

  const chRows = allChannels().map(ch => {
    const st = channelStatus[ch.id];
    const dot = !st ? 'var(--fg-subtle)' : (st.quota > 0 ? 'var(--green)' : 'var(--yellow)');
    const tail = !st ? '未连通' : st.ms + ' ms · ' + (st.quota > 0 ? '余 ' + st.quota : '无额度');
    return `<div class="ch-row">
      <span class="ch-dot" style="background:${dot}"></span>
      <b>${esc(ch.label)}</b>
      <span class="spacer"></span>
      <span class="mono dim">${esc(tail)}</span>
    </div>`;
  }).join('');

  mask.innerHTML = `
    <div class="modal-card">
      <h3>连接设置</h3>

      <div class="set-block">
        <h4>访问令牌</h4>
        <p class="hint">
          匿名调用每小时 60 次，浏览几个仓库就会耗尽；填入令牌后为 5000 次。
          令牌存在浏览器本地，随请求直接发给 GitHub。
        </p>
        <div class="scope-pick">
          <label class="form-check"><input type="checkbox" id="scPriv" ${LS.get('ghl_sc_priv', '0') === '1' ? 'checked' : ''}> <span>读取私有仓库 <code>repo</code></span></label>
          <label class="form-check"><input type="checkbox" id="scUser" ${LS.get('ghl_sc_user', '0') === '1' ? 'checked' : ''}> <span>修改账号资料 <code>user</code></span></label>
        </div>
        <div id="scopeHint" class="dim" style="font-size:11.5px;margin:-2px 0 8px"></div>
        <div class="tk-links">
          <a class="btn sm" id="tkGen"
             href="https://github.com/settings/tokens/new?scopes=public_repo&description=GitHub%20Web%20Client"
             target="_blank" rel="noopener">去 GitHub 生成令牌 ↗</a>
          <button class="btn sm ghost" id="tkCmd" title="复制 gh 命令">复制 gh 命令</button>
        </div>
        <p class="hint" style="font-size:11.5px;margin-top:8px">
          勾选上面的用途后点「去 GitHub 生成令牌」，链接会自动带上对应作用域。
          若链接打不开，说明 github.com 在当前网络不可达；装了 gh CLI 的话，在终端跑 <code>gh auth token</code> 可直接取出已有令牌。
        </p>
        <input id="tk" type="password" placeholder="ghp_… 或 github_pat_…" value="${esc(TOKEN)}" spellcheck="false">
        <div class="modal-actions">
          <button class="btn ghost sm" id="tkClear">清除</button>
          <button class="btn ghost sm" id="guideOpen">新手引导</button>
          <span class="spacer"></span>
          <button class="btn primary sm" id="tkSave">保存令牌</button>
        </div>
        <div id="tkStatus" class="dim" style="font-size:12px;margin-top:8px"></div>
      </div>

      <div class="set-block">
        <h4>账号</h4>
        <div id="acctBox" class="dim" style="font-size:12px">加载中…</div>
      </div>

      <div class="set-block">
        <h4>自建中转 <span class="dim" style="font-weight:400">可选，但最稳</span></h4>
        <p class="hint">
          填一个你自己的中转地址，它会排在中转通道的第一位。
          可以填纯前缀（<code>https://x.workers.dev/</code>），也可以填带 <code>{url}</code> 的模板
          （<code>https://x.workers.dev/?url={url}</code>）。部署方法见项目里的 worker.js。
        </p>
        <input id="px" type="text" placeholder="https://your-worker.workers.dev/" value="${esc(LS.get('ghl_proxy', ''))}" spellcheck="false">
        <div class="modal-actions">
          <button class="btn ghost sm" id="pxClear">清除</button>
          <span class="spacer"></span>
          <button class="btn sm" id="pxTest">测试</button>
          <button class="btn primary sm" id="pxSave">保存</button>
        </div>
        <div id="pxStatus" class="dim" style="font-size:12px;margin-top:8px"></div>
      </div>

      <div class="set-block">
        <h4>本地缓存</h4>
        <p class="hint" style="margin-bottom:8px">
          浏览过的内容留在本机。有效期内再次访问不会请求 GitHub，因此不消耗配额。
          仓库信息 8 分钟、文件与目录 5 分钟、README 30 分钟、搜索 10 分钟。
        </p>
        <div class="modal-actions" style="margin-top:0">
          <span class="dim" id="cacheInfo" style="font-size:12px"></span>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="cacheClear">清空缓存</button>
        </div>
      </div>

      <div class="set-block">
        <h4>写操作</h4>
        <p class="hint">默认关闭，仅读取。开启后可在仓库页收藏、Fork 与上传文件，并在「我的」页新建仓库。
           写请求只发给直连或自建通道，不经过公共中转。</p>
        <label class="form-check">
          <input type="checkbox" id="wrEn" ${writeEnabled() ? 'checked' : ''}>
          <span>启用写操作（需要带 <code>repo</code> 作用域的令牌）</span>
        </label>
      </div>

      <div class="set-block">
        <h4>翻译</h4>
        <p class="hint" style="margin-bottom:10px">
          大段文字会显示「译成中文」按钮。六个通道按顺序尝试，前一个失败自动换下一个；
          选定的通道提到最前，其余仍作兜底。
        </p>

        <label class="filt" style="margin-bottom:10px">
          <span>优先使用</span>
          <select id="trMode">
            <option value="auto">自动（本地模型优先）</option>
            <option value="browser">浏览器本地模型</option>
            <option value="tencent">腾讯翻译</option>
            <option value="bilibili">B 站 Index-Translate</option>
            <option value="pollinations">Pollinations</option>
            <option value="libre">自建 LibreTranslate</option>
            <option value="mymemory">MyMemory</option>
          </select>
        </label>

        <div class="tr-custom">
          <input id="trl" type="text" placeholder="LibreTranslate 地址，如 https://lt.example.com"
                 value="${esc(LS.get('ghl_translate', ''))}" spellcheck="false">
          <input id="trlKey" type="text" placeholder="API Key（该服务要求时填写）"
                 value="${esc(LS.get('ghl_translate_key', ''))}" spellcheck="false">
        </div>

        <div class="modal-actions" style="margin-top:10px">
          <span class="dim" id="trStatus" style="font-size:11.5px"></span>
          <span class="spacer"></span>
          <button class="btn ghost sm" id="trlClear">恢复自动</button>
          <button class="btn primary sm" id="trlSave">保存</button>
        </div>
      </div>

      <div class="set-block">
        <h4>自动更新</h4>
        <p class="hint" style="margin-bottom:10px">
          当前版本 <b id="updVer"></b>。每隔最多 6 小时读取一次来源仓库的 <code>VERSION</code> 文件，
          发现新版本时顶栏显示箭头，点击即更新。http(s) 页面直接热替换；本地 file:// 页面则下载新文件，
          替换原文件后重新打开。
        </p>
        <p class="hint" id="updShellHint" style="display:none;color:var(--yellow);margin:-2px 0 10px"></p>
        <label class="form-check" style="margin-bottom:10px">
          <input type="checkbox" id="updOn" ${updEnabled() ? 'checked' : ''}>
          <span>启用自动检查（默认开启）</span>
        </label>
        <label class="filt" style="margin-bottom:10px">
          <span>更新源</span>
          <input id="updRepo" type="text" placeholder="owner/repo，留空为默认源"
                 value="${esc(LS.get('ghl_upd_repo', ''))}" spellcheck="false" style="flex:1">
        </label>
        <div class="modal-actions">
          <span class="dim" id="updStatus" style="font-size:11.5px"></span>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="apkDl">下载安装包</button>
          <button class="btn sm" id="updCheck">检查更新</button>
        </div>
      </div>

      <div class="set-block">
        <h4>当前通路</h4>
        ${chRows}
        <div class="modal-actions">
          <button class="btn sm" id="reprobe2">重新探测</button>
          <span class="spacer"></span>
          <button class="btn" id="tkCancel">关闭</button>
        </div>
      </div>

      <p class="hint" style="font-size:11.5px;margin-top:14px;margin-bottom:0">
        直连通道不会把令牌交给第三方；走公共中转时，请求头会经过该中转服务。
        若在意这一点，请配置自建中转，或只用直连。
      </p>
    </div>`;

  const close = () => { mask.hidden = true; mask.innerHTML = ''; };
  $('#tkCancel').addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  const refreshCacheInfo = () => {
    const el = $('#cacheInfo');
    if (el) {
      const n = cacheCount();
      el.textContent = n ? '已缓存 ' + n + ' 项' : '暂无缓存';
    }
  };
  refreshCacheInfo();

  $('#cacheClear').addEventListener('click', () => {
    const n = clearCache();
    refreshCacheInfo();
    toast(n ? '已清空 ' + n + ' 项缓存' : '缓存本来就是空的');
  });

  const wrEn = $('#wrEn');
  if (wrEn) {
    wrEn.addEventListener('change', () => {
      LS.set('ghl_write', wrEn.checked ? '1' : '');
      toast(wrEn.checked ? '已启用写操作' : '已关闭写操作');
    });
  }

  const refreshTrStatus = async () => {
    const el = $('#trStatus');
    if (!el) return;
    const bt = await getBrowserTranslator();
    const bits = [bt ? '本地模型可用' : '无本地模型'];
    if (LS.get('ghl_translate', '')) bits.push('LibreTranslate 已配置');
    el.textContent = bits.join(' · ');
  };

  const trModeEl = $('#trMode');
  if (trModeEl) trModeEl.value = LS.get('ghl_tr_mode', 'auto');
  refreshTrStatus();

  $('#trlSave').addEventListener('click', () => {
    LS.set('ghl_tr_mode', $('#trMode') ? $('#trMode').value : 'auto');
    LS.set('ghl_translate', $('#trl').value.trim());
    LS.set('ghl_translate_key', $('#trlKey').value.trim());
    toast('翻译设置已保存');
    refreshTrStatus();
  });

  $('#trlClear').addEventListener('click', () => {
    LS.set('ghl_tr_mode', 'auto');
    LS.set('ghl_translate', '');
    LS.set('ghl_translate_key', '');
    if ($('#trMode')) $('#trMode').value = 'auto';
    $('#trl').value = '';
    $('#trlKey').value = '';
    toast('已恢复自动');
    refreshTrStatus();
  });

  const updVer = $('#updVer');
  if (updVer) updVer.textContent = APP_VERSION;

  // 页面热更不会替换安装包；安装包落后时说明为什么还会提示更新
  const shellHint = $('#updShellHint');
  if (shellHint) {
    let sv = '';
    try { if (window.Android && window.Android.shellVersion) sv = window.Android.shellVersion() || ''; } catch (_) {}
    if (sv && cmpVer(sv, APP_VERSION) < 0) {
      shellHint.style.display = '';
      shellHint.innerHTML = '当前安装包 ' + esc(sv) + '，页面 ' + esc(APP_VERSION) +
        '。页面热更不会替换安装包，点下方「检查更新」查看两者状态。';
    }
  }

  const refreshUpdStatus = () => {
    const el = $('#updStatus');
    if (!el) return;
    const last = Number(LS.get('ghl_upd_last', '0') || 0);
    const bits = [];
    if (updAvailable) bits.push('发现新版本 ' + updAvailable.version);
    else if (last) bits.push('上次检查 ' + new Date(last).toLocaleString('zh-CN'));
    else bits.push('尚未检查');
    el.textContent = bits.join(' · ');
  };
  refreshUpdStatus();

  const updOn = $('#updOn');
  if (updOn) {
    updOn.addEventListener('change', () => {
      LS.set('ghl_upd_on', updOn.checked ? '1' : '0');
      try {
        if (window.Android && typeof window.Android.setAutoUpdate === 'function') {
          window.Android.setAutoUpdate(updOn.checked);
        }
      } catch (_) {}
      toast(updOn.checked ? '已启用自动检查更新' : '已关闭自动检查更新');
    });
  }

  const updRepoEl = $('#updRepo');
  if (updRepoEl) {
    updRepoEl.addEventListener('change', () => {
      const v = updRepoEl.value.trim();
      if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) {
        toast('格式应为 owner/repo');
        updRepoEl.value = LS.get('ghl_upd_repo', '');
        return;
      }
      LS.set('ghl_upd_repo', v);
      toast(v ? '更新源已设为 ' + v : '更新源已恢复默认');
    });
  }

  $('#updCheck').addEventListener('click', async () => {
    const st = $('#updStatus');
    if (st) st.textContent = '检查中…';
    const r = await checkUpdate(true);
    const pageMsg = r
      ? '页面有新版本 ' + r.version + '，点击顶栏箭头更新'
      : '页面 ' + APP_VERSION + ' 已是最新';

    // 安装包状态与页面分开显示，避免“页面已最新”被误读成安装包也最新
    let apkMsg = '';
    try {
      const sv = (window.Android && window.Android.shellVersion) ? (window.Android.shellVersion() || '') : '';
      if (sv) {
        const meta = await fetchApkMeta();
        if (meta && meta.versionName) {
          apkMsg = cmpVer(sv, meta.versionName) < 0
            ? '；安装包 ' + sv + ' 可升级到 ' + meta.versionName
            : '；安装包 ' + sv + ' 已是最新';
        } else {
          apkMsg = '；安装包 ' + sv;
        }
      }
    } catch (_) {}

    if (st) st.textContent = pageMsg + apkMsg;
    if (r) toast('发现页面新版本 ' + r.version);

    // 安卓壳：有新版会弹安装包提示（手动触发，忽略“已提示过”）
    try {
      if (window.Android && typeof window.Android.checkApkUpdate === 'function') window.Android.checkApkUpdate();
    } catch (_) {}
  });

  // 不依赖原生桥：列出多个通道，交给系统浏览器下载安装包
  const apkDl = $('#apkDl');
  if (apkDl) apkDl.onclick = () => {
    const m = $('#modal');
    m.hidden = true;
    m.innerHTML = '';
    openApkDownloadDialog();
  };

  $('#tkClear').addEventListener('click', () => {
    saveToken('');
    $('#tk').value = '';
    toast('已清除令牌');
  });

  $('#tkCmd').addEventListener('click', () => copyText('gh auth token'));

  // 作用域勾选：public_repo 为只读基础，repo 覆盖私有仓库，user 用于改资料
  const scopeList = () => {
    const sc = [];
    if ($('#scUser') && $('#scUser').checked) sc.push('user');
    if ($('#scPriv') && $('#scPriv').checked) sc.push('repo');
    else sc.push('public_repo');
    return sc;
  };
  const updScope = () => {
    const el = $('#scopeHint');
    if (el) el.textContent = '将申请：' + scopeList().join('、');
  };
  ['scPriv', 'scUser'].forEach(id => {
    const e = $('#' + id);
    if (e) e.onchange = () => {
      LS.set(id === 'scPriv' ? 'ghl_sc_priv' : 'ghl_sc_user', e.checked ? '1' : '0');
      updScope();
    };
  });
  updScope();

  $('#tkGen').addEventListener('click', (e) => {
    e.preventDefault();
    const url = 'https://github.com/settings/tokens/new?scopes=' + scopeList().join(',') +
      '&description=GitHub%20Web%20Client';
    openWebPage(url);
    toast('已在客户端内打开；若一直空白，说明 github.com 在当前网络不可达', 5000);
  });

  $('#tkSave').addEventListener('click', async () => {
    const v = $('#tk').value.trim();
    if (!v) { toast('请先填入令牌'); return; }
    $('#tkStatus').textContent = '验证中…';
    const old = TOKEN;
    TOKEN = v;
    meCache = null;
    try {
      const u = await gh('/user');
      saveToken(v);
      $('#tkStatus').innerHTML = '已验证：<b>' + esc(u.login) + '</b>';
      toast('已保存，配额 ' + (rate.limit || 5000) + ' 次/小时');
    } catch (e) {
      TOKEN = old;
      meCache = null;
      $('#tkStatus').innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>';
    }
  });

  const guideBtn = $('#guideOpen');
  if (guideBtn) guideBtn.onclick = () => {
    const m = $('#modal');
    m.hidden = true;
    m.innerHTML = '';
    openGuide(0);
  };

  renderAccount();

  $('#pxClear').addEventListener('click', () => {
    LS.set('ghl_proxy', '');
    $('#px').value = '';
    channelOrder = [];
    initChannels().then(() => { toast('已清除自建中转'); $('#pxStatus').textContent = ''; });
  });

  $('#pxTest').addEventListener('click', async () => {
    const v = $('#px').value.trim();
    if (!v) { toast('请先填入地址'); return; }
    $('#pxStatus').textContent = '测试中…';
    LS.set('ghl_proxy', v);
    const ch = chCustom();
    const r = await probeChannel(ch);
    if (r) {
      channelStatus.custom = r;
      $('#pxStatus').innerHTML = '<span style="color:var(--green)">连通，' + r.ms + ' ms</span>';
    } else {
      channelStatus.custom = null;
      $('#pxStatus').innerHTML = '<span style="color:var(--red)">无法连通。确认地址可访问，且返回 GitHub API 的 JSON</span>';
    }
  });

  $('#pxSave').addEventListener('click', async () => {
    const v = $('#px').value.trim();
    LS.set('ghl_proxy', v);
    channelOrder = [];
    $('#pxStatus').textContent = '探测中…';
    await initChannels();
    const st = channelStatus.custom;
    $('#pxStatus').innerHTML = st
      ? '<span style="color:var(--green)">已启用，' + st.ms + ' ms</span>'
      : '<span style="color:var(--red)">已保存，但当前不可连通</span>';
    toast('通道已更新');
  });

  $('#reprobe2').addEventListener('click', async () => {
    toast('探测中…', 3000);
    await initChannels();
    openSettings();
  });
}

/* ---------------------------- 路由 ---------------------------- */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, qs] = raw.split('?');
  const seg = p.split('/').filter(Boolean).map(s => {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  });
  return { seg, q: new URLSearchParams(qs || '') };
}

async function route() {
  const { seg, q } = parseHash();
  document.querySelectorAll('.topnav a').forEach(a => a.classList.remove('on'));
  window.scrollTo(0, 0);
  updateAuthBadge();

  try {
    if (!seg.length) return await viewHome();

    switch (seg[0]) {
      case 'search':
        return await viewSearch(q.get('q') || '', q.get('type') || 'repositories', q);
      case 'me':
        document.querySelector('.topnav a[data-nav="me"]').classList.add('on');
        return await viewMe();
      case 'gists':
        document.querySelector('.topnav a[data-nav="gists"]').classList.add('on');
        return await viewGists();
      case 'g':
        document.querySelector('.topnav a[data-nav="gists"]').classList.add('on');
        return await viewGist(seg[1]);
      case 'tools':
        document.querySelector('.topnav a[data-nav="tools"]').classList.add('on');
        return await viewTools();
      case 'u':
        return await viewUser(seg[1]);
      case 'r': {
        const o = seg[1], r = seg[2];
        if (!r) return await viewUser(o);
        const kind = seg[3];
        if (!kind) return await viewRepo(o, r);
        switch (kind) {
          case 'tree': {
            const path = seg.slice(5).join('/');
            if (!path) return await viewRepo(o, r);
            return await viewTree(o, r, seg[4], path);
          }
          case 'blob':
            return await viewBlob(o, r, seg[4], seg.slice(5).join('/'));
          case 'issues':
            return await viewIssues(o, r, 'issues', q);
          case 'pulls':
            return await viewIssues(o, r, 'pulls', q);
          case 'issue':
            return await viewIssue(o, r, seg[4], false);
          case 'pull':
            return await viewIssue(o, r, seg[4], true);
          case 'releases':
            return await viewReleases(o, r);
          case 'commits':
            return await viewCommits(o, r, seg[4], q.get('page'));
          case 'commit':
            return viewCommit(o, r, seg[4]);
          case 'branches':
            return await viewBranches(o, r);
          case 'tools':
            return await viewTools(o, r, seg[4]);
          default:
            return await viewRepo(o, r);
        }
      }
      default:
        return await viewHome();
    }
  } catch (e) {
    app.innerHTML = errorBox('出错了', e.message);
  } finally {
    bindSrcLinks();
    if (seg[0] === 'r' && seg[2]) bindRepoActions(seg[1], seg[2]);
  }
}

/* ---------------------------- 写操作 ---------------------------- */

/**
 * 写操作默认关闭，需在设置中启用。
 * 请求只发给直连或自建通道，不经过公共中转，避免明文令牌被第三方获取。
 */

const writeEnabled = () => LS.get('ghl_write', '') === '1';
const canWrite = () => writeEnabled() && !!TOKEN;

async function ghWrite(method, path, body) {
  if (!TOKEN) throw new Error('需要访问令牌');
  await ensureChannels();

  let trusted = channelOrder.filter((ch) => ch.trust);
  // 启动探测给直连的时限很短，移动网络下容易误判为不可用；
  // 写操作再给直连一次机会（45 秒超时），成功则恢复到通道链首位
  const retryDirect = trusted.length === 0;
  if (retryDirect) trusted = [CH_DIRECT];

  let lastErr = null;
  for (const ch of trusted) {
    try {
      const out = await fetchVia(ch, path, { method: method, body: body, timeout: 45000 });
      clearCache();   // 内容已变，缓存不再可靠
      if (retryDirect && ch === CH_DIRECT) {
        channelOrder = [CH_DIRECT].concat(channelOrder);
        activeChannel = CH_DIRECT;
        updateChannelBadge();
      }
      return out;
    } catch (e) {
      if (!e.channelFail) throw e;
      lastErr = e;
    }
  }
  if (retryDirect) {
    throw new Error('直连不可用；写操作需要直连或自建通道，公共中转会暴露令牌');
  }
  throw (lastErr || new Error('写入失败'));
}

/** 是否已收藏。204 表示已收藏，404 表示未收藏 */
async function checkStarred(o, r) {
  if (!TOKEN) return null;
  const key = 'ghstar:' + o + '/' + r;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const rec = JSON.parse(raw);
      if (rec && Date.now() - rec.t < 10 * 60 * 1000) return rec.v;
    }
  } catch (_) {}

  try {
    const res = await fetch(API_HOST + '/user/starred/' + o + '/' + r, {
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' }
    });
    const v = res.status === 204;
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v })); } catch (_) {}
    return v;
  } catch (_) {
    return null;
  }
}

function forgetStar(o, r) {
  try { localStorage.removeItem('ghstar:' + o + '/' + r); } catch (_) {}
}

async function toggleStar(o, r, starred, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    await ghWrite(starred ? 'DELETE' : 'PUT', '/user/starred/' + o + '/' + r, undefined);
    forgetStar(o, r);
    toast(starred ? '已取消收藏' : '已收藏');
    await refreshStarBtn(o, r, btn);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast('操作失败：' + e.message, 5000);
  }
}

async function refreshStarBtn(o, r, btn) {
  const v = await checkStarred(o, r);
  btn.dataset.starred = v ? '1' : '0';
  btn.textContent = v ? '★ 已收藏' : '☆ 收藏';
  btn.disabled = false;
}

async function doFork(o, r, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const out = await ghWrite('POST', '/repos/' + o + '/' + r + '/forks', {});
    toast('已 fork：' + (out.full_name || ''));
    btn.textContent = '已 fork';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast('Fork 失败：' + e.message, 5000);
  }
}

/* ---------- 界面：仓库操作条 ---------- */

/**
 * 仓库页写操作区。未启用写操作时给出可见原因与设置入口，
 * 避免小屏上按钮缺失时无从判断（令牌缺失另在顶栏与首页提示）。
 */
function writeBlock(o, r, repo) {
  if (canWrite()) return repoActions(o, r, repo);
  if (!TOKEN || writeEnabled()) return '';
  return '<div class="write-hint">写操作未启用，收藏 / Fork / 上传 / 删除不可用' +
    '<button type="button" class="btn sm ghost" id="wrEnable">去设置开启</button></div>';
}

function repoActions(o, r, repo) {
  if (!canWrite()) return '';
  const isAdmin = !!(repo && repo.permissions && repo.permissions.admin);
  const isFork = !!(repo && repo.fork);
  return '<div class="repo-actions">' +
    '<button type="button" class="btn sm" id="actStar" data-starred="">收藏</button>' +
    (isFork ? '<span class="dim" style="font-size:12px">fork 来的仓库</span>'
            : '<button type="button" class="btn sm" id="actFork">Fork</button>') +
    '<button type="button" class="btn sm" id="actUpload">上传文件</button>' +
    (isAdmin ? '<button type="button" class="btn sm danger" id="actDel">删除仓库</button>' : '') +
    '</div>';
}

/**
 * 读取令牌的作用域。classic token 会通过 X-OAuth-Scopes 返回，
 * fine-grained token 没有这个响应头，此时返回 null 表示无法判断。
 */
let tokenScopes;
async function getTokenScopes() {
  if (tokenScopes !== undefined) return tokenScopes;
  try {
    const res = await fetch(API_HOST + '/', {
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' }
    });
    const raw = res.headers.get('x-oauth-scopes');
    tokenScopes = raw === null ? null : raw.split(',').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    tokenScopes = null;
  }
  return tokenScopes;
}

/** true 有权限 / false 明确没有 / null 无法判断（fine-grained） */
async function hasDeleteRepoScope() {
  const scopes = await getTokenScopes();
  if (!scopes) return null;
  return scopes.indexOf('delete_repo') >= 0;
}

/** 删除仓库：不可逆，需输入仓库全名确认 */
function openDeleteRepoDialog(o, r) {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  const full = o + '/' + r;

  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>删除仓库</h3>' +
      '<p class="hint" style="color:var(--red)">此操作不可撤销。仓库、Issue、PR、星标与 fork 关系都会被移除。</p>' +
      '<p class="hint">需要令牌带 <code>delete_repo</code> 作用域，仅有 <code>repo</code> 不足以删除。</p>' +
      '<p class="hint">请输入 <code>' + esc(full) + '</code> 以确认：</p>' +
      '<input id="drName" type="text" placeholder="' + esc(full) + '" spellcheck="false">' +
      '<div class="modal-actions">' +
        '<span class="dim" id="drMsg" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="drCancel">取消</button>' +
        '<button type="button" class="btn danger" id="drGo">永久删除</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#drCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#drName').focus();

  $('#drGo').addEventListener('click', async () => {
    if ($('#drName').value.trim() !== full) {
      $('#drMsg').textContent = '输入与仓库名不一致';
      return;
    }
    $('#drGo').disabled = true;
    $('#drMsg').textContent = '删除中…';
    try {
      await ghWrite('DELETE', '/repos/' + o + '/' + r, undefined);
      forgetStar(o, r);
      close();
      toast('已删除 ' + full);
      location.hash = '#/me';
    } catch (e) {
      $('#drGo').disabled = false;
      const raw = String(e.message || '');
      if (/admin rights|delete_repo|403/i.test(raw)) {
        $('#drMsg').innerHTML =
          '令牌权限不足，删除仓库需要 <code>delete_repo</code> 作用域。' +
          '<a href="https://github.com/settings/tokens" target="_blank" rel="noopener">重新生成令牌</a>' +
          '时勾选该项，再填入设置。';
        tokenScopes = undefined;   // 下次重新读取
      } else {
        $('#drMsg').textContent = raw;
      }
    }
  });
}

function bindRepoActions(o, r, forked) {
  const wrEnable = $('#wrEnable');
  if (wrEnable) wrEnable.addEventListener('click', openSettings);

  const star = $('#actStar');
  if (star) {
    refreshStarBtn(o, r, star);
    star.addEventListener('click', () => {
      toggleStar(o, r, star.dataset.starred === '1', star);
    });
  }
  const fork = $('#actFork');
  if (fork) fork.addEventListener('click', () => doFork(o, r, fork));

  const up = $('#actUpload');
  if (up) up.addEventListener('click', () => openUploadDialog(o, r));

  const del = $('#actDel');
  if (del) {
    del.addEventListener('click', () => openDeleteRepoDialog(o, r));
    // classic token 可直接读出作用域，缺 delete_repo 就先禁用，省得点了才报错
    hasDeleteRepoScope().then((ok) => {
      if (ok === false && del.isConnected) {
        del.disabled = true;
        del.title = '令牌缺少 delete_repo 作用域，无法删除仓库';
      }
    });
  }
}

/* ---------- 新建仓库 ---------- */

function openNewRepoDialog() {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>新建仓库</h3>' +
      '<p class="hint">需要带 <code>repo</code> 作用域的令牌。</p>' +
      '<input id="nrName" type="text" placeholder="仓库名，如 my-project" spellcheck="false">' +
      '<input id="nrDesc" type="text" placeholder="描述（可选）">' +
      '<div class="form-check">' +
        '<label><input type="checkbox" id="nrPrivate"> 私有仓库</label>' +
        '<label><input type="checkbox" id="nrInit" checked> 初始化 README</label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<span class="dim" id="nrMsg" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="nrCancel">取消</button>' +
        '<button type="button" class="btn primary" id="nrGo">创建</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#nrCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#nrName').focus();

  $('#nrGo').addEventListener('click', async () => {
    const name = $('#nrName').value.trim();
    if (!name) { $('#nrMsg').textContent = '仓库名不能为空'; return; }
    $('#nrGo').disabled = true;
    $('#nrMsg').textContent = '创建中…';
    try {
      const out = await ghWrite('POST', '/user/repos', {
        name: name,
        description: $('#nrDesc').value.trim(),
        private: $('#nrPrivate').checked,
        auto_init: $('#nrInit').checked
      });
      close();
      toast('已创建：' + out.full_name);
      location.hash = link(out.owner.login, out.name);
    } catch (e) {
      $('#nrGo').disabled = false;
      $('#nrMsg').textContent = e.message;
    }
  });
}

/* ---------- 上传文件 ---------- */

function openUploadDialog(o, r) {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>上传到 ' + esc(o + '/' + r) + '</h3>' +
      '<p class="hint">选择本地文件，按 UTF-8 文本读入后写入仓库。已存在的文件会被覆盖。</p>' +
      '<div class="drop-zone" id="upZone">' +
        '<input type="file" id="upFile" multiple hidden>' +
        '<span>点击选择文件，或拖到此处</span>' +
      '</div>' +
      '<div class="file-list" id="upList"></div>' +
      '<input id="upMsg" type="text" placeholder="提交信息，如 Add files" value="Add files via web client">' +
      '<div class="modal-actions">' +
        '<span class="dim" id="upStatus" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="upCancel">取消</button>' +
        '<button type="button" class="btn primary" id="upGo" disabled>上传</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#upCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };

  const picked = [];
  const zone = $('#upZone');
  const input = $('#upFile');

  const paint = () => {
    $('#upList').innerHTML = picked.map((f, i) =>
      '<div class="up-item"><span>' + esc(f.name) + '</span>' +
      '<button type="button" class="up-del" data-i="' + i + '">移除</button></div>').join('');
    $('#upGo').disabled = picked.length === 0;
    $('#upGo').textContent = picked.length ? '上传 ' + picked.length + ' 个文件' : '上传';
    $('#upList').querySelectorAll('.up-del').forEach((b) => {
      b.addEventListener('click', () => { picked.splice(Number(b.dataset.i), 1); paint(); });
    });
  };

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    Array.from(e.dataTransfer.files || []).forEach((f) => picked.push(f));
    paint();
  });
  input.addEventListener('change', () => {
    Array.from(input.files || []).forEach((f) => picked.push(f));
    paint();
  });

  $('#upGo').addEventListener('click', async () => {
    const msg = $('#upMsg').value.trim() || 'Add files via web client';
    const btn = $('#upGo');
    btn.disabled = true;
    let doneCount = 0;
    const failures = [];

    for (const f of picked) {
      $('#upStatus').textContent = '上传 ' + f.name + '（' + (doneCount + 1) + '/' + picked.length + '）';
      try {
        const text = await f.text();
        const b64 = btoa(unescape(encodeURIComponent(text)));
        await ghWrite('PUT', '/repos/' + o + '/' + r + '/contents/' + encPath(f.name), {
          message: msg,
          content: b64
        });
        doneCount++;
      } catch (e) {
        failures.push(f.name + '：' + e.message);
      }
    }

    if (!failures.length) {
      close();
      toast('已上传 ' + doneCount + ' 个文件');
      location.reload();
    } else {
      btn.disabled = false;
      $('#upStatus').textContent = '成功 ' + doneCount + ' 个，失败 ' + failures.length + ' 个';
      if (failures.length) toast(failures[0], 6000);
    }
  });

  paint();
}

/* ---------- 新建 Issue ---------- */

function openNewIssueDialog(o, r) {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>新建 Issue</h3>' +
      '<p class="hint">提交到 ' + esc(o + '/' + r) + '</p>' +
      '<input id="niTitle" type="text" placeholder="标题" spellcheck="false">' +
      '<textarea id="niBody" placeholder="正文，支持 Markdown"></textarea>' +
      '<input id="niLabels" type="text" placeholder="标签，逗号分隔（可选）" spellcheck="false">' +
      '<div class="modal-actions">' +
        '<span class="dim" id="niMsg" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="niCancel">取消</button>' +
        '<button type="button" class="btn primary" id="niGo">提交</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#niCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#niTitle').focus();

  $('#niGo').addEventListener('click', async () => {
    const title = $('#niTitle').value.trim();
    if (!title) { $('#niMsg').textContent = '标题不能为空'; return; }
    const labels = $('#niLabels').value.split(',').map((s) => s.trim()).filter(Boolean);

    $('#niGo').disabled = true;
    $('#niMsg').textContent = '提交中…';
    try {
      const out = await ghWrite('POST', '/repos/' + o + '/' + r + '/issues', {
        title: title,
        body: $('#niBody').value,
        labels: labels
      });
      close();
      toast('已创建 #' + out.number);
      location.hash = link(o, r, 'issue', out.number);
    } catch (e) {
      $('#niGo').disabled = false;
      $('#niMsg').textContent = e.message;
    }
  });
}

/* ---------- 新建 Pull Request ---------- */

async function openNewPrDialog(o, r, defaultBranch) {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  loading();
  let branches = [];
  try {
    branches = await gh('/repos/' + o + '/' + r + '/branches?per_page=100');
  } catch (_) {}
  if (!Array.isArray(branches)) branches = [];

  const opts = branches.map((b) =>
    '<option value="' + esc(b.name) + '"' + (b.name === defaultBranch ? ' selected' : '') + '>' +
    esc(b.name) + '</option>').join('');

  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>新建 Pull Request</h3>' +
      '<p class="hint">提交到 ' + esc(o + '/' + r) + '。若分支未列出，请先在原站推送该分支。</p>' +
      '<input id="npTitle" type="text" placeholder="标题" spellcheck="false">' +
      '<textarea id="npBody" placeholder="说明，支持 Markdown"></textarea>' +
      '<div class="form-row">' +
        '<label class="filt"><span>合并到</span><select id="npBase">' + opts + '</select></label>' +
        '<label class="filt"><span>来自</span><select id="npHead">' + opts + '</select></label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<span class="dim" id="npMsg" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="npCancel">取消</button>' +
        '<button type="button" class="btn primary" id="npGo">提交</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#npCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#npTitle').focus();

  $('#npGo').addEventListener('click', async () => {
    const title = $('#npTitle').value.trim();
    if (!title) { $('#npMsg').textContent = '标题不能为空'; return; }
    const head = $('#npHead').value;
    const base = $('#npBase').value;
    if (head === base) { $('#npMsg').textContent = '来源与目标分支不能相同'; return; }

    $('#npGo').disabled = true;
    $('#npMsg').textContent = '提交中…';
    try {
      const out = await ghWrite('POST', '/repos/' + o + '/' + r + '/pulls', {
        title: title,
        body: $('#npBody').value,
        head: head,
        base: base
      });
      close();
      toast('已创建 #' + out.number);
      location.hash = link(o, r, 'pull', out.number);
    } catch (e) {
      $('#npGo').disabled = false;
      $('#npMsg').textContent = e.message;
    }
  });
}

/* ---------- 评论与状态 ---------- */

async function submitComment(o, r, n, body, btn, area) {
  if (!body.trim()) { toast('评论内容为空'); return; }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    await ghWrite('POST', '/repos/' + o + '/' + r + '/issues/' + n + '/comments', { body: body });
    area.value = '';
    toast('评论已提交');
    location.reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast('提交失败：' + e.message, 5000);
  }
}

/** Issue 与 PR 共用 issues 端点改状态 */
async function setIssueState(o, r, n, state, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    await ghWrite('PATCH', '/repos/' + o + '/' + r + '/issues/' + n, { state: state });
    toast(state === 'closed' ? '已关闭' : '已重新打开');
    location.reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast('操作失败：' + e.message, 5000);
  }
}

function issueWriteBox(issue, n) {
  if (!canWrite()) {
    return '<p class="foot-note">只读视图。回复与状态变更需在设置中启用写操作后进行。</p>';
  }
  const next = issue.state === 'open' ? 'closed' : 'open';
  return '<div class="issue-write">' +
    '<textarea id="cmtBody" placeholder="写下评论，支持 Markdown"></textarea>' +
    '<div class="modal-actions" style="margin-top:8px">' +
      '<button type="button" class="btn sm" id="cmtSend">发表评论</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn sm ghost" id="cmtState">' +
        (next === 'closed' ? '关闭' : '重新打开') + '</button>' +
    '</div>' +
  '</div>';
}

function bindIssueWrite(o, r, n, issue) {
  const send = $('#cmtSend');
  const area = $('#cmtBody');
  if (send && area) {
    send.addEventListener('click', () => submitComment(o, r, n, area.value, send, area));
  }
  const st = $('#cmtState');
  if (st) {
    st.addEventListener('click', () => {
      setIssueState(o, r, n, issue.state === 'open' ? 'closed' : 'open', st);
    });
  }
}

/* ---------------------------- Gist ---------------------------- */

function gistRow(g) {
  const files = Object.keys(g.files || {});
  const first = files[0] || '';
  return '<div class="file-row" data-href="#/g/' + esc(g.id) + '">' +
    ICON.file +
    '<span class="fname-wrap"><span class="fname">' + esc(g.description || first) + '</span></span>' +
    '<span class="fmsg">' + files.length + ' 个文件 · ' + (g.public ? '公开' : '私密') + '</span>' +
    '<span class="fsize">' + timeAgo(g.updated_at) + '</span>' +
  '</div>';
}

async function viewGists() {
  loading();
  document.title = '我的 Gist';
  if (!TOKEN) {
    app.innerHTML = errorBox('需要访问令牌', 'Gist 属于账户内容，需先配置令牌。', '')
      .replace(/<button class="btn" onclick="location\.reload\(\)">重试<\/button>/,
        '<button class="btn primary" onclick="openSettings()">立即设置</button>');
    return;
  }

  let gists = [];
  try {
    gists = await gh('/gists?per_page=50');
  } catch (e) {
    app.innerHTML = errorBox('无法读取 Gist', e.message);
    return;
  }

  app.innerHTML =
    '<h2 class="page-title">我的 Gist</h2>' +
    (canWrite() ? '<div class="repo-actions"><button type="button" class="btn primary" id="newGist">新建 Gist</button></div>' : '') +
    '<div class="panel">' +
      '<div class="panel-head">共 ' + gists.length + ' 个' +
        (gists.length >= 50 ? '（仅显示最近 50 个）' : '') + '</div>' +
      (gists.length ? gists.map(gistRow).join('') : '<div class="empty">还没有 Gist</div>') +
    '</div>';

  bindFileRows();
  const ng = $('#newGist');
  if (ng) ng.addEventListener('click', openNewGistDialog);
}

function gistFileHtml(name, f) {
  let html = esc(f.content || '');
  if (f.language) {
    try {
      html = hljs.highlight(f.content || '', {
        language: String(f.language).toLowerCase(),
        ignoreIllegals: true
      }).value;
    } catch (_) {}
  }
  const truncated = f.truncated && f.raw_url;
  return '<div class="panel">' +
    '<div class="panel-head">' + ICON.file +
      '<span class="path-crumb">' + esc(name) + '</span>' +
      '<span class="spacer"></span>' +
      '<a class="btn sm ghost" href="' + esc(f.raw_url || '#') + '" target="_blank" rel="noopener">原始文件</a>' +
    '</div>' +
    '<pre class="code-view"><code class="hljs">' + html + '</code></pre>' +
    (truncated ? '<div class="empty">内容过长已截断，可点「原始文件」查看完整内容</div>' : '') +
  '</div>';
}

async function viewGist(id) {
  loading();
  let g;
  try {
    g = await gh('/gists/' + id);
  } catch (e) {
    app.innerHTML = errorBox('无法读取 Gist', e.message);
    return;
  }
  document.title = (g.description || 'Gist') + ' · ' + id;

  const files = Object.keys(g.files || {});
  const owner = g.owner ? g.owner.login : '';

  app.innerHTML =
    '<h2 class="page-title">' + esc(g.description || '未命名 Gist') + '</h2>' +
    '<div class="repo-meta" style="margin-bottom:14px">' +
      (owner ? '<span>' + esc(owner) + '</span>' : '') +
      '<span>' + (g.public ? '公开' : '私密') + '</span>' +
      '<span>' + ICON.clock + ' ' + timeAgo(g.updated_at) + '</span>' +
      '<span>' + files.length + ' 个文件 · ' + fmtNum(g.comments) + ' 条评论</span>' +
    '</div>' +
    srcLink('https://gist.github.com/' + (owner || '') + '/' + esc(id)) +
    files.map((n) => gistFileHtml(n, g.files[n])).join('') +
    (canWrite() && owner === (meCache ? meCache.login : owner)
      ? '<div class="repo-actions"><button type="button" class="btn sm ghost" id="delGist">删除此 Gist</button></div>'
      : '');

  const del = $('#delGist');
  if (del) {
    del.addEventListener('click', async () => {
      if (!confirm('删除 Gist「' + (g.description || id) + '」？此操作不可撤销。')) return;
      const original = del.textContent;
      del.disabled = true;
      del.textContent = '删除中…';
      try {
        await ghWrite('DELETE', '/gists/' + id, undefined);
        toast('已删除');
        location.hash = '#/gists';
      } catch (e) {
        del.disabled = false;
        del.textContent = original;
        toast('删除失败：' + e.message, 5000);
      }
    });
  }
}

function openNewGistDialog() {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>新建 Gist</h3>' +
      '<p class="hint">内容以 UTF-8 文本提交。文件名用于推断语法高亮。</p>' +
      '<input id="ngDesc" type="text" placeholder="描述（可选）">' +
      '<input id="ngName" type="text" placeholder="文件名，如 example.js" spellcheck="false">' +
      '<textarea id="ngBody" placeholder="文件内容"></textarea>' +
      '<div class="form-check">' +
        '<label><input type="checkbox" id="ngPublic"> 公开 Gist（不选则为私密）</label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<span class="dim" id="ngMsg" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="ngCancel">取消</button>' +
        '<button type="button" class="btn primary" id="ngGo">创建</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#ngCancel').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#ngDesc').focus();

  $('#ngGo').addEventListener('click', async () => {
    const name = $('#ngName').value.trim() || 'gist.txt';
    const body = $('#ngBody').value;
    if (!body.trim()) { $('#ngMsg').textContent = '内容不能为空'; return; }

    $('#ngGo').disabled = true;
    $('#ngMsg').textContent = '创建中…';
    try {
      const files = {};
      files[name] = { content: body };
      const out = await ghWrite('POST', '/gists', {
        description: $('#ngDesc').value.trim(),
        public: $('#ngPublic').checked,
        files: files
      });
      close();
      toast('已创建 Gist');
      location.hash = '#/g/' + out.id;
    } catch (e) {
      $('#ngGo').disabled = false;
      $('#ngMsg').textContent = e.message;
    }
  });
}

/* ---------------------------- Release ---------------------------- */

function openNewReleaseDialog(o, r, defaultBranch) {
  const mask = $('#modal');
  mask.hidden = false;
  mask.classList.add('top');
  mask.innerHTML =
    '<div class="dialog">' +
      '<h3>新建发行版</h3>' +
      '<p class="hint">' + esc(o + '/' + r) + '。标签不存在时会基于所选分支创建。</p>' +
      '<input id="nrTag" type="text" placeholder="标签名，如 v1.0.0" spellcheck="false">' +
      '<input id="nrTitle" type="text" placeholder="标题（可选，默认用标签名）">' +
      '<textarea id="nrBody" placeholder="说明，支持 Markdown"></textarea>' +
      '<div class="form-row">' +
        '<label class="filt"><span>基于分支</span><input id="nrBranch" type="text" value="' +
          esc(defaultBranch || 'main') + '" spellcheck="false" style="min-width:120px"></label>' +
      '</div>' +
      '<div class="form-check">' +
        '<label><input type="checkbox" id="nrDraft"> 存为草稿</label>' +
        '<label><input type="checkbox" id="nrPre"> 标记为预发行</label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<span class="dim" id="nrMsg2" style="font-size:12px"></span>' +
        '<span class="spacer"></span>' +
        '<button type="button" class="btn" id="nrCancel2">取消</button>' +
        '<button type="button" class="btn primary" id="nrGo2">发布</button>' +
      '</div>' +
    '</div>';

  const close = () => { mask.hidden = true; mask.classList.remove('top'); mask.innerHTML = ''; };
  $('#nrCancel2').addEventListener('click', close);
  mask.onclick = (e) => { if (e.target === mask) close(); };
  $('#nrTag').focus();

  $('#nrGo2').addEventListener('click', async () => {
    const tag = $('#nrTag').value.trim();
    if (!tag) { $('#nrMsg2').textContent = '标签名不能为空'; return; }

    $('#nrGo2').disabled = true;
    $('#nrMsg2').textContent = '发布中…';
    try {
      const out = await ghWrite('POST', '/repos/' + o + '/' + r + '/releases', {
        tag_name: tag,
        name: $('#nrTitle').value.trim() || tag,
        body: $('#nrBody').value,
        draft: $('#nrDraft').checked,
        prerelease: $('#nrPre').checked,
        target_commitish: $('#nrBranch').value.trim() || defaultBranch
      });
      close();
      toast('已发布 ' + tag);
      location.hash = link(o, r, 'releases');
    } catch (e) {
      $('#nrGo2').disabled = false;
      $('#nrMsg2').textContent = e.message;
    }
  });
}

async function deleteRelease(o, r, id, name, btn) {
  if (!confirm('删除发行版「' + name + '」？关联的 Git 标签不会一并删除。')) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '删除中…';
  try {
    await ghWrite('DELETE', '/repos/' + o + '/' + r + '/releases/' + id, undefined);
    toast('已删除');
    location.reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    toast('删除失败：' + e.message, 5000);
  }
}

/* ---------------------------- 搜索面板 ---------------------------- */

const SEARCH_TYPES = [
  ['repositories', '仓库'], ['code', '代码'], ['users', '用户'], ['issues', '议题']
];

function emptyFilters() {
  return {
    sort: '', lang: '', android: '', stars: '', pushed: '', repo: '', path: '',
    label: '', utype: '', repos: '', state: '', kind: ''
  };
}

/**
 * 顶栏的搜索只是一个触发器，点开才铺满整个面板。
 * 条件在这里一次挑好，提交时拼成 URL 交给搜索结果页。
 */
function openSearchPanel(opts) {
  opts = opts || {};
  const mask = $('#modal');
  if (!mask.hidden) return;

  mask.hidden = false;
  mask.classList.add('top');

  const st = {
    q: opts.q || '',
    type: opts.type || 'repositories',
    f: opts.f || emptyFilters()
  };

  function onEsc(e) {
    if (e.key === 'Escape') close();
  }

  const close = () => {
    mask.hidden = true;
    mask.classList.remove('top');
    mask.innerHTML = '';
    mask.onclick = null;
    document.removeEventListener('keydown', onEsc);
  };

  const preview = () => {
    const el = $('#sp-preview');
    if (!el) return;
    const raw = st.q.trim();
    if (!raw) { el.innerHTML = ''; return; }
    const parsed = parseGithubUrl(raw);
    if (parsed) {
      el.innerHTML = '<span class="sp-ok">将直接打开 ' + esc(parsed.label) + '</span>';
      return;
    }
    el.innerHTML = '实际检索 <code>' + esc(composeSearchQuery(raw, st.type, st.f)) + '</code>';
  };

  const go = () => {
    const raw = st.q.trim();
    if (!raw) { toast('先输入关键词或链接'); return; }
    const parsed = parseGithubUrl(raw);
    if (parsed) {
      close();
      location.hash = parsed.hash;
      return;
    }
    const np = new URLSearchParams();
    np.set('q', raw);
    np.set('type', st.type);
    Object.keys(st.f).forEach((k) => { if (st.f[k]) np.set(k, st.f[k]); });
    close();
    location.hash = '#/search?' + np.toString();
  };

  const bindFilters = () => {
    Object.keys(emptyFilters()).forEach((k) => {
      const el = document.getElementById('sp-' + k);
      if (!el) return;
      const sync = () => {
        st.f[k] = String(el.value || '').trim();
        preview();
      };
      el.addEventListener('change', sync);
      if (el.tagName === 'INPUT') {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); sync(); go(); }
        });
      }
    });
  };

  const draw = () => {
    mask.innerHTML =
      '<div class="search-panel">' +
        '<div class="sp-input-row">' +
          '<svg viewBox="0 0 16 16" width="17" height="17" class="sp-ico">' +
            '<path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.5 4.5 0 1 0-8.999 0 4.5 4.5 0 0 0 8.999 0Z"/>' +
          '</svg>' +
          '<input id="sp-q" type="text" placeholder="输入关键词，或粘贴 GitHub 链接" value="' +
            esc(st.q) + '" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="sp-types">' +
          SEARCH_TYPES.map(([k, l]) =>
            '<button type="button" class="sp-type' + (st.type === k ? ' on' : '') +
            '" data-t="' + k + '">' + l + '</button>').join('') +
        '</div>' +
        '<div class="sp-filters">' + searchFilterBar(st.type, st.f, 'sp-') + '</div>' +
        '<div class="sp-preview" id="sp-preview"></div>' +
        '<div class="sp-actions">' +
          '<span class="sp-hint">Enter 搜索　Esc 关闭</span>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn primary" id="sp-go">搜索</button>' +
        '</div>' +
      '</div>';

    const input = $('#sp-q');
    input.focus();
    const len = input.value.length;
    input.setSelectionRange(len, len);

    input.addEventListener('input', () => { st.q = input.value; preview(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });

    mask.querySelectorAll('.sp-type').forEach((b) => {
      b.addEventListener('click', () => {
        st.type = b.getAttribute('data-t');
        draw();
      });
    });

    $('#sp-go').addEventListener('click', go);
    bindFilters();
    preview();
  };

  mask.onclick = (e) => { if (e.target === mask) close(); };
  document.addEventListener('keydown', onEsc);
  draw();
}

function setupSearch() {
  const trigger = $('#q');
  if (trigger) trigger.addEventListener('click', () => openSearchPanel());

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';
    const isCmdK = (e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K');
    if ((e.key === '/' && !inField) || isCmdK) {
      e.preventDefault();
      openSearchPanel();
    }
  });
}

/* ---------- 从剪贴板直接打开 ---------- */

async function openFromClipboard() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    toast('读不到剪贴板');
    openSearchPanel();
    return;
  }
  const parsed = parseGithubUrl(text);
  if (parsed) {
    location.hash = parsed.hash;
    toast('已打开 ' + parsed.label);
    return;
  }
  const t = String(text || '').trim();
  if (t && t.length < 120) {
    openSearchPanel({ q: t });
  } else {
    toast('剪贴板里没有可用的链接或关键词');
  }
}

/* ---------------------------- 主题 ---------------------------- */

function setupTheme() {
  let saved = null;
  try { saved = localStorage.getItem('ghl_theme'); } catch (_) {}
  if (saved) document.documentElement.dataset.theme = saved;

  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ghl_theme', next); } catch (_) {}
    toast(next === 'dark' ? '深色' : '浅色');
  });
}

/* ---------------------------- 启动 ---------------------------- */

window.addEventListener('hashchange', route);

document.addEventListener('DOMContentLoaded', () => {
  setupSearch();
  setupTheme();
  updateAuthBadge();
  $('#auth').addEventListener('click', openSettings);
  $('#ch').addEventListener('click', openSettings);
  $('#upd').addEventListener('click', applyUpdate);
  if (!location.hash) location.hash = '#/';
  route();
  maybeOnboard();
  checkUpdate();
  ensureChannels();
});
