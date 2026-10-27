# Let's Encrypt 免费证书：从零到 https 生效（本机专用实操教程）

本文针对**你这台服务器**（入口 `http://mikuyun.xyz/chat/`，nginx + 子路径 `/chat/`，同机还有
`miku-ai.conf`、`nover.conf` 等其他站点）写，不是通用科普。每一步都可以直接复制执行。

命令全部是 **root** 身份（`sudo -i` 或每行加 `sudo`）。所有动作都在你自己的服务器上做。

---

## 0. 先决条件检查（5 分钟，缺一条后面必失败）

```bash
# ① 域名解析到本机 —— 输出的 IP 必须等于本机公网 IP
dig +short mikuyun.xyz A
curl -s https://ifconfig.me; echo          # 本机公网 IP

# ② www 子域是否也解析（决定第 4 步要不要带 -d www.mikuyun.xyz）
dig +short www.mikuyun.xyz A

# ③ 80 端口对外可达（Let's Encrypt 要从公网访问 /.well-known/acme-challenge/）
#    在服务器上跑，然后用手机流量（不要用同一网络）打开 http://mikuyun.xyz/ 能出页面即算通
ss -lntp | grep ':80 '

# ④ 已有网站在用哪些配置（本机多站点共存，后面绝不能新建同名 server 块）
ls -l /etc/nginx/sites-enabled/
grep -rn "server_name" /etc/nginx/sites-enabled/ | grep -i mikuyun

# ⑤ nginx 版本（>=1.18 即可；1.25.1+ 才有 http2 on 写法，本仓库配置用旧写法兼容）
nginx -v
```

**如果 ② 没有输出**：只申请 `mikuyun.xyz` 一张证书，并在第 5 步把
`nginx-chat-https.conf` 里的 `www.DOMAIN` 和 Origin 白名单中的 `https://www.DOMAIN` 一并删掉。
（配置里写了 `www` 却没有它的证书 = `nginx -t` 通过但浏览器报证书不匹配。）

**如果 ③ 不通**：云厂商安全组 / 防火墙先放行 80 和 443。80 不只是跳转用，**以后每次自动续期也要用**
（`--webroot` 校验走 80），不要签完就把 80 关掉。

---

## 1. 备份现有 nginx 配置（可回滚，必须先做）

```bash
BK=/root/nginx-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"
cp -a /etc/nginx/sites-available "$BK"/sites-available
cp -a /etc/nginx/sites-enabled  "$BK"/sites-enabled
cp -a /etc/nginx/snippets       "$BK"/snippets
cp -a /etc/nginx/nginx.conf     "$BK"/nginx.conf
nginx -T > "$BK"/nginx-dump.txt 2>&1   # 完整生效配置（回滚时对比用）
echo "备份在 $BK"
```

回滚就是：把 `$BK/sites-available/` 拷回去 → `nginx -t` → `systemctl reload nginx`。

---

## 2. 安装 certbot

Debian / Ubuntu 推荐 apt 版（行为最可预测，续期靠系统 `certbot.timer`）：

```bash
apt update
apt install -y certbot
certbot --version
```

如果发行版源里没有 certbot（或版本太老），再走 snap：

```bash
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot
```

CentOS / Rocky / AlmaLinux：`dnf install -y epel-release && dnf install -y certbot`。

**只需要 certbot 本体，不需要 `python3-certbot-nginx` 插件** —— 本仓库的 nginx 配置是手写的
（精确 Origin 白名单、每个 location 写全安全头），用 `--nginx` 插件让 certbot 自动改配置会破坏这些。
我们用 **webroot 模式**（certbot 只往指定目录写校验文件，一行 nginx 配置都不碰）。

---

## 3. 给「现有」的 HTTP server 块加 ACME 校验目录

⚠️ **本机最容易踩的坑**：`mikuyun.xyz` 的 80 端口**已经**有一个 server 块（聊天服务现在是作为
`/etc/nginx/snippets/aitrance-chat.conf` include 进去的，旁边还有别的站点）。
**不要**再把 `nginx-chat-https.conf` 里那段 `server { listen 80; server_name ... }` 整段加进去 ——
同名同端口两个 server 块，nginx 会打 `conflicting server name` 警告并只用第一个，你改的那份不生效。

