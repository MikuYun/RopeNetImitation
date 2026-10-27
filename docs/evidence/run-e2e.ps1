# run-e2e.ps1 —— 一次性把「起隔离服务 → 跑 e2e → 停服务」做完
#
# 为什么必须写在同一个脚本里：实测 Start-Process 起的子进程会随父 pwsh 退出被
# 一并回收（Windows job object），所以「先起服务、再单独跑一条命令」必然拿到 000。
# 本脚本是服务的父进程，node 脚本跑完才收工，服务生命周期不跨命令。
#
# 用法：
#   pwsh -File docs\evidence\run-e2e.ps1 -Script e2e-attachment.mjs [-LogFile <path>] [-HardTimeoutMs 420000]
#
# 副作用：会在 3099 起隔离后端（temp 库）、在 5173 起 vite(integration)；
#         若检测到已有实例在跑则复用、且不会去停别人的进程。日志写 docs\evidence\*.log。

param(
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$LogFile = '',
  [int]$HardTimeoutMs = 420000,
  [string]$WorkDir = 'B:\AITrance\frontend'
)

$ErrorActionPreference = 'Stop'
$evidence = 'B:\AITrance\docs\evidence'

function Get-Status([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri $u -TimeoutSec 2 -UseBasicParsing
    return [int]$r.StatusCode
  } catch {
    return 0
  }
}

# 快速端口探活（比 Invoke-WebRequest 快很多，看护循环里每秒用一次）
# 注意：vite 只监听 [::1]，所以前端必须用 hostname 'localhost' 探，不能用 127.0.0.1。
function Test-Port([string]$host_, [int]$port, [int]$timeoutMs = 500) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($host_, $port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Start-IsolatedBackend {
  $env:PORT = '3099'
  $env:DATABASE_PATH = 'C:\Users\31626\AppData\Local\Temp\aitr-e2e\e2e.sqlite'
  $env:DEFAULT_FRIEND_USERNAME = ''
  return Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList '--experimental-strip-types', 'src/server.ts' `
    -WorkingDirectory 'B:\AITrance\backend' `
    -RedirectStandardOutput (Join-Path $evidence 'backend-3099.log') `
    -RedirectStandardError (Join-Path $evidence 'backend-3099.err.log') `
    -WindowStyle Hidden -PassThru
}

function Start-IsolatedFrontend {
  $env:VITE_BACKEND_ORIGIN = 'http://127.0.0.1:3099'
  return Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList 'node_modules/vite/bin/vite.js', '--mode', 'integration', '--port', '5173' `
    -WorkingDirectory 'B:\AITrance\frontend' `
    -RedirectStandardOutput (Join-Path $evidence 'vite-dev.log') `
    -RedirectStandardError (Join-Path $evidence 'vite-dev.err.log') `
    -WindowStyle Hidden -PassThru
}

$startedBe = $null
$startedFe = $null
$allProcs = New-Object System.Collections.ArrayList

if ((Get-Status 'http://127.0.0.1:3099/api/v1/health') -ne 200) {
  $startedBe = Start-IsolatedBackend
  [void]$allProcs.Add($startedBe)
  Write-Output "启动后端 3099 pid=$($startedBe.Id)"
} else {
  Write-Output '后端 3099 已在运行，复用'
}

if ((Get-Status 'http://localhost:5173/') -ne 200) {
  $startedFe = Start-IsolatedFrontend
  [void]$allProcs.Add($startedFe)
  Write-Output "启动前端 5173 pid=$($startedFe.Id)"
} else {
  Write-Output '前端 5173 已在运行，复用'
}

$deadline = (Get-Date).AddSeconds(60)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $be = Get-Status 'http://127.0.0.1:3099/api/v1/health'
  $fe = Get-Status 'http://localhost:5173/'
  if ($be -eq 200 -and $fe -eq 200) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}

