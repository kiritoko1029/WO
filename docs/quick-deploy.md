# 向导部署：从域名到可用的 WO

准备好域名和 Docker 后，运行向导、回答几个问题即可。向导会生成配置、独立随机密钥、初始管理员和证书配置；不需要修改源码、Compose YAML 或手工放置 PEM 文件。

## 1. 准备服务器

生产环境使用 Linux x86_64、Git、Docker Engine 26+ 和 Docker Compose 2.24.4+。
宿主机不需要安装 Node.js 或 pnpm，向导会使用固定版本的临时 Node 容器。

准备一个域名，例如 `wo.example.com`，添加指向服务器公网 IPv4 的 DNS A 记录。
默认 HTTPS 和 TURN 共用这个域名及证书。使用 DNS/CDN 服务时应采用 **DNS only**，确保流量直达主机；普通 HTTP CDN 不能代理 TURN。

开放以下入站端口；续签期间也要保持 HTTP 验证端口可达：

| 端口            | 用途                          |
| --------------- | ----------------------------- |
| 80/TCP          | ACME HTTP-01 验证、HTTPS 跳转 |
| 443/TCP         | Web、REST、实时 WebSocket     |
| 3478/TCP + UDP  | STUN / TURN                   |
| 5349/TCP        | TURN TLS                      |
| 49160–49200/UDP | TURN 媒体中继                 |

如果服务器位于 NAT 后方，还需要将对应端口转发到服务器。数据库和应用的内部端口不会公开。
域名签发需要公网可验证的 DNS 与端口；没有公网域名时请使用下面的本地测试模式。

## 2. 运行向导

```bash
git clone https://github.com/kiritoko1029/WO.git
cd WO
bash deploy.sh
```

按提示填写：

1. 公网域名。
2. ACME 联系邮箱。
3. 初始管理员邮箱。
4. 服务器公网 IPv4。
5. 管理员密码。输入不会回显；直接回车会生成随机强密码。

首次运行会下载镜像和构建应用，通常比以后启动耗时更长。生产向导核验 DNS 和干净的 Git 版本，避免把未保存的本地修改作为发布来源。

启动成功后访问 `https://你的域名/`，后台地址为 `https://你的域名/admin`。
首登信息保存在私密文件 `deploy/.managed/wo/first-login.txt`，使用其中的邮箱和密码登录。
初始管理员在服务监听前就已创建并验证，无需通过公开注册页面领取管理员身份。

可以在客户端修改管理员密码。初始管理员的邮箱绑定部署身份，普通客户端不能修改该邮箱；需要更换时应由维护者进行身份迁移。

## 3. 无人值守安装

已有自动化工具时，可以传入参数；不传密码文件则自动生成密码并写入首登回执：

```bash
bash deploy.sh --non-interactive \
  --domain=wo.example.com \
  --email=operator@example.com \
  --admin-email=admin@example.com \
  --public-ip=你的公网IPv4
```

若需要指定密码，使用 `--password-file=仓库内的私密文件路径`，不要把密码直接写到命令行参数。
密码须为 10–128 个字符。不要将密码文件提交到 Git。

需要同时部署多个实例时，从第一次运行起选择独立项目，例如 `--project=wo-team`。
状态默认保存在 `deploy/.managed/<项目名>/`；也可使用该目录下的 `--state-dir`。
向导会检查容器和卷的部署归属，同名的旧服务或不匹配的数据卷会导致操作停止，避免接管其他部署。

## 4. Windows / Docker Desktop 本地测试

启动 Docker Desktop，选择 Linux containers，在仓库根目录执行：

```powershell
.\deploy.cmd --local
```

Linux 或 macOS 也可运行：

```bash
bash deploy.sh --local
```

默认本地项目名为 `wo-local`，入口为 `https://wo.localhost:18443/`，后台为
`https://wo.localhost:18443/admin`。首登回执在 `deploy/.managed/wo-local/first-login.txt`。
所有公开端口只绑定 `127.0.0.1`：HTTP 18080、HTTPS 18443、TURN 13478、TURN TLS 15349、relay UDP 55000–55020。

也可以直接双击 `deploy.cmd`，默认启动本地模式并保留结果窗口。
该启动器只为当前 PowerShell 子进程设置执行策略，不更改系统或用户的长期策略。
环境允许执行脚本时，仍可直接使用 `deploy.ps1`。

本地模式生成自签测试证书，浏览器不会自动信任。可导出 **公开证书**，仅在测试设备上加入受信任证书：

```powershell
docker cp wo-local-certificates-1:/status/certificate.pem .\wo-local-ca.pem
```

Linux/macOS 对应命令的目标路径为 `./wo-local-ca.pem`。如果使用不同 `--project`，容器名前缀也随之变化。
CLI 测试应显式信任该公开证书，不要关闭 TLS 校验，也不要复制私钥。
本地证书强制轮换后需要更新本机的测试信任；公网 ACME 证书续期不需要这一步。

## 日常操作

Linux 生产环境：

