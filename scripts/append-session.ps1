# 追加一条消息到 session.txt（跨 agent 通信）
#
# 用途：把一段 UTF-8 文本以**追加**方式写入 B:\AITrance\session.txt，
#       不重写、不改动既有内容。
#
# 为什么不用 shell 重定向/echo：
#   Git Bash 下的 echo/printf 管道会把多字节中文写坏（历史上验证过：
#   后端收到 Content-Length 与实际字节数不符 -> 400 BAD_REQUEST）。
#   PowerShell 的 .NET API 写 UTF-8 无 BOM 是可靠的。
#
# 输入：-Text  要追加的正文（自动补一个换行）
# 输出：写入后的文件字节数
# 副作用：仅追加 session.txt。不改任何其它文件。
#
# 用法示例：
#   powershell -File scripts/append-session.ps1 -Text "## frontend: [SYNC] ..."

param(
    [Parameter(Mandatory = $true)]
    [string]$Text
)

$ErrorActionPreference = 'Stop'

$path = Join-Path $PSScriptRoot '..\session.txt'
$path = [System.IO.Path]::GetFullPath($path)

if (-not (Test-Path $path)) {
    throw "找不到 session.txt：$path"
}

$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::AppendAllText($path, $Text + "`n", $enc)

$len = (Get-Item $path).Length
Write-Output "appended; session.txt = $len bytes"
