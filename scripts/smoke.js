// 冒烟：用最小 DOM stub 执行 app.js 顶层，抓 TDZ / 未定义引用这类加载期崩溃
// 用法：node scripts/smoke.js
const fs = require('fs');
const vm = require('vm');
const noop = () => {};
const mkEl = () => ({
  addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop,
  getAttribute: () => null, removeAttribute: noop, style: {}, dataset: {}, appendChild: noop,
  insertBefore: noop, removeChild: noop, focus: noop, setSelectionRange: noop, reset: noop,
  value: '', textContent: '', innerHTML: '', hidden: false, tagName: 'DIV', checked: false
});
const store = {};
const sandbox = {
  console,
  document: {
    querySelector: () => mkEl(), querySelectorAll: () => [], getElementById: () => mkEl(),
    createElement: () => mkEl(), addEventListener: noop, removeEventListener: noop,
    documentElement: { dataset: {} }, body: mkEl(), hidden: false, activeElement: mkEl()
  },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }, key: () => null, length: 0
  },
  location: { hash: '', reload: noop, href: '' },
  navigator: { userAgent: 'node', clipboard: { readText: async () => '' } },
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  marked: {
    parse: (s) => s,
    Renderer: class { constructor() { this.link = () => ''; this.image = () => ''; } },
    use: noop, setOptions: noop
  },
  hljs: undefined,
  performance: { now: () => Date.now() },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  caches: undefined,
  Storage: class {}
};
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
try {
  vm.runInNewContext(code, sandbox, { filename: 'app.js', timeout: 5000 });
  console.log('LOAD OK: app.js 顶层执行无异常');
} catch (e) {
  console.error('LOAD FAIL: ' + e.name + ': ' + e.message);
  console.error((e.stack || '').split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
