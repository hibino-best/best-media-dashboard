# クラウドの変更の取り込みを、タスクスケジューラーに登録する（最初に1回だけ実行。2026-11-16 ユーザー指定）
# 実行：PowerShell で  powershell -ExecutionPolicy Bypass -File scripts\sync_cloud_setup.ps1
# やめるとき：  Unregister-ScheduledTask -TaskName 'BESTメディア クラウドの変更の取り込み（30分ごと）' -Confirm:$false
$name = 'BESTメディア クラウドの変更の取り込み（30分ごと）'
$ps1 = Join-Path $PSScriptRoot 'sync_cloud.ps1'
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"') -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $act -Trigger @($every, $logon) -Settings $set -Description 'GitHub のクラウド作業用ブランチ（main-rre7tp）の変更を、PCに早送りで取り込む。PCに作業中の変更があれば取り込まない。記録は scripts\logs\sync_cloud_*.log' -Force | Out-Null
Write-Host "登録しました：$name"
Write-Host 'いまから1回動かします…'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1
Write-Host ('結果（終了コード ' + $LASTEXITCODE + '）：0＝取り込んだ／新しい変更なし、2＝作業中の変更があるので止めた、1＝失敗。くわしくは scripts\logs\sync_cloud_*.log')