做法：找到现有的那个文件（第 0 步 ④ 的 grep 结果），例如
`/etc/nginx/sites-available/miku-ai` 或 `/etc/nginx/sites-available/chat`，在它的
`server { listen 80; server_name mikuyun.xyz ...;` **内部**加三行：

```nginx
    # --- Let's Encrypt ACME 校验（certbot --webroot 会往这里写文件）---
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        access_log off;
        add_header Cache-Control no-store always;
    }
```

再建目录并自测（这一步不通就不要往下走）：

```bash
mkdir -p /var/www/certbot/.well-known/acme-challenge
echo "acme-ok-$(date +%s)" > /var/www/certbot/.well-known/acme-challenge/selftest
chown -R root:root /var/www/certbot
chmod -R 755 /var/www/certbot

nginx -t && systemctl reload nginx

# 本机自测（应原样打印 acme-ok-...）
curl -s http://mikuyun.xyz/.well-known/acme-challenge/selftest
# 再用手机流量（不同网络）打开一次同一个 URL，确认公网也通
```

输出 404 / 403 / 被 301 到 https，都说明位置放错了或前面有 location 抢先匹配 —— 回去检查。

---

## 4. 申请证书（先干跑，再正式）

```bash
# ① 干跑（走 Let's Encrypt 的 staging 环境，不消耗正式配额、签出的证书不可用但流程全验）
certbot certonly --webroot -w /var/www/certbot \
  -d mikuyun.xyz -d www.mikuyun.xyz \
  --dry-run

# www 没解析就去掉 -d www.mikuyun.xyz。干跑看到 "The dry run was successful." 才算通过。

# ② 正式签发（去掉 --dry-run）
certbot certonly --webroot -w /var/www/certbot \
  -d mikuyun.xyz -d www.mikuyun.xyz \
  --agree-tos -m 你的邮箱@example.com --no-eff-email
# 首次会问是否接收邮件，可加 --register-unsafely-without-email 免邮箱（不推荐，续期失败收不到通知）
```

成功后会打印 `Certificate is saved at: /etc/letsencrypt/live/mikuyun.xyz/fullchain.pem`。
核对一下（本仓库 `nginx-chat-https.conf` 里写的就是这两个路径）：

```bash
certbot certificates
ls -l /etc/letsencrypt/live/mikuyun.xyz/
# fullchain.pem 与 privkey.pem 必须存在；privkey 权限 600 属 root
```

> 反复干跑失败也要注意配额：Let's Encrypt 的限流是「每账号 + 每主机名，失败验证每小时 5 次」
> 和「相同的域名组合，每周最多 5 张证书」。所以务必先用 `--dry-run` 把流程跑通，
> 正式命令只执行一次到成功；不要在正式命令上反复试。

---

## 5. 切成 HTTPS：两步改配置

准备好域名与证书后，仓库里的 `backend/deploy/nginx-chat-https.conf` 就是**最终形态**，
按下面接线（它已经写好了 80→301、443、WSS、精确 Origin 白名单、每 location 全套安全头）。

### 5.1 生成替换掉 DOMAIN 的版本

```bash
cd /tmp
cp /opt/aitrance/current/deploy/nginx-chat-https.conf .   # 或从解压出来的发布包 deploy/ 里取
sed -i 's/DOMAIN/mikuyun.xyz/g' nginx-chat-https.conf
grep -n 'mikuyun.xyz' nginx-chat-https.conf | head   # 确认 DOMAIN 全被替换、没有残留
```

> 如果 www 没解析，先删掉 `www.mikuyun.xyz` 相关的三处：`server_name` 里的 `www.mikuyun.xyz`、
> Origin 白名单的 `if ($http_origin = "https://www.mikuyun.xyz")` 行、`chat.env` 里的 www origin。

### 5.2 落地：现有 80 块改「只跳转」，把 443 块追加到同一个文件

把步骤 3 那个现有站点文件改成下面这个形状（**只保留一个 80 的 server 块**，把聊天 snippet 的
include 注释掉 —— 不注释的话 `location /chat/` 会先匹配，HTTP 明文照旧能访问，跳转形同虚设）：

