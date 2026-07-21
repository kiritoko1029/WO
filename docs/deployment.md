# Docker 部署

本部署只运行四个长期服务：Caddy、应用 server、PostgreSQL 和 coturn。Caddy
镜像在构建阶段同时生成 Web SPA，因此 Web 不增加第五个运行服务。语音与桌面
视频优先走两端 P2P，无法直连时只回落到本机部署的 coturn，不依赖第三方实时
音视频、公共 STUN、SFU 或录制服务。

当前业务数据只有账号和会话，不需要对象存储，因此 Compose 不包含 MinIO、RustFS、Redis 或 mediasoup。未来确实出现对象数据时，只接入 RustFS，并先补独立的数据生命周期设计。

## 同源入口

Compose 启动后，一个 `APP_DOMAIN` 同时提供 Web、REST 和实时 WebSocket：

```text
https://rtc.example.com/            Web 客户端
https://rtc.example.com/join/123456 Web 房间邀请
https://rtc.example.com/v1/*        REST / WebSocket
```

Caddy 对 `/v1` 和 `/v1/*` 反向代理，其余路径先查找静态文件，再回退到
`/index.html`。Web 客户端只连接当前页面的同源后端，不启用跨域 CORS。refresh
token 只写入当前标签页的 `sessionStorage`；关闭标签页后需要重新登录。

首版浏览器范围是当前桌面 Chrome 和 Edge。屏幕共享由浏览器原生
`getDisplayMedia()` 选择器完成；能力缺失时保留语音并隐藏不可用的共享入口。

## 主机准备

- 生产环境使用 Linux x86_64/arm64 主机、Docker Engine 和 Docker Compose 2.24.4 或更高版本。
- 为 `APP_DOMAIN` 和 `TURN_HOST` 配置指向同一公网 IPv4 的 DNS A 记录。
- Caddy 通过 ACME 管理 HTTPS 证书；coturn 使用单独的证书和私钥，Caddy 不代理 TURN。
- 中国大陆主机需先确认 Docker 镜像源、DNS 和证书颁发机构可达。媒体流本身不会经过这些下载或证书服务。

防火墙只需开放：

- `80/TCP`、`443/TCP`：Caddy；
- `3478/TCP+UDP`：STUN/TURN；
- `5349/TCP+UDP`：TURN TLS/DTLS；
- `49160-49200/UDP`：TURN relay；范围可在 `.env` 中缩小或平移，但最多 200 个端口。

PostgreSQL 和 server 没有宿主机映射端口。

`TURN_PORT` 和 `TURN_TLS_PORT` 是宿主机公开端口；coturn 容器内始终监听 `3478` 和 `5349`。`TURN_URLS` 中的 `stun:`/`turn:` 端口必须等于 `TURN_PORT`，`turns:` 端口必须等于 `TURN_TLS_PORT`。两个端口不能相同，也不能占用 Caddy 的 `80/443`。

## 生产启动

从仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
node deploy/scripts/init-secrets.mjs
```

编辑 `deploy/.env`，替换示例域名、公网 IPv4 和邮箱。初始化脚本只生成三个 32 字节随机 secret 文件，使用原子新建，绝不会覆盖现有文件。

另行申请 `TURN_HOST` 的可信证书，将完整证书链和私钥分别放到：

```text
deploy/secrets/turn_tls_cert.pem
deploy/secrets/turn_tls_key.pem
```

生产预检要求证书可解析、至少还有 7 天有效期、主机名匹配、证书与私钥匹配，并拒绝自签证书。私钥和三个随机 secret 在 Linux 上应为 `0600`。

先运行安全预检：

```bash
node deploy/scripts/preflight.mjs --env-file=deploy/.env
```

预检会验证 Linux 主机意图、Docker/Compose 版本、DNS、公网 IPv4、端口占用、磁盘、目录、secret、TURN 证书以及最终 Compose 渲染。通过后，一条命令启动并等待四个服务健康：

```bash
docker compose --project-name wo --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
```

server 会在监听前执行带校验和和数据库锁的迁移；Caddy 只在 server 健康后对外服务。可用下面的命令查看状态和运行完整冒烟流程：

```bash
docker compose --project-name wo --env-file deploy/.env -f deploy/compose.yaml ps
node deploy/scripts/smoke.mjs --env-file=deploy/.env
```

冒烟流程创建三个随机临时账号，验证两人房间、第三人拒绝、offer/answer/candidate 转发、屏幕租约、房间结束和会话注销。脚本不会输出 token、SDP 或凭据。

部署完成后访问 `https://${APP_DOMAIN}`。房间页可复制
`https://${APP_DOMAIN}/join/<6位房间码>` 或 `wo://` 客户端邀请；HTTPS 邀请
既能继续使用 Web，也能通过显式按钮唤起桌面客户端。

