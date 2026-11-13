# BESTメディア ダッシュボード 引き継ぎ書（2026-11-05 整理）

資料（必要なときだけ読む）：仕様の要点 `引き継ぎ/仕様の要点.md`／仕様と変更履歴 `引き継ぎ/仕様と変更履歴.md`（約16万字。Grep で探して読む。新しい変更はこのファイルの末尾に追記し、CLAUDE.md には書き足さない）／過去の会話 `引き継ぎ/会話の記録/`／記憶の写し `引き継ぎ/記憶/`／整理前の CLAUDE.md `引き継ぎ/CLAUDE_整理前_2026-11-05.md`。
仕組みの図・スケジュール・保存先の正は、アプリの 管理 →「システム構造」と `webapp/system-map.json`。

## 構成
- **Webアプリ** `webapp/`（Node.js/Express、Firebase Auth、Firestore、BigQuery）。Cloud Run `best-media-dashboard`（project `bestmedia-510909`、`asia-northeast1`、SA `dashboard-app@bestmedia-510909.iam.gserviceaccount.com`）、URL https://best-media-dashboard-812117426134.asia-northeast1.run.app
  - 主なファイル：`server.js`（API・権限）、`public/app.js`（画面すべて）、`public/styles.css`、`public/index.html`、`wordpress.js`、`kintone.js`、`keywords.js`（検索Vol・Ahrefs KW調査）、`ahrefs.js`（KW追従）、`moshimo.js`（もしもCSV）、`system-map.json`。ほかは `引き継ぎ/仕様の要点.md`。
- **GAS** `gas/`（clasp、scriptId は `gas/.clasp.json`）。エディタ https://script.google.com/home/projects/1q1EEyUcPBCNRQ1k97FJda6Ib_YwkJQdDGF1ZBeeivTh6irnAwkPUTF2e/edit
  - `bigquery.gs`：毎日3時台 `dailyCollect`（GA4・SC・GA4ページ別・シート月次値・収益テーブル）、`backfillGA4Pages` など／`articles.gs`：`importArticleSheets`（**手動実行。自動化しない＝ユーザー指示**）／`main.gs`：月次表（monthlyRun・monthlyRefreshSC）／`revenue.gs`：収益テーブル