$exit = 0
try {
  if (-not $ready) {
    Write-Output 'SERVICE_NOT_READY（后端或前端 60s 内未就绪）'
    $exit = 2
  } else {
    # 自检：dev 必须是 integration 模式（VITE_USE_MOCK=false），否则 MSW 会拦掉真实请求
    try {
      $mainTs = (Invoke-WebRequest -Uri 'http://localhost:5173/src/main.ts' -TimeoutSec 5 -UseBasicParsing).Content
      if ($mainTs -notmatch 'VITE_USE_MOCK":\s*"false"') {
        Write-Output 'SELFCHECK_FAIL：VITE_USE_MOCK 不是 false，dev 不是 integration 模式'
        $exit = 2
      }
    } catch {
      Write-Output "SELFCHECK_FAIL：取 /src/main.ts 失败 —— $($_.Exception.Message)"
      $exit = 2
    }
  }

  if ($exit -eq 0) {
    Set-Location $WorkDir
    $env:HARD_TIMEOUT_MS = "$HardTimeoutMs"
    $env:BASE = 'http://localhost:5173'
    $env:BACKEND = 'http://127.0.0.1:3099'
    $outFile = Join-Path $evidence '.run-e2e.stdout.tmp'
    $errFile = Join-Path $evidence '.run-e2e.stderr.tmp'
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
    $run = Start-Process -FilePath 'E:\nodejs\node.exe' -ArgumentList $Script `
      -WorkingDirectory $WorkDir -NoNewWindow -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    # ── 服务存活看护 ──
    # 实测：vite dev（8.3.5）在跑长脚本时会因 ws 代理的 write ECONNABORTED 自行退出，
    # 后端也可能消失。一旦进程没了，脚本里下一次导航就是 ERR_CONNECTION_REFUSED，
    # 整轮断在那里。这里每秒探一次端口，发现死掉就重拉（只重拉本脚本自己起的、
    # 或已死掉的端口；绝不主动去停别人在跑的实例），并把事件写进日志。
    $restarts = 0
    $watchLog = New-Object System.Collections.ArrayList
    while (-not $run.HasExited) {
      Start-Sleep -Milliseconds 1000
      if ($run.HasExited) { break }
      if (-not (Test-Port '127.0.0.1' 3099)) {
        Start-Sleep -Milliseconds 300
        if (-not (Test-Port '127.0.0.1' 3099)) {
          $restarts += 1
          $p = Start-IsolatedBackend
          [void]$allProcs.Add($p)
          $m = "[看护] 后端 3099 已退出，已重拉 pid=$($p.Id)"
          [void]$watchLog.Add($m)
          Write-Output $m
        }
      }
      if (-not (Test-Port 'localhost' 5173)) {
        Start-Sleep -Milliseconds 300
        if (-not (Test-Port 'localhost' 5173)) {
          $restarts += 1
          $p = Start-IsolatedFrontend
          [void]$allProcs.Add($p)
          $m = "[看护] 前端 5173 已退出，已重拉 pid=$($p.Id)"
          [void]$watchLog.Add($m)
          Write-Output $m
        }
      }
    }

    $run.WaitForExit()
    $exit = $run.ExitCode
    if ($restarts -gt 0) {
      $m = "[看护] 本轮共重拉服务 $restarts 次（环境偏 flaky，非产品缺陷）"
      [void]$watchLog.Add($m)
      Write-Output $m
    }
    $stdout = if (Test-Path -LiteralPath $outFile) { Get-Content -LiteralPath $outFile -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile -Raw } else { '' }
    if ($null -eq $stdout) { $stdout = '' }
    Remove-Item -LiteralPath $outFile, $errFile -ErrorAction SilentlyContinue
    $combined = $stdout
    if ($stderr -ne '' -and $null -ne $stderr) { $combined = "$stdout`n$stderr" }
    if ($watchLog.Count -gt 0) {
      $combined = (($watchLog | ForEach-Object { $_ }) -join "`n") + "`n`n" + $combined
    }
    if ($LogFile -ne '') {
      $combined | Tee-Object -FilePath $LogFile
    } else {
      $combined
    }
  }
} finally {
  foreach ($p in $allProcs) {
    if ($null -ne $p) {
      & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
    }
  }
}

# 把退出码也写进日志，便于证据文件自证（日志本体是脚本 stdout 的完整副本）
if ($LogFile -ne '') {
  Add-Content -Path $LogFile -Value ""
  Add-Content -Path $LogFile -Value "EXIT=$exit"
}
Write-Output "EXIT=$exit"
exit $exit
