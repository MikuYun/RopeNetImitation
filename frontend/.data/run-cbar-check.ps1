# 手机端「发送图片 / 发送文件」按钮可见性回归：
#   1. 起 3098（干净临时库）+ 5174（--mode integration，真后端）
#   2. 真 Chrome 在 390x844 / 320x568 打开会话，断言
#      .cbar__btn--image / .cbar__btn--attach 可见、命中点未被遮挡、
#      点一下能弹出系统文件选择器（用 filechooser 事件确认）
$ErrorActionPreference = 'Stop'
$root = 'B:\AITrance'
$tmp = Join-Path $env:TEMP ('cbar-check-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$db = Join-Path $tmp 'chat.sqlite'

$backend = $null
$vite = $null
try {
  $env:PORT = '3098'
  $env:DATABASE_PATH = $db
  $env:HOST = '127.0.0.1'
  $env:DEFAULT_FRIEND_USERNAME = ''
  $env:CORS_ORIGINS = 'http://localhost:5174,http://127.0.0.1:5174'
  $env:ADMIN_UID = '1001'
  $env:ADMIN_INITIAL_PASSWORD = 'CbarChk!1234'
  $backend = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList '--experimental-strip-types', 'src/server.ts' `
    -WorkingDirectory (Join-Path $root 'backend') `
    -RedirectStandardOutput (Join-Path $tmp 'backend.log') `
    -RedirectStandardError (Join-Path $tmp 'backend.err.log') -PassThru

  $env:VITE_BACKEND_ORIGIN = 'http://127.0.0.1:3098'
  $vite = Start-Process -FilePath 'E:\nodejs\node.exe' `
    -ArgumentList 'node_modules/vite/bin/vite.js', '--mode', 'integration', '--port', '5174' `
    -WorkingDirectory (Join-Path $root 'frontend') `
    -RedirectStandardOutput (Join-Path $tmp 'vite.log') `
    -RedirectStandardError (Join-Path $tmp 'vite.err.log') -PassThru

  # 等后端
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3098/health' -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok) { throw 'backend 3098 未起来' }

  # 等前端 + 确认不是 mock 模式
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { $r = Invoke-WebRequest -Uri 'http://localhost:5174/' -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok) { throw 'vite 5174 未起来' }
  $main = (Invoke-WebRequest -Uri 'http://localhost:5174/src/main.ts' -UseBasicParsing).Content
  if ($main -notmatch 'VITE_USE_MOCK[^,]*false') { throw '前端不是 integration 模式（VITE_USE_MOCK 非 false）' }

  $env:BASE_URL = 'http://localhost:5174'
  $env:BACKEND_URL = 'http://127.0.0.1:3098'
  Push-Location (Join-Path $root 'frontend')
  try { & 'E:\nodejs\node.exe' '.data/cbar-mobile-check.mjs' } finally { Pop-Location }
  $code = $LASTEXITCODE
  Write-Output "EXIT=$code"
  exit $code
}
finally {
  if ($vite) { taskkill /PID $vite.Id /T /F 2>$null | Out-Null }
  if ($backend) { taskkill /PID $backend.Id /T /F 2>$null | Out-Null }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
