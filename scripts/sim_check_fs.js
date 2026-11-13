// 答え合わせ（AI MEDIAシミュレーション）の受付係（2026-11-05・2026-11-06 ユーザー指定）
// AIは Supabase を直接さわらない。このスクリプトだけが読み書きし、だれが何を読んだか（ai_access_log）・使ったトークン（ai_cost_log）・実行の状態（ai_runs）を残す。
// ポジションごとに読める上限は webapp/ai_team.json の ceiling。いまの範囲（scope）は Supabase ai_agents（指揮官が上限の中で調整）。
//
//   node scripts/sim_check_fs.js start 2026-11                 … 実行を始める（run_id と指揮官のモデルを JSON で出す。タスクのスクリプトが使う）
//   node scripts/sim_check_fs.js get 2026-11                   … 【指揮官】答え合わせの表・これまでの判断・チームの範囲。表がまだなければ終了コード 2
//   node scripts/sim_check_fs.js slice 2026-11 <agent> --media a,b [--items pv,cvr] [--draft <file>] --purpose "…"
//                                                              … 【指揮官】サブエージェントに渡す分だけを切り出してファイルにする（範囲の外は渡せない）
//   node scripts/sim_check_fs.js ask 2026-11 <agent> --brief <file>   … 【指揮官】Gemini・OpenAI に、切り出した分と質問だけを渡して聞く（トークンを記録）
//   node scripts/sim_check_fs.js done <agent>                  … サブエージェントの作業が終わった（画面の状態を「完了」に）
//   node scripts/sim_check_fs.js scope <agent> <table,table…>  … 【指揮官】そのポジションの読める範囲を上限の中で変える
//   node scripts/sim_check_fs.js save 2026-11 <file>           … 【指揮官】AIの見直しを保存（表は変えない）
//   node scripts/sim_check_fs.js finish <stream.jsonl> [終了コード] … Claude の実行記録から、このループで使ったトークンをエージェントごとに記録して終える
// AIの見直しの JSON：{ "by": "Claude（シュミレ・クロード指揮官）", "summary": "全体のまとめ", "media": { "<メディアのキー>": { "cause": "ずれの起点（日本語）", "fix": "直すところ" } } }
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const G = process.env.LOCALAPPDATA + '/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd', PROJECT = 'bestmedia-510909';
const TEAMDEF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'webapp', 'ai_team.json'), 'utf8')), TEAM = TEAMDEF.agents;
const LOOP = 'inner';   /* いまは内ループ（app.js の AI_LOOP と同じ。外ループにしたら 'outer'） */
const RUN = process.env.SIM_RUN_ID || '';
const RUN_DIR = path.join(__dirname, 'logs', 'run');
const argv = process.argv.slice(2), cmd = argv[0];
const opt = k => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : undefined; };
const isYm = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
const gc = args => execSync('"' + G + '" ' + args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const secret = name => { try { return JSON.parse(gc('secrets versions access latest --secret=' + name + ' --project ' + PROJECT)); } catch (e) { return null; } };
let sb = secret('supabase'); if (sb && (!sb.url || !sb.key)) sb = null;
const sbFetch = async (method, p, body, prefer) => { const r = await fetch(sb.url.replace(/\/+$/, '') + '/rest/v1/' + p, { method, headers: Object.assign({ apikey: sb.key, 'Content-Type': 'application/json' }, /^sb_/.test(sb.key) ? {} : { Authorization: 'Bearer ' + sb.key }, prefer ? { Prefer: prefer } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; } if (!r.ok) throw new Error((j && j.message) || ('Supabase ' + r.status)); return j; };
/* AIチームの表（ai_runs・ai_access_log・ai_agents）がまだなくても、答え合わせは止めない */
let teamOk = null;
const team = async () => { if (teamOk !== null) return teamOk; teamOk = false; if (!sb) return false; try { await sbFetch('GET', 'ai_runs?select=run_id&limit=1'); await sbFetch('GET', 'ai_cost_log?select=run_id,agent&limit=1'); teamOk = true; } catch (e) { teamOk = false; } return teamOk; };
const quiet = async f => { try { if (await team()) await f(); } catch (e) { console.error('（記録だけ失敗：' + e.message + '）'); } };
/** だれが何を読んだ・書いたか（agent＝読んだAI、by＝渡したAI） */
/* Google Chat のスペースへの通知（2026-11-06 ユーザー指定：キャラごとのアイコンで、だれが何をしたか）。Webhook がなければ何もしない。失敗しても答え合わせは止めない */
const CHAT = require(path.join(__dirname, '..', 'webapp', 'ai_chat.js'));
let chatUrl; const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const notify = async (agentId, html, opt) => { try {
  if (!RUN && !(opt && opt.always)) return; if (chatUrl === undefined) chatUrl = ((secret('ai_loop_keys') || {}).chat || {}).url || null; if (!chatUrl) return;
  const a = Object.assign({}, (await roster()).find(x => x.id === agentId) || TEAM[0], opt && opt.model ? { model: opt.model } : {});
  await CHAT.post(chatUrl, a, html, Object.assign({ thread: RUN || undefined }, opt || {}));
} catch (e) { console.error('（通知だけ失敗：' + e.message + '）'); } };
const charOf = id => (TEAM.find(a => a.id === id) || {}).char || id;
const access = (agent, tbl, op, rows, cols, purpose, by) => quiet(() => sbFetch('POST', 'ai_access_log', [{ run_id: RUN || null, agent, by_agent: by || agent, tbl, op, rows, cols: String(cols || '').slice(0, 300), purpose: String(purpose || '').slice(0, 300) }], 'return=minimal'));
/** 実行の状態（画面のいちばん上のキャラの表示） */
const mark = (agent, status, extra) => RUN && quiet(async () => {
  const cur = (await sbFetch('GET', 'ai_runs?select=agents,models&run_id=eq.' + encodeURIComponent(RUN)))[0]; if (!cur) return;
  const agents = Object.assign({}, cur.agents || {}); agents[agent] = Object.assign({}, agents[agent] || {}, { status, at: new Date().toISOString() }, extra || {});
  const body = { agents }; if (extra && extra.model) body.models = Object.assign({}, cur.models || {}, { [agent]: extra.model });
  await sbFetch('PATCH', 'ai_runs?run_id=eq.' + encodeURIComponent(RUN), body, 'return=minimal');
});
/** いまの範囲（Supabase ai_agents。なければ上限）とモデル */
async function roster() {
  let saved = []; if (await team()) { try { saved = await sbFetch('GET', 'ai_agents?select=*'); } catch (e) { saved = []; } }
  return TEAM.map(a => { const s = saved.find(x => x.id === a.id) || {}, sc = s.scope && s.scope.read ? s.scope : a.ceiling;
    return Object.assign({}, a, { model: s.model || a.model, scope: { read: (sc.read || []).filter(t => a.ceiling.read.includes(t)), write: (sc.write || []).filter(t => a.ceiling.write.includes(t)) }, active: s.active !== false }); });
}
const canRead = (ag, tbl) => ag.scope.read.includes(tbl);
const price = (model, tin, tout, cached) => { const p = Object.entries(TEAMDEF.prices || {}).find(([k]) => String(model).startsWith(k)); if (!p) return null; const [, v] = p; return ((tin - (cached || 0)) * v.in + (cached || 0) * (v.cached != null ? v.cached : v.in) + tout * v.out) / 1e6; };
const fsBase = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/sim_checks/';
const fromV = v => v == null ? null : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(fromV) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromV(x)])) : null;
const toV = x => x == null ? { nullValue: null } : typeof x === 'string' ? { stringValue: x.slice(0, 2000) } : typeof x === 'number' ? { doubleValue: x } : typeof x === 'boolean' ? { booleanValue: x }
  : Array.isArray(x) ? { arrayValue: { values: x.map(toV) } } : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toV(v)])) } };
