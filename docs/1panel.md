# 已有 1Panel / OpenResty 的部署方式

保留 1Panel 的 OpenResty 占用 80/443。WO 的 `--1panel` 模式只在宿主机
`127.0.0.1:18080` 提供 HTTP，由 1Panel 转发；外部访问地址保持
`https://WO域名`，不带 18080。WO 运行 server、PostgreSQL、coturn 和证书同步四个服务。

```text
浏览器 / 桌面客户端 ── HTTPS / WSS ── 1Panel OpenResty:443
                                         │
                                 127.0.0.1:18080
                                         │
                                      WO server

媒体 ── 3478 TCP/UDP、5349 TCP、relay UDP ── coturn
1Panel 网站 SSL 文件 ── 只读目录挂载 / 自动检查 ── TURN 证书
```

## 1. 在 1Panel 准备 WO 网站和证书

1. 为 WO 使用独立域名，且与部署向导中配置的域名一致，例如 `wo.example.com`。
2. 在 **网站 → 证书** 申请证书，使用 DNS 账户或 HTTP 验证，开启自动续签。
3. 在 **网站 → 创建网站 → 反向代理** 新建该域名，代理到
   `http://127.0.0.1:18080`，开启 WebSocket 支持。
4. 在该网站的 HTTPS 设置中绑定证书。保留 1Panel 生成的 TLS 和 ACME 验证配置。

如果后端尚未启动，暂时出现 502 是正常的，完成下面的 WO 启动后再检查。
普通 HTTP CDN 无法代理 TURN；域名应解析到这台服务器，并保证 TURN 端口直达。

## 2. 确认证书的宿主机目录

打开该网站的配置，查看 `ssl_certificate` 和 `ssl_certificate_key`。
常见容器内路径为：

```text
/www/sites/网站代号/ssl/fullchain.pem
/www/sites/网站代号/ssl/privkey.pem
```

`--cert-dir` 要填写它对应的**宿主机目录**，不能直接照抄容器路径。
可通过 1Panel 文件管理或 OpenResty 容器的“目录映射”找到 `/www` 对应位置。
例如 `/www` 映射到 `/opt/1panel/www`，则填写：

```text
/opt/1panel/www/sites/网站代号/ssl
```

旧版本或自定义安装目录可能不同。请选择单个网站的 `.../sites/<网站代号>/ssl`
目录，不要挂载整个 1Panel、系统目录或 Docker socket。
默认文件名为 `fullchain.pem` 和 `privkey.pem`；若实际不同，可分别指定
`--cert-file`、`--key-file`，参数只接受文件名。

## 3. 启动 WO

对于你这种**首次部署因端口冲突尚未完成**的情况，在原仓库目录运行：

```bash
git pull --ff-only
bash deploy.sh up --1panel --refresh-build \
  --cert-dir="/实际宿主机路径/sites/网站代号/ssl"
```

如之前指定了 `--project` 或 `--state-dir`，继续带相同参数。
该操作保留部署身份、域名、管理员、密码、数据库和证书卷，仅切换入口与证书来源。
它会停止并移除**这个 WO 项目自己的 Caddy 容器**，不会操作 1Panel 的 OpenResty，也不会删除数据卷。

全新安装则去掉 `--refresh-build`：

```bash
bash deploy.sh up --1panel \
  --cert-dir="/实际宿主机路径/sites/网站代号/ssl"
```

按提示填域名、管理员邮箱、公网 IPv4 和密码；证书申请由 1Panel 负责，不再要求额外输入 ACME 联系邮箱。
初始管理员信息仍保存在 `deploy/.managed/<项目名>/first-login.txt`。

如果 18080 也有其他服务占用，首次配置或未完成转换时可加 `--http-port=18081`，
并把 1Panel 代理地址改成 `http://127.0.0.1:18081`。对外仍使用标准 HTTPS 地址。
已成功完成的安装不接受此转换命令，需要先规划迁移；不要删除成功标记来绕过保护。

## 4. 应用反代片段

向导会生成：

```text
deploy/.managed/<项目名>/openresty-location.conf
```

在 1Panel 对应网站的反代高级配置里参考或应用该内容。它包含正确的 WebSocket
升级、长连接超时和真实 IP 头。**替换已有的 `location /`，不要重复添加第二段**；
保留 1Panel 管理的证书、HTTP 跳转和 `/.well-known` 等验证配置。

特别注意 `X-Forwarded-For` 必须由 `$remote_addr` 覆盖，不能改成
`$proxy_add_x_forwarded_for`。WO 仅信任一个直接代理跳，不要公开 18080，或额外
套一层 Caddy/CDN 后继续沿用同一信任设置。

1Panel 的常规 OpenResty 使用 Host 网络，因此能访问宿主机的 `127.0.0.1`。
如果你修改成了 Bridge 网络，该地址指向 OpenResty 自己的容器。请先在 1Panel
容器详情中确认网络模式；需要重新规划受信任的共享网络，不能靠把 WO 内部端口
开放到公网来解决。

## 5. 续签和检查

1Panel 负责签发、续签和加载网站 HTTPS 证书。WO 每 30 秒只读检查网站 SSL 文件，
验证域名、有效期和私钥匹配后，再发布给 coturn 并触发证书重载。
更新期间如果文件暂时不匹配，会保留上一份可用证书并重试。

```bash
bash deploy.sh status
bash deploy.sh logs
bash deploy.sh sync-cert    # 立即同步 1Panel 当前的证书文件
```

续签请在 1Panel 中进行；WO 的 `renew` 在这个模式下会提示改用 1Panel，
不会自行申请第二份证书。`/admin` 显示“1Panel 管理证书”和 TURN 导入状态；
网站 HTTPS 的加载情况应在 1Panel 查看。

本机检查后端：

```bash
curl http://127.0.0.1:18080/v1/health/ready
```

然后访问 `https://WO域名/` 和 `/admin`，检查客户端能否登录并创建房间。
安全组继续放行 3478 TCP/UDP、5349 TCP 和配置的 relay UDP 范围；TURN 不经过
OpenResty 的 HTTP 反代。

**验证范围：** 自动化测试使用官方 OpenResty 容器、本地测试 CA 和真实 WO 服务，
验证回环入口、HTTPS/WSS、证书目录替换、错误私钥保护和 TURN 自动重载。
它不修改你的 1Panel 实例，也不代替公网 DNS、防火墙和真实双机网络验证。

参考：[1Panel 创建网站](https://1panel.cn/docs/v2/user_manual/websites/website_create/)、
[1Panel 证书续签](https://1panel.cn/docs/v2/user_manual/websites/certificate_renew/)、
[1Panel 默认 Host 网络说明](https://github.com/1Panel-dev/1Panel/discussions/6115)。
