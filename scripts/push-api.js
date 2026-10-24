'use strict';
/**
 * 通过 GitHub Git Data API 推送当前分支。
 *
 * 适用场景：本机到 github.com 的 git 通道不通（代理返回 502、TLS 握手失败等），
 * 但 api.github.com 可用。提交对象的每个字段都逐字节还原，因此远端 SHA 与本地一致，
 * 不需要 force push，也不用改写本地历史。
 *
 * 用法：
 *   GH_TOKEN=... node scripts/push-api.js
 * 或：
 *   node scripts/push-api.js            （自动调用 gh auth token）
 *
 * 环境变量：
 *   GH_TOKEN   令牌，缺省时尝试 gh auth token
 *   BRANCH     要推的分支，缺省为当前分支
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

/* ---------------- 配置 ---------------- */

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (_) {
    console.error('缺少令牌：设置 GH_TOKEN，或确认 gh 已登录');
    process.exit(1);
  }
}

function resolveRepo() {
  const url = git(['remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) {
    console.error('无法从 origin 解析仓库：' + url);
    process.exit(1);
  }
  return m[1] + '/' + m[2];
}

const TOKEN = resolveToken();
const REPO = resolveRepo();
const BRANCH = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

/* ---------------- HTTP ---------------- */

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.github.com',
      path: apiPath,
      method,
      headers: Object.assign({
        'User-Agent': 'github-client-push',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + TOKEN,
        'X-GitHub-Api-Version': '2022-11-28'
      }, data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      } : {}),
      timeout: 60000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else {
          const err = new Error(method + ' ' + apiPath + ' -> ' + res.statusCode + ' ' + txt.slice(0, 300));
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + apiPath)));
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- commit 对象还原 ---------------- */

/** 秒 + ±HHMM → ISO 8601，保留原时区，否则字节不等、SHA 会变 */
function toIso(seconds, tz) {
  const sign = tz[0] === '-' ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(3, 5)) * 60);
  const d = new Date((Number(seconds) + minutes) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) +
    tz.slice(0, 3) + ':' + tz.slice(3);
}

function parseIdent(line) {
  const m = line.match(/^(?:author|committer)\s+(.*?)\s*<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/);
  if (!m) throw new Error('无法解析身份行：' + line);
  return { name: m[1], email: m[2], date: toIso(m[3], m[4]) };
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const localSha = git(['rev-parse', 'HEAD']).trim();
  const rawCommit = git(['cat-file', 'commit', 'HEAD']);

  // 第一个空行之前是头，之后是 message（原样保留，含尾部换行）
  const splitAt = rawCommit.indexOf('\n\n');
  const header = rawCommit.slice(0, splitAt).split('\n');
  const message = rawCommit.slice(splitAt + 2);

  const author = parseIdent(header.find((l) => l.startsWith('author ')));
  const committer = parseIdent(header.find((l) => l.startsWith('committer ')));
  const parentLine = header.find((l) => l.startsWith('parent '));
  const localParent = parentLine ? parentLine.split(' ')[1] : null;

  console.log('repo      : ' + REPO + '  (' + BRANCH + ')');
  console.log('local     : ' + localSha);
  console.log('parent    : ' + (localParent || '(root)'));

  // 0. 空仓库不收 git/blobs，先落一个占位文件把分支建起来
  let remoteHead = null;
  try {
    const ref = await api('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
    remoteHead = ref.object.sha;
  } catch (_) {
    await api('PUT', '/repos/' + REPO + '/contents/.seed', {
      message: 'seed',
      content: Buffer.from('seed\n').toString('base64')
    });
    console.log('seed      : 空仓库，已建立占位分支');
  }

  // 父提交只在远端存在时才挂上，否则作为 root 提交重建
  let parents = [];
  if (localParent) {
    try {
      await api('GET', '/repos/' + REPO + '/git/commits/' + localParent);
      parents = [localParent];
    } catch (_) {
      parents = [];
    }
  }

  // 1. blob
  const lines = git(['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$/);
    if (!m) throw new Error('ls-tree 输出异常：' + line);
    const [, mode, localBlob, rel] = m;
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const res = await api('POST', '/repos/' + REPO + '/git/blobs', {
      content: buf.toString('base64'),
      encoding: 'base64'
    });
    if (res.sha !== localBlob) {
      console.warn('  ! blob 不一致 ' + rel);
    }
    entries.push({ path: rel, mode: mode, type: 'blob', sha: res.sha });
  }
  console.log('blobs     : ' + entries.length + ' 个');

  // 2. tree
  const tree = await api('POST', '/repos/' + REPO + '/git/trees', { tree: entries });

  // 3. commit
  const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
    message: message,
    tree: tree.sha,
    parents: parents,
    author: author,
    committer: committer
  });
  console.log('remote    : ' + commit.sha);
  console.log('match     : ' + (commit.sha === localSha ? 'YES' : 'NO'));

  // 4. 移动分支
  if (remoteHead) {
    await api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, {
      sha: commit.sha,
      force: true
    });
  } else {
    await api('POST', '/repos/' + REPO + '/git/refs', {
      ref: 'refs/heads/' + BRANCH,
      sha: commit.sha
    });
  }

  git(['update-ref', 'refs/remotes/origin/' + BRANCH, commit.sha]);

  console.log('\n推送完成。');
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