## 桌面客户端配置

桌面客户端可在登录页和登录后的首页配置此部署。地址必须是 canonical HTTPS
origin，例如：

```text
https://rtc.example.com
```

不能包含路径、查询、片段或 URL 凭据。保存后客户端重启，REST、WSS、CSP 和
会话都使用新 origin。优先级为
`WO_API_ORIGIN > 已保存用户配置 > https://localhost`；存在
`WO_API_ORIGIN` 时界面显示为运维管理且不可编辑。

refresh token 按 origin 隔离。打开来自其他服务的邀请时，桌面客户端必须先
显示目标域名并由用户确认，随后重启并在目标服务重新登录；它不会把旧 origin
的凭据发送给新服务。

本地集成的自签证书只适用于隔离测试。桌面手工联调应安装公开 CA 证书，不能
关闭 TLS 校验。

## 外部 Nginx / OpenResty 反代（1Panel 等）

标准 `deploy/compose.yaml` 使用内置 Caddy 终止 HTTPS。若改用仓库根目录
`docker-compose.yml` / `docker-compose.external-db.yml`，只发布 server
（默认 `18080→3000`）和 coturn，则由宿主机上的 Nginx、OpenResty 或 1Panel
负责 `APP_DOMAIN` 的 HTTPS 与反代。

### 必须反代与禁止反代

| 流量 | 处理 |
|------|------|
| `https://${APP_DOMAIN}/`、`/v1/*` | 反代到 `http://127.0.0.1:18080`（或你设置的 `WO_HTTP_PORT`） |
| `wss://${APP_DOMAIN}/v1/realtime` | **同一 origin**，必须正确升级 WebSocket |
| `stun:` / `turn:` / `turns:`（`TURN_HOST`） | **不要** HTTP 反代；客户端直连 coturn 的 `3478`/`5349` 与 relay UDP 段 |

桌面与 Web 的「服务器」均填 canonical HTTPS origin，例如
`https://wo.example.com`，不要填 `turn.` 子域或带路径的 URL。

### WebSocket 关键配置

信令依赖 `GET /v1/realtime` 的 WebSocket 升级。下列错误几乎都来自反代未正确
传递 `Upgrade` / `Connection`：

```text
HTTP/1.1 400 Bad Request
Invalid Upgrade header
```

客户端会表现为「实时服务暂不可用」，登录与 REST 仍可能正常。

**禁止**使用 `proxy_set_header Connection $http_connection;`。客户端常见
`Connection: keep-alive`，上游收不到 `upgrade`，101 握手会失败。

### 推荐配置

在 `http {}`（1Panel 全局配置或站点配置最上方）增加：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

站点 `server` 内（TLS 证书由 1Panel / certbot 管理时可保留其 `listen` 与
`ssl_certificate` 段，只替换 `location`）：

```nginx
# WebSocket 信令：单独 location，显式 upgrade
location = /v1/realtime {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  $server_port;

    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_connect_timeout 60s;
    proxy_read_timeout    3600s;
    proxy_send_timeout    3600s;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_redirect off;
}

# Web SPA、REST、其余路径
location / {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  $server_port;

    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_connect_timeout 60s;
    proxy_read_timeout    3600s;
    proxy_send_timeout    3600s;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_redirect off;

    client_max_body_size 2m;
}
```

将 `18080` 换成实际的 `WO_HTTP_PORT`。`PUBLIC_URL` / `APP_DOMAIN` 必须与对外
HTTPS 域名一致（例如 `https://wo.example.com`）。

### 无法写 map 时的简化写法

