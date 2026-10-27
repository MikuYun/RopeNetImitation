param(
    [string]$Path = (Join-Path $PSScriptRoot 'session.txt'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '.session-monitor')
)

$ErrorActionPreference = 'Stop'
$targetPath = [System.IO.Path]::GetFullPath($Path)
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
$logPath = Join-Path $outputPath 'updates.jsonl'
$statusPath = Join-Path $outputPath 'status.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$startedAt = [DateTimeOffset]::Now.ToString('o')

function Read-Snapshot {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $content = [System.IO.File]::ReadAllText($targetPath, $utf8)
            return [pscustomobject]@{ exists = $true; content = $content }
        } catch [System.IO.FileNotFoundException] {
            return [pscustomobject]@{ exists = $false; content = $null }
        } catch [System.IO.IOException] {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Write-Record($Kind, $Snapshot, $Message) {
    $record = [ordered]@{
        timestamp = [DateTimeOffset]::Now.ToString('o')
        kind = $Kind
        path = $targetPath
        exists = $Snapshot.exists
        content = $Snapshot.content
        message = $Message
    }
    $json = ConvertTo-Json -InputObject $record -Compress
    [System.IO.File]::AppendAllText($logPath, $json + [Environment]::NewLine, $utf8)
}

function Write-Status($State) {
    $status = [ordered]@{
        state = $State
        pid = $PID
        path = $targetPath
        startedAt = $startedAt
        updatedAt = [DateTimeOffset]::Now.ToString('o')
        log = $logPath
    }
    [System.IO.File]::WriteAllText($statusPath, (ConvertTo-Json $status), $utf8)
}

$watcher = [System.IO.FileSystemWatcher]::new(
    [System.IO.Path]::GetDirectoryName($targetPath),
    [System.IO.Path]::GetFileName($targetPath)
)
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor
    [System.IO.NotifyFilters]::Size -bor [System.IO.NotifyFilters]::FileName
$watcher.InternalBufferSize = 32768
$subscriptions = @()
$lastSnapshot = $null
try {
    foreach ($eventName in @('Changed', 'Created', 'Deleted', 'Renamed', 'Error')) {
        $subscriptions += Register-ObjectEvent -InputObject $watcher -EventName $eventName `
            -SourceIdentifier "SessionMonitor.$eventName"
    }
    $watcher.EnableRaisingEvents = $true
    $lastSnapshot = Read-Snapshot
    Write-Record 'initial' $lastSnapshot $null
    Write-Status 'running'
    while ($true) {
        $notification = Wait-Event
        $isWatcherError = $notification.SourceIdentifier -eq 'SessionMonitor.Error'
        Remove-Event -EventIdentifier $notification.EventIdentifier
        if ($isWatcherError) {
            Write-Record 'watcher-error' $lastSnapshot `
                $notification.SourceEventArgs.GetException().Message
        }
        Start-Sleep -Milliseconds 250
        $snapshot = Read-Snapshot
        if ($snapshot.exists -ne $lastSnapshot.exists -or
            $snapshot.content -cne $lastSnapshot.content) {
            Write-Record 'update' $snapshot $null
            $lastSnapshot = $snapshot
            Write-Status 'running'
        }
    }
} catch {
    Write-Record 'error' $lastSnapshot $_.Exception.Message
    throw
} finally {
    $watcher.EnableRaisingEvents = $false
    foreach ($subscription in $subscriptions) {
        Unregister-Event -SubscriptionId $subscription.SubscriptionId
    }
    $watcher.Dispose()
    Write-Status 'stopped'
}
