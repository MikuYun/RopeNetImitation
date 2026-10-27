# run-ux2-p0.ps1 —— task-12：一次把「起隔离服务 → 跑 UX2 P0 浏览器实证 → 停服务」做完
#
# 为什么必须写在同一个脚本里（沿用 run-ux2-regression.ps1 的实测结论）：
#   Start-Process 起的子进程会随父 pwsh 退出被 Windows job object 一并回收，
#   所以「先起服务、再单独跑一条命令」必然拿到 ERR_CONNECTION_REFUSED。
#   本脚本是服务的父进程，脚本跑完才收工。
#
# 为什么不复用 5173 / 3099：
#   5173 上有一个**不是我的** development 模式 vite（VITE_USE_MOCK=true，MSW 拦 /api/*），
#   3099 上是别人起的旧库后端。本轮用全新端口对（3098 / 5174）+ 全新临时库，
#   既不动别人的进程，也避免历史脏数据把「未读数 / 首条消息」这类断言污染成假 FAIL。
#
# 用法：pwsh -NoProfile -File docs\evidence\run-ux2-p0.ps1 [-HardTimeoutMs 900000]
#       -HardTimeoutMs 是**每套脚本**的硬超时（P0 脚本需要上传/下载/多视口，默认给 15 分钟）。
# 日志：docs\evidence\e2e-ux2-p0-run.txt（脚本 stdout 完整副本 + 末尾 EXIT=）
# 副作用：只在临时库里注册 gate_a/b/c 测试账号、上传自己生成的临时图片/文本；
#         不碰生产库、不碰生产域名、不跑 backend/deploy/。

param([int]$HardTimeoutMs = 900000)

$ErrorActionPreference = 'Stop'
$evidence = 'B:\AITrance\docs\evidence'
$frontend = 'B:\AITrance\frontend'
$dbDir = 'C:\Users\31626\AppData\Local\Temp\ux2-p0'
$summary = Join-Path $evidence 'ux2-p0-summary.txt'

