// AIエラーチェッカーの受付係（2026-11-13 ユーザー指定：AI MEDIAシミュレーションと同じく Supabase＝AIの作業机）
// AIは本番のデータ（Firestore・BigQuery）をさわらない。このスクリプトだけが Supabase を読み書きし、
// 点検の材料（err_checks.materials）・だれが何を読んだか（ai_access_log）・使ったトークンと費用（ai_cost_log）・実行の状態（ai_runs）・指摘（err_findings）を残す。
// あなたの判断（OK／却下と理由）は err_decisions（画面から）。いまは内ループ：直すのはOKした指摘だけ（チャットで）。
//
//   node scripts/err_check_fs.js start <実行ID> <材料のフォルダ>        … 実行を始める（材料を Supabase に入れる）
//   node scripts/err_check_fs.js get <実行ID> <agent> <出力フォルダ>     … そのAIに渡す分だけを Supabase から書き出す（読んだ記録を残す）
//   node scripts/err_check_fs.js save <実行ID> <agent> <報告.md> [<stream.jsonl>|<codexのログ>] … 報告と指摘・トークンを保存
//   node scripts/err_check_fs.js record <pre|data> <実行ID> <報告.md> <codexのログ> <何を見たか>  … デプロイ前・データ修正前の CODEX の確認を記録（2026-11-13 ユーザー指定：これも Supabase に）
//   node scripts/err_check_fs.js finish <実行ID>                        … 実行を終える（状態・合計。点検の基準を今のコードに）
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const G = process.env.LOCALAPPDATA + '/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd', PROJECT = 'bestmedia-510909';
const ROOT = path.resolve(__dirname, '..'), BASE = path.join(__dirname, 'err_check', 'base');
const LOOP = 'inner';   /* いまは内ループ（app.js の ERR_LOOP と同じ。外ループにしたら 'outer'） */
/* AIエラーチェッカーのチーム。読めるのは点検の材料（err_checks）とこれまでの判断（err_decisions）だけ */
const TEAM = JSON.parse(fs.readFileSync(path.join(ROOT, 'webapp', 'ai_errcheck_team.json'), 'utf8')).agents;
const AGENTS = Object.fromEntries(TEAM.map(a => [a.id, Object.assign({}, a, { read: a.ceiling.read })]));
const argv = process.argv.slice(2), cmd = argv[0];
const gc = args => execSync('"' + G + '" ' + args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let sb = null; try { sb = JSON.parse(gc('secrets versions access latest --secret=supabase --project ' + PROJECT)); } catch (e) { sb = null; }
if (!sb || !sb.url || !sb.key) { console.error('Supabase の接続先を読めません（gcloud のログイン、または API・連携設定の Supabase を確認）'); process.exit(1); }
const sbFetch = async (method, p, body, prefer) => {
  const r = await fetch(sb.url.replace(/\/+$/, '') + '/rest/v1/' + p, { method, headers: Object.assign({ apikey: sb.key, 'Content-Type': 'application/json' }, /^sb_/.test(sb.key) ? {} : { Authorization: 'Bearer ' + sb.key }, prefer ? { Prefer: prefer } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; } if (!r.ok) throw new Error((j && j.message) || ('Supabase ' + r.status)); return j; };
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''); } catch (e) { return ''; } };
const cut = (s, n) => String(s || '').length > n ? String(s).slice(0, n) + '\n…（長いため途中まで）' : String(s || '');
/** AIの報告の最後の ```json { findings } ``` を読む */
function findingsOf(md) {
  const m = [...String(md).matchAll(/```json\s*([\s\S]*?)```/g)].pop(); if (!m) return null;
  try { return (JSON.parse(m[1]).findings || []).map(x => ({ level: ['高', '中', '低'].includes(x.level) ? x.level : '中', area: String(x.area || '').slice(0, 20), where_at: String(x.where || '').slice(0, 300), summary: String(x.summary || '').slice(0, 1000), fix: String(x.fix || '').slice(0, 1000) })); } catch (e) { return null; }
}
(async () => {
  if (cmd === 'start') {
    const [run, dir] = argv.slice(1); const sum = JSON.parse(read(dir, 'summary.json') || '{}');
    const materials = { syntax: cut(read(dir, 'syntax.txt'), 30000), diff: cut(read(dir, 'code.diff'), 400000), logs: cut(read(dir, 'logs.txt'), 60000), data: cut(read(dir, 'data.txt'), 60000) };
    await sbFetch('POST', 'err_checks', [{ run_id: run, loop: LOOP, status: 'running', summary: sum, materials, reports: {} }], 'resolution=merge-duplicates,return=minimal');
    await sbFetch('POST', 'ai_agents', Object.entries(AGENTS).map(([id, a]) => ({ id, char: a.char, position: a.position, provider: a.provider, kind: a.kind, parent: a.parent || '', model: a.model, scope: a.ceiling, updated_by: 'err_check' })), 'resolution=merge-duplicates,return=minimal').catch(e => console.error('ai_agents：' + e.message));
    await sbFetch('POST', 'ai_runs', [{ run_id: 'err-' + run, ym: run.slice(0, 4) + '-' + run.slice(4, 6), loop: LOOP, status: 'running', agents: Object.fromEntries(Object.keys(AGENTS).map(k => [k, { status: 'working', purpose: '週次のエラー点検' }])), models: Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, a.model])), note: 'AIエラーチェッカー' }], 'resolution=merge-duplicates,return=minimal').catch(e => console.error('ai_runs：' + e.message));
    return console.log('開始：' + run);
  }
  if (cmd === 'get') {
    const [run, agent, out] = argv.slice(1); if (!AGENTS[agent]) throw new Error('知らないAI：' + agent);
    const c = (await sbFetch('GET', 'err_checks?select=materials&run_id=eq.' + encodeURIComponent(run)))[0]; if (!c) throw new Error('実行がありません：' + run);
    const ng = await sbFetch('GET', 'err_decisions?select=finding_id,reason,at&decision=eq.ng&order=at.desc&limit=200');
    const fids = ng.map(x => x.finding_id).filter(Boolean), fs2 = fids.length ? await sbFetch('GET', 'err_findings?select=id,where_at,summary&id=in.(' + fids.join(',') + ')') : [];
    const dec = ng.map(x => { const f = fs2.find(y => y.id === x.finding_id) || {}; return '- ' + (f.where_at || '') + '：' + (f.summary || '') + '　→ 却下の理由：' + (x.reason || '（理由なし）'); });
    fs.mkdirSync(out, { recursive: true });
    const m = c.materials || {}; fs.writeFileSync(path.join(out, 'syntax.txt'), m.syntax || ''); fs.writeFileSync(path.join(out, 'code.diff'), m.diff || ''); fs.writeFileSync(path.join(out, 'logs.txt'), m.logs || ''); fs.writeFileSync(path.join(out, 'data.txt'), m.data || '');
    fs.writeFileSync(path.join(out, 'decisions.txt'), dec.length ? dec.join('\n') + '\n' : '（まだ却下した指摘はありません）\n');
    await sbFetch('POST', 'ai_access_log', [{ run_id: 'err-' + run, agent, by_agent: 'receptionist', tbl: 'err_checks', op: 'read', rows: 1, cols: 'syntax,diff,logs,data', purpose: '週次のエラー点検の材料' }, { run_id: 'err-' + run, agent, by_agent: 'receptionist', tbl: 'err_decisions', op: 'read', rows: dec.length, cols: 'finding,reason', purpose: '却下した指摘をくり返さない' }], 'return=minimal').catch(() => {});
    return console.log('渡した：' + agent + '（却下 ' + dec.length + '件）');
  }
  if (cmd === 'save') {
    const [run, agent, report, extra] = argv.slice(1); if (!AGENTS[agent]) throw new Error('知らないAI：' + agent);
    let md = read(path.dirname(report), path.basename(report)); let tin = null, tout = null, cr = null, cw = null, usd = null, model = AGENTS[agent].model, note = '';
    if (agent === 'err_claude' && extra && fs.existsSync(extra)) {   /* Claude：stream-json から本文とトークン */
      const ev = fs.readFileSync(extra, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const res = ev.find(e => e.type === 'result'); if (res && res.result && !md.trim()) md = res.result;
      if (res && res.is_error) note = 'Claude の実行でエラー：' + String(res.result || '').slice(0, 200);
      const seen = new Set(); tin = 0; tout = 0; cr = 0; cw = 0;
      ev.filter(e => e.type === 'assistant' && e.message && e.message.usage && !seen.has(e.message.id) && seen.add(e.message.id)).forEach(e => { const u = e.message.usage; tin += u.input_tokens || 0; tout += u.output_tokens || 0; cr += u.cache_read_input_tokens || 0; cw += u.cache_creation_input_tokens || 0; model = e.message.model || model; });
      if (res && res.total_cost_usd != null) usd = res.total_cost_usd; note = note || 'Claude Code（このPC・定額プラン。金額はAPI換算の参考）';
      if (!md.trim()) md = (ev.find(e => e.type === 'result') || {}).result || '';
      if (/Failed to authenticate|API Error/.test(md) && !findingsOf(md)) note = 'Claude Code の認証エラー：' + md.slice(0, 200);
    }
    if (agent === 'err_codex' && extra && fs.existsSync(extra)) {   /* CODEX：ログの最後の「tokens used」 */
      const t = read(path.dirname(extra), path.basename(extra)), m = [...t.matchAll(/tokens used\s*\r?\n\s*([\d,]+)/g)].pop(); if (m) tin = Number(m[1].replace(/,/g, ''));
      note = 'CODEX（このPC・ChatGPTプラン。トークンは入出力の合計）';
    }
    const f = findingsOf(md);
    if (f && f.length) await sbFetch('POST', 'err_findings', f.map(x => Object.assign({ run_id: run, by_agent: agent }, x)), 'return=minimal');
    const cur = (await sbFetch('GET', 'err_checks?select=reports&run_id=eq.' + encodeURIComponent(run)))[0] || {};
    await sbFetch('PATCH', 'err_checks?run_id=eq.' + encodeURIComponent(run), { reports: Object.assign({}, cur.reports || {}, { [agent]: { md: cut(md, 120000), parsed: !!f, count: f ? f.length : 0, note } }) }, 'return=minimal');
    await sbFetch('POST', 'ai_cost_log', [{ ai: AGENTS[agent].provider, agent, model, run_id: 'err-' + run, loop: LOOP, task: 'AIエラーチェッカー ' + run, tokens_in: tin, tokens_out: tout, cache_read: cr, cache_write: cw, usd, note }], 'return=minimal').catch(e => console.error('ai_cost_log：' + e.message));
    return console.log('保存：' + agent + ' 指摘 ' + (f ? f.length : '（JSONを読めず）') + (note ? '　' + note : ''));
  }
  if (cmd === 'record') {
    const [kind, run, report, logf, what] = argv.slice(1), KIND = { pre: 'デプロイ前の確認', data: 'データ修正前の確認' }; if (!KIND[kind]) throw new Error('pre か data を指定');
    const md = read(path.dirname(report), path.basename(report)), lt = logf && fs.existsSync(logf) ? read(path.dirname(logf), path.basename(logf)) : '', tm = [...lt.matchAll(/tokens used\s*\r?\n\s*([\d,]+)/g)].pop(), tin = tm ? Number(tm[1].replace(/,/g, '')) : null;
    const f = findingsOf(md), at = new Date().toISOString(), rid = 'err-' + run;
    await sbFetch('POST', 'err_checks', [{ run_id: run, loop: LOOP, status: f && f.length ? 'open' : f ? 'ok' : 'incomplete', ended_at: at, summary: { kind: KIND[kind], what: String(what || '').slice(0, 300) }, materials: {}, reports: { err_codex: { md: cut(md, 120000), parsed: !!f, count: f ? f.length : 0, note: 'CODEX（このPC・ChatGPTプラン。トークンは入出力の合計）' } }, note: f ? '' : '報告を読めなかったAI：err_codex' }], 'resolution=merge-duplicates,return=minimal');
    if (f && f.length) await sbFetch('POST', 'err_findings', f.map(x => Object.assign({ run_id: run, by_agent: 'err_codex' }, x)), 'return=minimal');
    await sbFetch('POST', 'ai_runs', [{ run_id: rid, ym: run.replace(/^[a-z]+_/, '').slice(0, 4) + '-' + run.replace(/^[a-z]+_/, '').slice(4, 6), loop: LOOP, status: f ? 'done' : 'error', ended_at: at, agents: { err_codex: { status: f ? 'done' : 'error', purpose: KIND[kind] } }, models: { err_codex: 'codex' }, tokens_in: tin, note: 'AIエラーチェッカー（' + KIND[kind] + '）' }], 'resolution=merge-duplicates,return=minimal').catch(e => console.error('ai_runs：' + e.message));
    await sbFetch('POST', 'ai_access_log', [{ run_id: rid, agent: 'err_codex', by_agent: 'receptionist', tbl: kind === 'pre' ? 'コードの差分' : 'データ修正のスクリプトと試算', op: 'read', rows: null, cols: String(what || '').slice(0, 200), purpose: KIND[kind] }], 'return=minimal').catch(() => {});
    await sbFetch('POST', 'ai_cost_log', [{ ai: 'openai', agent: 'err_codex', model: 'codex', run_id: rid, loop: LOOP, task: 'AIエラーチェッカー（' + KIND[kind] + '） ' + run, tokens_in: tin, usd: null, note: 'CODEX（このPC・ChatGPTプラン。トークンは入出力の合計）' }], 'return=minimal').catch(e => console.error('ai_cost_log：' + e.message));
    return console.log('記録：' + run + '（' + KIND[kind] + '）指摘 ' + (f ? f.length : '（JSONを読めず）'));
  }
  if (cmd === 'finish') {
    const run = argv[1];
    const c = (await sbFetch('GET', 'err_checks?select=summary,reports&run_id=eq.' + encodeURIComponent(run)))[0] || {};
    const n = (await sbFetch('GET', 'err_findings?select=id&run_id=eq.' + encodeURIComponent(run))).length, sum = c.summary || {};
    const failed = Object.keys(AGENTS).filter(a => !(c.reports || {})[a] || !(c.reports || {})[a].parsed);
    const status = failed.length ? 'incomplete' : n || sum.syntaxErrors ? 'open' : 'ok';   /* 片方のAIの報告を読めなかったら、指摘があっても「報告を読めず」（2026-11-16 指摘 #12） */
    await sbFetch('PATCH', 'err_checks?run_id=eq.' + encodeURIComponent(run), { status, ended_at: new Date().toISOString(), note: failed.length ? '報告を読めなかったAI：' + failed.join('・') : '' }, 'return=minimal');
    const cost = await sbFetch('GET', 'ai_cost_log?select=tokens_in,tokens_out,cache_read,cache_write,usd&run_id=eq.err-' + encodeURIComponent(run)).catch(() => []);
    const s = k => cost.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    await sbFetch('PATCH', 'ai_runs?run_id=eq.err-' + encodeURIComponent(run), { status: status === 'incomplete' ? 'error' : 'done', ended_at: new Date().toISOString(), agents: Object.fromEntries(Object.keys(AGENTS).map(k => [k, { status: failed.includes(k) ? 'error' : 'done' }])), tokens_in: s('tokens_in'), tokens_out: s('tokens_out'), cache_read: s('cache_read'), cache_write: s('cache_write'), usd: cost.some(r => r.usd != null) ? s('usd') : null }, 'return=minimal').catch(() => {});
    /* 次の点検はここからの差分（AIが読めなかったときは基準を進めない＝次回もう一度見る） */
    if (!failed.length) {
      const files = [];
      fs.readdirSync(path.join(ROOT, 'webapp')).filter(f => /\.(js|json)$/.test(f) && !/^package/.test(f)).forEach(f => files.push('webapp/' + f));
      ['app.js', 'styles.css', 'index.html'].forEach(f => files.push('webapp/public/' + f));
      fs.readdirSync(__dirname).filter(f => /\.(js|ps1|md)$/.test(f)).forEach(f => files.push('scripts/' + f));
      files.forEach(f => { const s2 = path.join(ROOT, f), d = path.join(BASE, f); if (!fs.existsSync(s2)) return; fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s2, d); });
    }
    return console.log('終了：' + run + '　状態 ' + status + '　指摘 ' + n + '件' + (failed.length ? '　報告を読めなかったAI：' + failed.join('・') : ''));
  }
  console.log('使い方：start／get／save／finish（ファイルの先頭を見てください）');
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