- **設定シート**：SEO数値管理シート `1IuvtcFDIn8rXrVC2YrM6Agv4AMRtvaVjwqbF-YqA6eY`（「自動集計設定」「記事管理シート」タブ）
- **定期実行**（Cloud Scheduler → /tasks/*、OIDC）：`wp-collect` 毎日3:40、`kintone-collect` 毎日4:10、`index-check` 毎日4:40、`invoice-stale` 毎日9:00、`kw-volume` 毎月5日4:30、`moshimo-collect` 毎月2日・15日5:30、`ahrefs-sync` 毎週月5:00、`ahrefs-fetch` 毎月2日5:00、`invoice-unrequested` 毎月3日0:00
- **保存先**：BigQuery `best_media`／Firestore（users、settings/*、contracts、article_overrides など）／Secret Manager（kintone・Ahrefs のトークン、moshimo-login）

## 手順（必ず守る）
### Webアプリのデプロイ
1. 大きい変更の前は scratchpad にバックアップ。
2. `node --check public/app.js`、`node --check server.js`（と変更した .js）を**別々に**実行（`&&` でつながない）。
3. 画面を変えたら `public/index.html` の `?v=N` を上げる。
4. `system-map.json` の `version`（`1.<N>`）・`updated` を更新し、`changelog` 先頭に1件。**個人名なし・40字以内で「どの項目を調整したか」だけ**（2026-10-28 ユーザー指定）。仕組みが変わったら該当箇所も直す。
5. テスト画面：`.claude/launch.json` の `dashboard-dev-test` → http://localhost:5178/dev-test/index.html（ダミーAPIは `webapp/dev-test/index.html`）。
5.5 **必ずエラーチェック＋CODEX の確認**（2026-11-13 ユーザー指定）：`node scripts/predeploy_review.js`（構文チェック＋前回デプロイからの差分を CODEX が読むだけで確認。終了コード 2 は指摘あり → 直すか、直さない理由をユーザーに伝えてから）。デプロイしたら `node scripts/predeploy_review.js mark`。
6. `webapp` で `& "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" run deploy best-media-dashboard --source . --region asia-northeast1 --project bestmedia-510909 --quiet`
7. 本番でログイン画面と新しい `app.js?v=N` の読み込みを確認してから報告。

### GAS
- 反映：`gas` で `& 'C:\Program Files\nodejs\node.exe' 'C:\Users\yoshi\AppData\Roaming\npm\node_modules\@google\clasp\build\src\index.js' push --force`
- ユーザーに実行を頼むときは毎回「エディタのURL・ファイル名・関数名・手順（再読み込み→ファイルを開く→関数を選ぶ→実行）」をセットで書く。
- 結果：`gcloud logging read "resource.type=app_script_function" --freshness=30m --project bestmedia-510909`。GASは1回6分まで。
- clasp/gcloud は invalid_rapt で切れる → ユーザーのターミナルで `npx -y @google/clasp login`、`gcloud auth login --force`（ブラウザ方式）。

### コードの注意
- 1行に詰めた置換スクリプトでは `//` でなく `/* */`（画面が真っ白になった事故あり）。`node -e` の正規表現・バッククォートは崩れやすい → scratchpad のファイルか Edit ツール。
- BigQuery の列 `no` は予約語なのでバッククォートで囲む。
- 描画は非同期。読み込み後に `renderSeq` が変わっていたら書き込まない。
- press_overrides の ID は encodeURIComponent(リリースID)（REST では二重 encode）。article_overrides の ID は sha1(`メディア|no<No>`)。
- PC に ADC がないので、ローカルの確認スクリプトは `gcloud auth print-access-token` を OAuth2Client に入れて Firestore・BigQuery を読む（scratchpad に置く）。

## 決めごと
- **スプレッドシートは読み取りのみ**（設定タブの行の自動追加・削除だけ例外）。画面での修正は Firestore に保存し、取り込みより優先。
- **APIキー・トークン・パスワードはチャットに貼らせない・出さない**（画面の入力欄 → Secret Manager）。
- kintone は個人情報（お客様名・カナ・電話・メール・郵便番号・町名・番地・建物名）を取らない。住所は市区町村まで。
- 生年月日・給与・賞与・評価・人件費はフル管理者だけに見せる。
- Cloud Scheduler を追加するときは事前に説明する。
- 進行管理などのデータ（article_overrides・contracts・sheet_accepts・press_overrides など）を直すのはユーザーの「OK」のあと。直す前の値は残す（sheet_fix_logs・contracts の history・scratchpad）。
- データを直すスクリプトは必ず「試算（--do なし）→ `node scripts/predeploy_review.js data <スクリプト> <試算の結果>` で CODEX の確認 → 実行 → 全件の検証（書き換え前の値と照らし合わせ）」の順（2026-11-13：別ディレクトリの同じ記事No.が保存先〈sha1(メディア|no<No>)〉を共有していて、名前の統一で54記事を壊した事故あり）。
- AIツールは全部 Supabase（AIの作業机）を使い、AI MEDIAシミュレーションと同じ作り（受付係・ai_runs・ai_access_log・ai_cost_log・キャラ・内ループ）にする（2026-11-13 ユーザー指定）。週次の「AIエラーチェッカー」＝タスクスケジューラー「BESTメディア AIエラーチェッカー（毎週月曜）」→ scripts/err_check.ps1。
- ユーザー指示で決めたルールは、コードにも `（YYYY-MM-DD ユーザー指定）` とコメントを残す。
- 数字の比較は表で示す。
