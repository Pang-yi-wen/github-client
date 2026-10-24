'use strict';
/**
 * 把 src/ 与 vendor/ 拼成单个自包含 HTML。
 *   node build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const VENDOR = path.join(ROOT, 'vendor');
const OUT = path.join(ROOT, 'GitHub.html');

const read = (p) => fs.readFileSync(p, 'utf8');

/** 给 hljs 主题加主题作用域，避免深浅两套互相覆盖 */
function scopeCss(css, theme) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!sels.length) continue;
    const scoped = sels.map(s => `[data-theme="${theme}"] ${s}`).join(',');
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (body) rules.push(`${scoped}{${body}}`);
  }
  return rules.join('\n');
}

/** 内联进 <script> 时，避免提前闭合 */
function safeJs(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function main() {
  const shell = read(path.join(SRC, 'shell.html'));
  const style = read(path.join(SRC, 'style.css'));
  const app = read(path.join(SRC, 'app.js'));
  const marked = read(path.join(VENDOR, 'marked.min.js'));
  const hljs = read(path.join(VENDOR, 'highlight.min.js'));

  const hljsDark = read(path.join(VENDOR, 'hljs-github-dark.min.css'));
  const hljsLight = read(path.join(VENDOR, 'hljs-github-light.min.css'));

  const css = [
    '/* ---- base ---- */',
    style,
    '/* ---- syntax: dark ---- */',
    scopeCss(hljsDark, 'dark'),
    '/* ---- syntax: light ---- */',
    scopeCss(hljsLight, 'light')
  ].join('\n\n');

  const html = shell
    .replace('/*{{STYLE}}*/', () => css)
    .replace('/*{{MARKED}}*/', () => safeJs(marked))
    .replace('/*{{HLJS}}*/', () => safeJs(hljs))
    .replace('/*{{APP}}*/', () => safeJs(app));

  fs.writeFileSync(OUT, html, 'utf8');

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('built  ' + OUT);
  console.log('  total    ' + kb(Buffer.byteLength(html)));
  console.log('  style    ' + kb(Buffer.byteLength(css)));
  console.log('  marked   ' + kb(Buffer.byteLength(marked)));
  console.log('  hljs     ' + kb(Buffer.byteLength(hljs)));
  console.log('  app      ' + kb(Buffer.byteLength(app)));
}

main();
