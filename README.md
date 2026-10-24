# GitHub 客户端

一个只读 GitHub 的静态单页。`GitHub.html` 双击即用，或改名 `index.html` 丢到任意静态托管。

不抓取网页，只调官方 REST API，因此不受前端改版影响；API 不通时自动换通路。

## 通路

请求按顺序尝试，任一失败切下一条：

| 通路 | 地址 | 前提 |
| --- | --- | --- |
| 直连 | `api.github.com` | 网络可达 GitHub |
| 自建 | 自填，见 `worker.js` | 有自己的 Cloudflare Worker 或反代 |
| 公共 | `gh-proxy.org` → `gh-proxy.com` | 无需配置；额度由该站共享，可能被用尽 |

文件内容与 README 图片另走 raw 通道（`raw.githubusercontent.com` → `gh-proxy.org` → `gh-proxy.com` → `ghfast.top` → API 二进制），不占 API 额度。因此 API 完全不可用时，仍能浏览已进入的仓库文件。

探测端点用 `/rate_limit`，不消耗额度。顶栏徽标显示当前通路与延迟，绿色为直连或自建，黄色为公共中转。

## 本地缓存

浏览过的响应存在 `localStorage`，有效期内再次访问不发请求，因此不消耗配额。

| 内容 | 有效期 |
| --- | --- |
| 文件、目录、搜索 | 5–10 分钟 |
| 提交、议题、PR | 4–5 分钟 |
| 仓库信息 | 8 分钟 |
| 发行版、分支 | 15 分钟 |
| 用户主页 | 20 分钟 |
| README | 30 分钟 |

换令牌会清空缓存（可见范围变了）。设置面板里能看到条数，也可手动清空。

## 用法

打开后填一次访问令牌即可（右上「未授权」）。面板里可以直接跳到 GitHub 的令牌生成页（已预填 `public_repo,read:org` 作用域），也可以复制 `gh auth token` 命令到终端取现成的。

| 项 | 匿名 | 带令牌 |
| --- | --- | --- |
| 核心接口额度 | 60 次/小时 | 5000 次/小时 |
| 代码搜索 | 不可用 | 可用 |
| 私有仓库 | 不可用 | 可用 |

把 github.com 的链接粘进搜索框，回车即到对应页面，不用手动找：

| 粘进来的链接 | 去往 |
| --- | --- |
| `github.com/o/r` | 仓库首页 |
| `.../blob/<分支>/<路径>` | 文件 |
| `.../tree/<分支>/<路径>` | 目录 |
| `.../issues`、`.../issues/12` | 议题列表 / 议题 |
| `.../pulls`、`.../pull/34` | PR 列表 / PR |
| `.../releases`、`.../commits`、`.../branches`、`.../commit/<sha>` | 对应标签页 |
| `github.com/<用户>` | 用户主页 |
| `raw.githubusercontent.com/...` | 文件 |

不带协议（`github.com/o/r`）也认。首页的「从剪贴板打开」省去粘贴这一步。

已支持：仓库浏览、目录树、文件查看与语法高亮、README 渲染、Markdown 预览、Issue / PR 只读、评论正文、提交历史、发行版、分支、用户主页、仓库 / 代码 / 用户 / 议题搜索、按仓库生成下载与克隆地址。

快捷键：`/` 或 `Ctrl+K` 聚焦搜索，`Esc` 收起。

## 边界

- 只读。开 issue、star、push 等写操作不在此处完成。
- 无后端。所有请求由浏览器直连 GitHub 或用户指定的中转，没有中间服务器。
- 令牌存在浏览器 `localStorage`，随请求直接发往 GitHub。走公共中转时该服务能看到请求头，介意就用直连或自建。
- 私有仓库、代码搜索依赖令牌权限；令牌需带 `repo` 与 `read:org` 作用域。
- 单页约 280 KB，依赖全部内联，断网也能打开界面。

## 部署

纯静态，无构建步骤：

| 平台 | 做法 |
| --- | --- |
| Cloudflare Pages | 上传 `GitHub.html`，改名 `index.html` |
| Vercel / Netlify | 同上，或拖整个目录 |
| 自有服务器 | 放进 web 根目录 |

### 自建中转

公共中转的额度不受自己控制，长期用建议自建：

1. 在 Cloudflare 新建 Worker，粘贴 `worker.js` 内容，部署。
2. 复制 Worker 地址（`https://xxx.workers.dev/`）。
3. 填入客户端「设置 → 自建中转」，点保存。

Worker 只转发白名单内的 GitHub 域名，避免被当作开放代理滥用；用户令牌原样透传，额度是独立的。

Nginx 亦可替代，把 `/https://api.github.com/...` 转发到上游并补上 `Access-Control-Allow-Origin` 与 `Access-Control-Allow-Headers` 即可。

## 构建

修改 `src/` 或 `vendor/` 后重新生成单文件：

```
node build.js
```

## 文件

```
GitHub.html           成品，单文件，可直接部署
worker.js             Cloudflare Worker 中转
build.js              把 src 与 vendor 内联成单文件
src/shell.html        外壳模板
src/style.css         样式
src/app.js            应用逻辑
vendor/               marked、highlight.js
scripts/push-api.js   git 通道不通时经 API 推送（维护用）
```
