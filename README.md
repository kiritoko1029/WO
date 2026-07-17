# WO

WO 是一个可自托管的双人语音与桌面共享应用。中心模式由自己的
Docker Compose 提供账号、房间信令、Web、PostgreSQL 和 TURN；媒体优先在两端
直接传输。桌面端还提供仅面向可信局域网的轻量房间模式。

> 当前能力有自动化测试，但 Windows/macOS 正式安装包、真实双机局域网和
> 1080p60 仍未完成发布认证。准确状态见
> [支持矩阵](docs/support-matrix.md)。

## 仓库组成

| 路径                    | 作用                                              |
| ----------------------- | ------------------------------------------------- |
| `apps/desktop`          | Electron 桌面客户端                               |
| `apps/web`              | 复用桌面 React/WebRTC 层的浏览器客户端            |
| `apps/server`           | 中心 API、房间信令，以及可嵌入的局域网轻量服务    |
| `packages/protocol`     | REST、信令、邀请和 WebRTC 的共享运行时协议        |
| `packages/database`     | PostgreSQL schema 与迁移                          |
| `packages/config`       | 中心服务配置                                      |
| `packages/media-policy` | 媒体参数与策略                                    |
| `deploy`                | Caddy、server、PostgreSQL、coturn 的 Compose 部署 |
| `apps/media-lab-*`      | 媒体能力实验工具，不属于生产入口                  |

## 中心模式快速开始

要求 Node.js 24、pnpm 10.32.1、Docker Engine 和 Docker Compose 2.24.4+。

```bash
pnpm install --frozen-lockfile
cp deploy/.env.example deploy/.env
node deploy/scripts/init-secrets.mjs
```

编辑 `deploy/.env`，为应用和 TURN 配置真实域名、证书及公网 IPv4，然后运行：

```bash
node deploy/scripts/preflight.mjs --env-file=deploy/.env
docker compose --project-name wo --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
node deploy/scripts/smoke.mjs --env-file=deploy/.env
```

打开 `https://<APP_DOMAIN>` 即可使用 Web 客户端。Caddy 在同一 HTTPS origin
提供 SPA，并把 `/v1/*` 和实时 WebSocket 代理到 server；不需要单独配置 Web
域名或 CORS。完整的证书、防火墙、备份与升级要求见
[部署文档](docs/deployment.md)。

## 桌面端连接自建服务

桌面客户端在登录页和登录后的首页都显示“后端服务”。填写的值必须是规范的
HTTPS origin：

```text
https://wo.example.com
```

不能包含路径、查询参数、片段、用户名或密码。保存后客户端会重启，使 REST、
WSS、CSP 和会话都切换到同一个 origin。

后端地址优先级为：

```text
WO_API_ORIGIN > 桌面用户配置 > https://localhost
```

例如运维可固定地址：

```bash
WO_API_ORIGIN=https://wo.example.com pnpm --filter @wo/desktop dev
```

设置 `WO_API_ORIGIN` 后界面只读。refresh token 与 origin 绑定，切换服务不会把
旧服务凭据发送到新服务。自签证书只用于隔离测试；应把公开 CA 证书正确加入
系统信任库，不要关闭 TLS 校验。

## 加入和分享房间

中心房间可分享 6 位房间码，或直接复制两种链接：

```text
https://wo.example.com/join/123456
wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456
```

HTTPS 链接可继续使用同源 Web 客户端，也可通过页面上的“在 WO 客户端打开”
唤起已安装客户端。邀请指向另一个中心服务时，桌面客户端会显示目标域名并要求
确认；确认后重启并在目标服务重新登录，不会静默切换或沿用原登录态。

不要手工拼接 `wo://` 链接。客户端会严格校验协议版本、服务 origin、房间码和
局域网邀请字段。

## 可信局域网轻量模式

轻量模式仅用于两台桌面设备处于同一可信 RFC1918 局域网的场景：

1. 房主在登录页或首页选择“可信局域网”，输入显示名称并创建房间。
2. 房主在房间内复制“客户端邀请链接”，私下发送给另一台设备。
3. 加入方打开链接；也可选择“可信局域网”与“加入房间”，输入显示名称并粘贴
   完整 `wo://` 邀请。

- 创建房间的一方在桌面进程内启动临时双人服务；
- 不需要中心服务、账号、PostgreSQL 或 TURN；
- 房主退出、设备休眠或服务关闭时房间结束；绑定地址消失或网卡身份变化由默认 5 秒轮询检测后关闭；
- 6 位房间码只用于人工核对，不能单独发现房主，也不是认证凭据；
- 完整邀请还包含房主私网地址、随机端口和 256 位随机密钥；
- 信令帧使用 HMAC-SHA-256 认证并拒绝重放，但 `ws://`/`http://` 传输本身不
  加密。

因此不要在访客 Wi-Fi、公共网络或不受信任的企业网段使用轻量模式。知道房间码
的人仍无法只靠房间码找到或加入房间；必须获得创建者分享的完整邀请。
完整邀请等同临时访问凭据，不要发送到公共频道或日志。

该模式已有协议、服务和自动化集成证据，但尚未经过两台真实 Windows/macOS
设备的语音、屏幕共享和防火墙认证，状态为 `IMPLEMENTED, NOT CERTIFIED`。

## Web 支持边界

Web 首版支持当前桌面 Chrome 和 Edge，并固定使用页面自己的同源后端。refresh
token 只保存在当前标签页的 `sessionStorage`，关闭标签页后需要重新登录。
屏幕共享使用浏览器原生选择器；浏览器没有 `getDisplayMedia()` 时降级为仅语音。
Safari、Firefox 和移动浏览器不在当前屏幕共享承诺范围内。

## 开发检查

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:contract
pnpm test:e2e:web
```

Web E2E 会使用 `deploy/.env.integration` 启动并清理隔离的四服务 Compose
栈，以两个 Chromium 会话验证创建、加入和双向语音。

桌面/Web 的开发与打包命令分别位于
[`apps/desktop/package.json`](apps/desktop/package.json) 和
[`apps/web/package.json`](apps/web/package.json)。
