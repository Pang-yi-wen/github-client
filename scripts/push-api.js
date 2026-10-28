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

/**
 * 待推送的提交列表（按时间从旧到新）。
 * COMMITS：显式列出 SHA，逗号分隔
 * FROM   ：起点（不含），自动展开 git rev-list --reverse FROM..HEAD
 * 缺省   ：只推 HEAD
 *
 * 一次推多个提交时必须给全链路：Git Data API 创建 commit 时父对象必须已在远端，
 * 否则 API 不会报错、而是静默建成 root 提交，远端 SHA 与本地不一致。
 */
function resolveCommits() {
  if (process.env.COMMITS) {
    return process.env.COMMITS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.FROM) {
    return git(['rev-list', '--reverse', process.env.FROM.trim() + '..HEAD'])
      .split('\n').filter(Boolean);
  }
  return [git(['rev-parse', 'HEAD']).trim()];
}

/** 读取一个本地提交对象：头字段 + 原始 message */
function readCommit(sha) {
  const raw = git(['cat-file', 'commit', sha]);
  // 第一个空行之前是头，之后是 message（原样保留，含尾部换行）
  const splitAt = raw.indexOf('\n\n');
  const header = raw.slice(0, splitAt).split('\n');
  const message = raw.slice(splitAt + 2);
  return {
    sha,
    tree: (header.find((l) => l.startsWith('tree ')) || '').split(' ')[1],
    parents: header.filter((l) => l.startsWith('parent ')).map((l) => l.split(' ')[1]),
    author: parseIdent(header.find((l) => l.startsWith('author '))),
    committer: parseIdent(header.find((l) => l.startsWith('committer '))),
    message
  };
}

/** 把一棵树的所有 blob 传到远端；返回建树用的 entries */
async function pushTree(localSha) {
  const lines = git(['ls-tree', '-r', localSha]).split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (!m) throw new Error('ls-tree 输出异常：' + line);
    const [, mode, type, blobSha, rel] = m;
    if (type !== 'blob') continue; // 仓库里没有子模块
    let remoteSha = null;
    try {
      // 已存在就不用重传；大仓库这一步能省掉大半请求
      await api('GET', '/repos/' + REPO + '/git/blobs/' + blobSha);
      remoteSha = blobSha;
    } catch (_) {
      // 必须按 blob SHA 取内容：读工作区文件在推历史提交时会拿到新版本，树会不对
      const buf = execFileSync('git', ['cat-file', 'blob', blobSha],
        { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      const res = await api('POST', '/repos/' + REPO + '/git/blobs', {
        content: buf.toString('base64'),
        encoding: 'base64'
      });
      if (res.sha !== blobSha) console.warn('  ! blob 不一致 ' + rel);
      remoteSha = res.sha;
    }
    entries.push({ path: rel, mode, type: 'blob', sha: remoteSha });
  }
  const tree = await api('POST', '/repos/' + REPO + '/git/trees', { tree: entries });
  return { tree, count: entries.length };
}

(async () => {
  const list = resolveCommits();
  console.log('repo      : ' + REPO + '  (' + BRANCH + ')');
  console.log('commits   : ' + list.join(' '));

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

  // 本地 SHA → 远端 SHA；本次推多个提交时要靠它把父提交串起来
  const pushed = new Map();
  let last = null;

  for (const localSha of list) {
    const c = readCommit(localSha);

    const parents = [];
    for (const p of c.parents) {
      if (pushed.has(p)) { parents.push(pushed.get(p)); continue; }
      try {
        await api('GET', '/repos/' + REPO + '/git/commits/' + p);
        parents.push(p);
      } catch (_) {
        if (process.env.ALLOW_ROOT === '1') {
          console.warn('  ! 父提交不在远端，建成 root：' + p);
          continue;
        }
        throw new Error('父提交不在远端：' + p + '。请把它一并列入 COMMITS（或设 FROM），' +
          '否则 API 会静默建成 root 提交导致 SHA 漂移；确要 root 请设 ALLOW_ROOT=1。');
      }
    }

    const { tree, count } = await pushTree(localSha);
    const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
      message: c.message,
      tree: tree.sha,
      parents,
      author: c.author,
      committer: c.committer
    });

    pushed.set(localSha, commit.sha);
    last = commit.sha;
    console.log([
      '  local    ' + localSha.slice(0, 7),
      'remote  ' + commit.sha.slice(0, 7),
      'blobs   ' + count,
      'tree    ' + (tree.sha === c.tree ? 'ok' : 'MISMATCH ' + tree.sha + ' != ' + c.tree),
      'match   ' + (commit.sha === localSha ? 'YES' : 'NO')
    ].join('  '));
  }

  // 移动分支
  if (remoteHead) {
    await api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: last, force: true });
  } else {
    await api('POST', '/repos/' + REPO + '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: last });
  }

  // tracking ref 只能指向本地存在的对象；SHA 漂移时跳过
  const localHas = (sha) => {
    try { git(['cat-file', '-e', sha]); return true; } catch (_) { return false; }
  };
  if (localHas(last)) git(['update-ref', 'refs/remotes/origin/' + BRANCH, last]);
  else console.warn('! 远端 SHA 与本地不一致，未更新 refs/remotes/origin/' + BRANCH);

  console.log('\n推送完成：' + list.length + ' 个提交 -> ' + last);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
