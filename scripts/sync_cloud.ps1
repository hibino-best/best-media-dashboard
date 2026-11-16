# クラウドの変更の取り込み（2026-11-16 ユーザー指定：クラウド（claude.ai/code）で進めた変更を、PCに自動で取り込む）
# タスクスケジューラー「BESTメディア クラウドの変更の取り込み（30分ごと）」から30分ごと・ログオン時に動く（登録は scripts\sync_cloud_setup.ps1 を1回だけ）
# - GitHub のクラウド作業用ブランチ（origin/main-rre7tp）を取ってきて、PCの今のブランチを「早送り」で合わせる
# - PCに保存していない変更・まだ GitHub に送っていないコミットがあるときは、壊さないように取り込まない（ログと通知で知らせる）
# - 本番デプロイ・データの変更はしない（取り込むだけ）
# 記録は scripts\logs\sync_cloud_YYYYMM.log。取り込んだとき・止めたときだけ画面の右下に通知
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$cloud = 'main-rre7tp'
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = 'C:\Program Files\Git\cmd\git.exe' }
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('sync_cloud_' + (Get-Date -Format 'yyyyMM') + '.log')
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm') $m" | Out-File $log -Encoding utf8 -Append }
function Notify($title, $text) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true
    $n.ShowBalloonTip(10000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 10; $n.Dispose()
  } catch { }
}
& $git fetch origin $cloud --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Log "GitHub から取得できませんでした（ネットワークか GitHub のログインを確認）"; exit 1 }
$counts = (& $git rev-list --left-right --count "HEAD...origin/$cloud").Trim() -split '\s+'
$mine = [int]$counts[0]; $new = [int]$counts[1]
if ($new -eq 0) { exit 0 }   # 新しい変更なし（ログも残さない）
$branch = (& $git rev-parse --abbrev-ref HEAD).Trim()
$dirty = & $git status --porcelain --untracked-files=no
if ($dirty) {
  Log "クラウドに新しい変更が${new}件ありますが、PCに保存していない変更があるため取り込みませんでした（ブランチ $branch）"
  Notify 'クラウドの変更を取り込めませんでした' "PCで作業中の変更があります。作業を終えてから Claude に「クラウドの変更を取り込んで」と頼んでください。"
  exit 2
}
if ($mine -gt 0) {
  Log "クラウドに新しい変更が${new}件ありますが、PCにだけあるコミットが${mine}件あるため取り込みませんでした（ブランチ $branch）"
  Notify 'クラウドの変更を取り込めませんでした' "PCとクラウドの両方に別々の変更があります。Claude に「クラウドの変更とPCの変更をまとめて」と頼んでください。"
  exit 2
}
$subjects = (& $git log --format='%s' "HEAD..origin/$cloud") -join ' / '
& $git merge --ff-only "origin/$cloud" --quiet 2>&1 | Out-File $log -Encoding utf8 -Append
if ($LASTEXITCODE -ne 0) { Log "取り込みに失敗しました（ブランチ $branch）"; Notify 'クラウドの変更を取り込めませんでした' 'scripts\logs の sync_cloud のログを見てください。'; exit 1 }
Log "クラウドの変更を${new}件取り込みました（ブランチ $branch）：$subjects"
Notify 'クラウドの変更を取り込みました' "${new}件：$subjects（デプロイはまだです）"
exit 0
