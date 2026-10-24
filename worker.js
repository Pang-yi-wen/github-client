/**
 * GitHub 中转 · Cloudflare Worker
 *
 * 部署后把 Worker 地址填进客户端「设置 → 自建中转」。
 * 支持两种调用形式：
 *   https://<worker>/https://api.github.com/repos/owner/repo
 *   https://<worker>/?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fowner%2Frepo
 *
 * 只允许转发到 GitHub 的固定几个域名，避免变成开放代理被人滥用。
 */

const ALLOWED_HOSTS = [
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'github.githubassets.com'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, X-GitHub-Api-Version, If-None-Match',
  'Access-Control-Expose-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function resolveTarget(requestUrl) {
  const u = new URL(requestUrl);

  const viaQuery = u.searchParams.get('url');
  if (viaQuery) return viaQuery;

  // 路径形如 /https://host/path 或 /host/path
  let rest = u.pathname.replace(/^\/+/, '');
  if (rest.startsWith('https:/') && !rest.startsWith('https://')) rest = rest.replace('https:/', 'https://');
  if (rest.startsWith('http:/') && !rest.startsWith('http://')) rest = rest.replace('http:/', 'http://');
  if (!/^https?:\/\//i.test(rest)) rest = 'https://' + rest;
  return rest + (u.search || '');
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'Only GET / HEAD are forwarded');
    }

    let target;
    try {
      target = resolveTarget(request.url);
    } catch (_) {
      return jsonError(400, 'Cannot parse target url');
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch (_) {
      return jsonError(400, 'Invalid target url: ' + target);
    }

    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return jsonError(403, 'Host not allowed: ' + parsed.hostname);
    }

    // 只保留必要的请求头，避免把 Worker 自身的头透传出去
    const headers = new Headers();
    const pass = ['authorization', 'accept', 'x-github-api-version', 'if-none-match', 'user-agent'];
    for (const key of pass) {
      const v = request.headers.get(key);
      if (v) headers.set(key, v);
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'github-relay-worker/1.0');

    let upstream;
    try {
      upstream = await fetch(parsed.toString(), {
        method: request.method,
        headers,
        redirect: 'follow',
        cf: {
          // 让 GitHub 的 CDN 缓存生效，减少回源
          cacheTtl: 60,
          cacheEverything: false
        }
      });
    } catch (e) {
      return jsonError(502, 'Upstream fetch failed: ' + e.message);
    }

    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    out.delete('content-security-policy');
    out.delete('content-encoding');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out
    });
  }
};
