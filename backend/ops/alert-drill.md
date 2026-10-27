# OPS-02 告警演练（alert drill）

> 状态：**BLOCK** —— 演练步骤已给出并可复跑，但本机（开发工作站，无生产环境访问权）
> **无法真实发出任何告警**：没有告警通道（无 SMTP / 无 webhook / 无 IM 机器人凭据），
> 也没有值班人（on-call）名单与升级路径。因此下面第 1–4 步可以立即在任何环境执行，
> 第 5–7 步（打通通道、建值班表、回执确认）**必须在有生产告警基础设施的环境由人执行**。

## 0. 事实与边界

| 项 | 事实 |
| --- | --- |
| 监控工具 | `backend/ops/health-probe.mjs`（已实测，见 `backend/evidence/ops.md`） |
| 告警通道 | **不存在**。仓库内无 SMTP/邮件、无 webhook、无 IM 机器人、无 PagerDuty 等配置 |
| 值班人 | **不存在**。仓库内无 on-call 名单、无升级路径、无告警接收人 |
| 生产部署 | 未部署（本项目目前只有开发机与 CI 构建） |
| 本机可做 | 阈值与告警判定的**功能验证**（杀死进程 → `health-probe` 返回 CRITICAL + exit 1，已实测） |
| 本机不可做 | 真实送达、真实叫醒人、真实确认回执 |

## 1. 触发源（工具侧，已就绪）

`health-probe.mjs` 在快照里按阈值输出 `alerts[]`，并用退出码传播：

- 退出码 `0` = 无 CRITICAL；`1` = 有 CRITICAL；`2` = 参数/环境错误。
- 告警码：

| code | level | 触发条件 |
| --- | --- | --- |
| `HEALTH_CONSECUTIVE_FAILURES` | CRITICAL | `/health` 或 `/api/v1/health` 连续 ≥3 次探测失败 |
| `DISK_LOW` | CRITICAL | 数据库所在分区可用空间 < 10% |
| `DB_INTEGRITY` | CRITICAL | `PRAGMA integrity_check` 非 `ok` |
| `DB_UNREADABLE` | CRITICAL | 只读打开数据库失败 |
| `DB_SCHEMA_MISMATCH` | CRITICAL | 库能打开但缺业务表（`--database` 指错文件 / schema 未初始化） |
| `HTTP_5XX_RATE` | CRITICAL | 5xx 比例 > 1%（需 `--log` 提供应用日志，否则该项为 `null`，不虚构） |
| `PROBE_SLOW` | WARN | 探测 p95 > 500ms |
| `DB_WAL_LARGE` | WARN | WAL 字节数 > 主库 10 倍**且** > 64 MiB（绝对下限，避免新建空库误报） |
| `ALL_CLEAR` | INFO | 以上均未触发 |

## 2. 演练步骤（在目标环境执行；每步记录命令、退出码、输出片段）

### 步骤 1：正常态快照（期望 ALL_CLEAR / exit 0）

```bash
cd backend
node ops/health-probe.mjs \
  --base-url http://127.0.0.1:3001 \
  --database /var/lib/aitrance-chat/chat.sqlite \
  --log /var/log/aitrance-chat/backend.log \
  --rounds 5 --interval 2000 \
  --report /tmp/alert-drill-normal.json
echo "exit=$?"
```

期望：`status` = `OK`，`alerts` = `[{level:"INFO",code:"ALL_CLEAR"}]`，exit `0`。
记录：`probes./health.p95`、`disk.freePercent`、`database.integrityOk`、`serverErrors.errorRatePercent`。

### 步骤 2：可用性告警（期望 CRITICAL + exit 1）

在**预发/演练环境**停掉后端进程（生产环境用维护窗口或副本实例，禁止直接杀生产）：

```bash
# 演练环境示例
systemctl stop aitrance-chat   # 或 kill <pid>
node ops/health-probe.mjs --base-url http://127.0.0.1:3001 --rounds 4 --interval 500
echo "exit=$?"
```

