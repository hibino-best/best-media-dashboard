/**
 * Ahrefs（Rank Tracker）連携：KW追従
 *
 * - 毎週：進行管理で「完了」の記事の検索KWを、メディアごとの Rank Tracker プロジェクトに追加（未登録のKWだけ）
 *   プロジェクトがなければ自動で作る（Management API。API units は消費しない）
 * - 毎月：前月末時点の順位・URL・検索Vol・トラフィックを Rank Tracker から取得して BigQuery kw_rank_monthly に保存
 * - APIキーは Secret Manager（ahrefs-api-key）に保存。画面には表示しない
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const SECRET_ID = 'ahrefs-api-key';
const BASE = 'https://api.ahrefs.com/v3/';
const normKw = s => String(s || '').normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();   // ゼロ幅スペースなど見えない文字は除く
// 照合用：空白をすべて除く（Ahrefs 側で空白の入れ方が変わることがあるため）
const looseKw = s => normKw(s).replace(/\s+/g, '');
// Rank Tracker で追うサイト（メディア → URL）
const SITE_URLS = {
  '生活お助け': 'https://otasuke-honpo.com/', '害獣お助け': 'https://gaijyu.otasuke-honpo.com/', 'ハチお助け': 'https://hachi.otasuke-honpo.com/', '水まわりお助け': 'https://mizu.otasuke-honpo.com/',
  'カギお助け': 'https://kagi.otasuke-honpo.com/', 'ガラスお助け': 'https://glass.otasuke-honpo.com/', '屋根外壁お助け': 'https://roof.otasuke-honpo.com/', 'シロアリお助け': 'https://shiroari.otasuke-honpo.com/',
  'BEST365': 'https://best365.best24.co.jp/', '害虫害獣コンシェルジュ': 'https://gaichugaiju.best24.co.jp/',
};

module.exports = function ahrefs({ PROJECT, db, query, T, admin, doneKeywords, kwArticles, mediaName, allowedMedia , kwVolumes, kwNorm}) {
  const sm = new SecretManagerServiceClient();
  const settingsRef = db.collection('settings').doc('ahrefs');
  const secretName = `projects/${PROJECT}/secrets/${SECRET_ID}`;
  const iso = v => v && v.toDate ? v.toDate().toISOString() : null;

  async function getSettings() { const s = await settingsRef.get(); return s.exists ? s.data() : {}; }
  async function saveKey(key) {
    try { await sm.getSecret({ name: secretName }); } catch (e) {
      if (e.code !== 5) throw e;
      await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: SECRET_ID, secret: { replication: { automatic: {} } } });
    }
    await sm.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(key, 'utf8') } });
  }
  async function loadKey() {
    const [v] = await sm.accessSecretVersion({ name: secretName + '/versions/latest' });
    return v.payload.data.toString('utf8').trim();
  }
  /** Ahrefs API を呼ぶ（エラーは日本語にして投げる） */
  async function call(key, method, path, params, body) {
    const qs = new URLSearchParams(Object.assign({ output: 'json' }, params || {}));
    const res = await fetch(BASE + path + '?' + qs, { method, headers: Object.assign({ Authorization: 'Bearer ' + key, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => { try { return JSON.parse(text).error; } catch (e) { return text.slice(0, 200); } })();
      throw new Error(res.status === 401 ? 'APIキーが正しくありません（401）' : res.status === 403 ? 'このプランではこのAPIが使えないか、権限がありません（403）：' + msg : res.status === 429 ? '呼び出しが多すぎます（429）。時間をおいてもう一度' : 'Ahrefs API エラー（' + res.status + '）：' + msg);
    }
    return text ? JSON.parse(text) : {};
  }
  /** メディアの Rank Tracker プロジェクト（なければ作る） */
  async function ensureProject(key, media, s) {
    const projects = s.projects || {};
    if (projects[media]) return projects[media];
    const url = SITE_URLS[media];
    // 同じURLのプロジェクトがすでにあれば使う
    const list = (await call(key, 'GET', 'management/projects', {})).projects || [];
    const host = new URL(url).host;
    const hit = list.find(p => String(p.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') === host);
    const id = hit ? String(hit.project_id) : String(((await call(key, 'POST', 'management/projects', {}, { project_name: 'BEST ' + mediaName(media), mode: 'prefix', url, protocol: 'both', access: 'shared' })).projects || [])[0].project_id);
    projects[media] = id;
    await settingsRef.set({ projects }, { merge: true });
    s.projects = projects;
    return id;
  }

  /** 毎週：完了した記事のKWのうち、Rank Tracker に入っていないものを追加 */
  async function sync() {
    const s = await getSettings();
    if (!s.hasKey) return { ok: false, error: 'AhrefsのAPIキーが未設定です' };
    const log = [], pending = {}, samples = {};
    let full = false;   // Rank Tracker のKW上限に達した
    const isLimit = e => /limit/i.test(e.message);
    try {
      const key = await loadKey(), byMedia = await doneKeywords();
      for (const media of Object.keys(byMedia).filter(m => SITE_URLS[m])) {
        const uniq = () => new Set(byMedia[media].map(k => normKw(k.kw)).filter(Boolean)).size;
        // 上限に達したあと、まだプロジェクトがないメディアは全部が未登録（プロジェクトがあれば、登録済みとの差を数える）
        if (full && !(s.projects || {})[media]) { pending[media] = uniq(); continue; }
        let pid;
        try { pid = await ensureProject(key, media, s); } catch (e) { if (!isLimit(e)) throw e; full = true; pending[media] = uniq(); continue; }
        const haveList = ((await call(key, 'GET', 'management/project-keywords', { project_id: pid })).keywords || []).map(k => k.keyword);
        const have = new Set(haveList.map(looseKw));
        const seen = new Set(), add = [];
        byMedia[media].forEach(k => { const n = looseKw(k.kw); if (n && !have.has(n) && !seen.has(n)) { seen.add(n); add.push({ keyword: String(k.kw).replace(/[​-‍⁠﻿]/g, '').replace(/　/g, ' ').replace(/\s+/g, ' ').trim(), tags: k.sub ? [String(k.sub).slice(0, 50)] : [] }); } });
        samples[media] = { ahrefs: haveList.slice(0, 5), add: add.slice(0, 5).map(x => x.keyword), registered: haveList.length };   // 照合の確認用
        let added = 0;
        const put = list => call(key, 'PUT', 'management/project-keywords', { project_id: pid }, { keywords: list, locations: [{ country: 'jp' }] });
        for (let i = 0; i < add.length && !full; i += 100) {
          const chunk = add.slice(i, i + 100);
          try { await put(chunk); added += chunk.length; }
          catch (e) {
            if (!isLimit(e)) throw e;
            // 上限：入るところまで1件ずつ入れる
            for (const k of chunk) { try { await put([k]); added++; } catch (e2) { if (!isLimit(e2)) throw e2; full = true; break; } }
          }
        }
        if (add.length - added) pending[media] = add.length - added;
        log.push(mediaName(media) + ' ' + added + '件追加' + (add.length - added ? '・未登録 ' + (add.length - added) + '件' : '') + '（登録済み ' + have.size + '件）');
      }
      const pendTotal = Object.values(pending).reduce((x, y) => x + y, 0);
      const result = (full ? 'Rank Tracker のKW上限に達しました。未登録 ' + pendTotal + '件（' + Object.entries(pending).map(([m, n]) => mediaName(m) + ' ' + n + '件').join('、') + '）。上限を増やすと、次の同期（毎週月曜）で自動で追加します。／' : '') + (log.join('／') || '完了した記事のKWがありません');
      await settingsRef.set({ lastSyncAt: admin.firestore.FieldValue.serverTimestamp(), lastSyncResult: result, lastError: '', limitReached: full, samples: JSON.stringify(samples).slice(0, 5000) }, { merge: true });
      await settingsRef.update({ pending });   // 未登録の件数は毎回まるごと入れ替える
      return { ok: true, result };
    } catch (e) {
      await settingsRef.set({ lastSyncAt: admin.firestore.FieldValue.serverTimestamp(), lastError: 'KWの同期：' + e.message }, { merge: true });
      return { ok: false, error: e.message };
    }
  }

  async function ensureTable() {
    await query(`CREATE TABLE IF NOT EXISTS ${T('kw_rank_monthly')} (month DATE, media STRING, keyword STRING, device STRING, position FLOAT64, url STRING, volume FLOAT64, traffic FLOAT64, kd FLOAT64, tags STRING, fetched_at TIMESTAMP) PARTITION BY month CLUSTER BY media`);
  }
  /** 毎月：前月末時点の順位を取得（ym を渡すとその月） */
  async function fetchMonthly(ym) {
    const s = await getSettings();
    if (!s.hasKey) return { ok: false, error: 'AhrefsのAPIキーが未設定です' };
    try {
      const key = await loadKey();
      const now = new Date(Date.now() + 9 * 3600000);
      const target = ym || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const [y, m] = target.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const date = last < now.toISOString().slice(0, 10) ? last : now.toISOString().slice(0, 10);
      const rows = [], log = [];
      for (const [media, pid] of Object.entries(s.projects || {})) {
        let n = 0;
        for (const device of ['mobile', 'desktop']) {
          const r = await call(key, 'GET', 'rank-tracker/overview', { project_id: pid, device, date, select: 'keyword,position,url,volume,traffic,keyword_difficulty,tags', limit: '10000' });
          const list = Object.values(r).find(Array.isArray) || [];
          list.forEach(x => { rows.push({ month: target + '-01', media, keyword: String(x.keyword || ''), device, position: x.position == null ? null : Number(x.position), url: x.url || null, volume: x.volume == null ? null : Number(x.volume), traffic: x.traffic == null ? null : Number(x.traffic), kd: x.keyword_difficulty == null ? null : Number(x.keyword_difficulty), tags: Array.isArray(x.tags) ? x.tags.join('、') : (x.tags || null) }); n++; });
        }
        log.push(mediaName(media) + ' ' + n + '件');
      }
      await ensureTable();
      if (rows.length) {
        await query(`DELETE FROM ${T('kw_rank_monthly')} WHERE month = DATE(@month)`, { month: target + '-01' });
        for (let i = 0; i < rows.length; i += 5000) {
          await query(`INSERT INTO ${T('kw_rank_monthly')} (month, media, keyword, device, position, url, volume, traffic, kd, tags, fetched_at)
            SELECT DATE(r.month), r.media, r.keyword, r.device, r.position, r.url, r.volume, r.traffic, r.kd, r.tags, CURRENT_TIMESTAMP() FROM UNNEST(@rows) r`,
          { rows: rows.slice(i, i + 5000) }, { rows: [{ month: 'STRING', media: 'STRING', keyword: 'STRING', device: 'STRING', position: 'FLOAT64', url: 'STRING', volume: 'FLOAT64', traffic: 'FLOAT64', kd: 'FLOAT64', tags: 'STRING' }] });
        }
      }
      const result = target.replace('-', '/') + '（' + date + ' 時点）：' + (log.join('／') || 'プロジェクトがありません。先にKWを同期してください');
      await settingsRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp(), lastFetchResult: result, lastError: '' }, { merge: true });
      return { ok: true, result };
    } catch (e) {
      await settingsRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp(), lastError: '順位の取得：' + e.message }, { merge: true });
      return { ok: false, error: e.message };
    }
  }

  function routes(adminApi, api) {
    adminApi.get('/ahrefs', async (req, res, next) => {
      try {
        const s = await getSettings();
        res.json({ hasKey: !!s.hasKey, limitReached: !!s.limitReached, pending: Object.entries(s.pending || {}).map(([media, n]) => ({ media, name: mediaName(media), n })), projects: Object.entries(s.projects || {}).map(([media, id]) => ({ media, name: mediaName(media), id })), lastSyncAt: iso(s.lastSyncAt), lastSyncResult: s.lastSyncResult || '', lastFetchAt: iso(s.lastFetchAt), lastFetchResult: s.lastFetchResult || '', lastError: s.lastError || '' });
      } catch (e) { next(e); }
    });
    adminApi.put('/ahrefs', async (req, res, next) => {
      try {
        const k = String((req.body || {}).apiKey || '').trim();
        if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(k)) return res.status(400).json({ error: 'APIキーの形式が正しくありません' });
        await call(k, 'GET', 'management/projects', {});   // 使えるキーか確かめてから保存
        await saveKey(k);
        await settingsRef.set({ hasKey: true, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastError: '' }, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'AhrefsのAPIキーを保存', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    adminApi.post('/ahrefs/sync', async (req, res) => { res.json(await sync()); });
    adminApi.post('/ahrefs/fetch', async (req, res) => { res.json(await fetchMonthly((req.body || {}).ym)); });
    // KW追従：メディアの直近13か月の順位
    api.get('/kw-rank', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        // メディア累計（サマリの順位分布）：見られるメディアの順位だけ
        if (media === '__all__') {
          let all = [];
          try {
            all = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, keyword, device, position, url, volume, traffic, kd, tags FROM ${T('kw_rank_monthly')}
              WHERE month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 13 MONTH)`);
          } catch (e) { /* まだ表がない */ }
          // 検索Vol：Rank Tracker に値がないKWは、キーワード調査で取った値（kw_volume_monthly）を使う（2026-10-27）
          if (kwVolumes) { const vols = await kwVolumes(); all.forEach(r => { if (r.volume == null) { const v = vols.get(kwNorm(r.keyword)); if (v) r.volume = v.vol; } }); }
          const s0 = await getSettings(), rows0 = all.filter(r => allowedMedia(req.user, r.media));
          if (req.query.full !== '1') return res.json({ rows: rows0, connected: !!s0.hasKey });
          // KW追従のメディア累計：GA4 のページ別と記事情報もメディアごとに
          const medias = [...new Set(rows0.map(r => r.media))];
          let pages0 = [];
          try {
            pages0 = (await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, page_path, SUM(pageviews) pv, SUM(sessions) sessions, SUM(key_events) cv FROM ${T('ga4_page_monthly')}
              WHERE month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 13 MONTH) GROUP BY ym, media, page_path`)).filter(p => medias.includes(p.media));
          } catch (e) { /* まだ表がない */ }
          const arts0 = [];
          for (const m of medias) (await kwArticles(m)).forEach(x => arts0.push(Object.assign({ media: m }, x)));
          return res.json({ rows: rows0, pages: pages0, articles: arts0, connected: !!s0.hasKey, pending: Object.values(s0.pending || {}).reduce((x, y) => x + Number(y || 0), 0) });
        }
        if (!media || !allowedMedia(req.user, media)) return res.status(400).json({ error: 'メディアの指定が正しくありません' });
        let rows = [];
        try {
          rows = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, keyword, device, position, url, volume, traffic, kd, tags FROM ${T('kw_rank_monthly')}
            WHERE media = @media AND month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 13 MONTH) ORDER BY month`, { media });
        } catch (e) { /* まだ表がない */ }
        // 検索Vol：Rank Tracker に値がないKWは、キーワード調査で取った値（kw_volume_monthly）を使う（2026-10-27）
        if (kwVolumes) { const vols = await kwVolumes(); rows.forEach(r => { if (r.volume == null) { const v = vols.get(kwNorm(r.keyword)); if (v) r.volume = v.vol; } }); }
        // GA4 のページ別（記事URLのパスで照合）と、進行管理の記事URL（KW → URL）
        let pages = [];
        try {
          pages = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, page_path, SUM(pageviews) pv, SUM(sessions) sessions, SUM(key_events) cv FROM ${T('ga4_page_monthly')}
            WHERE media = @media AND month >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Tokyo'), MONTH), INTERVAL 13 MONTH) GROUP BY ym, page_path`, { media });
        } catch (e) { /* まだ表がない */ }
        const articles = await kwArticles(media);
        const s = await getSettings();
        res.json({ rows, pages, articles, connected: !!s.hasKey, project: (s.projects || {})[media] || null, lastFetchAt: iso(s.lastFetchAt), pending: (s.pending || {})[media] || 0 });
      } catch (e) { next(e); }
    });
  }

  return { routes, sync, fetchMonthly, loadKey };   /* loadKey：競合調査のドメインパワー（2026-11-13） */
};
module.exports.SITE_URLS = SITE_URLS;   // 自社メディアのURL（コピペチェックで除く）
