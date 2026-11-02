# schedule-app

手机主屏幕上的离线日程。数据存在本机 localStorage，导出 / 导入 JSON 仍然可用。

页面打开时的本地提醒一直都在。关闭应用后的提醒要另外部署下面的 Cloudflare Worker，并用 Web Push 推到 iPhone（iOS 16.4+，且必须从主屏幕打开）。

## 后台提醒

Worker 在 `worker/`。GitHub Pages 不能定时跑代码，所以提醒由 Cloudflare Worker 每分钟检查一次，到点后用 VAPID Web Push 发给服务工作线程。

配置只改两处，两边的公钥必须是同一对：

- `index.html` 顶部的 `PUSH_CONFIG`（`workerUrl`、`vapidPublicKey`，可选 `appToken`）
- `worker/wrangler.toml` 里的 `VAPID_PUBLIC_KEY`，以及 KV 的 `id`

### 1. 注册 Cloudflare

打开 [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) 注册免费账号。Workers 免费额度足够个人使用（每天 10 万次请求，账号最多 5 个 Cron）。

### 2. 登录 Wrangler

```bash
cd worker
npm install
npx wrangler login
```

浏览器会打开授权页，同意即可。

### 3. 创建 KV

```bash
npx wrangler kv namespace create REMINDERS
```

把命令打印的 `id` 填进 `worker/wrangler.toml`，替换 `REPLACE_WITH_KV_ID`。

### 4. 生成 VAPID 密钥

```bash
npm run vapid
```

等价命令：`node scripts/generate-vapid.mjs`。

也可以用 `npx web-push generate-vapid-keys`，公钥、私钥格式相同。只生成一次。换密钥后，手机要重新点「开启后台提醒」。

- 公钥写到 `worker/wrangler.toml` 的 `VAPID_PUBLIC_KEY`
- 公钥再写到 `index.html` 的 `PUSH_CONFIG.vapidPublicKey`
- `VAPID_SUBJECT` 改成你自己的 `mailto:你的邮箱`
- 私钥不要提交。在 `worker/` 目录执行：

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

提示时粘贴私钥，回车。

可选：给接口加口令，避免别人拿到 Worker 地址后写入提醒。

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
npx wrangler secret put APP_TOKEN
```

把同一个字符串填进 `PUSH_CONFIG.appToken`。不设置 `APP_TOKEN` 时接口不校验。

### 5. 部署

```bash
npx wrangler deploy
```

记下输出的地址，例如 `https://schedule-app-push.<账号>.workers.dev`。不要末尾斜杠。

本地试跑（不部署）可以用：

```bash
cp .dev.vars.example .dev.vars
# 把公钥、私钥、VAPID_SUBJECT 写进 .dev.vars
npx wrangler dev
```

### 6. 填回前端

在 `index.html` 顶部：

```javascript
var PUSH_CONFIG={
  workerUrl:'https://schedule-app-push.<账号>.workers.dev',
  vapidPublicKey:'<第 4 步的公钥>',
  appToken:''
};
```

提交并推到 `main`。GitHub Pages 会重新发布 [https://leoxd1007.github.io/schedule-app/](https://leoxd1007.github.io/schedule-app/)。

可以先部署 Worker、写好 `PUSH_CONFIG` 再合并；也可以先合并，再改 `PUSH_CONFIG` 提交一次。

### 7. 手机上打开

1. 用 Safari 打开上面的 Pages 地址。
2. 分享 → 添加到主屏幕。
3. 从主屏幕图标打开（不要停在 Safari 标签页里）。
4. 点「开启后台提醒」，允许通知。
5. 建一条一两分钟后的日程，确认能收到。全天日程按手机本地时间 9:00 起算，和页面里的本地提醒一致。

### 可选：用 GitHub Actions 部署

仓库里已有 `.github/workflows/deploy-worker.yml`。在 GitHub 仓库的 Settings → Secrets and variables → Actions 添加：

- `CLOUDFLARE_API_TOKEN`（需要 Workers 脚本编辑权限和该账号的 KV 权限）
- `CLOUDFLARE_ACCOUNT_ID`（Cloudflare 控制台右侧栏的 Account ID）

两个都存在时，推到 `main` 且改动了 `worker/` 就会执行 `wrangler deploy`。缺任何一个，这一步会跳过，不会让流水线失败。Worker 上已经用 `wrangler secret put` 保存的私钥和 `APP_TOKEN` 会保留。`wrangler.toml` 里的 KV id 和公钥仍然要先写进仓库。

### 限制

- iPhone 只有添加到主屏幕之后，从该图标打开，且系统是 iOS 16.4 及以上，才能订阅 Web Push。Safari 普通标签页不行。通知权限必须由你点击按钮触发。
- Cron 每分钟跑一次，所以提醒可能比设定时间晚大约一分钟，Cloudflare 偶尔还会再晚一点。超过 15 分钟仍未发出的提醒会被跳过，避免晚上打开应用时补发过期通知。
- 后台提醒开启并且和服务器同步成功后，页面打开时不再弹本地通知，避免响两次。同步失败或关闭后台提醒时，仍用原来的页面内提醒。
- 免费版 Cron 每次只有约 10 毫秒 CPU。个人一两台设备通常够用。如果控制台里定时任务报 CPU 超限，需要 Workers 付费方案。
- 推送服务返回 404 或 410 时会删掉这台设备的订阅，需要重新点「开启后台提醒」。