# 全新临时库：P0-8 断言「gate_a 的 uid 恰好是 10001」，只有在干净库上才成立
# （uid 由 SELECT MAX(uid)+1 分配，历史库会把首个普通账号顶到 1000x 之外）。
if (Test-Path $dbDir) { Remove-Item -Recurse -Force $dbDir -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $dbDir | Out-Null

function Get-Status([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri $u -TimeoutSec 3 -UseBasicParsing
    return [int]$r.StatusCode
  } catch {
    return 0
  }
}

function Wait-Ready([string]$u, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if ((Get-Status $u) -eq 200) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

$procs = New-Object System.Collections.ArrayList
$lines = New-Object System.Collections.ArrayList

function Add-Line([string]$s) {
  [void]$lines.Add($s)
  Write-Output $s
}

try {
  # ── 后端 3098（全新临时库，首启 bootstrap 管理员 1001）───────────────
  $env:PORT = '3098'
  $env:DATABASE_PATH = Join-Path $dbDir 'chat.sqlite'
  $env:DEFAULT_FRIEND_USERNAME = ''
  $env:CORS_ORIGINS = 'http://localhost:5174,http://127.0.0.1:5174'
  $env:ADMIN_UID = '1001'
  $env:ADMIN_INITIAL_PASSWORD = 'A454545asd@'
  $be = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList '--experimental-strip-types', 'src/server.ts' `
    -WorkingDirectory 'B:\AITrance\backend' `
    -RedirectStandardOutput (Join-Path $evidence 'backend-3098.log') `
    -RedirectStandardError (Join-Path $evidence 'backend-3098.err.log') `
    -WindowStyle Hidden -PassThru
  [void]$procs.Add($be)
  Add-Line "启动后端 3098 pid=$($be.Id) db=$env:DATABASE_PATH"
  if (-not (Wait-Ready 'http://127.0.0.1:3098/api/v1/health' 60)) { throw 'backend 3098 not ready' }

  # ── 前端 5174（integration：VITE_USE_MOCK=false）────────────────────
  $env:VITE_BACKEND_ORIGIN = 'http://127.0.0.1:3098'
  $fe = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList 'node_modules/vite/bin/vite.js', '--mode', 'integration', '--port', '5174' `
    -WorkingDirectory $frontend `
    -RedirectStandardOutput (Join-Path $evidence 'vite-5174.log') `
    -RedirectStandardError (Join-Path $evidence 'vite-5174.err.log') `
    -WindowStyle Hidden -PassThru
  [void]$procs.Add($fe)
  Add-Line "启动前端 5174 pid=$($fe.Id)"
  if (-not (Wait-Ready 'http://localhost:5174/' 60)) { throw 'frontend 5174 not ready' }

  # ── 三段自检（任一失败立刻中止，否则后面全是噪声）──────────────────
  $mainTs = (Invoke-WebRequest -Uri 'http://localhost:5174/src/main.ts' -UseBasicParsing -TimeoutSec 15).Content
  $mockOk = $mainTs -match 'VITE_USE_MOCK":\s*"false"'
  Add-Line "自检 1 VITE_USE_MOCK=false ... $(if ($mockOk) { '通过' } else { '失败' })"
  if (-not $mockOk) { throw 'mock still on' }

  $proxyHealth = Get-Status 'http://localhost:5174/api/v1/health'
  Add-Line "自检 2 GET /api/v1/health via 5174 proxy = $proxyHealth"
  if ($proxyHealth -ne 200) { throw 'proxy health not 200' }

  $adminLogin = 0
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3098/api/v1/auth/login' -Method Post `
      -ContentType 'application/json' -Body '{"username":"1001","password":"A454545asd@"}' `
      -UseBasicParsing -TimeoutSec 10
    $adminLogin = [int]$r.StatusCode
  } catch { $adminLogin = 0 }
  Add-Line "自检 3 管理员 1001 登录 = $adminLogin"
  if ($adminLogin -ne 200) { throw 'admin bootstrap login not 200' }

  # ── 跑 P0 浏览器实证（脚本读 BASE / BACKEND 环境变量）────────────────
  $env:BASE = 'http://localhost:5174'
  $env:BACKEND = 'http://127.0.0.1:3098'
  $env:HARD_TIMEOUT_MS = [string]$HardTimeoutMs

  $name = 'e2e-ux2-p0.mjs'
  $outLog = Join-Path $evidence 'e2e-ux2-p0-run.txt'
  Add-Line ''
  Add-Line "──── 运行 $name ────"
  $stdout = Join-Path $evidence '.ux2p0.stdout.tmp'
  $stderr = Join-Path $evidence '.ux2p0.stderr.tmp'
  Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
  $run = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList $name -WorkingDirectory $frontend -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $deadline = (Get-Date).AddMilliseconds($HardTimeoutMs + 120000)
  while (-not $run.HasExited) {
    if ((Get-Date) -gt $deadline) {
      Add-Line "[超时] $name 超过硬超时，强制结束"
      taskkill /PID $run.Id /T /F | Out-Null
      break
    }
    Start-Sleep -Milliseconds 500
  }
  $run.WaitForExit()
  $code = $run.ExitCode
  $body = @()
  if (Test-Path $stdout) { $body += (Get-Content $stdout) }
  if (Test-Path $stderr) { $body += (Get-Content $stderr -ErrorAction SilentlyContinue) }
  $body += ''
  $body += "EXIT=$code"
  $body | Set-Content -Path $outLog -Encoding UTF8
  Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
  $tail = ($body | Where-Object { $_ -match '^===' } | Select-Object -Last 1)
  if (-not $tail) { $tail = '(无汇总行)' }
  Add-Line "$name EXIT=$code  $tail"

  Add-Line ''
  Add-Line '──── P0 汇总 ────'
  Add-Line "$name`tEXIT=$code`t$tail`t$outLog"
  if ($code -ne 0) { throw "e2e-ux2-p0.mjs 退出码 $code（见 $outLog）" }
} catch {
  Add-Line "脚本异常：$($_.Exception.Message)"
} finally {
  Start-Sleep -Milliseconds 300
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
  }
  $lines | Set-Content -Path $summary -Encoding UTF8
  Write-Output "汇总日志：$summary"
}
