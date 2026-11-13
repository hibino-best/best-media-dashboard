# AI MEDIAシミュレーションの答え合わせ（2026-11-05 ユーザー指定：毎月5日に前月分、タスクスケジューラー＋claude -p）
# 毎月5日〜10日の12:00にタスクスケジューラーから実行。前月分が終わっていれば（引き継ぎ\答え合わせ\YYYY-MM.md があれば）何もしない。
# ダッシュボードがまだ表を保存していなければ（管理者が5日以降にダッシュボードを開くと保存される）、AIは動かさずに翌日に回す。
# 結果は scripts\logs\sim_check_YYYYMMDD.log に残る
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$node = 'C:\Program Files\nodejs\node.exe'
$fsjs = Join-Path $PSScriptRoot 'sim_check_fs.js'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('sim_check_' + (Get-Date -Format 'yyyyMMdd') + '.log')
$ym = (Get-Date).AddMonths(-1).ToString('yyyy-MM')
$done = Join-Path $root ('引き継ぎ\答え合わせ\' + $ym + '.md')
"=== 開始 $(Get-Date -Format 'yyyy-MM-dd HH:mm')（対象 $ym） ===" | Out-File $log -Encoding utf8 -Append
if (Test-Path $done) { "$ym 分は答え合わせ済みのため終了" | Out-File $log -Encoding utf8 -Append; exit 0 }
if ((Get-Date).Day -lt 5) { "5日より前のため終了" | Out-File $log -Encoding utf8 -Append; exit 0 }
& $node $fsjs get $ym *> $null
if ($LASTEXITCODE -ne 0) { "表がまだないため、AIは動かさずに終了（翌日にもう一度）" | Out-File $log -Encoding utf8 -Append; exit 0 }
New-Item -ItemType Directory -Force (Split-Path $done) | Out-Null
# AIチーム（2026-11-06 ユーザー指定）：実行を始めて run_id をもらう。編集長（指揮官）のモデルは Supabase ai_agents（画面で変えられる）
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$start = & $node $fsjs start $ym | ConvertFrom-Json
$env:SIM_RUN_ID = $start.run_id
"run_id $($start.run_id)／編集長のモデル $($start.commanderModel)" | Out-File $log -Encoding utf8 -Append
$prompt = (Get-Content (Join-Path $PSScriptRoot 'sim_check_prompt.md') -Raw -Encoding utf8) + "`n対象の月：$ym`n"
# 実行記録（stream-json）を残し、このループで使ったトークンだけを finish でエージェントごとに数える
$stream = Join-Path $logDir ('sim_check_stream_' + (Get-Date -Format 'yyyyMMdd_HHmm') + '.jsonl')
& "$env:USERPROFILE\.local\bin\claude.exe" -p $prompt `
  --model $start.commanderModel `
  --output-format stream-json --verbose `
  --permission-mode acceptEdits `
  --allowedTools "Read" "Grep" "Glob" "Write" "Agent" "Skill" "Bash(node scripts/sim_check_fs.js*)" `
  2>&1 | Out-File $stream -Encoding utf8
$code = $LASTEXITCODE
& $node $fsjs finish $stream $code 2>&1 | Out-File $log -Encoding utf8 -Append
"=== 終了 $(Get-Date -Format 'yyyy-MM-dd HH:mm')（終了コード $code） ===" | Out-File $log -Encoding utf8 -Append
