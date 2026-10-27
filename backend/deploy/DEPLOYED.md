# 公网部署记录

更新日期：2026-10-08。入口：`http://mikuyun.xyz/chat/`，只使用 HTTP。沿用最初提供并已解析的域名 `mikuyun.xyz`，不是后续消息中的 `mukuyun.xyz`。

## 当前版本

- release：`/opt/aitrance/releases/release-20261008-165721-responsive`。仅更新前端；backend链接到上一个release的后端，服务PID保持1207141，没有重启服务。
- 当前链接：`/opt/aitrance/current`。
- 服务：`aitrance-chat.service`，非 root 用户，Node.js 24.15.0，仅监听 `127.0.0.1:3001`。
- 本轮未修改Nginx或原站文件，也未重启Nginx及任何后端。按10月8日部署前快照保留现有配置，不把9月28日旧文件覆盖回去。
- 前端更新包 SHA256：`97a2057ed55982b8c6dacbad0fd8c3997d4f2f66c5323000a62825727a97f7b5`。保留旧 hash 静态资源，避免已打开页面的懒加载404。
- 数据目录：`/var/lib/aitrance`，权限 700。数据库由聊天服务用户拥有。
- 原重置备份目录：`/root/aitrance-backups/release-20260928-141619-autofriend`，root 私有。
- 9月28日更新备份：`/root/aitrance-backups/release-20260928-162735-deeplink/chat-before-ui-update-consistent.sqlite`，Node SQLite 在线一致性备份、权限600、integrity_check=ok；同目录保留 previous-release.txt。系统 Python 不支持 Connection.backup，失败产物不可作为有效备份。
- 本轮回滚信息：`/root/aitrance-backups/release-20261008-165721-responsive`，包含previous-release.txt、preserved-files.sha256和chat-service-pid.txt。不修改数据库，无数据库迁移或重置。

## 2026-10-08 双端界面预览部署

用户明确要求先部署查看效果。本次是界面预览交付，不代表PM正式发布NO-GO已关闭，不自行迁移HTTPS、处理依赖或操作探针数据。

- 隔离候选：`backend/.data/deploy/web-dSTH8o`，构建期间原前端文件哈希稳定；npm ci、vue-tsc/Vite生产build及27/27单测通过，mock移除通过。
- 包：`backend/.data/deploy/release-20261008-165721-responsive.tar.gz`，137524字节；上传与解包后校验SHA256通过。
- 新index SHA256：`d01f2f57475d5d3f3cf62351e63ca85d77d55628d352f911df12f03533e51c21`，直接公网下载匹配。
- 原子切换current，旧版本`release-20260928-162735-deeplink`完整保留，新目录带旧hash资源。回滚可将current原子切回旧版本，无需重启后端或改数据库。
- Nginx检查通过。部署前后miku-ai.conf、nover.conf、chat snippet、原站index、后端server.js均哈希一致；聊天服务仍active、PID未变。
- 原站配置现已明确`location = / { return 404; }`，原`/api/health`亦404；这与9月28日历史记录不同。本方未改该配置。实际原应用路径`/miku_ai/`、`/miku_ai/api/health`、`/nover/`公网均200，不能以旧路由假设擅自修复或回退原站。
- `/chat/`、登录/注册深链、入口JS/CSS与聊天health公网200，index匹配新构建。
- 直接公网Chrome检查：320/390px登录无横向溢出；QJQ登录后手机底部导航、联系人、更多、深色主题正常；320x568、390x844、768x1024、1440x900切换布局正确，均无横向溢出；WS ready与API都使用/chat前缀，无页面或API错误。
- 本轮没有注册账号、发送消息、打开会话、修改已读或清库。验收仅登录/注销，注销token复核401；未保存凭据或业务截图。
- iOS/Android真机键盘/安全区、后台标签页已读仍待验；source-map-js high未关闭、HTTP明文风险未改变。117项响应式断言和13项交互门禁为frontend本地证据，本轮没有冒称已在公网完整复跑。

## 用户与默认好友

用户授权清空全部聊天账号及关联数据，并创建账号 `QJQ`、昵称“柒玖柒”。用户名按现有契约存储为 `qjq`，大小写登录等价，密码按用户提供值通过 scrypt 哈希保存，不写入文档或配置。

14:29首次交付清理时：users=1，好友、申请、会话、消息与认证会话均为0；随后进行了一次登录/注销验收，验收 token 再请求本人接口返回401。这是历史快照，不是当前用户数量。

16:30更新时共有3名用户、9条消息，包含前端协作者新增的 qja_probe（前端验收探针），其与QJQ的专用私聊有8条消息。另一个用户及其数据必须保留，不能再次全库重置。本轮未创建新账号或发送消息，验收仅读取探针历史并触发该会话正常已读更新。探针清理命令被工具安全策略拒绝，尚未执行；只读复核探针仍存在，后端仍active。不要把本记录理解为探针已删除。

生产配置 `DEFAULT_FRIEND_USERNAME=QJQ`。新用户注册即双向成为好友，无需申请通过；QJQ 在线时好友列表实时出现新人。没有自动发送消息或授予管理员权限。未修改其他网站数据库。

## 验证证据

- 后端 `npm test` 15/15；`npm run check`、`npm run docs` 通过。
- 两个独立 Chrome BrowserContext 访问公网：QJQ 登录、新人注册、新人列表自动出现柒玖柒、QJQ 列表不刷新出现新人。
- 从好友列表打开私聊，双方消息气泡实时出现；双方收到 WS ready，API/WS 使用 `/chat` 前缀，无页面异常。
- 重新打开会话可以加载已持久化的双向消息。测试账号及消息在最终重置中已删除，最终只保留指定账号。
- 清理后 QJQ 公网浏览器登录成功、昵称正确、无残留测试好友；注销后验收 token 为401。
- 原 `/`、原 `/api/health`、`/chat/`、`/chat/api/v1/health` 均为200。Nginx 配置检查通过。
- 16:30前端更新：独立构建副本 vue-tsc + vite build 通过，生产无mock，Vitest 27/27通过。
- 直接访问线上新产物（非本地dev代理）连续两轮 Chrome 冷启动深链 + F5，8条消息气泡均显示且不重复；每轮两次WS ready、历史接口正常，无presence探测、HTTP 4xx/5xx、JS异常或未加/chat前缀的API请求。验收token已注销并复核401。

## 已知限制

- 深链/F5历史空白问题已由frontend修复，本方重新构建上线并两轮公网复验通过，原问题关闭；未跨写frontend源码。探针账号清理仍待处理，见用户段落。
- 本次验证从当前开发网络访问公网服务器，不等于已在两家不同运营商网络实机复验；部署入口可供不同网络访问，移动端适配未纳入本轮验收。
- HTTP 明文传输密码、token 和消息。同域路径不是安全隔离。建议尽快更换此前提供的临时 SSH 密码，且网站账号不要复用服务器密码；正式部署建议 HTTPS。

更新、备份和回滚步骤见 `HTTP.md`。重启服务后须等待健康检查200，再宣布恢复；systemd active 不代表监听端口已就绪。
