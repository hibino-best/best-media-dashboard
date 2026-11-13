/**
 * Supabase（AIの作業机）（2026-11-05 ユーザー指定：設計図どおり BigQuery＝原本、Supabase＝AIの作業机）
 * ・接続先（プロジェクトのURL）と service_role のキーは、画面（API・連携設定）から Secret Manager「supabase」に保存。画面・チャットには出さない
 * ・表は全部 RLS をオンにしてポリシーを作らない＝service_role（このサーバーと答え合わせのタスク）だけが読み書きできる
 * ・毎日（index-check のついで）BigQuery から「まとめの写し」（予測・メディアごとの月の実績）を写す。毎日書くので無料プランの一時停止も防げる
 * ・答え合わせの表・AIの提案・あなたの判断（OK／却下と理由）・AIの費用の記録をここに置く
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const SECRET = 'supabase';
const TABLES = ['sim_checks', 'sim_ai_reviews', 'sim_decisions', 'sim_copy_predictions', 'sim_copy_actuals', 'ai_cost_log'];
/* AIチームの表（2026-11-06 ユーザー指定：どのAIが何を読んだ・使ったか、ループで使ったトークン量、月ごとのモデル）。
   なくても答え合わせは動く（ready は TABLES だけで判定）。teamReady で別に見る */
const TEAM_TABLES = ['ai_agents', 'ai_runs', 'ai_access_log'];
/* AIエラーチェッカーの表（2026-11-13）。なくてもほかは動く（errReady で別に見る） */
const ERR_TABLES = ['err_checks', 'err_findings', 'err_decisions'];
const SQL = `-- BESTメディア：AIの作業机（Supabase の SQL Editor に貼って「Run」。何度実行しても大丈夫）
create table if not exists sim_checks (ym text primary key, rows jsonb not null default '[]', at timestamptz default now(), saved_by text);
create table if not exists sim_ai_reviews (id bigserial primary key, ym text not null, ai text not null, summary text, media jsonb not null default '{}', at timestamptz default now());
create table if not exists sim_decisions (id bigserial primary key, ym text not null, media text not null, ai text, proposal text, decision text not null check (decision in ('ok','ng')), reason text, decided_by text, at timestamptz default now());
create table if not exists sim_copy_predictions (snapshot_ym text, media text, scenario text, ym text, metric text, value double precision, copied_at timestamptz default now(), primary key (snapshot_ym, media, scenario, ym, metric));
create table if not exists sim_copy_actuals (ym text, media text, pv double precision, sessions double precision, cv double precision, imp double precision, clicks double precision, copied_at timestamptz default now(), primary key (ym, media));
create table if not exists ai_cost_log (id bigserial primary key, at timestamptz default now(), ai text not null, task text, tokens_in bigint, tokens_out bigint, usd double precision, note text);
alter table sim_checks enable row level security;
alter table sim_ai_reviews enable row level security;
alter table sim_decisions enable row level security;
alter table sim_copy_predictions enable row level security;
alter table sim_copy_actuals enable row level security;
alter table ai_cost_log enable row level security;
-- AIチーム（2026-11-06）：ポジションと読める範囲、実行ごとの記録、だれが何を読んだか
create table if not exists ai_agents (id text primary key, char text, position text, provider text, kind text, parent text, model text, scope jsonb not null default '{}', active boolean default true, updated_at timestamptz default now(), updated_by text);
create table if not exists ai_runs (run_id text primary key, ym text, loop text, started_at timestamptz default now(), ended_at timestamptz, status text, agents jsonb not null default '{}', models jsonb not null default '{}', tokens_in bigint, tokens_out bigint, cache_read bigint, cache_write bigint, usd double precision, note text);
create table if not exists ai_access_log (id bigserial primary key, at timestamptz default now(), run_id text, agent text, by_agent text, tbl text, op text, rows integer, cols text, purpose text);
alter table ai_cost_log add column if not exists run_id text;
alter table ai_cost_log add column if not exists agent text;
alter table ai_cost_log add column if not exists model text;
alter table ai_cost_log add column if not exists loop text;
alter table ai_cost_log add column if not exists cache_read bigint;
alter table ai_cost_log add column if not exists cache_write bigint;
alter table ai_agents enable row level security;
alter table ai_runs enable row level security;
alter table ai_access_log enable row level security;
-- AIエラーチェッカー（2026-11-13）：点検の材料と報告・AIの指摘・あなたの判断（OK／却下と理由）
create table if not exists err_checks (run_id text primary key, at timestamptz default now(), ended_at timestamptz, loop text, status text, summary jsonb not null default '{}', materials jsonb not null default '{}', reports jsonb not null default '{}', note text);
create table if not exists err_findings (id bigserial primary key, run_id text not null, by_agent text, level text, area text, where_at text, summary text, fix text, at timestamptz default now());
create table if not exists err_decisions (id bigserial primary key, finding_id bigint not null, run_id text, decision text not null check (decision in ('ok','ng')), reason text, decided_by text, at timestamptz default now());
alter table err_checks enable row level security;
alter table err_findings enable row level security;
alter table err_decisions enable row level security;`;

