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

- 当前生产镜像只认证 Linux x86_64 主机，要求 Docker Engine 26 或更高版本和
  Docker Compose 2.24.4 或更高版本；arm64 尚无 release bundle 和运行态证据。
- 为 `APP_DOMAIN` 和 `TURN_HOST` 配置指向同一公网 IPv4 的 DNS A 记录。
- Caddy 通过 ACME 管理 HTTPS 证书；coturn 使用单独的证书和私钥，Caddy 不代理 TURN。
- 中国大陆主机需先确认 Docker 镜像源、DNS 和证书颁发机构可达。媒体流本身不会经过这些下载或证书服务。

防火墙只需开放：

- `80/TCP`、`443/TCP`：Caddy；
- `3478/TCP+UDP`：STUN/TURN；
- `5349/TCP`：TURN TLS；
- `49160-49200/UDP`：TURN relay；bridge 模式可在 `.env` 中缩小或平移，
  但最多 200 个端口。

PostgreSQL 和 server 没有宿主机映射端口。

`TURN_PORT` 和 `TURN_TLS_PORT` 是宿主机公开端口。bridge 模式下 coturn
容器内固定监听 `3478` 和 `5349`；host 模式直接监听这两个公开端口。
`TURN_URLS` 中的 `stun:`/`turn:` 端口必须等于 `TURN_PORT`，`turns:` 端口
必须等于 `TURN_TLS_PORT`。两个端口不能相同，也不能占用 Caddy 的 `80/443`。
当前部署只认证 TURN TLS over TCP，不启用 DTLS 或 RFC 6062 TCP relay。

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
node deploy/scripts/compose.mjs --env-file=deploy/.env up -d --build --wait
```

`compose.mjs` 会从 clean Git HEAD 派生 commit、commit UTC 时间、对应
`SOURCE_DATE_EPOCH` 和版本号，并传给 caddy、server、coturn 构建。生产
`preflight`、`build` 和可能触发构建的 `up` 都要求发布目录包含 `.git` 且工作树
干净；shell 或 env-file 中的 `BUILD_*` 不能覆盖该身份。`ps`、`down`、备份和
恢复等不构建命令不依赖 Git。`upgrade.mjs` 在停服前核验三张镜像的 image ID、
架构和 OCI labels，以 image ID override 启动，再核对运行容器实际使用的
`.Image`，避免可变 tag 在核验与启动之间被替换。

server 会在监听前执行带校验和和数据库锁的迁移；Caddy 只在 server 健康后对外服务。可用下面的命令查看状态和运行完整冒烟流程：

```bash
node deploy/scripts/compose.mjs --env-file=deploy/.env ps
node deploy/scripts/smoke.mjs --env-file=deploy/.env
```

冒烟流程创建三个随机临时账号，验证两人房间、第三人拒绝、offer/answer/candidate 转发、屏幕租约、房间结束和会话注销。脚本不会输出 token、SDP 或凭据。

部署完成后访问 `https://${APP_DOMAIN}`。房间页可复制
`https://${APP_DOMAIN}/join/<6位房间码>` 或 `wo://` 客户端邀请；HTTPS 邀请
既能继续使用 Web，也能通过显式按钮唤起桌面客户端。

## TURN host-network 模式

默认 bridge 模式适合小规模部署，并保留最多 200 个 relay 端口的保护。若 relay
范围较大，Docker 会为每个发布端口创建代理/NAT 状态；经测量确认它成为主机内存
瓶颈后，才使用 `deploy/compose.turn-host.yaml`。host 模式不改变 TURN 的公网
协议，但取消 coturn 的 Docker 端口发布和网络地址转换，relay 范围最多 512 个
UDP 端口。

host 模式要求云主机只有一个稳定的 RFC1918 IPv4 作为默认出口，并由云 EIP
一对一映射到 `PUBLIC_IPV4`。先创建一个专用于覆盖镜像状态卷的空目录：

```bash
sudo install -d -o root -g root -m 0755 /opt/wo/coturn-empty
```

