# 接管审计与上线判定

日期：2026-10-08。结论：**NO-GO**。本轮最新稳定源码副本采样时间：11:51（Asia/Shanghai），之后的改动必须再次验收。

## 实际复跑

| 检查 | 命令 | 结果 | 说明 |
|---|---|---|---|
| Node | node --version | v24.15.0 | 本机，不代表生产再次核验 |
| frontend类型 | npm run typecheck | 通过 | 本轮本机复跑 |
| frontend测试 | npm test | 27/27 | 仅normalize单测，不能替代E2E |
| backend类型 | npm run check | 通过 | 本轮本机复跑 |
| backend测试 | node --experimental-strip-types --test test/chat.test.ts | 15/15 | 不覆盖dist；隔离库/本机真实WS |
| frontend运行依赖 | npm audit --omit=dev --json --registry=https://registry.npmjs.org | high=1 | source-map-js，GHSA-68fv-2mgg-jv7q，受影响<1.2.2，有修复；浏览器可达性待分析 |
| backend运行依赖 | 同上 | 0条 | 不代表无未知漏洞 |

默认npmmirror audit为404 NOT_IMPLEMENTED；本轮命令指定官方registry，未改机器配置。审计服务失败不能当“零漏洞”。

隔离build、overlay、契约、独立回归以 `management/evidence/*/report.json` 为准，失败保留，不提前宣称通过。

## 最新隔离验收

稳定副本：`management/evidence/2026-10-08T03-51-53-918Z-6hOSsO/`。

源码指纹：`04bcad65635b996903ade5b9b0d98c30cb74fd860cd71d3e48afd7543f15e283`。这是门禁采样文件的聚合 SHA256，不是 git commit 或全量生产发布编号。

| 门禁 | 实际结果 |
|---|---|
| 已安装依赖版本对锁文件 | 两侧通过；不是干净 npm ci |
| 前端 typecheck、原有单测 | 通过，27/27 |
| 后端编译、原有单测 | 通过，15/15 |
| OpenAPI 重新生成与新鲜度 | 通过，未改工程师的原 OpenAPI |
| 契约比对与注入缺陷自检 | 通过；报告仅写隔离副本 |
| /chat overlay、类型、Vite打包、mock移除 | 通过；不改业务源码与现有 dist |
| PM独立回归 | **13项：7过、6败**，详见 pm-regressions.log |
| Chrome双context本地生产产物 | **9/9通过**：冷深链、双向实时、PC Enter、手机Enter换行与发送键、两端无横向溢出、F5历史、失效退出、无未预期错误 |
| 运行依赖审计 | 前端high=1，后端0；前端未关闭 |
| 验收期间源文件稳定 | 通过，避免把混合在途版本当候选版本 |

浏览器使用一次性内存库和随机密码，不登录公网、不碰正式账号，截图只有合成数据。手机视口是 Chrome 模拟，不是 iOS/Android 真机。

### 仍失败的六个反例

1. 注销后迟到的消息历史仍回填私密缓存（SEC-02）。
2. stop 后迟到 ticket 仍创建旧 socket（SEC-02）。
3. 旧 socket 的迟到 onclose 清掉新 socket 并触发重连（SEC-02）。
4. stop 后旧 socket 的迟到 onmessage 仍进入应用分发（SEC-02）。
5. 较旧已读请求失败回滚了已成功的新游标（FE-02）。
6. refresh 自身401再次等待自己的 refreshSingleFlight，原请求不结束也不触发失效处理（FE-04）。

反例断言正确目标行为，失败是待修复证据；不以更改测试期望来关闭风险。完整清单与路径已通过 session 反馈给 frontend。

## 配置与历史风险

- DEPLOYED.md历史记录及chat.env.example明确HTTP，无密码/token/消息传输保护；SEC-01阻塞。本轮未访问生产或改Nginx。
- Origin验证、非root systemd、回环监听、scrypt、单次ticket与WS限制是良好基线，不抵消HTTP。
- 原记录明确旧qja_probe清理被阻止且未完成，另有真实用户，不得全库重置。

## 修复进展与剩余风险

- 前端已出现响应式布局、readingId 与正文可见性判据；两个非正文不自动已读、一个正向已读独立回归通过。完整后台/详情/主题/断点矩阵尚未验收，不关闭 FE-01/03。
- auth 清理业务缓存与代际机制已经加入。原“注销和失效残留缓存”两个独立回归、旧列表响应隔离已过；迟到历史/WS仍失败，SEC-02不能整体关闭。
- 已读单次请求失败回滚回归通过，但旧失败覆盖新成功仍失败，FE-02不能关闭。
- 浏览器实测已从失效后仍停在聊天且显示3条气泡，改善为 `/chat/login`、私密气泡0；9项浏览器检查通过，但 refresh401自等待仍阻塞 FE-04。
- 响应式复跑工具存在仓库根路径/旧wire初始化/目标隔离与状态检查风险，已反馈 frontend，不由PM跨目录修改。

## 尚未验收

- UI-RESP已有设计文档、实现与脚本变化，但未收到工程师正式ACK/逐项交付，不推断R1–R6全完成。
- 最新浏览器E2E、iOS/Android真机、HTTPS/WSS、注册治理、隐私/账号删除说明。
- 同版npm ci/产物、恢复/回滚演练、容量、监控告警及责任人。
- 2026-09-28公网截图/文档仅历史证据，不证明新功能通过。

## 沟通状态

已以pm追加边界、上线任务、失败证据与复跑命令。frontend出现与反馈对应的修复，仍未正式ACK；backend未收到本轮ACK或交付。任务单“待ACK”表示协作确认状态，不抹掉源码中已观察到的进展。监控不会自动唤醒，也不保证任务执行；正式上线未完成。