```nginx
# ===== 80：只做 ACME 校验 + 301 跳转到 https =====
server {
    listen 80;
    server_name mikuyun.xyz www.mikuyun.xyz;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        access_log off;
        add_header Cache-Control no-store always;
    }

    location / { return 301 https://$host$request_uri; }   # $request_uri 保留 /chat/ 前缀

    # 聊天应用的 location 全部移走，这个 include 必须注释掉
    # include /etc/nginx/snippets/aitrance-chat.conf;
}

# ===== 443：从 nginx-chat-https.conf 里把整个 443 server 块原样粘过来 =====
# (它包含 /chat/api/ 反代、/chat/ws 升级、/chat/assets/ 长缓存、SPA 回退、
#  CSP/HSTS/nosniff/Referrer-Policy/X-Frame-Options、精确 Origin 白名单)
```

也就是：**80 块用上面这段覆盖**，**443 块从 `nginx-chat-https.conf` 第 52 行的分隔注释开始，
即第 55 行 `server { listen 443 ssl http2;` 到文件最后一个 `}` —— 原样粘到同一个文件末尾**。
不要新建 `sites-enabled/aitrance-chat-https`（会和现有站点抢同名的 80 server 块）。

改完校验并生效：

```bash
nginx -t && systemctl reload nginx
```

`nginx -t` 报 `conflicting server name "mikuyun.xyz" on 0.0.0.0:80` = 你没把原来那个 80 块处理干净。
报 `cannot load certificate ... fullchain.pem` = 第 4 步的证书路径不对（检查 `certbot certificates`）。

---

## 6. 后端换成「明文凭据防护」模式并重启

现在 nginx 终结 TLS，**nginx → 后端 3001 这一段仍是回环明文**。后端必须被显式告知
「对外是 https」，否则 register/login 里那条明文凭据拦截（403 `HTTPS_REQUIRED`）根本不会生效。

编辑 `/etc/aitrance/chat.env`，改 3 个地方：

```ini
# ① 协议从 http 改成 https（必须精确 origin，不能带 /chat，不能带结尾斜杠）
#    后端启动时用 new URL() 校验，写成 http://... 或加路径会直接启动失败
CORS_ORIGINS=https://mikuyun.xyz,https://www.mikuyun.xyz

# ② 打开明文凭据防护（nginx 终结 TLS 场景必须显式设 true；默认 auto 在本形态下不生效）
REQUIRE_HTTPS=true

# ③ 信任本机 nginx 的 X-Forwarded-Proto（示例配置里本来就是 true，确认别被改掉）
TRUST_LOOPBACK_PROXY=true

# 注意：nginx 终结 TLS 时**不要**设 TLS_CERT_PATH / TLS_KEY_PATH，
# 那两个是「Fastify 自己监听 https」的形态，设了会和 nginx 抢 443 / 起监听冲突。
```

```bash
systemctl restart aitrance-chat
sleep 2
systemctl is-active aitrance-chat          # 必须 active
journalctl -u aitrance-chat -n 30 --no-pager | grep -E 'transport|Retention sweep'
# 正常应看到 "transport":"http","requireHttps":true
```

> 特殊字符提醒：`chat.env` 里若 `ADMIN_INITIAL_PASSWORD` 带 `#`、空格、引号，要用单引号包裹。
> 改完若服务起不来，`journalctl -u aitrance-chat -n 50 --no-pager` 会直接给出行号级错误
> （例如 `CORS_ORIGINS must contain exact HTTP origins`）。

---

## 7. 验证清单（逐条过，全绿才算成功）