在 `deploy/.env` 中显式设置：

```dotenv
TURN_NETWORK_MODE=host
TURN_INTERNAL_IP=172.16.0.10
TURN_STATE_EMPTY_DIR=/opt/wo/coturn-empty
TURN_RELAY_MIN_PORT=49160
TURN_RELAY_MAX_PORT=49509
```

`TURN_INTERNAL_IP` 必须替换为本机默认路由实际使用的私网地址。coturn 只监听该
地址，向客户端报告 `PUBLIC_IPV4/TURN_INTERNAL_IP` 映射，并拒绝 relay 回
公网 IP、本机、私网、链路本地、CGNAT 和元数据地址。

若 relay 范围与 `net.ipv4.ip_local_port_range` 重叠，必须把完整重叠范围合并
进 `net.ipv4.ip_local_reserved_ports`。先读取现值，保留所有已有范围，再通过
配置管理写入独立的 `/etc/sysctl.d/60-wo-turn-relay.conf`；不得用新范围覆盖
现值。例如现值为空时：

```text
net.ipv4.ip_local_reserved_ports=49160-49509
```

应用后运行生产预检。预检会验证私网 IP 已分配、保留端口完整覆盖、空目录整条
路径无符号链接且不可由非 root 用户写入，并检查最终 coturn 拓扑为 host network、
零 `ports`、零 Compose `networks`：

```bash
node deploy/scripts/preflight.mjs --env-file=deploy/.env
node deploy/scripts/compose.mjs --env-file=deploy/.env up -d --build --wait
```

`backup.mjs`、`restore.mjs` 和 `upgrade.mjs` 会根据 env file 自动选择该 overlay。
host 模式下 `docker compose port coturn ...` 没有映射结果是正常现象；使用
进程级 `ss` 和外部 TURN allocation/data 探针验收实际 listener。

回滚时先把 `TURN_NETWORK_MODE` 改回 `bridge`，将 relay 范围恢复到不超过
200 个端口，再只使用基础 Compose 文件重建 coturn。保留
`ip_local_reserved_ports` 不会影响 bridge 模式；若要删除，必须恢复变更前完整
值，不能清空其他服务已有的保留范围。

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

当前媒体计划固定为三条 m-line：麦克风音频、系统音频和屏幕视频。旧的两条
m-line 客户端不能与当前客户端混合进房；服务端不会重写或翻译 SDP。发布和
回滚必须替换整个活跃客户端批次，不能只滚动升级其中一端。完成握手级客户端
版本拒绝前，运维必须通过下载入口和发布窗口阻止旧/新版本并存。

本地集成的自签证书只适用于隔离测试。桌面手工联调应安装公开 CA 证书，不能
关闭 TLS 校验。

## 外部 Nginx / OpenResty 反代（1Panel 等）

标准 `deploy/compose.yaml` 使用内置 Caddy 终止 HTTPS。若改用仓库根目录
`docker-compose.yml` / `docker-compose.external-db.yml`，只发布 server
（默认 `18080→3000`）和 coturn，则由宿主机上的 Nginx、OpenResty 或 1Panel
负责 `APP_DOMAIN` 的 HTTPS 与反代。

### 必须反代与禁止反代

| 流量                                        | 处理                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `https://${APP_DOMAIN}/`、`/v1/*`           | 反代到 `http://127.0.0.1:18080`（或你设置的 `WO_HTTP_PORT`）           |
| `wss://${APP_DOMAIN}/v1/realtime`           | **同一 origin**，必须正确升级 WebSocket                                |
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
- 防火墙 / 安全组放行：`80/443`（HTTPS）、`3478` TCP+UDP、`5349` TCP、
  `49160-49200/UDP`（或你在 `.env` 中配置的 relay 范围）

root profile 不能通过 `compose.mjs` 执行 `build` 或 `up`。这两类命令会改变
生产镜像选择，必须先生成并校验 release bundle，再由 release apply 入口使用
不可变 image ID 激活。`TURN_NETWORK_MODE=host` 时，该入口会自动追加
`deploy/compose.turn-host.yaml`；不要手工绕过 bundle gate。