期望：`alerts` 含两条 `HEALTH_CONSECUTIVE_FAILURES`（`/health` 与 `/api/v1/health`），`status` = `CRITICAL`，exit `1`。
**本机已验证该路径**（对 `http://127.0.0.1:3999` 空端口探测）：4 轮全失败 → `maxConsecutiveFailures=4` → 2 条 CRITICAL → exit `1`。

### 步骤 3：磁盘告警（期望 CRITICAL）

```bash
# 只在演练机上做：用一个小的 tmpfs 挂载点模拟 <10% 可用
mkdir -p /mnt/tiny && mount -t tmpfs -o size=8m tmpfs /mnt/tiny
cp /var/lib/aitrance-chat/chat.sqlite /mnt/tiny/chat.sqlite   # 约 7MB，剩 <10%
node ops/health-probe.mjs --database /mnt/tiny/chat.sqlite
echo "exit=$?"
umount /mnt/tiny
```

期望：`alerts` 含 `DISK_LOW` CRITICAL。**禁止在生产数据目录上伪造该状态。**

### 步骤 4：完整性告警（只在演练副本上做）

```bash
cp chat-backup.sqlite /tmp/corrupt.sqlite
# 故意破坏 1 个页（仅演练副本）
printf '\x00\x00\x00\x00' | dd of=/tmp/corrupt.sqlite bs=1 seek=4096 count=4 conv=notrunc
node ops/health-probe.mjs --database /tmp/corrupt.sqlite
echo "exit=$?"
```

期望：`alerts` 含 `DB_INTEGRITY` CRITICAL，或 `DB_UNREADABLE`（视破坏位置）。**禁止对生产库或唯一备份做此操作。**

### 步骤 5：接通告警通道（BLOCK：本机无凭据，未执行）

在目标环境新增一个投递包装（示例，**未在本仓库实现**，因为无通道凭据）：

```bash
# 伪代码：由 ops 用真实凭据实现，任选其一
node ops/health-probe.mjs ... --report /var/log/aitrance/health.json
if [ $? -ne 0 ]; then
  curl -fsS -X POST "$ALERT_WEBHOOK_URL" -H 'Content-Type: application/json' \
    -d @/var/log/aitrance/health.json
fi
```

需要的决策（**BLOCK，需 Lead/用户提供**）：
1. 通道选型：邮件 / IM 机器人 / PagerDuty / 其它？
2. 接收人：谁收？初级/升级二级分别是谁？
3. 触发频率与抑制：每 N 分钟重复？故障恢复是否需发「已恢复」？
4. 是否允许自动升级（15 分钟无 ACK 升二级）？

### 步骤 6：送达验证（BLOCK）

- 步骤 1–4 的告警**必须真实送达接收人**，并由接收人回执。
- 记录：发送时间、送达时间、接收人、回执。
- 未送达 = 演练失败，不得记为通过。

### 步骤 7：值班表与升级路径（BLOCK）

- 需要写入：值班人姓名/联系方式、值班周期、升级顺序、静默窗口规则。
- 本仓库当前**没有任何 on-call 内容**。

## 3. 部署落地建议（等生产部署时执行）

1. `health-probe.mjs` 由 cron/systemd timer 每 60 秒跑一次，`--report` 落固定路径。
2. 包装脚本按退出码投递到通道（步骤 5 的决策确定后实现）。
3. 应用侧 5xx 计数：把 `--log` 指向应用日志；若接入 Prometheus 等指标系统，应改为直接查询指标，而不是解析日志。
4. 备份任务同样接入同一通道（见 `backend/ops/alert-drill.md` 与 OPS-01）；**备份失败必须告警**，否则 RPO 会静默劣化。

## 4. 结论

| 项 | 状态 |
| --- | --- |
| 阈值与告警判定逻辑可复跑、可验证 | **PASS**（本机实测，见 `backend/evidence/ops.md`） |
| 真实告警送达 | **BLOCK**：无告警通道、无值班人、无生产环境访问权 |
| 值班表与升级路径 | **BLOCK**：仓库内不存在 |
