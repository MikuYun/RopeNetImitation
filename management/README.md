# 项目经理工作台

产品：AITrance 网页聊天。接管日期：2026-10-08。

## 当前结论

**NO-GO：不批准正式公开上线。** 既有 HTTP 公网部署只是验证环境，不代表满足正式发布标准。前后端单元测试通过也不等于产品验收通过。

项目经理只写 `management/`、只追加 `session.txt`；只读业务代码与契约。保留工程师目录所有权和在途 `UI-RESP-20261008` 任务。不创建替代工程师 agent，不擅自提交 git、部署、登录生产或清理生产数据。

## 工作入口

- [上线标准与任务单](release-plan.md)：责任人、验收证据、优先级及门禁。
- [当前审计结论](current-status.md)：区分实际验证、历史记录、源码风险和待验证项。
- `node management/verify.mjs`：隔离副本编译、测试、契约、部署路径和依赖审计，输出 `management/evidence/<时间>/report.json`，不改业务源码或已有构建产物。
- `node management/verify.mjs --skip-audit`：仅用于离线排错，审计标记未验，**不能作为发布通过依据**。
- `management/tests/release-regressions.test.ts`：独立回归，以正确行为为断言；未修复时失败，不反向断言缺陷行为制造通过。
- `management/tests/ws-lifecycle.test.ts`、`management/tests/http-session.test.ts`：旧 socket/ticket 生命周期与 refresh401终止性回归，不访问网络或正式账号。
- `node management/browser-check.mjs management/evidence/<运行目录>/snapshot`：复跑指定副本的 Chrome 双用户收发、深链/刷新、输入行为及失效隐私回归；只允许本地 snapshot，临时内存库，证据另存唯一子目录。Chrome 手机视口不是真机。

需要 Node.js 24、前后端已按锁文件安装的依赖。副本以目录 junction/symlink 复用只读依赖，不复制本地 `.env`、SQLite、日志、token 或线上凭据。脚本核验已安装包版本与锁文件；正式 release 还必须由工程师补充隔离环境 `npm ci` 证据。

## 协作闭环

1. `pm: [Q]` 下发，工程师回 `[ACK]`，给出顺序、阻塞与预计交付时间。
2. 工程师在自己的目录修改，提供文件、命令、结果和证据；不得只报“完成”。
3. PM 复跑门禁、反例与跨端回归。失败退回原责任人；源码变化需要复跑。
4. P0/P1 关闭、真机与运营条件满足后才审批候选 release。审批与生产操作是两个动作。
5. 发布由 backend 按批准的窗口操作，先备份和确认回滚，再做无生产探针的验收。

session 与 monitor 是文件通信，不保证工程师执行，也不自动唤醒会话。无 ACK 保持“已下发、未确认”，不伪造进度。