### root profile release bundle

在 clean Git checkout 中生成 release bundle。输出目录的父目录必须已存在，
输出目录本身必须不存在；本机 Docker 中也不能已有该 commit 对应的
`wo-caddy`、`wo-server` 或 `wo-coturn` release tag：

```bash
node deploy/scripts/build-release.mjs \
  --output-dir=/opt/wo/releases/<release-version>
```

构建入口从 clean HEAD 派生 release identity，再用该完整 commit 创建隔离源码
快照。三张镜像各执行两次无缓存构建，要求 image ID 和全部 rootfs layer 相同；
每轮校验后删除临时 Docker tag。manifest、源码清单、三份 Docker archive 和
checksum 全部自校验通过后，才把临时目录原子发布为指定输出目录。

首次部署前创建权限受限的 rollback root，并从
`release-manifest.sha256` 读取 64 位 manifest SHA-256：

```bash
sudo install -d -o root -g root -m 0700 /opt/wo/rollback

node deploy/scripts/apply-release.mjs \
  --manifest=/opt/wo/releases/<release-version>/release-manifest.json \
  --expected-manifest-sha256=<manifest-sha256> \
  --env-file=deploy/.env \
  --rollback-root=/opt/wo/rollback \
  --profile=external-db \
  --mode=initial \
  --confirm-apply
```

使用仓库内 PostgreSQL 时将 profile 改为 `root-managed-db`。该 profile 要求
Compose 中配置的 PostgreSQL 镜像已在本机存在；apply 会先解析其 image ID，
再通过 `pull_policy: never` 的临时 override 启动，不会在激活过程中拉取可变
tag。已有 PostgreSQL 只做 Running/healthy 检查，不会重建。

`initial` 要求 server 和 coturn 都不存在。`root-managed-db + upgrade` 仍明确
拒绝，因为该 profile 尚未具备与镜像回滚绑定的事务性数据库 restore；不要停止
旧容器后用 `initial` 绕过。`external-db + upgrade` 使用独立的 staging 数据库
事务，Caddy archive 只完成校验，不会替换由 1Panel/OpenResty 管理的公开入口。

### external-db release upgrade

先在维护窗口开始前用只读命令取得外部 PostgreSQL 与 OpenResty/Nginx ingress
的完整容器 ID 和不可变 image ID，并从 PostgreSQL 读取 major 与
`system_identifier`。`deploy/.env` 的 `POSTGRES_USER` 是应用角色，必须存在且
具备 `LOGIN`、不是 superuser；`--external-postgres-admin` 是单独的发布管理员，
必须是 superuser 且具备 `CREATEDB`。确认目标后执行：

```bash
node deploy/scripts/apply-release.mjs \
  --manifest=/opt/wo/releases/<release-version>/release-manifest.json \
  --expected-manifest-sha256=<manifest-sha256> \
  --env-file=deploy/.env \
  --rollback-root=/opt/wo/rollback \
  --profile=external-db \
  --mode=upgrade \
  --external-postgres-container-id=<64位容器ID> \
  --external-postgres-admin=<发布管理员角色> \
  --expected-postgres-major=<major> \
  --expected-postgres-system-id=<system_identifier> \
  --external-ingress-container-id=<64位容器ID> \
  --expected-ingress-image-id=sha256:<64位image摘要> \
  --confirm-apply
```

入口会在任何 Docker 写操作前校验全部参数、bundle、外部容器身份和旧 Server
的 Compose project/service/config hash。只有“当前 external-db Compose + 旧的
不可变 Server image”重新渲染出的 hash 与运行容器一致，才会加载新 archive。
服务存在性和停止验证使用 `docker compose ps --all -q`，不会把已停止容器误判
为不存在。Compose hash 校验会用权限 `0600` 的 comparison-only override 恢复
捕获的 `Config.Image` 字符串；该文件不参与激活，实际回滚仍只使用不可变 image
ID 和 `pull_policy: never`。

