// 操作マニュアル（webapp/manuals/*.md）を Firestore manuals/<key> に入れる（2026-11-05 ユーザー指定）
// 画面（GET /api/manuals/:key）は「最終更新」の日付が新しいほうを表示するので、デプロイしなくても反映される。
// 使い方：node scripts/push_manuals.js writer director   （引数なし＝4つ全部）
// gcloud のログイン（gcloud auth print-access-token）を使う。切れていたらエラーで止まる
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const KEYS = ['writer', 'director', 'contractor', 'staff', 'outline'];
const G = path.join(process.env.LOCALAPPDATA, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
const BASE = 'https://firestore.googleapis.com/v1/projects/bestmedia-510909/databases/(default)/documents';
(async () => {
  const keys = process.argv.slice(2).filter(k => KEYS.includes(k));
  const list = keys.length ? keys : KEYS;
  let tok;
  try { tok = execSync('"' + G + '" auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { console.error('gcloud のログインが切れています。ターミナルで gcloud auth login --force を実行してください'); process.exit(2); }
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  for (const k of list) {
    const md = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'manuals', k + '.md'), 'utf8');
    const date = (md.match(/最終更新[：:]\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const body = { writes: [{ update: { name: 'projects/bestmedia-510909/databases/(default)/documents/manuals/' + k, fields: { md: { stringValue: md }, date: { stringValue: date }, updatedBy: { stringValue: 'manual-update（タスクスケジューラー）' } } }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }] };
    const r = await (await fetch(BASE + ':commit', { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
    if (r.error) { console.error(k + '：保存できませんでした ' + JSON.stringify(r.error)); process.exit(3); }
    console.log(k + '：保存しました（最終更新 ' + date + '）');
  }
})();
