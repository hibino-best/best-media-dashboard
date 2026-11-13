/**
 * シミュレーション（2026-11-05 ユーザー指定）：計算のもとになる値（前提）を BigQuery から出す。計算そのものは public/sim_model.js（画面）
 *
 * メディアごとに返すもの
 * - curve：新規記事1本あたりの月のPV（公開から何か月目か＝age ごと。P25・P50・P75。季節の影響を除いた値）
 *   元：記事管理（article_items）の記事URL × GA4のページ別の月のPV（ga4_page_monthly。2025-10〜）。PVがない月は0として数える
 * - season：季節の指数（1〜12月。平均1）。元：そのメディアの記事の検索KWの、Ahrefs の月ごとの検索Vol（kw_volume_monthly）の合計
 * - vol：公開済みの記事の検索Volの平均と、まだ公開していない記事の検索Vol（大きい順）。次に書く記事のVolの見込みに使う
 * - rewrite：リライト・簡易リライト1本あたりのPVの増え方（公開の前3か月と後3か月の差の中央値）
 * - aio：Search Console のクリック率の前年比（直近3か月。AIO＝Googleの「AIによる概要」の影響の目安。暫定）
 * 全体で返すもの
 * - costRatio：新規記事に対するリライト・簡易リライトの費用の割合（記事単価の契約の単価から。2026-11-05 ユーザー指定：平均値ではなく比率）
 * 予測の保存（答え合わせ用）：BigQuery sim_predictions（毎月、その月の最初に開いたときに画面から保存。原本は BigQuery だけ）
 */
const PAGE_FROM = '2025-10';   // ga4_page_monthly のいちばん古い月
const pct = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y), i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const ymDiff = (a, b) => { const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number); return (ya - yb) * 12 + (ma - mb); };
const NEW_TYPES = [null, '', '新規', 'リライト(新規)'], RW_TYPES = ['リライト', '簡易リライト'];

