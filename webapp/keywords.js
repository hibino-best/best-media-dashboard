/**
 * 検索Vol（Ahrefs Keywords Explorer）
 *
 * - 記事管理の検索KWについて、Ahrefs の「直近12か月の平均検索数（volume・日本）」を取得
 *   （2026-10-13 ユーザー指定：Google広告の基本アクセスが承認されなかったため Ahrefs に切り替え。表示は直近12か月の平均）
 * - 取得するたびに BigQuery kw_volume_monthly に追記する（毎月の値をためて、今後の推移を残す）
 * - Rank Tracker に登録済みのKWは、毎月の順位取得（kw_rank_monthly）で検索Volも取れているので、ここでは取らない（ユニットの節約）
 * - API units：1KWにつき10ユニット（1回の呼び出しは最低50ユニット）。残りのユニットは limits-and-usage（無料）で確認する
 * - 毎月の自動取得は「有効」にしたときだけ動く（2026-10-13 ユーザー指定：Ahrefs のプラン変更まで止めておく）
 * - APIキーは Ahrefs（KW追従）と同じもの（Secret Manager：ahrefs-api-key）
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const BASE = 'https://api.ahrefs.com/v3/';
const SECRET_ID = 'ahrefs-api-key';
const UNITS_PER_KW = 10, MIN_UNITS = 50, BATCH = 50;
const normKw = s => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
// 照合用：見えない文字と空白をすべて除く（Ahrefs 側で空白の入れ方が変わることがあるため）
const looseKw = s => normKw(String(s || '').replace(/[​-‍⁠﻿]/g, '')).replace(/\s+/g, '');

module.exports = function keywords({ PROJECT, db, query, T, admin }) {
  const sm = new SecretManagerServiceClient();
  const settingsRef = db.collection('settings').doc('kw_volume');
  const ahrefsRef = db.collection('settings').doc('ahrefs');
  const secretName = `projects/${PROJECT}/secrets/${SECRET_ID}`;

  async function getSettings() { const s = await settingsRef.get(); return s.exists ? s.data() : {}; }
  async function loadKey() {
    const [v] = await sm.accessSecretVersion({ name: secretName + '/versions/latest' });
    return v.payload.data.toString('utf8').trim();
  }
  async function call(key, path, params) {
    const qs = new URLSearchParams(Object.assign({ output: 'json' }, params || {}));
    const res = await fetch(BASE + path + '?' + qs, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => { try { return JSON.parse(text).error; } catch (e) { return text.slice(0, 200); } })();
      throw new Error(res.status === 401 ? 'AhrefsのAPIキーが正しくありません（401）' : res.status === 403 ? '今のAhrefsのプランではキーワード調査のAPIが使えないか、ユニットが足りません（403）：' + msg : res.status === 429 ? '呼び出しが多すぎます（429）。時間をおいてもう一度' : 'Ahrefs API エラー（' + res.status + '）：' + msg);
    }
    return text ? JSON.parse(text) : {};
  }
  /** 残りのユニット（この呼び出しはユニットを消費しない） */
  async function units(key) {
    const u = (await call(key, 'subscription-info/limits-and-usage', {})).limits_and_usage || {};
    const used = u.units_usage_workspace, limit = u.units_limit_workspace;
    return { used: used == null ? null : Number(used), limit: limit == null ? null : Number(limit), left: used == null || limit == null ? null : Number(limit) - Number(used), resetDate: u.usage_reset_date || null, plan: u.subscription || null };
  }

  let tableReady = false;
  async function ensureTable() {
    if (tableReady) return;
    await query(`CREATE TABLE IF NOT EXISTS ${T('kw_volume_monthly')} (fetched_at TIMESTAMP, kw STRING, kw_norm STRING, month DATE, searches INT64, avg_monthly INT64, source STRING) PARTITION BY DATE(fetched_at) CLUSTER BY kw_norm`);
    await query(`ALTER TABLE ${T('kw_volume_monthly')} ADD COLUMN IF NOT EXISTS source STRING`);
    tableReady = true;
  }
  async function jobLog(status, message) {
    await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), '検索Vol', '全メディア', NULL, NULL, @status, @message)`,
      { status, message: String(message).slice(0, 1000) }).catch(e => console.warn('job_log: ' + e.message));
  }

  /** 記事管理にある検索KW（取り込み分＋ダッシュボードで追加・修正した分） */
  async function allKeywords() {
    const out = new Map();
    const add = k => { const n = normKw(k); if (n && n.length <= 80 && n.split(' ').length <= 10 && !out.has(n)) out.set(n, String(k).normalize('NFKC').replace(/\s+/g, ' ').trim()); };
    try { (await query(`SELECT DISTINCT kw FROM ${T('article_items')} WHERE kw IS NOT NULL AND kw != ''`)).forEach(r => add(r.kw)); } catch (e) { console.warn('article_items: ' + e.message); }
    const [en, ov] = await Promise.all([db.collection('article_entries').get(), db.collection('article_overrides').get()]);
    en.docs.forEach(d => add(d.data().kw)); ov.docs.forEach(d => add(d.data().f_kw));
    return out;
  }
  /** Rank Tracker の順位取得で検索Volが取れているKW（照合用のキー） */
  async function trackedKeywords() {
    try { return new Set((await query(`SELECT DISTINCT keyword FROM ${T('kw_rank_monthly')} WHERE volume IS NOT NULL`)).map(r => looseKw(r.keyword))); }
    catch (e) { return new Set(); }   // まだ表がない
  }
  /** 取得の対象：記事のKWのうち、Rank Tracker で取れていないもの */
  async function targets() {
    const [kws, tracked] = await Promise.all([allKeywords(), trackedKeywords()]);
    const list = [...kws.values()].filter(k => !tracked.has(looseKw(k)));
    return { list, total: kws.size, tracked: kws.size - list.length };
  }
  /** 使うユニットの目安：1回（最大50KW）ごとに 10ユニット×KW数、ただし最低50ユニット */
  const estimate = n => { let u = 0; for (let i = 0; i < n; i += BATCH) u += Math.max(MIN_UNITS, Math.min(BATCH, n - i) * UNITS_PER_KW); return u; };

  /**
   * 取得して保存する
   * @param {{limit?: number, scheduled?: boolean}} opts limit：お試しで取るKWの数、scheduled：毎月の自動実行
   */
  async function collect(opts = {}) {
    const s = await getSettings();
    if (opts.scheduled && !s.enabled) return { ok: true, message: '毎月の自動取得は停止中のため、取得しませんでした' };
    const label = opts.limit ? 'お試し（' + opts.limit + 'KW）' : '全KW';
    try {
      const a = await ahrefsRef.get();
      if (!(a.exists && a.data().hasKey)) throw new Error('AhrefsのAPIキーが未設定です（API・連携設定 → Ahrefs）');
      await ensureTable();
      const key = await loadKey();
      const before = await units(key).catch(() => null);
      let { list } = await targets();
      if (opts.limit) list = list.slice(0, opts.limit);
      const now = new Date(Date.now() + 9 * 3600000);
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);   // 前月の値として保存
      const rows = [];
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        const r = await call(key, 'keywords-explorer/overview', { country: 'jp', select: 'keyword,volume', keywords: chunk.join(','), limit: String(chunk.length) });
        (r.keywords || []).forEach(x => { if (x.keyword && x.volume != null) rows.push({ kw: String(x.keyword), kw_norm: normKw(x.keyword), month, avg_monthly: Math.round(Number(x.volume)) }); });
      }
      for (let i = 0; i < rows.length; i += 5000) {
        await query(`INSERT INTO ${T('kw_volume_monthly')} (fetched_at, kw, kw_norm, month, searches, avg_monthly, source)
          SELECT CURRENT_TIMESTAMP(), r.kw, r.kw_norm, DATE(r.month), NULL, r.avg_monthly, 'ahrefs' FROM UNNEST(@rows) r`,
          { rows: rows.slice(i, i + 5000) }, { rows: [{ kw: 'STRING', kw_norm: 'STRING', month: 'STRING', avg_monthly: 'INT64' }] });
      }
      const after = await units(key).catch(() => null);
      const usedNow = before && after && before.used != null && after.used != null ? after.used - before.used : null;
      const msg = label + '：' + list.length + 'KW中 ' + rows.length + 'KWを取得' + (usedNow != null ? '（使ったユニット ' + usedNow.toLocaleString() + '）' : '');
      await settingsRef.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastResult: msg, lastError: null }, { merge: true });
      await jobLog('OK', msg);
      volCache = null;
      return { ok: true, message: msg };
    } catch (e) {
      await settingsRef.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastError: label + '：' + e.message }, { merge: true });
      await jobLog('ERROR', label + '：' + e.message);
      return { ok: false, error: e.message };
    }
  }

  /** KW → 最新の検索Vol（Ahrefs の直近12か月平均）。キーワード調査と Rank Tracker のうち新しい方 */
  let volCache = null;
  async function volumes() {
    if (volCache && volCache.until > Date.now()) return volCache.value;
    const value = new Map();
    const put = (kw, vol, ym) => { const n = looseKw(kw), cur = value.get(n); if (n && vol != null && (!cur || ym > cur.ym)) value.set(n, { vol: Number(vol), ym }); };
    try {
      (await query(`SELECT kw_norm, avg_monthly, FORMAT_DATE('%Y-%m', month) ym FROM ${T('kw_volume_monthly')} WHERE source = 'ahrefs' AND avg_monthly IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY kw_norm ORDER BY month DESC, fetched_at DESC) = 1`)).forEach(r => put(r.kw_norm, r.avg_monthly, r.ym));
    } catch (e) { /* まだ表がない */ }
    try {
      (await query(`SELECT keyword, volume, FORMAT_DATE('%Y-%m', month) ym FROM ${T('kw_rank_monthly')} WHERE volume IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY month DESC, fetched_at DESC) = 1`)).forEach(r => put(r.keyword, Math.round(Number(r.volume)), r.ym));
    } catch (e) { /* まだ表がない */ }
    volCache = { value, until: Date.now() + 10 * 60 * 1000 };
    return value;
  }

  function routes(adminApi) {
    adminApi.get('/kwvol', async (req, res, next) => {
      try {
        const s = await getSettings(), a = await ahrefsRef.get(), hasKey = !!(a.exists && a.data().hasKey);
        const t = await targets();
        let u = null, unitsError = '';
        if (hasKey) { try { u = await units(await loadKey()); } catch (e) { unitsError = e.message; } }
        res.json({ enabled: !!s.enabled, hasKey, total: t.total, tracked: t.tracked, targets: t.list.length, estimate: estimate(t.list.length), units: u, unitsError,
          lastRunAt: s.lastRunAt && s.lastRunAt.toDate ? s.lastRunAt.toDate().toISOString() : null, lastResult: s.lastResult || '', lastError: s.lastError || '' });
      } catch (e) { next(e); }
    });
    adminApi.put('/kwvol', async (req, res, next) => {
      try {
        const enabled = !!(req.body || {}).enabled;
        await settingsRef.set({ enabled, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '検索Volの毎月の自動取得を' + (enabled ? '有効' : '停止') + 'にした', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    adminApi.post('/kwvol/run', async (req, res) => {
      const limit = Number((req.body || {}).limit) || 0;
      res.json(await collect(limit > 0 ? { limit: Math.min(limit, 100) } : {}));
    });
  }

  // 画面側の照合は空白を無視する（looseKw）
  return { routes, collect, volumes, normKw: looseKw };
};
