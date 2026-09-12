# WO

[English](README.md) | **简体中文**

**听见彼此，看见同一个世界。**

WO 是一个可自托管的双人语音与桌面共享应用。中心模式由自己的
Docker Compose 提供账号、房间信令、Web、PostgreSQL 和 TURN；媒体优先在两端
直接传输。桌面端还提供仅面向可信局域网的轻量房间模式。

[桌面客户端下载](https://github.com/kiritoko1029/WO/releases) ·
[部署指南](docs/deployment.md) · [支持矩阵](docs/support-matrix.md)

![WO 浅色登录页：产品介绍、账号入口和服务器设置](docs/screenshots/auth-light.jpg)

## 可以做什么

- **两个人，一个房间。** 创建房间，把 6 位房间码或邀请链接发给对方，即可加入。
- **让交流更舒服。** 选择麦克风和扬声器，调节输入与对方音量，按需静音，使用平台支持的降噪方式。
- **分享眼前的内容。** 在语音通话中共享屏幕或窗口，支持全屏观看、缩放和连接质量诊断。屏幕采集与系统音频能力以支持矩阵为准。
- **选择自己的连接方式。** 桌面端和 Web 可连接自托管服务；同一可信局域网内，两台桌面客户端也能建立轻量房间。
- **清楚、顺手的操作。** 支持浅色、深色和跟随系统主题；表单区分正在创建与正在加入，防止重复提交，失败后可重试，弹窗支持键盘导航。

## 界面预览

| 从一个邀请开始                                                        | 为两个人留出专注的空间                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ![WO 首页：创建房间与输入房间码加入](docs/screenshots/home-light.jpg) | ![WO 深色房间：参与者、共享舞台与通话控制](docs/screenshots/room-dark.jpg) |

以上图片直接截取自应用共用的 React 界面，使用本地示例账号和模拟的已连接房间；
房间图展示的是等待屏幕共享状态。图片用于展示界面，不作为真实媒体性能或发布认证证据。
复现方式见[界面预览与截图说明](docs/ui-preview.md)。

## 选择连接模式

|          | 自托管中心模式                   | 可信局域网轻量模式               |
| -------- | -------------------------------- | -------------------------------- |
| 客户端   | 桌面端与 Web                     | 两台桌面客户端                   |
| 使用范围 | 配置 HTTPS 和 TURN 后跨网络连接  | 同一个可信私有网络               |
| 账号     | 自建服务上的邮箱账号             | 仅需显示名称                     |
| 邀请方式 | 6 位房间码或链接                 | 必须使用完整的私密客户端邀请链接 |
| 基础设施 | Docker Compose、PostgreSQL、TURN | 房主电脑内的临时服务             |
| 房间结束 | 房主结束或离开房间               | 房主休眠、退出应用时也会结束     |

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

生产环境准备 Linux x86_64、Git、Docker Engine 26+ 和 Docker Compose 2.24.4+，
将域名 A 记录指向服务器并开放 HTTPS/TURN 端口。在克隆的仓库根目录执行：

```bash
bash deploy.sh
```

按提示填写域名、ACME 联系邮箱、管理员邮箱、公网 IPv4 和密码（也可自动生成）。
向导自动生成配置与密钥、初始化管理员、通过 ACME 签发证书并启动五个服务。
无需修改源码、环境文件或手工放置证书，也无需在宿主机安装 Node.js/pnpm；
证书自动续期，Caddy 和 TURN 自动加载新证书。

Windows Docker Desktop 可先进行隔离的本地体验：

```powershell
.\deploy.cmd --local
```

本地入口为 `https://wo.localhost:18443`，使用测试证书；生产入口为你的 HTTPS 域名。
访问 `/admin` 查看用户、房间和证书状态。首登信息保存在私密的
`deploy/.managed/<项目名>/first-login.txt`（生产默认 `wo`，本地默认 `wo-local`）。
再次运行 `up` 保持已有版本和密码，也支持 `status`、`logs`、`renew`、`stop`。

端口、首次登录、测试证书信任和故障排查见[向导部署指南](docs/quick-deploy.md)。
需要自管证书、外部数据库、备份或发布运维时，参阅[高级部署文档](docs/deployment.md)。

![本地 Docker 验收环境中的管理后台与证书状态](docs/screenshots/admin-deployment.jpg)

后台截图来自真实的本机 Docker 验收环境，使用本地测试证书。

## 桌面端连接自建服务

桌面客户端在登录页和登录后的首页都显示“服务器”。填写的值必须是规范的
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

无需后端、真实账号或媒体权限，即可预览界面：

```bash
pnpm --filter @wo/web dev --host 127.0.0.1
```

打开 `http://127.0.0.1:5173/preview/index.html`。预览使用独立的开发入口，不会进入正式 Web 构建。
常规 Web 开发仍使用根页面，并把 `/v1` 代理到本机 3000 端口的服务。

客户端会合并同一连接的并发 WebRTC 统计请求，双向质量采样复用一份报告；
音量未变化时不通知界面，旧连接的迟到统计会被丢弃。
回归测试验证了请求调度和资源生命周期，实际 CPU 占用、延迟和帧率仍取决于设备与网络。

Web E2E 会使用 `deploy/.env.integration` 启动并清理隔离的四服务 Compose
栈，以两个 Chromium 会话验证创建、加入和双向语音。

桌面/Web 的开发与打包命令分别位于
[`apps/desktop/package.json`](apps/desktop/package.json) 和
[`apps/web/package.json`](apps/web/package.json)。

## 桌面发版构建

在 Actions 页面运行 **Desktop release** 工作流，即可自动打包 Windows
（x64 安装版 + 便携版）与 macOS（x64 + arm64 DMG/ZIP）客户端，并把产物
挂到 GitHub Release。默认两平台均为 unsigned-development 构建（打包门禁会
标记为不可分发）；签名（及公证）所需的仓库密钥见工作流文件内的说明。

## 许可证

以 [MIT License](LICENSE) 发布。