```bash
# ① http 一律 301 到 https，且保留 /chat/ 前缀
curl -sI http://mikuyun.xyz/chat/ | head -3            # 期望 301 + Location: https://mikuyun.xyz/chat/
# ② 首页 200 且带全套安全头
curl -sI https://mikuyun.xyz/chat/ | grep -iE 'HTTP/|content-security-policy|strict-transport|permissions-policy|x-frame'
# ③ 后端健康检查走 https
curl -s https://mikuyun.xyz/chat/api/v1/health
# ④ 明文凭据防护确实生效：直连 3001 绕过 nginx，等于「明文链路」
curl -s -X POST http://127.0.0.1:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"x","password":"yyyyyyyy"}'
# 期望 403 且 code=HTTPS_REQUIRED（说明 requireHttps=true 生效）；这条**必须**验
# ⑤ WS 升级能过代理（期望 101 Switching Protocols，而不是 502/404）
#    ticket 是伪造的，升级成功后会被业务层立即关掉（4001 Invalid ticket）—— 这是**正确**结果，
#    说明 wss 链路通了、只是门票无效。
curl -si --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: https://mikuyun.xyz' https://mikuyun.xyz/chat/ws | head -5
# ⑥ Origin 白名单仍然生效（伪造来源必须 403 ORIGIN_FORBIDDEN）
curl -si -H 'Origin: https://evil.example' https://mikuyun.xyz/chat/api/v1/health | head -3
# ⑦ 证书链与到期时间（-servername 必须带，否则可能拿到同 IP 其他站点的证书）
echo | openssl s_client -connect mikuyun.xyz:443 -servername mikuyun.xyz 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

浏览器最后确认（**必须做**，curl 验不出前端问题）：

1. 打开 `https://mikuyun.xyz/chat/` → 地址栏是锁，F12 Console **没有** CSP 报错、没有 4xx/5xx。
2. 登录（账号 `QJQ`）→ 能进聊天；发一条消息，另一个窗口能实时收到（验证 `wss://`）。
3. 发一张图片（>100KB 的）→ 能上传成功（验证 `client_max_body_size 12m` 在 https 侧也生效）。
4. 手机浏览器打开同一地址 → 无「不安全」提示。

> 常见「页面能开但登录 403」= 第 6 步 `CORS_ORIGINS` 还写着 `http://`。
> 常见「图片上传 413」= 443 的 `/chat/api/` 里少了 `client_max_body_size 12m`。
> 常见「消息发出去对方收不到」= 同域 `wss://.../chat/ws` 被中间层挡了（检查安全组 / 云 WAF 是否放行 Upgrade）。

---

## 8. 自动续期（设一次，之后不用管）

Let's Encrypt 证书 **90 天**有效。certbot 会自己装一个 systemd timer，默认每天跑两次、
到期前 30 天才真正续。你要做的是给它装一个「续完通知 nginx 重载」的钩子，并测一遍。

```bash
# ① 部署钩子（续期成功后才会执行；先 nginx -t 再 reload，配置坏时不重载坏配置）
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# ② 确认定时器在跑
systemctl list-timers | grep -i certbot      # 应有 certbot.timer（或 snap.certbot.renew.timer）

# ③ 干跑一次「续期 + 钩子」全链路（走 staging，不会真换证书）
certbot renew --dry-run
# 看到 "Congratulations, all simulated renewals succeeded" 才算配好；
# 如果钩子报错，这里会直接把脚本的 stderr 打出来。

# ④ 手动查剩余天数
certbot certificates | grep -E 'Certificate Name|Expiry'
```

安全网（可选但建议）：给 `certbot renew` 的失败加一条监控 —— 最简单是把它挂到你的
`backend/ops/health-probe.mjs` 或任意 cron 里，检查
`openssl s_client -connect mikuyun.xyz:443 -servername mikuyun.xyz </dev/null 2>/dev/null | openssl x509 -noout -checkend 604800`
（剩余不足 7 天时退出码非 0）。注意 `-servername` 不能省，否则拿到的可能是同 IP 其他站点的证书。

---

