# 操作マニュアルの月1回の見直し（2026-11-05 ユーザー指定：タスクスケジューラー＋claude -p）
# 毎月1日にタスクスケジューラーから実行。機能が変わっていなければマニュアルは更新しない。
# 結果は scripts\logs\manual_update_YYYYMMDD.log に残る
$ErrorActionPreference = 'Continue'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false   # 外部プログラム（claude）に日本語と「"」をそのまま渡す（2026-11-16 AIエラーチェッカーの指摘 #2・#3）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('manual_update_' + (Get-Date -Format 'yyyyMMdd') + '.log')
$prompt = Get-Content (Join-Path $PSScriptRoot 'manual_update_prompt.md') -Raw -Encoding utf8
"=== 開始 $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File $log -Encoding utf8 -Append
$prompt | & "$env:USERPROFILE\.local\bin\claude.exe" -p `
  --permission-mode acceptEdits `
  --allowedTools "Read" "Grep" "Glob" "Edit" "Write" "Bash(node scripts/push_manuals.js*)" `
  2>&1 | Out-File $log -Encoding utf8 -Append
"=== 終了 $(Get-Date -Format 'yyyy-MM-dd HH:mm')（終了コード $LASTEXITCODE） ===" | Out-File $log -Encoding utf8 -Append