```bash
bash deploy.sh status    # 容器健康状态
bash deploy.sh logs      # 最近运行日志
bash deploy.sh renew     # 手动触发一次证书更新；平时自动执行
bash deploy.sh stop      # 停止服务，保留数据和证书
bash deploy.sh up        # 启动原有容器，保持已有版本
```

Windows 本地模式在每条命令末尾加 `--local`，例如：

```powershell
.\deploy.cmd status --local
.\deploy.cmd renew --local
.\deploy.cmd stop --local
.\deploy.cmd up --local
```

使用了自定义项目或状态目录时，每次都传入相同参数。
重复运行不会重置密码、重新生成缺失的旧密钥或自动升级镜像。缺失密钥时应恢复备份。
已有部署的域名、IP、管理员身份或代码版本发生变化时，向导会要求规划迁移；它不是升级器。
需要升级、回滚、外部数据库或自管入口时，使用[高级部署与运维说明](deployment.md)，并先确认该流程适用于所选部署配置。

## 自动证书与管理后台

![管理后台中的部署地址、证书有效期、续签状态和公开指纹](screenshots/admin-deployment.jpg)

截图来自本机 Docker 验收环境的真实 API 数据，使用本地测试证书。

向导使用五个长期容器：Caddy、server、PostgreSQL、coturn 和 certificates。

- certificates 使用固定镜像版本的 acme.sh，经 HTTP-01 签发证书，并周期性检查原生续签与 ACME ARI 更新。
- 第一次证书未就绪时，Caddy 仅提供 HTTP 验证入口；有效证书发布后自动切换为 HTTPS。
- 每次更新先校验域名、有效期和私钥匹配，再原子发布一个完整证书版本。
- Caddy 自动重载证书；coturn 的非特权 watcher 更新运行证书并发送 SIGUSR2。无需手工替换文件或重建容器。
- 更新失败时保留仍有效的旧证书并重试。后台显示失败或状态过旧提示，方便排查。
- `/admin` 显示域名、TURN 地址、证书有效期、指纹、续签状态及是否为本地证书。
  后台只读取公开证书和状态；私钥不挂载到应用服务，任何长期服务都没有 Docker socket。

不要将证书状态“已就绪”当成网络性能认证；跨网络连通仍依赖端口、防火墙和客户端网络。

## 状态保存与故障排查

`deploy/.managed/` 已被 Git 忽略。在 Linux 上，状态目录为 `0700`，密钥和首登回执为 `0600`。
同时备份该目录、项目的 PostgreSQL 数据卷、ACME 账号状态卷和证书卷。
不要对已有部署执行 `docker compose down -v`，它会删除数据卷。

| 现象                      | 处理                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Docker 或 Compose 不可用  | 先启动 Docker；确认使用 Linux engine 及要求的 Compose 版本                            |
| DNS / 公网 IP 检查失败    | 检查 A 记录、DNS only、实际公网 IP 和 NAT 转发                                        |
| 证书长期未就绪            | 检查 80/TCP、DNS 和 CA 可达性；运行 `logs`，等待 CA 限流解除后再重试                  |
| 证书自动更新失败          | 后台检查有效期与失败状态；修复网络后执行 `renew`；不要删除 ACME 账号卷                |
| `BOOTSTRAP_CONFLICT`      | 数据库中的原始管理员身份与引导配置不一致；恢复匹配的状态/数据库备份，勿重新领取旧账号 |
| 项目归属冲突              | 使用原项目对应的状态目录，或选择新的项目名；不要删除不明容器/数据卷                   |
| 版本或生成配置不一致      | 恢复安装时的代码与状态；改域名、升级等操作需要显式迁移                                |
| `up` 提示部署操作正在执行 | 检查另一终端或进程；只有确认没有操作运行时才清理陈旧锁                                |

## 可复跑的容器验收

证书边界与本地 ACME 测试会创建并清理自己的独立资源：

```powershell
$env:WO_DOCKER_CERTIFICATE_TEST='1'
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/managed-certificates.integration.test.ts
$env:WO_DOCKER_ACME_TEST='1'
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/managed-acme.integration.test.ts
```

完整应用测试需要先准备固定的本地验收项目；测试不删除该栈：

```powershell
.\deploy.cmd --local --non-interactive --project=wo-managed-acceptance
$env:WO_MANAGED_STACK_TEST='1'
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/managed-deployment.integration.test.ts
$env:WO_MANAGED_SECRET_TEST='1'
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/managed-secret-permissions.integration.test.ts
.\deploy.cmd stop --local --project=wo-managed-acceptance
```

验收覆盖管理员首登与访问控制、五服务健康、严格 HTTPS/WSS、双人房间、TURN 健康探测、证书实际轮换，以及轮换时已有信令连接可继续使用。
ACME 验收使用 [Let's Encrypt Pebble](https://github.com/letsencrypt/pebble) 本地测试 CA，执行真实 HTTP-01 验证，未跳过 TLS 校验；不代表某个公网域名已签发成功。

实现依据：[acme.sh](https://github.com/acmesh-official/acme.sh)、[Caddy 证书重载](https://caddyserver.com/docs/command-line#caddy-reload)、[coturn 证书重载信号](https://github.com/coturn/coturn/issues/725)。
