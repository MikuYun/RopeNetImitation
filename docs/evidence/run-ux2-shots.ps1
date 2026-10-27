# run-ux2-shots.ps1 —— task-11 页面域截图：一次把「起隔离服务 → 跑截图脚本 → 停服务」做完
#
# 为什么必须写在同一个脚本里（沿用 task-8 run-e2e.ps1 的结论）：实测 Start-Process 起的
# 子进程会随父 pwsh 退出被一并回收（Windows job object），所以「先起服务、再单独跑一条
# 命令」必然拿到 ERR_CONNECTION_REFUSED。本脚本是服务的父进程，node 脚本跑完才收工。
#
# 与 run-e2e.ps1 的区别（为什么要另写一个）：
#   1. 端口换成 3098(后端) / 5174(前端)——5173 上已有一个 **development 模式**（VITE_USE_MOCK=true）
#      的 vite 在跑，MSW 会拦截所有 /api/*，拿到的全是 mock 数据，不能用来做「连真后端」的证据。
#   2. 后端换了干净的临时库（../Temp/ux2-sql/chat.sqlite），首启会自动 bootstrap 管理员
#      1001 / A454545asd@，管理后台才有真数据可截。
#   3. 后端 CORS_ORIGINS 要加上 5174：vite 代理会把浏览器的 Origin 原样转给后端，
#      后端 app.ts:178 对不在白名单里的 Origin 一律 403 ORIGIN_FORBIDDEN。
#
# 用法：pwsh -NoProfile -File docs\evidence\run-ux2-shots.ps1 [-HardTimeoutMs 300000]
# 日志：docs\evidence\ux2-shots.log（脚本 stdout 完整副本 + 末尾 EXIT=）
# 副作用：只在临时库上注册 ux2_* 测试账号、上传两张自己生成的 PNG；不碰生产库/生产域名。

param([int]$HardTimeoutMs = 300000)

$ErrorActionPreference = 'Stop'
$evidence = 'B:\AITrance\docs\evidence'
$dbDir = 'C:\Users\31626\AppData\Local\Temp\ux2-sql'
$logFile = Join-Path $evidence 'ux2-shots.log'

New-Item -ItemType Directory -Force -Path $dbDir | Out-Null

function Get-Status([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri $u -TimeoutSec 2 -UseBasicParsing
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
$exit = 1
try {
  # ── 后端 3098（干净临时库，自动 bootstrap 管理员 1001）────────────────
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
  Write-Output "启动后端 3098 pid=$($be.Id) db=$env:DATABASE_PATH"
  if (-not (Wait-Ready 'http://127.0.0.1:3098/api/v1/health' 60)) {
    Write-Output '后端 3098 未就绪，中止'
    throw 'backend 3098 not ready'
  }

  # ── 前端 5174（integration：VITE_USE_MOCK=false）──────────────────────
  $env:VITE_BACKEND_ORIGIN = 'http://127.0.0.1:3098'
  $fe = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList 'node_modules/vite/bin/vite.js', '--mode', 'integration', '--port', '5174' `
    -WorkingDirectory 'B:\AITrance\frontend' `
    -RedirectStandardOutput (Join-Path $evidence 'vite-5174.log') `
    -RedirectStandardError (Join-Path $evidence 'vite-5174.err.log') `
    -WindowStyle Hidden -PassThru
  [void]$procs.Add($fe)
  Write-Output "启动前端 5174 pid=$($fe.Id)"
  if (-not (Wait-Ready 'http://localhost:5174/' 60)) {
    Write-Output '前端 5174 未就绪，中止'
    throw 'frontend 5174 not ready'
  }

  # 自检 1：mock 必须关闭（development 模式会开 MSW 拦 /api，拿到的是假数据）
  $mainTs = (Invoke-WebRequest -Uri 'http://localhost:5174/src/main.ts' -UseBasicParsing -TimeoutSec 10).Content
  if ($mainTs -notmatch 'VITE_USE_MOCK":\s*"false"') {
    Write-Output '自检失败：VITE_USE_MOCK 不是 false'
    Write-Output ($mainTs.Substring(0, [Math]::Min(400, $mainTs.Length)))
    throw 'mock still on'
  }
  Write-Output '自检 1 通过：VITE_USE_MOCK=false'

  # 自检 2：代理链通（浏览器侧同源路径 → vite → 3098）
  $proxyHealth = Get-Status 'http://localhost:5174/api/v1/health'
  Write-Output "自检 2：GET /api/v1/health via 5174 proxy = $proxyHealth"
  if ($proxyHealth -ne 200) { throw 'proxy health not 200' }

  # 自检 3：管理员能登录（首启 bootstrap 生效）
  $body = '{"username":"1001","password":"A454545asd@"}'
  $login = Invoke-WebRequest -Uri 'http://127.0.0.1:3098/api/v1/auth/login' -Method Post `
    -ContentType 'application/json' -Body $body -UseBasicParsing
  Write-Output "自检 3：管理员 1001 登录 = $([int]$login.StatusCode)"

  # ── 跑截图脚本 ────────────────────────────────────────────────────────
  $env:BASE = 'http://localhost:5174'
  $env:BACKEND = 'http://127.0.0.1:3098'
  $run = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList 'B:\AITrance\docs\evidence\shot-ux2-pages.mjs' `
    -WorkingDirectory 'B:\AITrance\frontend' `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $evidence '.ux2.stdout.tmp') `
    -RedirectStandardError (Join-Path $evidence '.ux2.stderr.tmp')

  $deadline = (Get-Date).AddMilliseconds($HardTimeoutMs)
  while (-not $run.HasExited) {
    if ((Get-Date) -gt $deadline) {
      Write-Output "[超时] 超过 ${HardTimeoutMs}ms，强制结束"
      taskkill /PID $run.Id /T /F | Out-Null
      break
    }
    Start-Sleep -Milliseconds 500
  }
  $run.WaitForExit()
  $exit = $run.ExitCode
  Write-Output "截图脚本退出码 EXIT=$exit"
} catch {
  Write-Output "脚本异常：$($_.Exception.Message)"
  $exit = 1
} finally {
  Start-Sleep -Milliseconds 300
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
  }
  $out = @()
  if (Test-Path (Join-Path $evidence '.ux2.stdout.tmp')) {
    $out += (Get-Content (Join-Path $evidence '.ux2.stdout.tmp'))
    $out += (Get-Content (Join-Path $evidence '.ux2.stderr.tmp') -ErrorAction SilentlyContinue)
    Remove-Item (Join-Path $evidence '.ux2.stdout.tmp'), (Join-Path $evidence '.ux2.stderr.tmp') -ErrorAction SilentlyContinue
  }
  $out += ''
  $out += "EXIT=$exit"
  $out | Set-Content -Path $logFile -Encoding UTF8
  Write-Output '──────── 截图脚本输出 ────────'
  $out | ForEach-Object { Write-Output $_ }
  Write-Output "日志：$logFile"
  exit $exit
}