## 9. 常见故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `certbot` 报 `Timeout during connect (likely firewall problem)` | 80 端口被安全组/防火墙挡 | 放行 80（续期也要用，别关） |
| 报 `Invalid response from http://mikuyun.xyz/.well-known/acme-challenge/... : 404` | ACME location 没加进**正确的** 80 server 块，或被前面的 location 抢先匹配 | 回到第 3 步，`nginx -T \| grep -A5 acme-challenge` 确认生效位置 |
| 报 `challenge ... 301` | 80 块里已有全局 301 到 https，而 ACME location 没写 `^~` 前缀 | ACME location 必须 `location ^~ /.well-known/acme-challenge/`，且放在 `location /` 之前 |
| `conflicting server name ... on 0.0.0.0:80` | 又加了一个 `server_name mikuyun.xyz` 的 80 块 | 只保留一个 80 server 块（第 5.2 步） |
| 浏览器「证书名称不匹配」 | 证书只含 `mikuyun.xyz`，但访问的是 `www.mikuyun.xyz` | 用 `-d` 同时签两个，或删掉配置里的 www |
| 页面能开但登录 403 `ORIGIN_FORBIDDEN` | `CORS_ORIGINS` 仍是 `http://`，或 nginx Origin 白名单没换成 `https://` | 两边都改成 `https://mikuyun.xyz` |
| 登录 403 `HTTPS_REQUIRED` | `REQUIRE_HTTPS` 没设 `true`，或 nginx 没传 `X-Forwarded-Proto https` | 按第 6 步改；确认 443 的 location 里有 `proxy_set_header X-Forwarded-Proto https;` |
| 后端启动失败 `CORS_ORIGINS must contain exact HTTP origins` | 写了带 `/chat`、带结尾斜杠、或用了 `*` | 只能写 `https://mikuyun.xyz` 这种精确 origin |
| 图片上传 413（且响应是 nginx HTML 而非 JSON） | 443 的 `/chat/api/` 缺 `client_max_body_size 12m` | 补上 |
| `certbot renew` 成功但浏览器还是旧证书 | deploy hook 没装 / nginx 没 reload | 第 8 步 ①；`systemctl status certbot` 看服务 |

---

## 10. 风险提醒（做之前先看清楚）

1. **HSTS 是单程票**：配置里有 `Strict-Transport-Security: max-age=31536000; includeSubDomains`。
   一旦浏览器收到，**这一年内**该域名及其所有子域只能用 https，http 会被浏览器直接拒绝（不给点「继续」的机会）。
   如果这台机器上还有只跑 http 的子域（例如某个 `xxx.mikuyun.xyz`），先把 `includeSubDomains` 去掉、
   或把 `max-age` 调小（如 300），稳定运行几天再加大。
2. **80 端口必须常开**：`--webroot` 续期走 80。关掉 80 等于 90 天后证书到期、站点全站证书报错。
3. **证书私钥不要外传**：`/etc/letsencrypt/` 整个目录权限 700、`archive/` 里是真实私钥；不要打包进发布包、
   不要上传到仓库。备份服务器时它应该单独做受限备份。
4. **改 nginx 前必须备份**（第 1 步）：这台机器还有 `miku-ai.conf`、`nover.conf` 等其他站点，
   `nginx -t` 不过就千万别 reload（reload 失败时 nginx 会保留旧配置继续跑，但你的下一次改更乱）。
5. **回滚**：把第 1 步备份的 `sites-available` / `snippets` 拷回 → `nginx -t` → `systemctl reload nginx`；
   同时把 `chat.env` 的 `REQUIRE_HTTPS` 改回 `false`（或删掉）、`CORS_ORIGINS` 改回 `http://` 再重启后端。
   **不要**删 `/etc/letsencrypt/`（留着不影响什么，删了要重签且会吃限流配额）。

---

## 附：一页命令速查（熟练后只看这里）

```bash
# 1 备份
BK=/root/nginx-backup-$(date +%F-%H%M) && mkdir -p $BK && cp -a /etc/nginx/sites-available /etc/nginx/snippets $BK/
# 2 装
apt install -y certbot
# 3 加 ACME location 到现有 80 server 块 + mkdir -p /var/www/certbot/.well-known/acme-challenge
nginx -t && systemctl reload nginx
# 4 签
certbot certonly --webroot -w /var/www/certbot -d mikuyun.xyz -d www.mikuyun.xyz --dry-run
certbot certonly --webroot -w /var/www/certbot -d mikuyun.xyz -d www.mikuyun.xyz --agree-tos -m you@example.com
# 5 换 nginx 配置（80 只跳转 + 443 完整块），注释掉 /etc/nginx/snippets/aitrance-chat.conf 的 include
nginx -t && systemctl reload nginx
# 6 改 /etc/aitrance/chat.env：CORS_ORIGINS 换 https、REQUIRE_HTTPS=true、TRUST_LOOPBACK_PROXY=true
systemctl restart aitrance-chat && curl -s https://mikuyun.xyz/chat/api/v1/health
# 7 验（见第 7 节 7 条 curl + 4 项浏览器）
# 8 续期钩子 + 干跑
certbot renew --dry-run
```