1Panel 若不允许编辑 `http` 级 `map`，把两处 `Connection` 都写成固定值：

```nginx
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection "upgrade";
```

`/v1/realtime` 必须如此；`location /` 使用固定 `"upgrade"` 在本部署下可接受。

### 1Panel 检查清单

- 网站 WebSocket 支持：**开启**
- `APP_DOMAIN` 证书使用**完整链**（fullchain），不要只挂叶子证书
- `TURN_HOST` **不要**建 HTTP 反向代理站点；DNS A 记录指向同一公网 IP 即可
- 防火墙 / 安全组放行：`80/443`（HTTPS）、`3478` TCP+UDP、`5349` TCP+UDP、
  `49160-49200/UDP`（或你在 `.env` 中配置的 relay 范围）

### 验收

```bash
# REST
curl -sS https://wo.example.com/v1/health/ready

# 申请 ticket 时不要带 JSON body（有 body 会 400 VALIDATION_ERROR）
curl -sS -X POST https://wo.example.com/v1/realtime/ticket \
  -H "Authorization: Bearer <accessToken>"
```

使用合法 ticket 连接 `wss://wo.example.com/v1/realtime`，子协议为
`wo-v1` 与 `ticket.<ticket>`。成功时应为 **101 Switching Protocols**，而不是
`400 Invalid Upgrade header`。

## 局域网轻量模式边界

轻量模式不使用本 Compose。创建者的桌面进程只在可用的 RFC1918 私网 IPv4
地址上启动临时双人服务，不依赖账号、PostgreSQL 或 TURN。完整邀请包含私网
端点、6 位房间码和 256 位随机密钥；房间码只用于人工核对，不能单独发现房主
或通过认证。

轻量信令帧由 HMAC-SHA-256 和单调序列号认证，但 `ws://`/`http://` 不提供
传输加密。因此该模式只适用于可信局域网，不适用于访客 Wi-Fi、公共网络、跨网
发现或公网 NAT 穿透。房主退出、设备休眠、绑定地址消失、网卡身份变化或关闭房间会终止内嵌服务。

轻量模式代码和自动化集成证据为 `IMPLEMENTED`；尚无两台真实桌面设备的
认证结果，仍为 `NOT CERTIFIED`。

## Secret 边界

`postgres_password`、`jwt_access_secret` 和 `turn_shared_secret` 通过 Compose secrets 以文件挂载。server 入口脚本只以 root 读取这些宿主文件，随后清空 capabilities 和附加组，并让 Node 以 `1000:1000` 成为 PID 1；应用当前从该 Node 进程自身的环境读取数据库 URL 和两个应用 secret，但这些值不进入 Compose 环境、`docker inspect` 或进程参数。coturn 入口脚本把 secret、证书和私钥复制到私有 tmpfs，设为 `0600` 后立即清除 shell 变量，再让 turnserver 以 `65534:65533` 成为 PID 1；TURN 共享密钥不进入 turnserver 环境或参数。coturn 健康探针直接从 secret 文件读取共享密钥，在进程内派生 60 秒 REST 凭据并执行认证 allocation，长期共享密钥不会进入命令参数。

不要把 `deploy/.env`、`deploy/secrets/`、备份或私钥提交到 Git。

## 本地集成

本地集成固定使用 Compose 项目 `wo-integration`，只绑定 `127.0.0.1`，并使用独立的 `.env.integration`、`secrets.integration/`、`backups.integration/`、PostgreSQL volume 和 Caddy volume。它与生产项目 `wo` 没有容器、网络、volume 或 secret 文件重叠。

```bash
cp deploy/.env.integration.example deploy/.env.integration
node deploy/scripts/init-secrets.mjs --secret-dir=./secrets.integration
node deploy/scripts/init-integration-cert.mjs
pnpm test:e2e:web
```

证书初始化器只写固定的 `secrets.integration/`，使用排他新建；证书或私钥任一已存在时都会停止。它生成 `turn.localhost` 的 30 天自签证书，仅用于本地集成。生产必须使用受信任 CA 为真实 `TURN_HOST` 签发的完整链。

Web E2E 自动启动并清理 `wo-integration`，使用两个隔离 Chromium 会话创建和
加入房间，并通过双方持续增长的 WebRTC 音频收发统计验证双向语音。

