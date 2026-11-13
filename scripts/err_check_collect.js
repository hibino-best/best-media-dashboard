// AIエラーチェッカー（2026-11-13 ユーザー指定）：点検の材料を集める（読むだけ。データ・設定は変えない）
// 使い方：node scripts/err_check_collect.js <出力フォルダ>
//   syntax.txt … webapp と scripts の .js の構文チェック（node --check）
//   code.diff  … 前回の点検（scripts/err_check/base）からのコードの差分。初回は差分なし
//   logs.txt   … 直近7日の Cloud Run のエラー・500番台、Cloud Scheduler の失敗、GAS のエラー
//   data.txt   … データの食い違い（担当者名がどの契約・社員・紐づけにも当たらない、別ディレクトリの記事が同じ保存先を共有している、保存先に key・media がない など）
//   summary.json … 件数のまとめ（保存の時に使う）
const { execSync, spawnSync } = require('child_process'), path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), WEB = path.join(ROOT, 'webapp'), BASE = path.join(__dirname, 'err_check', 'base');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'err_check', 'runs', 'manual'));
fs.mkdirSync(OUT, { recursive: true });
const G = path.join(process.env.LOCALAPPDATA, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
const PROJECT = 'bestmedia-510909';
const summary = { at: new Date().toISOString(), syntaxErrors: 0, diffFiles: 0, logErrors: 0, server5xx: 0, jobFailures: 0, gasErrors: 0, dataIssues: 0, notes: [] };
/** 点検するコードのファイル（webapp の .js・画面のファイル、scripts の .js・.ps1） */
function codeFiles() {
  const list = [];
  fs.readdirSync(WEB).filter(f => /\.(js|json)$/.test(f) && !/^package/.test(f)).forEach(f => list.push('webapp/' + f));
  ['app.js', 'styles.css', 'index.html'].forEach(f => list.push('webapp/public/' + f));
  fs.readdirSync(__dirname).filter(f => /\.(js|ps1|md)$/.test(f)).forEach(f => list.push('scripts/' + f));
  return list.filter(f => fs.existsSync(path.join(ROOT, f)));
}
// 1. 構文チェック
{
  const lines = [];
  codeFiles().filter(f => f.endsWith('.js')).forEach(f => {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) { summary.syntaxErrors++; lines.push('× ' + f + '\n' + String(r.stderr || '').slice(0, 1500)); } else lines.push('○ ' + f);
  });
  fs.writeFileSync(path.join(OUT, 'syntax.txt'), lines.join('\n') + '\n');
}
// 2. 前回の点検からのコードの差分
{
  let diff = '';
  if (!fs.existsSync(BASE)) { diff = '（初回のため、前回の点検との差分はありません。今のコード全体を点検してください）\n'; summary.notes.push('初回'); }
  else {
    codeFiles().forEach(f => {
      const a = path.join(BASE, f), b = path.join(ROOT, f);
      if (!fs.existsSync(a)) { diff += '\n### 新しいファイル：' + f + '\n'; summary.diffFiles++; return; }
      const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.stdout) { diff += r.stdout.split(BASE.replace(/\\/g, '/')).join('').split(ROOT.replace(/\\/g, '/')).join(''); summary.diffFiles++; }
    });
    if (!diff) diff = '（前回の点検からコードの変更はありません）\n';
  }
  fs.writeFileSync(path.join(OUT, 'code.diff'), diff);
}
// gcloud のログイン（切れていたら、ログ・データの点検はできない）
let tok = '';
try { tok = execSync('"' + G + '" auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { summary.notes.push('gcloud のログインが切れているため、ログとデータは点検できませんでした（ターミナルで gcloud auth login --force）'); }
const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
const gcl = args => { try { return execSync('"' + G + '" ' + args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); } catch (e) { return 'ERR ' + String(e.stderr || e.message).slice(0, 500); } };
(async () => {
  // 3. ログ
  if (tok) {
    const L = [];
    const run = JSON.parse(gcl('logging read "resource.type=cloud_run_revision AND resource.labels.service_name=best-media-dashboard AND (severity>=ERROR OR httpRequest.status>=500)" --freshness=7d --limit 200 --format=json --project ' + PROJECT).replace(/^ERR[\s\S]*/, '[]') || '[]');
    summary.logErrors = run.filter(x => x.severity === 'ERROR' || x.severity === 'CRITICAL').length; summary.server5xx = run.filter(x => x.httpRequest && x.httpRequest.status >= 500).length;
    L.push('## Cloud Run（直近7日）：エラー ' + summary.logErrors + '件、500番台 ' + summary.server5xx + '件');
    const grp = {}; run.forEach(x => { const k = (x.httpRequest ? x.httpRequest.status + ' ' + x.httpRequest.requestMethod + ' ' + String(x.httpRequest.requestUrl || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') : '') + ' ' + String(x.textPayload || (x.jsonPayload && x.jsonPayload.message) || '').slice(0, 200); (grp[k] = grp[k] || { n: 0, last: x.timestamp }).n++; });
    Object.entries(grp).sort((a, b) => b[1].n - a[1].n).slice(0, 40).forEach(([k, v]) => L.push('- ' + v.n + '件（最後 ' + v.last + '）' + k));
    const jobs = JSON.parse(gcl('scheduler jobs list --location asia-northeast1 --format=json --project ' + PROJECT).replace(/^ERR[\s\S]*/, '[]') || '[]');
    const bad = jobs.filter(j => j.status && j.status.code); summary.jobFailures = bad.length;
    L.push('', '## Cloud Scheduler：' + jobs.length + '件のうち、最後の実行が失敗 ' + bad.length + '件');
    jobs.forEach(j => L.push('- ' + j.name.split('/').pop() + '：' + (j.status && j.status.code ? '失敗（コード ' + j.status.code + '）' : '成功') + '　最後 ' + (j.lastAttemptTime || '—') + '　' + (j.schedule || '')));
    const gas = JSON.parse(gcl('logging read "resource.type=app_script_function AND severity>=ERROR" --freshness=7d --limit 100 --format=json --project ' + PROJECT).replace(/^ERR[\s\S]*/, '[]') || '[]');
    summary.gasErrors = gas.length;
    L.push('', '## GAS（直近7日）：エラー ' + gas.length + '件');
    const gg = {}; gas.forEach(x => { const k = ((x.resource && x.resource.labels && x.resource.labels.function_name) || '') + '：' + String(x.textPayload || (x.jsonPayload && x.jsonPayload.message) || '').slice(0, 200); gg[k] = (gg[k] || 0) + 1; });
    Object.entries(gg).slice(0, 30).forEach(([k, n]) => L.push('- ' + n + '件 ' + k));
    fs.writeFileSync(path.join(OUT, 'logs.txt'), L.join('\n') + '\n');
  } else fs.writeFileSync(path.join(OUT, 'logs.txt'), '（gcloud のログインが切れているため点検できませんでした）\n');
  // 4. データの食い違い
  if (tok) {
    const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
    const val = f => f == null ? null : 'stringValue' in f ? f.stringValue : 'booleanValue' in f ? f.booleanValue : 'integerValue' in f ? Number(f.integerValue) : 'nullValue' in f ? null : 'timestampValue' in f ? f.timestampValue : null;
    const all = async c => { let out = [], pt = ''; do { const r = await fetch(FS + '/' + c + '?pageSize=300' + (pt ? '&pageToken=' + pt : ''), { headers: H }).then(x => x.json()); out = out.concat((r.documents || []).map(d => Object.assign({ _id: d.name.split('/').pop() }, Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)]))))); pt = r.nextPageToken || ''; } while (pt); return out; };
    const D = [];
    const F = ['writer', 'director', 'upload_owner', 'supervisor', 'image_owner'];
    const q = await fetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + PROJECT + '/queries', { method: 'POST', headers: H, body: JSON.stringify({ useLegacySql: false, maxResults: 30000, query: 'SELECT media, sub, `no`, row_no, ' + F.join(', ') + ' FROM best_media.article_items' }) }).then(r => r.json());
    const rows = (q.rows || []).map(r => { const v = r.f.map(x => x.v), o = { media: v[0], sub: v[1], no: v[2], key: v[0] + '|' + (v[2] ? 'no' + v[2] : 'row' + v[3]) }; F.forEach((f, i) => { o[f] = v[4 + i]; }); return o; });
    const ovs = await all('article_overrides'), ovByKey = {}; ovs.forEach(o => { if (o.key) ovByKey[o.key] = o; });
    const ens = (await all('article_entries')).filter(e => !e.deleted);
    const names = new Set((await all('contracts')).map(c => String(c.name || '').trim()).concat((await all('staff')).map(s => String(s.name || '').trim())));
    const links = await all('person_links'), linked = new Set(links.map(l => (l.media || '') + '|' + String(l.alias || '').trim()));
    // (1) 担当者名がどの契約・社員にも当たらず、紐づけ（担当なし・紐づけないも含む）もない
    const un = {};
    const eff = r => { const o = ovByKey[r.key]; const x = Object.assign({}, r); if (o) F.forEach(f => { if ('f_' + f in o) x[f] = o['f_' + f]; }); return o && o.f_deleted ? null : x; };
    rows.map(eff).filter(Boolean).concat(ens).forEach(x => F.forEach(f => { const v = String(x[f] || '').trim(); if (!v || names.has(v) || linked.has((x.media || '') + '|' + v) || linked.has('|' + v)) return; const k = x.media + '｜' + v; un[k] = (un[k] || 0) + 1; }));
    const unL = Object.entries(un).sort((a, b) => b[1] - a[1]);
    D.push('## 担当者名がどの契約・社員にも当たらず、担当者の紐づけもない：' + unL.length + '種類'); unL.slice(0, 60).forEach(([k, n]) => D.push('- ' + k + '：' + n + '件'));
    // (2) 別ディレクトリの記事が同じ保存先（メディア|No）を共有していて、画面で直した値がある（片方を直すともう片方も変わる）
    const byKey = {}; rows.forEach(r => { (byKey[r.key] = byKey[r.key] || []).push(r); });
    const shared = Object.entries(byKey).filter(([k, L]) => L.length > 1 && new Set(L.map(r => r.sub || '')).size > 1 && ovByKey[k] && Object.keys(ovByKey[k]).some(x => x.startsWith('f_')));
    D.push('', '## 別ディレクトリの記事が同じ保存先（メディア|No）を共有し、画面で直した値がある：' + shared.length + '件');
    shared.slice(0, 40).forEach(([k, L]) => D.push('- ' + k + '（' + L.map(r => r.sub || '（なし）').join('・') + '）直した項目：' + Object.keys(ovByKey[k]).filter(x => x.startsWith('f_')).map(x => x.slice(2)).join('、')));
    // (3) 保存先に key・media がない
    const broken = ovs.filter(o => !o.key || !o.media);
    D.push('', '## 画面で直した値の保存先に key・media がない：' + broken.length + '件'); broken.slice(0, 20).forEach(o => D.push('- ' + o._id));
    summary.dataIssues = unL.length + shared.length + broken.length;
    fs.writeFileSync(path.join(OUT, 'data.txt'), D.join('\n') + '\n');
  } else fs.writeFileSync(path.join(OUT, 'data.txt'), '（gcloud のログインが切れているため点検できませんでした）\n');
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
})().catch(e => { summary.notes.push('材料集めでエラー：' + e.message); fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1)); console.log(JSON.stringify(summary)); });