module.exports = function supabase({ PROJECT, query, T }) {
  const sm = new SecretManagerServiceClient(), sname = `projects/${PROJECT}/secrets/${SECRET}`;
  let cfgCache = null, readyCache = null;
  async function cfg() {
    if (cfgCache && cfgCache.until > Date.now()) return cfgCache.v;
    let v = null; try { const [x] = await sm.accessSecretVersion({ name: sname + '/versions/latest' }); v = JSON.parse(x.payload.data.toString('utf8')); if (!v.url || !v.key) v = null; } catch (e) { v = null; }
    cfgCache = { v, until: Date.now() + 10 * 60 * 1000 }; return v;
  }
  async function setCfg(url, key) {
    try { await sm.getSecret({ name: sname }); } catch (e) { if (e.code !== 5) throw e; await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: SECRET, secret: { replication: { automatic: {} } } }); }
    await sm.addSecretVersion({ parent: sname, payload: { data: Buffer.from(JSON.stringify({ url, key }), 'utf8') } });
    cfgCache = null; readyCache = null;
  }
  /** PostgREST を呼ぶ。c を渡すとその接続先で（保存前の確認用） */
  async function rest(method, path, body, prefer, c) {
    c = c || await cfg(); if (!c) throw new Error('Supabase がまだつながっていません');
    const r = await fetch(c.url.replace(/\/+$/, '') + '/rest/v1/' + path, { method, headers: Object.assign({ apikey: c.key, 'Content-Type': 'application/json' }, /^sb_/.test(c.key) ? {} : { Authorization: 'Bearer ' + c.key }, prefer ? { Prefer: prefer } : {}), body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
    if (!r.ok) { const e = new Error((j && (j.message || j.hint)) || ('Supabase ' + r.status)); e.status = r.status; e.code = j && j.code; throw e; }
    return j;
  }
  /** つながっているか・表があるか */
  async function status(c) {
    const given = !!c; c = c || await cfg(); if (!c) return { connected: false, tables: {} };
    const tables = {}; let err = '';
    for (const t of TABLES) { try { await rest('GET', t + '?select=*&limit=1', null, null, c); tables[t] = true; } catch (e) { tables[t] = false; if (!(e.code === 'PGRST205' || e.status === 404)) err = e.message; } }
    for (const t of TEAM_TABLES.concat(ERR_TABLES)) { try { await rest('GET', t + '?select=*&limit=1', null, null, c); tables[t] = true; } catch (e) { tables[t] = false; } }
    let teamReady = TEAM_TABLES.every(t => tables[t]); if (teamReady) { try { await rest('GET', 'ai_cost_log?select=run_id,agent,model&limit=1', null, null, c); } catch (e) { teamReady = false; } }   /* ai_cost_log の新しい列も */
    const rd = !err && TABLES.every(t => tables[t]); if (!given) readyCache = { v: rd, until: Date.now() + (rd ? 5 * 60 * 1000 : 20 * 1000) };   /* 保存済みの接続先で確かめたときは覚え直す */
    return { connected: !err, error: err, url: c.url, tables, ready: rd, teamReady, errReady: ERR_TABLES.every(t => tables[t]) };
  }
  /* 準備できているかは、できていれば5分・できていなければ20秒だけ覚える（表を作った直後にすぐ使えるように。2026-11-05） */
  async function ready() { if (readyCache && readyCache.until > Date.now()) return readyCache.v; let v = false; try { v = (await status()).ready; } catch (e) { v = false; } readyCache = { v, until: Date.now() + (v ? 5 * 60 * 1000 : 20 * 1000) }; return v; }
  const upsert = (table, rows, conflict) => rows.length ? rest('POST', table + (conflict ? '?on_conflict=' + conflict : ''), rows, 'resolution=merge-duplicates,return=minimal') : null;
  /** 毎日の写し：BigQuery（原本）→ Supabase（まとめの写し） */
  async function copyDaily() {
    if (!(await ready())) return { ok: false, skipped: 'Supabase がまだ準備できていません' };
    const now = new Date().toISOString();
    let preds = []; try { preds = await query(`SELECT snapshot_ym, media, scenario, ym, metric, value FROM ${T('sim_predictions')} QUALIFY ROW_NUMBER() OVER (PARTITION BY snapshot_ym, media, scenario, ym, metric ORDER BY saved_at DESC) = 1`); } catch (e) { preds = []; }
    const ga = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, SUM(pageviews) pv, SUM(sessions) sessions, SUM(key_events) cv FROM ${T('ga4_monthly')} WHERE IFNULL(block, '') = '' AND month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 14 MONTH) GROUP BY ym, media`);
    const sc = await query(`SELECT FORMAT_DATE('%Y-%m', date) ym, media, SUM(impressions) imp, SUM(clicks) clicks FROM ${T('sc_daily')} WHERE IFNULL(block, '') = '' AND date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 14 MONTH) GROUP BY ym, media`);
    const act = {}; ga.forEach(r => { act[r.ym + '|' + r.media] = { ym: r.ym, media: r.media, pv: Number(r.pv) || 0, sessions: Number(r.sessions) || 0, cv: Number(r.cv) || 0, imp: null, clicks: null, copied_at: now }; });
    sc.forEach(r => { const k = r.ym + '|' + r.media; act[k] = act[k] || { ym: r.ym, media: r.media, pv: null, sessions: null, cv: null, copied_at: now }; act[k].imp = Number(r.imp) || 0; act[k].clicks = Number(r.clicks) || 0; });
    const P = preds.map(r => ({ snapshot_ym: r.snapshot_ym, media: r.media, scenario: r.scenario, ym: r.ym, metric: r.metric, value: Number(r.value), copied_at: now }));
    for (let i = 0; i < P.length; i += 2000) await upsert('sim_copy_predictions', P.slice(i, i + 2000), 'snapshot_ym,media,scenario,ym,metric');
    await upsert('sim_copy_actuals', Object.values(act), 'ym,media');
    return { ok: true, predictions: P.length, actuals: Object.keys(act).length, at: now };
  }
  return { cfg, setCfg, rest, status, ready, upsert, copyDaily, SQL, TABLES, TEAM_TABLES, ERR_TABLES };
};