module.exports = function sim({ db, query, T, todayJst, allowedMedia, isFullAdmin, supa, capOk, usdJpy }) {
  const simOk = u => capOk ? capOk(u, 'sim_view', x => x.roleEff !== 'resta') : u.roleEff !== 'resta';   /* 権限管理の sim_view（2026-11-06） */
  const aiOk = u => capOk ? capOk(u, 'ai_tools', () => false) : isFullAdmin(u);
  let cache = null;
  async function base() {
    if (cache && cache.until > Date.now()) return cache.value;
    const cur = todayJst().slice(0, 7), lastFull = ymAdd(cur, -1);
    const path = c => `REGEXP_REPLACE(REGEXP_EXTRACT(${c}, r'https?://[^/]+(/[^?#]*)'), r'/$', '')`;
    const [arts, pvs, seas, vols, sc, kwh] = await Promise.all([
      query(`SELECT media, ${path('url')} p, FORMAT_DATE('%Y-%m', upload_date) um, type FROM ${T('article_items')} WHERE url LIKE 'http%' AND upload_date IS NOT NULL`),
      query(`SELECT media, REGEXP_REPLACE(page_path, r'/$', '') p, FORMAT_DATE('%Y-%m', month) ym, SUM(pageviews) pv FROM ${T('ga4_page_monthly')} GROUP BY 1, 2, 3`),
      query(`SELECT media, FORMAT_DATE('%Y-%m', month) ym, SUM(pageviews) pv FROM ${T('ga4_monthly')} WHERE channel = '(all)' GROUP BY 1, 2`).catch(() => []),
      query(`WITH v AS (SELECT kw_norm, SAFE_CAST(avg_monthly AS FLOAT64) av FROM ${T('kw_volume_monthly')} QUALIFY ROW_NUMBER() OVER (PARTITION BY kw_norm ORDER BY month DESC, fetched_at DESC) = 1)
             SELECT a.media, COALESCE(v.av, a.vol_avg) v, a.upload_date IS NOT NULL done FROM ${T('article_items')} a LEFT JOIN v ON v.kw_norm = LOWER(TRIM(REGEXP_REPLACE(NORMALIZE(a.kw, NFKC), r'\\s+', ' ')))
             WHERE (a.type IS NULL OR a.type NOT IN ('リライト', '簡易リライト')) AND COALESCE(v.av, a.vol_avg) > 0`).catch(() => []),
      query(`SELECT media, FORMAT_DATE('%Y-%m', date) ym, SUM(clicks) c, SUM(impressions) i FROM ${T('sc_daily')} WHERE block IS NULL OR block = '' GROUP BY 1, 2`).catch(() => []),
      /* 代表KWの月ごとの検索Vol（Ahrefs volume-history。kw_volume_history）× 記事の検索KW（メディア・ディレクトリ）（2026-11-05 ユーザー指定） */
      query(`WITH a AS (SELECT DISTINCT media, IFNULL(sub, '') sub, LOWER(TRIM(REGEXP_REPLACE(NORMALIZE(kw, NFKC), r'\\s+', ' '))) k FROM ${T('article_items')} WHERE kw IS NOT NULL AND TRIM(kw) != ''),
             h AS (SELECT kw_norm, month, volume FROM ${T('kw_volume_history')} WHERE month < DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH) QUALIFY ROW_NUMBER() OVER (PARTITION BY kw_norm, month ORDER BY fetched_at DESC) = 1)
             SELECT a.media, a.sub, h.kw_norm k, FORMAT_DATE('%Y-%m', h.month) ym, h.volume v FROM a JOIN h ON h.kw_norm = a.k`).catch(() => []),
    ]);
    const out = {};
    const M = m => (out[m] = out[m] || { media: m });
    // 季節の指数
    /* 季節の指数：Ahrefs は今は12か月平均しかないので、そのメディアの GA4 の月のPVから出す（前後12か月の移動平均との比を月ごとに中央値。25か月以上あるメディアだけ。2026-11-05） */
    const sBy = {}; seas.forEach(r => { if (r.ym <= lastFull) (sBy[r.media] = sBy[r.media] || {})[r.ym] = Number(r.pv) || 0; });
    Object.entries(sBy).forEach(([m, o]) => {
      const yms = Object.keys(o).sort(); if (yms.length < 25) { M(m).seasonNote = 'GA4のデータが' + yms.length + 'か月分のため季節の指数なし'; return; }
      const ratios = {};
      for (let i = 6; i < yms.length - 6; i++) { const w = yms.slice(i - 6, i + 7), ma = (w.slice(0, 12).reduce((a, k) => a + o[k], 0) + w.slice(1).reduce((a, k) => a + o[k], 0)) / 24; if (ma > 0 && o[yms[i]] > 0) (ratios[Number(yms[i].slice(5))] = ratios[Number(yms[i].slice(5))] || []).push(o[yms[i]] / ma); }
      if (Object.keys(ratios).length < 12) { M(m).seasonNote = '季節の指数を出せる月が足りません'; return; }
      const raw = Array.from({ length: 12 }, (_, i) => pct(ratios[i + 1], .5)), avg = raw.reduce((a, v) => a + v, 0) / 12;
      M(m).season = raw.map(v => Math.round(v / avg * 1000) / 1000); M(m).seasonNote = 'GA4の' + yms.length + 'か月分から';
    });
    /* 季節の指数（KWから。2026-11-05 ユーザー指定：軸のKWから出す）：代表KWごとに月の検索Vol÷そのKWの平均 → KWの平均Volの平方根で重みをつけて平均 → 同じ月（1〜12月）の年ごとの値の中央値 → 平均1にそろえる。
       メディア全体と、ディレクトリ（KWが3つ以上あるとき）ごと。GA4から出した指数は参考（seasonGa4）として残す */
    const kwSeason = list => {
      const byK = {}; list.forEach(r => { (byK[r.k] = byK[r.k] || {})[r.ym] = Number(r.v) || 0; });
      const ks = Object.keys(byK); if (ks.length < 3) return null;
      /* 一時的な急増（ニュースなど。例：クマネズミの5月）は除く：そのKWのいつもの値（中央値）の4倍を超える月・4分の1未満の月は使わない（2026-11-05 ユーザー指摘） */
      const acc = {}; ks.forEach(k => { const all = Object.values(byK[k]), med = pct(all, .5); if (!(med > 0)) return; const keep = Object.entries(byK[k]).filter(([, v]) => v <= med * 4 && v >= med / 4); if (!keep.length) return; const mean = keep.reduce((a, [, v]) => a + v, 0) / keep.length, w = Math.sqrt(mean); keep.forEach(([ym, v]) => { const o = (acc[ym] = acc[ym] || { s: 0, w: 0 }); o.s += w * v / mean; o.w += w; }); });
      const byM = {}; Object.entries(acc).forEach(([ym, o]) => { if (o.w > 0) (byM[Number(ym.slice(5))] = byM[Number(ym.slice(5))] || []).push(o.s / o.w); });
      if (Object.keys(byM).length < 12) return null;
      const raw = Array.from({ length: 12 }, (_, i) => pct(byM[i + 1], .5)), avg = raw.reduce((a, v) => a + v, 0) / 12;
      return { season: raw.map(v => Math.round(v / avg * 1000) / 1000), kws: ks.length };
    };
    const kwBy = {}; kwh.forEach(r => { (kwBy[r.media] = kwBy[r.media] || []).push(r); });
    Object.entries(kwBy).forEach(([m, list]) => {
      const all = kwSeason(list); if (all) { const o = M(m); if (o.season) o.seasonGa4 = o.season; o.season = all.season; o.seasonNote = '代表KW ' + all.kws + '個の月ごとの検索Vol（Ahrefs）から'; }
      const subs = [...new Set(list.map(r => r.sub).filter(Boolean))], dir = {};
      subs.forEach(sb => { const s = kwSeason(list.filter(r => r.sub === sb)); if (s) dir[sb] = { season: s.season, kws: s.kws }; });
      if (Object.keys(dir).length) M(m).seasonDir = dir;
    });
    const seasonOf = (m, ym) => { const s = (out[m] || {}).season; return s ? s[Number(ym.slice(5)) - 1] : 1; };
    // 記事ごとの月のPV
    const pvBy = {}; pvs.forEach(r => { pvBy[r.media + '|' + r.p + '|' + r.ym] = Number(r.pv) || 0; });
    const pages = new Set(pvs.map(r => r.media + '|' + r.p));
    const curveRaw = {}, rwUp = {};
    arts.forEach(a => {
      if (!a.p || !pages.has(a.media + '|' + a.p)) return;
      const isNew = NEW_TYPES.includes(a.type == null ? null : String(a.type)), isRw = RW_TYPES.includes(String(a.type || ''));
      if (isNew) for (let ym = a.um < PAGE_FROM ? PAGE_FROM : a.um; ym <= lastFull; ym = ymAdd(ym, 1)) {
        const age = ymDiff(ym, a.um); if (age > 24) continue;
        const v = (pvBy[a.media + '|' + a.p + '|' + ym] || 0) / seasonOf(a.media, ym);
        ((curveRaw[a.media] = curveRaw[a.media] || {})[age] = curveRaw[a.media][age] || []).push(v);
      }
      if (isRw && ymAdd(a.um, -3) >= PAGE_FROM && ymAdd(a.um, 3) <= lastFull) {
        const avg = ks => ks.reduce((s, k) => s + (pvBy[a.media + '|' + a.p + '|' + ymAdd(a.um, k)] || 0) / seasonOf(a.media, ymAdd(a.um, k)), 0) / ks.length;
        ((rwUp[a.media] = rwUp[a.media] || {})[a.type] = rwUp[a.media][a.type] || []).push(avg([1, 2, 3]) - avg([-3, -2, -1]));
      }
    });
    const allCurve = {};
    Object.entries(curveRaw).forEach(([m, byAge]) => {
      const c = {}; Object.entries(byAge).forEach(([age, arr]) => { (allCurve[age] = allCurve[age] || []).push(...arr); if (arr.length >= 5) c[age] = { n: arr.length, p25: pct(arr, .25), p50: pct(arr, .5), p75: pct(arr, .75) }; });
      M(m).curve = c;
    });
    const allC = {}; Object.entries(allCurve).forEach(([age, arr]) => { if (arr.length >= 5) allC[age] = { n: arr.length, p25: pct(arr, .25), p50: pct(arr, .5), p75: pct(arr, .75) }; });
    const rwAll = {}; Object.values(rwUp).forEach(o => Object.entries(o).forEach(([t, arr]) => (rwAll[t] = rwAll[t] || []).push(...arr)));   /* 実績が少ないメディアは全メディアの値 */
    Object.entries(rwUp).forEach(([m, o]) => { M(m).rewrite = Object.fromEntries(Object.entries(o).map(([t, arr]) => [t, { n: arr.length, p50: pct(arr, .5) }])); });
    // 検索Vol
    const vBy = {}; vols.forEach(r => { const o = (vBy[r.media] = vBy[r.media] || { done: [], todo: [] }); (r.done === true || r.done === 'true' ? o.done : o.todo).push(Number(r.v)); });
    Object.entries(vBy).forEach(([m, o]) => { M(m).vol = { doneAvg: o.done.length ? o.done.reduce((a, v) => a + v, 0) / o.done.length : null, doneMed: pct(o.done, .5), doneN: o.done.length, todo: o.todo.sort((a, b) => b - a).slice(0, 600) }; });
    // AIO の目安：直近3か月のクリック率 ÷ 前の年の同じ月
    const scBy = {}; sc.forEach(r => { (scBy[r.media] = scBy[r.media] || {})[r.ym] = { c: Number(r.c) || 0, i: Number(r.i) || 0 }; });
    /* メディアごとのクリック率は掲載順位の変化で大きくぶれるので、全メディアの合計の比を初期値にする（メディアごとは参考）（2026-11-05） */
    const tot = {}; Object.values(scBy).forEach(o => Object.entries(o).forEach(([ym, x]) => { const t = (tot[ym] = tot[ym] || { c: 0, i: 0 }); t.c += x.c; t.i += x.i; }));
    scBy.__all = tot;
    Object.entries(scBy).forEach(([m, o]) => {
      let c1 = 0, i1 = 0, c0 = 0, i0 = 0;
      [1, 2, 3].forEach(k => { const ym = ymAdd(cur, -k), py = ymAdd(ym, -12); if (o[ym] && o[py] && o[py].i > 0) { c1 += o[ym].c; i1 += o[ym].i; c0 += o[py].c; i0 += o[py].i; } });
      if (i1 > 0 && i0 > 0 && c0 > 0) M(m).aio = { ratio: Math.round((c1 / i1) / (c0 / i0) * 1000) / 1000, ctrNow: c1 / i1, ctrPrev: c0 / i0 };
    });
    // 費用の比率：記事単価の契約（新規とリライトの両方がある契約）の単価の比の中央値
    const rw = [], lt = [];
    (await db.collection('contracts').get()).docs.forEach(d => { const p = d.data().pay || {}, n = Number(p.articleNew); if (n > 0) { if (Number(p.articleRewrite) > 0) rw.push(p.articleRewrite / n); if (Number(p.articleLite) > 0) lt.push(p.articleLite / n); } });
    const aioAll = out.__all && out.__all.aio ? out.__all.aio : null; delete out.__all;
    const value = { cur, lastFull, pageFrom: PAGE_FROM, media: out, aioAll, rewriteAll: Object.fromEntries(Object.entries(rwAll).map(([t, arr]) => [t, { n: arr.length, p50: pct(arr, .5) }])), allCurve: allC, costRatio: { rewrite: rw.length ? pct(rw, .5) : 0.58, lite: lt.length ? pct(lt, .5) : 0.31, n: rw.length }, at: new Date().toISOString() };
    cache = { value, until: Date.now() + 30 * 60 * 1000 };
    return value;
  }

  const TBL = 'sim_predictions';
  async function ensureTable() { await query(`CREATE TABLE IF NOT EXISTS ${T(TBL)} (snapshot_ym STRING, media STRING, scenario STRING, ym STRING, metric STRING, value FLOAT64, saved_at TIMESTAMP, saved_by STRING)`); }

  function routes(api) {
    api.get('/sim/base', async (req, res, next) => {
      try {
        if (!simOk(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        const v = await base(), media = Object.fromEntries(Object.entries(v.media).filter(([m]) => allowedMedia(req.user, m)));
        res.json(Object.assign({}, v, { media }));
      } catch (e) { next(e); }
    });
    // 保存済みの予測（答え合わせ用）
    api.get('/sim/predictions', async (req, res, next) => {
      try {
        if (!simOk(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        let rows = []; try { rows = await query(`SELECT snapshot_ym, media, scenario, ym, metric, value FROM ${T(TBL)} QUALIFY ROW_NUMBER() OVER (PARTITION BY snapshot_ym, media, scenario, ym, metric ORDER BY saved_at DESC) = 1`); } catch (e) { /* まだない */ }
        res.json({ rows: rows.filter(r => allowedMedia(req.user, r.media)) });
      } catch (e) { next(e); }
    });
    // 今月の予測を保存（その月にまだ保存していないメディアだけ。前提は「目標記事数どおり」の初期値）。全メディアが見られる人だけ
    api.post('/sim/predictions', async (req, res, next) => {
      try {
        if (req.user.scope !== 'all' || req.user.roleEff === 'resta') return res.status(403).json({ error: '保存できるのは全メディアが見られる人だけです' });
        const cur = todayJst().slice(0, 7), list = [];
        /* 送られてくる形：{ media, scenario, from: 'YYYY-MM', values: { pv: [12か月], ... } } → 1行ずつに広げる */
        (Array.isArray((req.body || {}).rows) ? req.body.rows : []).slice(0, 100).forEach(x => { if (!x || !/^\d{4}-\d{2}$/.test(String(x.from || ''))) return; Object.entries(x.values || {}).forEach(([k, arr]) => (Array.isArray(arr) ? arr : []).slice(0, 24).forEach((v, i) => { if (v != null) list.push({ media: x.media, scenario: x.scenario, ym: ymAdd(x.from, i), metric: k, value: v }); })); });
        await ensureTable();
        const have = new Set((await query(`SELECT DISTINCT media FROM ${T(TBL)} WHERE snapshot_ym = @s`, { s: cur })).map(r => r.media));
        const rows = list.filter(r => r && typeof r.media === 'string' && !have.has(r.media) && ['ideal', 'real', 'pess'].includes(r.scenario) && /^\d{4}-\d{2}$/.test(r.ym) && r.ym >= cur && typeof r.metric === 'string' && Number.isFinite(Number(r.value))).slice(0, 30000);   /* 項目を増やしたので上限を上げた（2026-11-05） */
        if (!rows.length) return res.json({ ok: true, saved: 0, already: [...have] });
        for (let i = 0; i < rows.length; i += 500) {
          const part = rows.slice(i, i + 500), params = { s: cur, by: req.user.email || '' };
          const vals = part.map((r, j) => { params['m' + j] = r.media.slice(0, 60); params['c' + j] = r.scenario; params['y' + j] = r.ym; params['k' + j] = r.metric.slice(0, 30); params['v' + j] = Number(r.value); return `(@s, @m${j}, @c${j}, @y${j}, @k${j}, @v${j}, CURRENT_TIMESTAMP(), @by)`; }).join(', ');
          await query(`INSERT INTO ${T(TBL)} (snapshot_ym, media, scenario, ym, metric, value, saved_at, saved_by) VALUES ${vals}`, params);
        }
        res.json({ ok: true, saved: rows.length, medias: [...new Set(rows.map(r => r.media))] });
      } catch (e) { next(e); }
    });
    /* 答え合わせの結果（2026-11-05 ユーザー指定：毎月5日に前月分）。画面（管理者）が計算した表を Firestore sim_checks/{対象月} に保存し、
       5日のタスク（タスクスケジューラー＋claude -p の sim-checker）がそれを読んでAIの見直しを ai に書く。画面は ai があればAIの答えを出す */
    const isYm = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
    api.get('/sim/checks', async (req, res, next) => {
      try {
        if (!aiOk(req.user) && !simOk(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        /* Supabase（AIの作業机）がつながっていればそこから。表・AIの提案（AIごとに最新）・あなたの判断。まだなら Firestore（2026-11-05） */
        const useSb = supa && await supa.ready();
        let checks;
        if (useSb) {
          const [cs, rv, dc] = await Promise.all([supa.rest('GET', 'sim_checks?select=*&order=ym.desc&limit=60'), supa.rest('GET', 'sim_ai_reviews?select=*&order=at.desc&limit=300'), supa.rest('GET', 'sim_decisions?select=*&order=at.desc&limit=1000')]);
          checks = cs.map(c => { const revs = rv.filter(r => r.ym === c.ym), ai = revs[0] ? { by: revs[0].ai, at: revs[0].at, summary: revs[0].summary, media: revs[0].media || {} } : null;
            return { ym: c.ym, rows: c.rows || [], at: c.at, by: c.saved_by, ai, reviews: revs.map(r => ({ ai: r.ai, at: r.at })), decisions: dc.filter(d => d.ym === c.ym).map(d => ({ media: d.media, decision: d.decision, reason: d.reason, ai: d.ai, by: d.decided_by, at: d.at })) }; });
        } else { const snap = await db.collection('sim_checks').get(); checks = snap.docs.map(d => Object.assign({ ym: d.id }, d.data())); }
        res.json({ store: useSb ? 'supabase' : 'firestore', checks: checks.map(c => Object.assign(c, { rows: (c.rows || []).filter(r => allowedMedia(req.user, r.media)), decisions: (c.decisions || []).filter(d => allowedMedia(req.user, d.media)) })) });
      } catch (e) { next(e); }
    });
    api.put('/sim/checks/:ym', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが保存できます' });
        const ym = req.params.ym; if (!isYm(ym)) return res.status(400).json({ error: '月の形が違います' });
        if (todayJst() < (() => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7) + '-05'; })()) return res.status(400).json({ error: '答え合わせは翌月5日からです' });
        const num = v => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
        const rows = (Array.isArray((req.body || {}).rows) ? req.body.rows : []).slice(0, 50).map(r => ({
          media: String(r.media || '').slice(0, 60), name: String(r.name || '').slice(0, 60), cause: String(r.cause || '').slice(0, 30), fix: String(r.fix || '').slice(0, 400), revR: num(r.revR),
          els: (Array.isArray(r.els) ? r.els : []).slice(0, 10).map(e => ({ k: String(e.k || '').slice(0, 20), pred: num(e.pred), act: num(e.act), r: num(e.r), skip: !!e.skip, off: !!e.off }))
        })).filter(r => r.media);
        /* 一度保存した月は上書きしない（AIの見直しと食い違わないように）。Supabase がつながっていればそこへ（2026-11-05） */
        if (supa && await supa.ready()) {
          const cur = await supa.rest('GET', 'sim_checks?select=ym&ym=eq.' + ym);
          if (cur.length && !(req.body || {}).force) return res.json({ ok: true, already: true });
          await supa.upsert('sim_checks', [{ ym, rows, at: new Date().toISOString(), saved_by: req.user.email || '' }], 'ym');
          return res.json({ ok: true, saved: rows.length, store: 'supabase' });
        }
        const ref = db.collection('sim_checks').doc(ym), cur = await ref.get();
        if (cur.exists && !(req.body || {}).force) return res.json({ ok: true, already: true });
        await ref.set({ rows, at: new Date().toISOString(), by: req.user.email || '' }, { merge: true });
        res.json({ ok: true, saved: rows.length, store: 'firestore' });
      } catch (e) { next(e); }
    });
    /* あなたの判断（内ループ）：AIの調整案に OK／却下 と理由を残す。Supabase sim_decisions（2026-11-05 ユーザー指定：設計図の「判断と理由」） */
    api.post('/sim/decisions', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが判断できます' });
        if (!(supa && await supa.ready())) return res.status(400).json({ error: 'Supabase（AIの作業机）がまだつながっていません。API・連携設定でつないでください' });
        const b = req.body || {}, ym = String(b.ym || ''), media = String(b.media || '').slice(0, 60), decision = b.decision === 'ok' ? 'ok' : b.decision === 'ng' ? 'ng' : '';
        if (!isYm(ym) || !media || !decision) return res.status(400).json({ error: '月・メディア・判断を入れてください' });
        await supa.rest('POST', 'sim_decisions', [{ ym, media, decision, ai: String(b.ai || '').slice(0, 60), proposal: String(b.proposal || '').slice(0, 800), reason: String(b.reason || '').slice(0, 800), decided_by: req.user.email || '' }], 'return=minimal');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    /* ===== AIチーム（2026-11-06 ユーザー指定） =====
       ・だれ（どのエージェント・サブエージェント）が動いているか、月ごとのトークン量・費用・モデル、Supabase でだれが何を読んだか
       ・ポジションと読める範囲は webapp/ai_team.json（上限＝ceiling）。いまの範囲（scope）とモデルは Supabase ai_agents（指揮官が上限の中で調整）
       ・Gemini・OpenAI のキーは Secret Manager「ai_loop_keys」（このループ専用のキー。画面から入れる。チャットには出さない） */
    const TEAM = require('./ai_team.json').agents;
    const teamReady = async () => { if (!(supa && await supa.ready())) return false; try { await supa.rest('GET', 'ai_runs?select=run_id&limit=1'); await supa.rest('GET', 'ai_cost_log?select=run_id,agent,model&limit=1'); return true; } catch (e) { return false; } };
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const sm = new SecretManagerServiceClient(), KEYS = `projects/bestmedia-510909/secrets/ai_loop_keys`;
    async function loopKeys() { try { const [x] = await sm.accessSecretVersion({ name: KEYS + '/versions/latest' }); return JSON.parse(x.payload.data.toString('utf8')) || {}; } catch (e) { return {}; } }
    async function setLoopKeys(v) {
      try { await sm.getSecret({ name: KEYS }); } catch (e) { if (e.code !== 5) throw e; await sm.createSecret({ parent: 'projects/bestmedia-510909', secretId: 'ai_loop_keys', secret: { replication: { automatic: {} } } }); }
      await sm.addSecretVersion({ parent: KEYS, payload: { data: Buffer.from(JSON.stringify(v), 'utf8') } });
    }
    /** キーで実際にモデルの一覧が読めるか（保存の前に確かめる） */
    async function testKey(provider, key) {
      const r = provider === 'gemini' ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) })
        : await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('このキーでは使えませんでした（' + r.status + '：' + String((j.error && (j.error.message || j.error.status)) || '').slice(0, 120) + '）');
      return provider === 'gemini' ? (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name || '').replace(/^models\//, ''))
        : (j.data || []).map(m => m.id).filter(id => /^(gpt|o\d)/.test(id));
    }
    api.get('/sim/ai-team', async (req, res, next) => {
      try {
        if (!aiOk(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        res.set('Cache-Control', 'no-store');
        const keys = await loopKeys(), ready = await teamReady();
        let saved = [], runs = [], cost = [], access = [];
        if (ready) {
          saved = await supa.rest('GET', 'ai_agents?select=*');
          const miss = TEAM.filter(a => !saved.some(s => s.id === a.id));   /* はじめは上限＝いまの範囲 */
          if (miss.length) { await supa.upsert('ai_agents', miss.map(a => ({ id: a.id, char: a.char, position: a.position, provider: a.provider, kind: a.kind, parent: a.parent, model: a.model, scope: a.ceiling, active: true, updated_by: 'system' })), 'id'); saved = await supa.rest('GET', 'ai_agents?select=*'); }
          [runs, cost, access] = await Promise.all([supa.rest('GET', 'ai_runs?select=*&order=started_at.desc&limit=60'), supa.rest('GET', 'ai_cost_log?select=*&order=at.desc&limit=2000'), supa.rest('GET', 'ai_access_log?select=*&order=at.desc&limit=500')]);
        }
        const agents = TEAM.map(a => { const s = saved.find(x => x.id === a.id) || {}; return Object.assign({}, a, { model: s.model || a.model, scope: s.scope && Object.keys(s.scope).length ? s.scope : a.ceiling, active: s.active !== false, updatedBy: s.updated_by || '', updatedAt: s.updated_at || null,
          connected: a.provider === 'claude' ? true : !!(keys[a.provider] && keys[a.provider].key) }); });
        /* 円に換算（その月の月末のレート。今月は最新）。ドルは括弧で添える（2026-10-29 ユーザー指定） */
        const fx = {}; for (const m of [...new Set(cost.map(r => String(r.at || '').slice(0, 7)).filter(Boolean))]) { try { fx[m] = (await usdJpy(m)).rate; } catch (e) { /* なし */ } }
        res.json({ fx, teamReady: ready, store: supa && await supa.ready() ? 'supabase' : 'firestore', agents, runs, cost, access, models: Object.fromEntries(['gemini', 'openai'].map(p => [p, (keys[p] && keys[p].models) || []])), chat: !!(keys.chat && keys.chat.url), canEdit: isFullAdmin(req.user) });
      } catch (e) { next(e); }
    });
    /* キーの保存（フル管理者だけ）。キーは返さない */
    api.put('/sim/ai-keys/:provider', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが設定できます' });
        const p = req.params.provider; if (!['gemini', 'openai'].includes(p)) return res.status(400).json({ error: 'AIの種類が違います' });
        const key = String((req.body || {}).key || '').trim(); if (key.length < 20 || /\s/.test(key)) return res.status(400).json({ error: 'キーの形が違います' });
        const models = await testKey(p, key).catch(e => { e.status = 400; throw e; });
        const cur = await loopKeys(); cur[p] = { key, models: models.slice(0, 120), at: new Date().toISOString(), by: req.user.email || '' };
        await setLoopKeys(cur);
        res.json({ ok: true, models: cur[p].models });
      } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); next(e); }
    });
    /* Google Chat のスペースへの通知（2026-11-06 ユーザー指定）：Webhook を保存する前に、キングぷるるからテストを1通送って確かめる。空で送ると止める */
    api.put('/sim/ai-chat', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが設定できます' });
        const chat = require('./ai_chat'), url = String((req.body || {}).url || '').trim(), cur = await loopKeys();
        if (!url) { delete cur.chat; await setLoopKeys(cur); return res.json({ ok: true, off: true }); }
        if (!chat.isWebhook(url)) return res.status(400).json({ error: 'Webhook の URL の形が違います（https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=… をそのまま貼ってください）' });
        const lead = TEAM.find(a => a.kind === 'agent');
        try { await chat.post(url, lead, '<b>つながりました！</b><br>答え合わせのたびに、このスペースへ、キャラごとに何をしたかをお知らせします。', { link: chat.TEAMDEF.dashboardUrl }); } catch (e) { return res.status(400).json({ error: e.message }); }
        cur.chat = { url, at: new Date().toISOString(), by: req.user.email || '' }; await setLoopKeys(cur);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    /* モデルの変更（フル管理者だけ）。読める範囲は指揮官が上限の中で調整する（画面では変えない） */
    api.put('/sim/ai-agents/:id', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが設定できます' });
        const a = TEAM.find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: '見つかりません' });
        if (!(await teamReady())) return res.status(400).json({ error: 'Supabase に AIチームの表がまだありません（API・連携設定の Supabase で SQL を実行してください）' });
        const model = String((req.body || {}).model || '').trim().slice(0, 80); if (!/^[\w.\-:]+$/.test(model)) return res.status(400).json({ error: 'モデル名の形が違います' });
        await supa.upsert('ai_agents', [{ id: a.id, model, updated_at: new Date().toISOString(), updated_by: req.user.email || '' }], 'id');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes, base };
};