```bash
node deploy/scripts/preflight.mjs --env-file=deploy/.env.integration --integration --allow-non-linux
docker compose --project-name wo-integration --env-file deploy/.env.integration -f deploy/compose.yaml -f deploy/compose.integration.yaml up -d --build --wait
node deploy/scripts/export-local-ca.mjs --env-file=deploy/.env.integration
node deploy/scripts/smoke.mjs --env-file=deploy/.env.integration --base-url=https://rtc.localhost --ca-file=deploy/.certs/caddy-authority/root.crt --integration --turn-proof
docker compose --project-name wo-integration --env-file deploy/.env.integration -f deploy/compose.yaml -f deploy/compose.integration.yaml down -v
```

本地有两条彼此独立的信任链：HTTPS/WSS 使用 Caddy internal CA，`export-local-ca.mjs` 只导出其公开 `root.crt`；`turns:` 使用 `secrets.integration/turn_tls_cert.pem`。CLI smoke 会分别校验两条链。桌面端手工联调时，只在隔离测试机器的系统信任库中加入这两个公开证书，绝不能复制 Caddy CA 私钥或 `turn_tls_key.pem`，也不得关闭 TLS 校验。

`--turn-proof` 使用业务服务签发的短期凭据，验证 UDP relay 双向数据、`turns:` TLS relay 和错误凭据拒绝。该测试发生在本机 Docker 网络，只证明本地配置和认证链路，不代表公网 NAT、防火墙或运营商路径已经可用。

## 备份、恢复与升级

备份同时保存 PostgreSQL 自包含 dump 和 Caddy `/data` 状态，并在 manifest 中记录 SHA-256、production/integration profile、数据库名和 PostgreSQL major：

```bash
node deploy/scripts/backup.mjs --env-file=deploy/.env
```

Caddy 备份含证书与 ACME 账户材料，必须按 secret 级别加密保存。恢复会先校验 profile、文件摘要和 tar 路径/类型。数据库先导入空的 staging database 并在单事务中完成，之后保留原数据库并受控改名切换；Caddy 在同一 volume 中 staging 后切换。新栈健康前旧状态不会删除，失败时会先停写、切回数据库与 Caddy，再启动原服务。恢复必须显式确认：

```bash
node deploy/scripts/restore.mjs --env-file=deploy/.env --backup-dir=/absolute/backup/path --confirm-restore
```

升级流程先预检并拒绝 PostgreSQL major 变化，再捕获当前四个镜像。拉取外部 PostgreSQL 镜像并构建 Caddy/server/coturn 期间旧栈继续服务；切换前会停止 Caddy/server，取得无写入竞态的备份。Caddy 构建会同步更新 Web SPA；它在新 server 的内部网络 smoke 通过前保持停止，因此验证失败时可以恢复旧镜像和备份而不丢失外部写入。内部验证通过后才启动公开 Caddy；公开入口激活若失败，只回退 Caddy 镜像并保留已验证的新数据库，不再做数据回退。因此备份和内部验证期间会有短暂停机：

```bash
node deploy/scripts/upgrade.mjs --env-file=deploy/.env
```

跨 PostgreSQL 大版本升级不在该脚本范围内，必须按 PostgreSQL 官方升级流程单独演练。

## TURN 上线验收

同机 allocation、容器内 relay 或 hairpin NAT 不能证明公网 relay 可用。正式验收必须从第二台 external host 获取经过认证接口签发的短期 TURN 凭据，分别通过 UDP、TCP 和 `turns:` 使用 `turnutils_peer`/`turnutils_uclient` 交换双向数据；同时验证错误凭据失败、过期凭据失败，以及回环、私网、链路本地和云元数据目标被 ACL 拒绝。

验收记录只保留候选类型、协议、双向成功、ACL 分类和过期结果，不记录公网地址、账号、room code、SDP 或 TURN credential。

## 契约检查

静态部署契约使用专用配置，禁用“无测试也通过”：

```bash
pnpm exec vitest run --config vitest.root.contract.config.ts
docker compose --project-name wo --env-file deploy/.env -f deploy/compose.yaml config --quiet
```
