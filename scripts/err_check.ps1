# AIエラーチェッカー（2026-11-13 ユーザー指定：毎週月曜12:00、タスクスケジューラー＋claude -p ＋ CODEX。AI MEDIAシミュレーションと同じく Supabase＝AIの作業机）
# 1) 材料を集める（構文・前回からのコードの差分・ログ・データの食い違い）… scripts\err_check_collect.js（本番のデータを読むのはここだけ）
# 2) 受付係（scripts\err_check_fs.js）が材料を Supabase に入れ、それぞれのAIに渡す分だけを書き出す（読んだ記録 ai_access_log）
# 3) エラチェ・クロード指揮官（Claude Code）とエラチェ・コーデックス検証（CODEX）が別々に点検（読むだけ。いまは内ループ）
# 4) 受付係が報告・指摘（err_findings）・トークン（ai_cost_log）・実行（ai_runs）を保存 → タスク通知と「AIツール → AIエラーチェッカー」に出る
# 記録は scripts\logs\err_check_YYYYMMDD.log、材料は scripts\err_check\runs\<実行ID>\
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = New-Object System.Text.UTF8Encoding $false   # 外部プログラム（claude・codex）に日本語と「"」をそのまま渡す（2026-11-16 AIエラーチェッカーの指摘 #2・#3）
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$node = 'C:\Program Files\nodejs\node.exe'
$fsjs = Join-Path $PSScriptRoot 'err_check_fs.js'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ('err_check_' + (Get-Date -Format 'yyyyMMdd') + '.log')
$id = Get-Date -Format 'yyyyMMdd_HHmm'
$dir = Join-Path $PSScriptRoot ('err_check\runs\' + $id)
New-Item -ItemType Directory -Force $dir | Out-Null
"=== 開始 $(Get-Date -Format 'yyyy-MM-dd HH:mm')（$id） ===" | Out-File $log -Encoding utf8 -Append
& $node (Join-Path $PSScriptRoot 'err_check_collect.js') (Join-Path $dir 'raw') 2>&1 | Out-File $log -Encoding utf8 -Append
& $node $fsjs start $id (Join-Path $dir 'raw') 2>&1 | Out-File $log -Encoding utf8 -Append
if ($LASTEXITCODE -ne 0) { "受付係を始められないため終了（Supabase・gcloud のログインを確認）" | Out-File $log -Encoding utf8 -Append; exit 1 }
$base = Get-Content (Join-Path $PSScriptRoot 'err_check_prompt.md') -Raw -Encoding utf8
# --- エラチェ・クロード指揮官（Claude Code。読むだけの道具だけ） ---
& $node $fsjs get $id err_claude (Join-Path $dir 'err_claude') 2>&1 | Out-File $log -Encoding utf8 -Append
$stream = Join-Path $dir 'err_claude_stream.jsonl'
($base + "`n点検の材料のフォルダ：scripts/err_check/runs/$id/err_claude`n") | & "$env:USERPROFILE\.local\bin\claude.exe" -p --output-format stream-json --verbose --allowedTools "Read" "Grep" "Glob" 2>&1 | Out-File $stream -Encoding utf8
"Claude Code 終了コード $LASTEXITCODE" | Out-File $log -Encoding utf8 -Append
$clmd = Join-Path $dir 'err_claude.md'; '' | Out-File $clmd -Encoding utf8
& $node $fsjs save $id err_claude $clmd $stream 2>&1 | Out-File $log -Encoding utf8 -Append
# --- エラチェ・コーデックス検証（CODEX。デスクトップアプリの codex.exe、読むだけのサンドボックス） ---
& $node $fsjs get $id err_codex (Join-Path $dir 'err_codex') 2>&1 | Out-File $log -Encoding utf8 -Append
$cx = (Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$cxmd = Join-Path $dir 'err_codex.md'; $cxlog = Join-Path $dir 'err_codex_run.log'
if ($cx) {
  ($base + "`n点検の材料のフォルダ：scripts/err_check/runs/$id/err_codex`n") | & $cx exec --sandbox read-only --skip-git-repo-check --ephemeral -C $root -o $cxmd - 2>&1 | Out-File $cxlog -Encoding utf8
  "CODEX 終了コード $LASTEXITCODE" | Out-File $log -Encoding utf8 -Append
} else { "CODEX が見つかりません（Codex アプリが入っているか確認）" | Out-File $cxmd -Encoding utf8 }
& $node $fsjs save $id err_codex $cxmd $cxlog 2>&1 | Out-File $log -Encoding utf8 -Append
& $node $fsjs finish $id 2>&1 | Out-File $log -Encoding utf8 -Append
"=== 終了 $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File $log -Encoding utf8 -Append