维护顺序固定为：停止并验证 ingress，停止旧 Server，围栏并清空原数据库连接，
生成新鲜 custom dump，恢复到随机 staging，使用非 superuser 应用角色执行迁移
和 internal smoke，重新检查 staging 固定 OID 与完整 metadata，停止 staging
Server，在单个 PostgreSQL 事务中切换两个数据库名，再激活新 Server/coturn 并
执行 internal smoke。碰撞与剩余连接 count 必须是恰好一行非负十进制，空输出
不会当成零。最后恢复同一 ingress 容器；若其 Docker healthcheck 暂为
`starting`，会有界等待 `healthy`，不会放松容器/image 身份。

数据库 manifest 保存原 OID、owner、locale、tablespace、connection limit、
allow-connections、ICU rules、完整 ACL（含 grantor）、数据库/角色 GUC 以及 dump
大小和 SHA-256，并记录应用角色 `applicationRoleCanLogin: true`。ACL 按授权链
在事务内切换到每个原 grantor 后重放；无法证明的授权链会在切库前失败关闭。

失败时先证明新服务和 ingress 已停止，再按固定 OID 恢复原数据库与连接权限，
用 `pull_policy: never` 的 rollback override 恢复旧镜像/运行配置并执行 smoke，
最后才恢复 ingress。rollback smoke、ingress 恢复或停止验证任一失败时，不删除
staging/failed 数据库，也不释放 backup、rollback workspace 或 image lease。
激活或 rollback 的双 rename 即使已提交后才返回错误，也会按固定 OID 识别唯一
布局后恢复或继续；只有本轮实际尝试过数据库围栏，失败路径才恢复原 connection
limit。
成功输出中的 `backup=<path>` 仍需按备份保留策略保存。

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
node deploy/scripts/compose.mjs --integration --env-file=deploy/.env.integration up -d --build --wait
node deploy/scripts/export-local-ca.mjs --env-file=deploy/.env.integration
node deploy/scripts/smoke.mjs --env-file=deploy/.env.integration --base-url=https://rtc.localhost --ca-file=deploy/.certs/caddy-authority/root.crt --integration --turn-proof
node deploy/scripts/compose.mjs --integration --env-file=deploy/.env.integration down -v
```

如果本机的 `80/443` 已被其他栈占用，可仅覆盖 integration 的宿主发布端口，
容器内部端口和默认契约保持不变。preflight、Compose 集成、Web E2E 和桌面 E2E
必须使用同一组覆盖值：

```bash
export WO_INTEGRATION_HTTP_PORT=18080
export WO_INTEGRATION_HTTPS_PORT=18443
export WO_E2E_BASE_URL=https://rtc.localhost:18443
node deploy/scripts/preflight.mjs --env-file=deploy/.env.integration --integration --allow-non-linux
pnpm test:e2e:web
pnpm test:e2e:desktop
```

当本机 Node 无法解析 `rtc.localhost` 时，CLI smoke 可以继续严格校验证书并使用
Caddy 为 loopback IP 签发的 internal 证书：

```bash
WO_INTEGRATION_HTTP_PORT=18080 WO_INTEGRATION_HTTPS_PORT=18443 \
WO_INTEGRATION_SMOKE_BASE_URL=https://127.0.0.1:18443 \
WO_RUN_COMPOSE_INTEGRATION=1 pnpm exec vitest run \
  --config vitest.root.integration.config.ts \
  tests/integration/compose-stack.integration.test.ts