async function checkRows(ym) {
  if (sb) { const c = await sbFetch('GET', 'sim_checks?select=*&ym=eq.' + ym); return c.length ? { rows: c[0].rows, at: c[0].at } : { rows: null }; }
  const tok = gc('auth print-access-token'), r = await fetch(fsBase + ym, { headers: { Authorization: 'Bearer ' + tok } });
  if (r.status === 404) return { rows: null }; const d = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); const o = fromV({ mapValue: { fields: d.fields || {} } }); return { rows: o.rows, at: o.at };
}
/** 混み合っている（429・500番台）ときは、30秒・60秒待って3回まで試す（2026-11-06：Gemini が high demand を返した） */
const retry = async f => { for (let i = 0; ; i++) { const r = await f(); if (r.ok || i >= 2 || !(r.status === 429 || r.status >= 500)) return r; console.error('混み合っているため ' + (30 * (i + 1)) + '秒待って試し直します（' + r.status + '）'); await new Promise(z => setTimeout(z, 30000 * (i + 1))); } };
const usage = () => { console.error('使い方：start|get|slice|ask|done|scope|save|finish（ファイルの先頭の説明を見てください）'); process.exitCode = 1; };

(async () => {
  if (cmd === 'start') {
    const ym = argv[1]; if (!isYm(ym)) return usage();
    const run_id = ym + '_' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15), team0 = await roster(), cm = team0.find(a => a.id === 'commander');
    await quiet(() => sbFetch('POST', 'ai_runs', [{ run_id, ym, loop: LOOP, status: 'running', agents: { commander: { status: 'working', at: new Date().toISOString() } }, models: { commander: cm.model } }], 'return=minimal'));
    /* 検証デスク（Claude のサブエージェント）のモデルは、エージェントの定義ファイルに入れる */
    const ck = team0.find(a => a.id === 'checker'), mdp = path.join(__dirname, '..', '.claude', 'agents', 'sim-checker.md');
    try { const md = fs.readFileSync(mdp, 'utf8'), nx = md.replace(/^model:.*$/m, 'model: ' + ck.model); if (nx !== md) fs.writeFileSync(mdp, nx, 'utf8'); } catch (e) { /* なし */ }
    fs.mkdirSync(RUN_DIR, { recursive: true }); fs.readdirSync(RUN_DIR).forEach(f => fs.unlinkSync(path.join(RUN_DIR, f)));   /* 前回の切り出しは消す */
    process.env.SIM_RUN_ID = run_id;
    await (async () => { const RUN0 = run_id; try { if (chatUrl === undefined) chatUrl = ((secret('ai_loop_keys') || {}).chat || {}).url || null; if (chatUrl) await CHAT.post(chatUrl, cm, '🔔 <b>' + ym.replace('-', '/') + '分の答え合わせを始めます</b><br>チーム：' + team0.map(a => esc(a.char) + '（' + esc(a.model) + '）').join('・'), { thread: RUN0 }); } catch (e) { console.error('（通知だけ失敗：' + e.message + '）'); } })();
    console.log(JSON.stringify({ run_id, commanderModel: cm.model }));
  } else if (cmd === 'get') {
    const ym = argv[1]; if (!isYm(ym)) return usage();
    const { rows, at } = await checkRows(ym);
    if (!rows || !rows.length) { console.log('まだ表が保存されていません（管理者が5日以降にダッシュボードを開くと保存されます）'); process.exitCode = 2; return; }
    const decisions = sb ? await sbFetch('GET', 'sim_decisions?select=ym,media,decision,reason,proposal,ai,at&order=at.desc&limit=200') : [];   /* これまでの判断（却下の理由はAIが次に活かす） */
    const t = await roster();
    if (RUN) { await access('commander', 'sim_checks', 'read', rows.length, 'rows（全メディア）', '答え合わせの全体を見る'); await access('commander', 'sim_decisions', 'read', decisions.length, 'ym,media,decision,reason,proposal', 'これまでの判断'); }
    await notify('commander', '📋 答え合わせの表を読みました：' + rows.length + 'メディア（ずれあり ' + rows.filter(r => r.cause).length + '）<br>これまでの判断 ' + decisions.length + '件も確認します');
    console.log(JSON.stringify({ ym, store: sb ? 'supabase' : 'firestore', at, rows, pastDecisions: decisions,
      team: t.map(a => ({ id: a.id, char: a.char, position: a.position, provider: a.provider, model: a.model, scope: a.scope, ceiling: a.ceiling, available: a.provider === 'claude' || !!((secret('ai_loop_keys') || {})[a.provider] || {}).key })) }, null, 1));
  } else if (cmd === 'slice') {
    const ym = argv[1], id = argv[2]; if (!isYm(ym) || !id) return usage();
    const ag = (await roster()).find(a => a.id === id); if (!ag || ag.id === 'commander') { console.error('渡す相手が違います：' + id); process.exitCode = 1; return; }
    const media = String(opt('media') || '').split(',').map(s => s.trim()).filter(Boolean), items = String(opt('items') || '').split(',').map(s => s.trim()).filter(Boolean), purpose = opt('purpose') || '';
    if (!media.length) { console.error('--media で渡すメディアを決めてください（必要な分だけ）'); process.exitCode = 1; return; }
    const out = { ym, for: ag.char, purpose, media }, given = [];
    if (canRead(ag, 'sim_checks')) {
      const { rows } = await checkRows(ym);
      out.rows = (rows || []).filter(r => media.includes(r.media)).map(r => Object.assign({}, r, { els: (r.els || []).filter(e => !items.length || items.includes(e.k)) }));
      given.push(['sim_checks', out.rows.length, items.length ? items.join(',') : 'els（全要素）']);
    }
    if (canRead(ag, 'sim_decisions') && sb) { out.pastDecisions = (await sbFetch('GET', 'sim_decisions?select=ym,media,decision,reason,proposal&order=at.desc&limit=200')).filter(d => media.includes(d.media)); given.push(['sim_decisions', out.pastDecisions.length, 'media,decision,reason,proposal']); }
    if (canRead(ag, 'sim_copy_actuals') && sb) {
      const from = (() => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 14, 1)); return d.toISOString().slice(0, 7); })(), inM = 'in.(' + media.map(m => '"' + m + '"').join(',') + ')';
      out.actuals = await sbFetch('GET', 'sim_copy_actuals?select=ym,media,pv,sessions,imp,clicks&media=' + encodeURIComponent(inM) + '&ym=gte.' + from + '&ym=lte.' + ym + '&order=ym');
      given.push(['sim_copy_actuals', out.actuals.length, 'ym,media,pv,sessions,imp,clicks（直近14か月）']);
      if (canRead(ag, 'sim_copy_predictions')) { out.predictions = await sbFetch('GET', 'sim_copy_predictions?select=snapshot_ym,media,ym,value&scenario=eq.ideal&metric=eq.pv&media=' + encodeURIComponent(inM) + '&ym=eq.' + ym); given.push(['sim_copy_predictions', out.predictions.length, 'PVの予測（理想）']); }
    }
    const draft = opt('draft'); if (draft) { out.draft = JSON.parse(fs.readFileSync(draft, 'utf8')); if (out.draft.media) out.draft.media = Object.fromEntries(Object.entries(out.draft.media).filter(([k]) => media.includes(k))); given.push(['（編集長の調整案）', Object.keys(out.draft.media || {}).length, 'cause,fix']); }
    if (!given.length) { console.error(ag.char + ' は、いまの範囲では何も読めません（範囲：' + ag.scope.read.join(',') + '）'); process.exitCode = 1; return; }
    fs.mkdirSync(RUN_DIR, { recursive: true }); const f = path.join(RUN_DIR, id + '_' + ym + '.json'); fs.writeFileSync(f, JSON.stringify(out, null, 1), 'utf8');
    for (const [tbl, n, cols] of given) await access(id, tbl, 'read', n, cols, purpose, 'commander');
    await mark(id, 'working', { model: ag.model, purpose: purpose.slice(0, 120) });
    await notify(id, '📥 ' + esc(charOf('commander')) + 'から受け取りました<br><b>' + esc(purpose || '（目的なし）') + '</b><br>' + media.map(esc).join('・') + '／' + given.map(g => esc(g[0]) + ' ' + g[1] + '行').join('・'));
    console.log('渡す分を切り出しました：' + path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/') + '（' + given.map(g => g[0] + ' ' + g[1] + '行').join('・') + '）');
  } else if (cmd === 'ask') {
    const ym = argv[1], id = argv[2], brief = opt('brief'); if (!isYm(ym) || !id || !brief) return usage();
    const ag = (await roster()).find(a => a.id === id); if (!ag || !['gemini', 'openai'].includes(ag.provider)) { console.error('聞けるのは Gemini・OpenAI の担当だけです'); process.exitCode = 1; return; }
    const key = ((secret('ai_loop_keys') || {})[ag.provider] || {}).key; if (!key) { console.log(ag.char + '（' + ag.provider + '）はまだつないでいません。聞かずに進めてください'); await mark(id, 'off'); return; }
    const sf = path.join(RUN_DIR, id + '_' + ym + '.json'); if (!fs.existsSync(sf)) { console.error('先に slice で渡す分を切り出してください'); process.exitCode = 1; return; }
    const text = fs.readFileSync(brief, 'utf8').slice(0, 4000) + '\n\n## 渡すデータ（これ以外は見せていません）\n' + fs.readFileSync(sf, 'utf8').slice(0, 60000) + '\n\n日本語で、結論→理由の順に、800字以内で答えてください。';
    await mark(id, 'working', { model: ag.model });
    let ans = '', tin = 0, tout = 0, cached = 0;
    /* 予備のモデル（ai_team.json の fallback）：混み合って使えないときは切り替える。実際に使ったモデルを記録（2026-11-06） */
    const fb = (TEAM.find(x => x.id === id) || {}).fallback, gem = m => retry(() => fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent', { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { maxOutputTokens: 4000 } }) }));
    if (ag.provider === 'gemini') {
      let r = await gem(ag.model); if (!r.ok && fb && fb !== ag.model && (r.status === 429 || r.status >= 500)) { console.error(ag.model + ' が使えないため、予備の ' + fb + ' で聞きます'); ag.model = fb; r = await gem(fb); }
      const j = await r.json(); if (!r.ok) { await mark(id, 'error'); await notify(id, '❌ うまくいきませんでした：' + esc((j.error && j.error.message) || r.status)); throw new Error('Gemini：' + ((j.error && j.error.message) || r.status)); }
      ans = ((j.candidates || [])[0] || {}).content ? j.candidates[0].content.parts.map(p => p.text || '').join('') : '';
      const u = j.usageMetadata || {}; tin = u.promptTokenCount || 0; tout = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); cached = u.cachedContentTokenCount || 0;
    } else {
      const r = await retry(() => fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ag.model, input: text, max_output_tokens: 4000 }) }));
      const j = await r.json(); if (!r.ok) { await mark(id, 'error'); await notify(id, '❌ うまくいきませんでした：' + esc((j.error && j.error.message) || r.status)); throw new Error('OpenAI：' + ((j.error && j.error.message) || r.status)); }
      ans = (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
      const u = j.usage || {}; tin = u.input_tokens || 0; tout = u.output_tokens || 0; cached = (u.input_tokens_details || {}).cached_tokens || 0;
    }
    await quiet(() => sbFetch('POST', 'ai_cost_log', [{ ai: ag.provider, agent: id, model: ag.model, run_id: RUN || null, loop: LOOP, task: 'シミュレーションの答え合わせ ' + ym, tokens_in: tin, tokens_out: tout, cache_read: cached, cache_write: 0, usd: price(ag.model, tin, tout, cached), note: ag.char + '（API）' }], 'return=minimal'));
    await mark(id, 'done', { model: ag.model, tokens: tin + tout });
    await notify(id, '💡 <b>答えました</b>（入力 ' + tin + '・出力 ' + tout + ' トークン' + (price(ag.model, tin, tout, cached) != null ? '・約$' + price(ag.model, tin, tout, cached).toFixed(4) : '') + '）<br>' + esc(String(ans).slice(0, 700)).replace(/\n/g, '<br>'), { model: ag.model });
    console.log('【' + ag.char + '（' + ag.model + '）の答え】入力 ' + tin + '・出力 ' + tout + ' トークン\n' + ans);
  } else if (cmd === 'done') {
    const id = argv[1]; if (!TEAM.some(a => a.id === id)) return usage(); await mark(id, 'done'); await notify(id, '✅ 調べ終わりました。結果を' + esc(charOf('commander')) + 'に返しました'); console.log('完了にしました：' + id);
  } else if (cmd === 'scope') {
    const id = argv[1], want = String(argv[2] || '').split(',').map(s => s.trim()).filter(Boolean), a = TEAM.find(x => x.id === id); if (!a || a.id === 'commander') return usage();
    const ng = want.filter(t => !a.ceiling.read.includes(t)); if (ng.length) { console.error(a.char + ' の上限の外です：' + ng.join(',') + '（上限：' + a.ceiling.read.join(',') + '）'); process.exitCode = 1; return; }
    if (!(await team())) { console.log('Supabase に AIチームの表がないため、範囲は上限のままです'); return; }
    await sbFetch('POST', 'ai_agents?on_conflict=id', [{ id, scope: { read: want, write: [] }, updated_at: new Date().toISOString(), updated_by: 'commander' }], 'resolution=merge-duplicates,return=minimal');
    await access(id, 'ai_agents', 'write', 1, 'scope.read=' + want.join(','), '読める範囲を調整', 'commander');
    await notify('commander', '🔧 ' + esc(a.char) + ' の読める範囲を変えました：' + (want.map(esc).join('・') || 'なし'));
    console.log(a.char + ' の読める範囲：' + (want.join('・') || 'なし'));
  } else if (cmd === 'save') {
    const ym = argv[1], file = argv[2]; if (!isYm(ym) || !file) return usage();
    const ai = JSON.parse(fs.readFileSync(file, 'utf8'));
    const media = Object.fromEntries(Object.entries(ai.media || {}).slice(0, 50).map(([k, v]) => [k.slice(0, 60), { cause: String((v || {}).cause || '').slice(0, 60), fix: String((v || {}).fix || '').slice(0, 600) }]));
    const by = String(ai.by || 'Claude（シュミレ・クロード指揮官）').slice(0, 60), summary = String(ai.summary || '').slice(0, 2000);
    if (sb) {
      await sbFetch('POST', 'sim_ai_reviews', [{ ym, ai: by, summary, media }], 'return=minimal');
      if (RUN) await access('commander', 'sim_ai_reviews', 'write', 1, 'summary,media（' + Object.keys(media).length + 'メディア）', 'AIの見直しを保存');
      if (!(await team())) await sbFetch('POST', 'ai_cost_log', [{ ai: by, task: 'シミュレーションの答え合わせ ' + ym, usd: 0, note: 'Claude Code（このPC・定額）で実行' }], 'return=minimal');   /* AIチームの表がないときだけ（あるときは finish でトークンごと記録） */
    } else {
      const tok = gc('auth print-access-token');
      const r = await (await fetch(fsBase + ym + '?updateMask.fieldPaths=ai', { method: 'PATCH', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { ai: toV({ by, at: new Date().toISOString(), summary, media }) } }) })).json();
      if (r.error) { console.error(JSON.stringify(r.error)); process.exitCode = 1; return; }
    }
    await notify('commander', '📝 <b>調整案を保存しました</b>（' + Object.keys(media).length + 'メディア・あなたのOK待ち）<br>' + esc(summary.slice(0, 900)).replace(/\n/g, '<br>'));
    console.log('保存しました：' + ym + '（' + Object.keys(media).length + 'メディア、' + (sb ? 'Supabase' : 'Firestore') + '）');
  } else if (cmd === 'finish') {
    /* Claude の実行記録（stream-json）から、このループで使ったトークンだけを数える。サブエージェントの分は parent_tool_use_id でわける */
    const file = argv[1], code = Number(argv[2] || 0); if (!file || !fs.existsSync(file)) return usage();
    const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const toolAgent = {}, seen = new Set(), by = {};   /* by[agent|model] = {in,out,cr,cw} */
    const subId = t => { const s = String(t || ''); const a = TEAM.find(x => x.id === s || s === 'sim-checker' && x.id === 'checker'); return a ? a.id : 'sub:' + s; };
    let result = null;
    for (const ev of lines) {
      if (ev.type === 'result') result = ev;
      if (ev.type !== 'assistant' || !ev.message) continue;
      (ev.message.content || []).forEach(c => { if (c.type === 'tool_use' && ['Agent', 'Task'].includes(c.name)) toolAgent[c.id] = subId((c.input || {}).subagent_type); });
      const id = ev.message.id, u = ev.message.usage; if (!u || !id || seen.has(id) || ev.message.model === '<synthetic>') continue; seen.add(id);
      const agent = ev.parent_tool_use_id ? (toolAgent[ev.parent_tool_use_id] || 'sub:?') : 'commander', k = agent + '|' + ev.message.model;
      const o = by[k] = by[k] || { agent, model: ev.message.model, in: 0, out: 0, cr: 0, cw: 0 };
      o.in += u.input_tokens || 0; o.out += u.output_tokens || 0; o.cr += u.cache_read_input_tokens || 0; o.cw += u.cache_creation_input_tokens || 0;
    }
    /* 費用：モデルごとの金額（API換算）を、トークンの重みでエージェントに分ける */
    const mu = (result && result.modelUsage) || {}, w = o => o.in + o.out * 5 + o.cr * 0.1 + o.cw * 1.25, rows = Object.values(by);
    rows.forEach(o => { const m = mu[o.model]; const tot = rows.filter(x => x.model === o.model).reduce((s, x) => s + w(x), 0); o.usd = m && m.costUSD != null && tot > 0 ? m.costUSD * w(o) / tot : null; });
    const ym = RUN ? RUN.slice(0, 7) : '';
    await quiet(async () => { if (rows.length) await sbFetch('POST', 'ai_cost_log', rows.map(o => ({ ai: 'claude', agent: o.agent, model: o.model, run_id: RUN || null, loop: LOOP, task: 'シミュレーションの答え合わせ ' + ym, tokens_in: o.in, tokens_out: o.out, cache_read: o.cr, cache_write: o.cw, usd: o.usd, note: 'Claude Code（このPC・定額）。金額はAPI換算' })), 'return=minimal'); });
    await quiet(async () => {
      if (!RUN) return;
      const all = await sbFetch('GET', 'ai_cost_log?select=agent,model,tokens_in,tokens_out,cache_read,cache_write,usd&run_id=eq.' + encodeURIComponent(RUN));
      const cur = (await sbFetch('GET', 'ai_runs?select=agents,models&run_id=eq.' + encodeURIComponent(RUN)))[0] || {};
      const agents = Object.assign({}, cur.agents || {}), models = Object.assign({}, cur.models || {});
      all.forEach(r => { models[r.agent] = r.model; agents[r.agent] = Object.assign({}, agents[r.agent] || {}, { status: (agents[r.agent] || {}).status === 'error' ? 'error' : 'done', tokens: ((agents[r.agent] || {}).tokens || 0) + (r.tokens_in || 0) + (r.tokens_out || 0) }); });
      Object.keys(agents).forEach(k => { if (agents[k].status === 'working') agents[k].status = code === 0 && !(result && result.is_error) ? 'done' : 'error'; });
      const sum = k => all.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      await sbFetch('PATCH', 'ai_runs?run_id=eq.' + encodeURIComponent(RUN), { ended_at: new Date().toISOString(), status: code === 0 && result && !result.is_error ? 'done' : 'error', agents, models,
        tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'), cache_read: sum('cache_read'), cache_write: sum('cache_write'), usd: all.some(r => r.usd != null) ? sum('usd') : null,
        note: result ? String(result.is_error ? 'エラー：' : '').concat(String(result.result || '').slice(0, 600)) : '実行記録に結果がありません' }, 'return=minimal');
    });
    { const ok = code === 0 && result && !result.is_error, usd = rows.reduce((s, o) => s + (o.usd || 0), 0);
      let others = []; await quiet(async () => { if (RUN) others = (await sbFetch('GET', 'ai_cost_log?select=agent,model,tokens_in,tokens_out,usd&run_id=eq.' + encodeURIComponent(RUN))).filter(r => !['commander', 'checker'].includes(r.agent) && !String(r.agent).startsWith('sub:')); });
      const lines = rows.map(o => esc(charOf(o.agent)) + '（' + esc(o.model) + '）' + (o.in + o.out + o.cw).toLocaleString() + ' トークン').concat(others.map(r => esc(charOf(r.agent)) + '（' + esc(r.model) + '）' + ((r.tokens_in || 0) + (r.tokens_out || 0)).toLocaleString() + ' トークン'));
      const total = usd + others.reduce((s, r) => s + (r.usd || 0), 0);
      await notify('commander', (ok ? '🎉 <b>答え合わせが終わりました</b>' : '❌ <b>答え合わせがエラーで止まりました</b>') + '<br>' + lines.join('<br>') + '<br>費用の目安：$' + total.toFixed(2) + '（Claude は定額のためAPI換算）' + (ok ? '' : '<br>' + esc(String((result && result.result) || '実行記録に結果がありません').slice(0, 300))) + '<br>調整案は AIツールの画面で OK／却下 をつけてください', { link: TEAMDEF.dashboardUrl }); }
    console.log('このループで使ったトークン：' + rows.map(o => o.agent + '（' + o.model + '）入力 ' + o.in + '・出力 ' + o.out + '・キャッシュ読み ' + o.cr + '・キャッシュ作成 ' + o.cw).join('／'));
    if (result) console.log('結果：' + (result.is_error ? 'エラー ' : '') + String(result.result || '').slice(0, 2000));
  } else usage();
})().catch(e => { console.error(e.message); process.exitCode = 1; });
