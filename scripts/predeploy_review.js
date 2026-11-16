// デプロイ前の確認（2026-11-13 ユーザー指定：必ずエラーチェックをして、CODEX にも確認してもらう）
// 使い方：
//   node scripts/predeploy_review.js            … 前回デプロイしたコード（scripts/err_check/deployed）との差分を作り、構文チェックと CODEX の確認（読むだけ）をする
//   node scripts/predeploy_review.js mark       … デプロイしたあとに実行。今のコードを「前回デプロイしたコード」として残す
//   node scripts/predeploy_review.js data <スクリプト> <試算の結果ファイル>  … データを直すスクリプトを、実行する前に CODEX に確認してもらう
// 結果は scripts/logs/predeploy_<日時>.md。終了コード 0＝指摘なし、2＝指摘あり（直してからデプロイ）、1＝確認できなかった
const { spawnSync } = require('child_process'), path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), DEP = path.join(__dirname, 'err_check', 'deployed'), LOG = path.join(__dirname, 'logs');
const files = () => { const l = []; fs.readdirSync(path.join(ROOT, 'webapp')).filter(f => /\.(js|json)$/.test(f) && !/^package/.test(f)).forEach(f => l.push('webapp/' + f)); ['app.js', 'styles.css', 'index.html'].forEach(f => l.push('webapp/public/' + f)); return l; };
const codexExe = () => { const b = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'); try { return fs.readdirSync(b).map(d => path.join(b, d, 'codex.exe')).filter(f => fs.existsSync(f)).sort((a, c) => fs.statSync(c).mtimeMs - fs.statSync(a).mtimeMs)[0]; } catch (e) { return null; } };
const stamp = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
const cmd = process.argv[2] || 'review';
if (cmd === 'mark') { files().forEach(f => { const d = path.join(DEP, f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), d); }); console.log('今のコードを「前回デプロイしたコード」にしました'); process.exit(0); }
fs.mkdirSync(LOG, { recursive: true });
let prompt, out = path.join(LOG, 'predeploy_' + stamp() + '.md');
if (cmd === 'data') {
  const [script, plan] = process.argv.slice(3);
  prompt = 'BEST MEDIA ダッシュボードのデータ（Firestore・BigQuery）を直すスクリプトを、実行する前に確認してください。日本語で答えてください。ファイル・データは一切変えないでください（読むだけ）。\n'
    + 'スクリプト：' + script + '\n試算の結果：' + plan + '\n'
    + '見てほしいこと：対象の取り違え（同じキーを複数の行が共有していないか。例：article_overrides の ID は sha1(メディア|no<No>) で、別ディレクトリの同じ記事No.は保存先を共有する）、意図しない上書き・消去、元に戻せるか（書き換え前の値を残しているか）、件数の多すぎ・少なすぎ、エラーで途中で止まったときの状態。\n'
    + '最後に ```json {"ok": true か false, "findings": [{"level":"高|中|低","where":"","summary":"","fix":""}]} ``` を1つ付けてください。';
} else {
  /* 構文チェック */
  const bad = files().filter(f => f.endsWith('.js')).filter(f => spawnSync(process.execPath, ['--check', path.join(ROOT, f)]).status !== 0);
  if (bad.length) { console.log('構文エラー：' + bad.join('、') + '（直してからデプロイ）'); process.exit(2); }
  if (!fs.existsSync(DEP)) { console.log('前回デプロイしたコードの記録がありません。デプロイしたあとに node scripts/predeploy_review.js mark を実行してください'); process.exit(1); }
  let diff = ''; files().forEach(f => { const a = path.join(DEP, f), b = path.join(ROOT, f); if (!fs.existsSync(a)) { diff += '\n### 新しいファイル：' + f + '\n'; return; } const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U4', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.stdout) diff += r.stdout.split(DEP.replace(/\\/g, '/')).join('').split(ROOT.replace(/\\/g, '/')).join(''); });
  if (!diff) { console.log('前回のデプロイから変更はありません'); process.exit(0); }
  const df = path.join(LOG, 'predeploy_' + stamp() + '.diff'); fs.writeFileSync(df, diff);
  prompt = 'BEST MEDIA ダッシュボード（webapp/）を本番にデプロイする前の確認です。日本語で答えてください。ファイルは一切変えないでください（読むだけ）。\n'
    + '前回デプロイしたコードとの差分：' + path.relative(ROOT, df).replace(/\\/g, '/') + '\n必要なら webapp/ の元のファイルも読んでください。仕様の要点は 引き継ぎ/仕様の要点.md、決めごとは CLAUDE.md。\n'
    + '見てほしいこと：不具合（例外・null・非同期の順番・画面が真っ白になる構文）、考え漏れ（同じ処理をしているほかの画面・経路の直し漏れ、保存されない・二重に保存される、権限、別ディレクトリで同じ記事No.の記事の保存先の共有）、データの上書き、日本語の文字化け、セキュリティ（キーやトークンの露出）。\n'
    + '最後に ```json {"ok": true か false, "findings": [{"level":"高|中|低","where":"ファイル:行","summary":"","fix":""}]} ``` を1つ付けてください。高・中の指摘がなければ ok は true。';
}
const cx = codexExe(); if (!cx) { console.log('CODEX が見つかりません（Codex アプリが入っているか確認）'); process.exit(1); }
const r = spawnSync(cx, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', ROOT, '-o', out, '-'], { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
const md = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
if (!md) {
  console.log('CODEX から返事がありませんでした：' + String(r.stderr || r.error || '').slice(-500));
  /* 確認できなかったことも Supabase に記録（2026-11-16） */
  fs.writeFileSync(out, '（CODEX から返事がありませんでした。時間切れ・PCのスリープ・ログイン切れなど）\n');
  const lf = out.replace(/\.md$/, '_run.log'); fs.writeFileSync(lf, String(r.stdout || '') + '\n' + String(r.stderr || ''));
  const kind = cmd === 'data' ? 'data' : 'pre', ts = path.basename(out).replace(/^predeploy_/, '').replace(/\.md$/, '');
  spawnSync(process.execPath, [path.join(__dirname, 'err_check_fs.js'), 'record', kind, kind + '_' + ts.slice(0, 8) + '_' + ts.slice(8, 12), out, lf, '確認できず'], { encoding: 'utf8' });
  process.exit(1);
}
console.log(md);
const m = [...md.matchAll(/```json\s*([\s\S]*?)```/g)].pop(); let j = null; try { j = m && JSON.parse(m[1]); } catch (e) { j = null; }
console.log('\n→ 結果：' + out);
/* Supabase の記録（AIエラーチェッカーの点検の記録・費用に入る。2026-11-13 ユーザー指定：これも Supabase に） */
{
  const lf = out.replace(/\.md$/, '_run.log'); fs.writeFileSync(lf, String(r.stdout || '') + '\n' + String(r.stderr || ''));
  const kind = cmd === 'data' ? 'data' : 'pre', ts = path.basename(out).replace(/^predeploy_/, '').replace(/\.md$/, ''), rid = kind + '_' + ts.slice(0, 8) + '_' + ts.slice(8, 12);
  const what = cmd === 'data' ? process.argv.slice(3).map(x => path.basename(x)).join('・') : '前回デプロイからの差分';
  const rr = spawnSync(process.execPath, [path.join(__dirname, 'err_check_fs.js'), 'record', kind, rid, out, lf, what], { encoding: 'utf8' });
  console.log(String(rr.stdout || '').trim() || 'Supabase に記録できませんでした：' + String(rr.stderr || '').trim());
}
process.exit(j && j.ok === true ? 0 : 2);