```

不得关闭 Node 或浏览器的 TLS 证书校验。桌面 acceptance 证书例外仍只接受
`rtc.localhost`、当前 Caddy CA 链和固定 root SPKI；高端口不会扩大主机信任范围。

本地有两条彼此独立的信任链：HTTPS/WSS 使用 Caddy internal CA，`export-local-ca.mjs` 只导出其公开 `root.crt`；`turns:` 使用 `secrets.integration/turn_tls_cert.pem`。CLI smoke 会分别校验两条链。桌面端手工联调时，只在隔离测试机器的系统信任库中加入这两个公开证书，绝不能复制 Caddy CA 私钥或 `turn_tls_key.pem`，也不得关闭 TLS 校验。

`--turn-proof` 使用业务服务签发的短期凭据，验证 UDP、TCP 和
`turns:` TLS relay 双向数据，以及错误凭据拒绝。该测试发生在本机
Docker 网络，只证明本地配置和认证链路，不代表公网 NAT、防火墙或
运营商路径已经可用。

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

升级前会在已经预检的 `BACKUP_DIR` 下创建权限受限的回滚工作区。升级成功时该
目录自动删除；如果旧 coturn 通过回滚 override 恢复，目录会被保留，因为旧
容器的配置 bind mount 仍依赖其中的快照。确认回滚后的容器已被后续正式版本
替换且再次重启通过后，才可手工清理对应的 `wo-upgrade-*` 目录。

跨 PostgreSQL 大版本升级不在该脚本范围内，必须按 PostgreSQL 官方升级流程单独演练。

## 只读监控探测

`monitor.mjs` 对生产栈做只读健康探测：caddy/server/coturn/postgres 四个容器
必须唯一、running、healthcheck 已配置且 healthy、无 OOM、restart 次数不超
阈值；server/coturn/postgres 还必须配置 json-file 日志轮转与内存限制；根分区
与 `/var/lib/docker` 使用率不超过 85%；TURN 证书文件与 `APP_DOMAIN` 的
HTTPS 证书剩余有效期不少于 21 天。docker/df 子进程探测有 20 秒超时，daemon
卡死会转为明确失败而不是挂起。任一违规输出 `MONITOR_ISSUE` 并以非零码
退出：

```bash
node deploy/scripts/monitor.mjs --env-file=deploy/.env
node deploy/scripts/monitor.mjs --env-file=deploy/.env --json
```

告警接入以退出码为准，宿主机用 cron/systemd timer 周期执行并在非零退出时
发送通知（邮件、webhook 均可）。探测不修改任何状态，也不输出 secret。无外网
TLS 访问的主机可用 `--skip-web-probe` 跳过 HTTPS 探测。

## 镜像与工件保留策略

- release bundle：保留最近 2 个已部署版本的完整 bundle（含 manifest 与三份
  Docker archive），用于快速回切；更早版本只保留 `release-manifest.json` 与
  checksum 供审计追溯。
- 生产镜像：当前 revision 与上一 revision 的三镜像必须保留；再早的
  `wo-caddy/wo-server/wo-coturn` 版本标签在确认无容器引用后删除。
- 备份：按 `backup.mjs` 产物保留最近 7 份每日备份加 4 份周备份；异地加密
  副本至少保留最近 2 份，删除前必须先验证更新副本可解密。
- 回滚工作区：`wo-upgrade-*`、`wo-release-apply-*` 目录在对应版本被后续
  正式版本替换并重启验证后手工清理。
- Docker 构建缓存：宿主机磁盘使用率超过 85%（与监控阈值一致）时执行
  `docker builder prune` 与悬空镜像清理；不得使用会删除有标签镜像的
  `docker system prune -a`。

## TURN 上线验收

同机 allocation、容器内 relay 或 hairpin NAT 不能证明公网 relay 可用。正式验收必须从第二台 external host 获取经过认证接口签发的短期 TURN 凭据，分别通过 UDP、TCP 和 `turns:` 使用 `turnutils_peer`/`turnutils_uclient` 交换双向数据；同时验证错误凭据失败、过期凭据失败，以及回环、私网、链路本地和云元数据目标被 ACL 拒绝。

验收记录只保留候选类型、协议、双向成功、ACL 分类和过期结果，不记录公网地址、账号、room code、SDP 或 TURN credential。

## 契约检查

静态部署契约使用专用配置，禁用“无测试也通过”：

```bash
pnpm exec vitest run --config vitest.root.contract.config.ts
node deploy/scripts/compose.mjs --env-file=deploy/.env config --quiet
```
