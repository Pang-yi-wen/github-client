/**
 * 匿名计数端点。部署到 Cloudflare Workers，绑定一个 Durable Object。
 *
 * 绑定（wrangler.toml）：
 *   [durable_objects]
 *   bindings = [{ name = "COUNTER_DO", class_name = "Counter" }]
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_classes = ["Counter"]
 *
 * 计数存放在 Durable Object 的存储里，单实例串行累加，并发不丢。
 *
 * 路由：
 *   /hit?k=<名称>    计数 +1，返回当前值
 *   /stats           返回全部计数
 *
 * 只累计数字，不记录 IP、User-Agent 或任何标识。
 */

const KEYS = ['view', 'unique', 'search', 'repo', 'translate'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { ...CORS, 'Content-Type': 'application/json' }
});

/** 名称只保留小写字母、数字、下划线、连字符，截断到 24 字符；空则退为 view */
const clean = (k) => String(k || 'view').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'view';

/* ------------------------- Durable Object ------------------------- */

export class Counter {
  constructor(state) {
    this.state = state;
    this.counts = {};
    // ready 只创建一次：所有 bump 都等它完成后再同步累加，不会出现读-改-写竞争
    this.ready = state.storage.get('counts').then((v) => { this.counts = v || {}; });
  }

  async bump(kind) {
    await this.ready;
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    await this.state.storage.put('counts', this.counts);
    return this.counts[kind];
  }

  async all() {
    await this.ready;
    return this.counts;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__bump') {
      return json({ ok: true, value: await this.bump(clean(url.searchParams.get('k'))) });
    }
    if (url.pathname === '/__all') {
      return json(await this.all());
    }
    return json({ error: 'not found' }, 404);
  }
}

/* ----------------------------- Worker ----------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!env.COUNTER_DO) {
      return json({ error: '未绑定 Durable Object COUNTER_DO' }, 500);
    }

    const stub = env.COUNTER_DO.get(env.COUNTER_DO.idFromName('global'));

    if (url.pathname === '/hit') {
      const kind = clean(url.searchParams.get('k'));
      const r = await stub.fetch(new Request('https://counter/__bump?k=' + encodeURIComponent(kind)));
      return json(await r.json());
    }

    if (url.pathname === '/stats') {
      const counts = await (await stub.fetch(new Request('https://counter/__all'))).json();
      const out = {};
      for (const k of KEYS) out[k] = Number(counts[k] || 0);
      return json(out);
    }

    return json({ error: 'not found' }, 404);
  }
};
