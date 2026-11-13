// Search Console のインデックス状況（URL検査 API）（2026-10-28 ユーザー指定）
// ・毎日 Cloud Scheduler（index-check）→ /tasks/index-check で、公開記事の URL を検査して BigQuery index_status に追記
// ・1サイト1日2,000件まで。まだインデックスされていない記事 → まだ一度も確認していない記事 → 確認が古い記事の順に、1回の実行で時間の許すかぎり
// ・Search Console は「申請中」を返さないので、ダッシュボードで申請ボタンを押した記事を Firestore index_requests に記録し、次の確認で登録されるまで △
// ・登録リクエストは API ではできない（Indexing API は求人・ライブ配信だけ）。ボタンは Search Console の URL検査の画面を開く
// ・Webアプリのアカウント（dashboard-app@…）を各サイトの Search Console にユーザー追加しておく必要がある
const crypto = require('crypto');

module.exports = function indexCheck({ db, admin, query, T, allowedMedia }) {
  const col = db.collection('index_requests');
  const keyOf = url => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 24);
  const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
  const DAY_LIMIT = 1900, TIME_BUDGET = 13 * 60 * 1000;   // 上限 2,000 件／日の少し手前。Cloud Run の待ち時間の中で止める

  async function token() {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=' + encodeURIComponent(SCOPE), { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw new Error('アクセストークンを取得できません（' + r.status + '）');
    return (await r.json()).access_token;
  }
  async function api(tok, method, path, body) {
    const r = await fetch('https://searchconsole.googleapis.com' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  }
  async function ensureTable() {
    await query(`CREATE TABLE IF NOT EXISTS ${T('index_status')} (url STRING, media STRING, site STRING, verdict STRING, coverage STRING, indexing_state STRING, last_crawl TIMESTAMP, checked_at TIMESTAMP)`);
  }
  /** URL がどのサイト（プロパティ）に入るか：URL プレフィックスは前方一致、ドメインプロパティはホスト名で */
  const siteFor = (sites, url) => {
    let host = ''; try { host = new URL(url).hostname; } catch (e) { return null; }
    const pre = sites.filter(s => !s.startsWith('sc-domain:') && url.startsWith(s)).sort((a, b) => b.length - a.length)[0];
    if (pre) return pre;
    return sites.find(s => s.startsWith('sc-domain:') && (host === s.slice(10) || host.endsWith('.' + s.slice(10)))) || null;
  };
  /** 最新の確認結果（URL ごと） */
  async function latest() {
    try {
      return await query(`SELECT url, media, site, verdict, coverage, indexing_state, CAST(last_crawl AS STRING) last_crawl, CAST(checked_at AS STRING) checked_at FROM ${T('index_status')}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY url ORDER BY checked_at DESC) = 1`);
    } catch (e) { return []; }
  }
  /** 公開記事の URL（記事管理：記事URLがあり、完了かアップロード日が今日まで） */
  async function publishedUrls() {
    return query(`SELECT DISTINCT media, TRIM(url) url FROM ${T('article_items')} WHERE url IS NOT NULL AND TRIM(url) LIKE 'http%'
      AND (status IN ('完了', '最終化') OR upload_date <= CURRENT_DATE('Asia/Tokyo'))`);
  }

  async function collect() {
    const started = Date.now(), msgs = [];
    try {
      await ensureTable();
      const tok = await token();
      const sites = ((await api(tok, 'GET', '/webmasters/v3/sites')).siteEntry || []).map(s => s.siteUrl);
      if (!sites.length) throw new Error('Search Console のサイトが1つも見つかりません。Webアプリのアカウントを各サイトのユーザーに追加してください');
      const last = new Map((await latest()).map(r => [r.url, r]));
      const urls = (await publishedUrls()).map(r => Object.assign(r, { site: siteFor(sites, r.url) }));
      const noSite = [...new Set(urls.filter(u => !u.site).map(u => u.media))];
      // 確認する順：インデックスされていない → 未確認 → 古い順
      const rank = u => { const l = last.get(u.url); return !l ? 1 : l.verdict === 'PASS' ? 2 : 0; };
      const todo = urls.filter(u => u.site).sort((a, b) => rank(a) - rank(b) || String((last.get(a.url) || {}).checked_at || '').localeCompare(String((last.get(b.url) || {}).checked_at || '')));
      const perSite = {}, rows = [];
      // 5件ずつ同時に確認する（1件ずつだと 13 分で 100 件ほどしか進まなかったため。2026-10-28）
      let stop = false, timeUp = false;
      const one = async u => {
        try {
          const inspect = async url => ((await api(tok, 'POST', '/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: u.site, languageCode: 'ja' })).inspectionResult || {}).indexStatusResult || {};
          let ix = await inspect(u.url);
          // 記事管理シートの URL と、サイトの正式な URL で最後の「/」が違うことがある（害獣お助けなど）。登録されていないときは「/」を付けた形・外した形でも確かめる（2026-10-28）
          if (ix.verdict !== 'PASS' && /認識されていません|リダイレクト|not.*known|redirect/i.test(ix.coverageState || '')) {
            const alt = u.url.endsWith('/') ? u.url.replace(/\/+$/, '') : /[?#]/.test(u.url) ? null : u.url + '/';
            if (alt) { const ix2 = await inspect(alt); if (ix2.verdict === 'PASS' || !/認識されていません|リダイレクト/.test(ix2.coverageState || '')) ix = ix2; }
          }
          rows.push({ url: u.url, media: u.media, site: u.site, verdict: ix.verdict || null, coverage: ix.coverageState || null, indexing_state: ix.indexingState || null, last_crawl: ix.lastCrawlTime || null });
        } catch (e) {
          if (e.status === 429) { stop = true; msgs.push('上限に達したため途中で止めました'); return; }
          if (e.status === 403) { if (perSite[u.site] <= DAY_LIMIT) msgs.push(u.site + '：権限がありません'); perSite[u.site] = DAY_LIMIT + 1; return; }
          msgs.push(u.url + '：' + e.message);
        }
      };
      const queue = todo.filter(u => { perSite[u.site] = (perSite[u.site] || 0) + 1; return perSite[u.site] <= DAY_LIMIT; });
      Object.keys(perSite).forEach(k => { perSite[k] = 0; });
      for (let i = 0; i < queue.length && !stop; i += 5) {
        if (Date.now() - started > TIME_BUDGET) { timeUp = true; break; }
        await Promise.all(queue.slice(i, i + 5).filter(u => (perSite[u.site] || 0) <= DAY_LIMIT).map(one));
      }
      if (timeUp) msgs.push('時間の上限で途中まで（残りは次の回）');
      for (let i = 0; i < rows.length; i += 500) {
        await query(`INSERT INTO ${T('index_status')} (url, media, site, verdict, coverage, indexing_state, last_crawl, checked_at)
          SELECT r.url, r.media, r.site, r.verdict, r.coverage, r.indexing_state, TIMESTAMP(r.last_crawl), CURRENT_TIMESTAMP() FROM UNNEST(@rows) r`,
          { rows: rows.slice(i, i + 500) }, { rows: [{ url: 'STRING', media: 'STRING', site: 'STRING', verdict: 'STRING', coverage: 'STRING', indexing_state: 'STRING', last_crawl: 'STRING' }] });
      }
      const ok = rows.filter(r => r.verdict === 'PASS').length;
      const msg = rows.length + '件を確認（インデックス済み ' + ok + '件）' + (noSite.length ? '。Search Console にサイトがない（権限がない）メディア：' + noSite.join('・') : '') + (msgs.length ? '。' + msgs.slice(0, 5).join(' / ') : '');
      await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), 'インデックス確認', '全メディア', NULL, NULL, 'OK', @m)`, { m: msg.slice(0, 1000) }).catch(() => {});
      return { ok: true, checked: rows.length, indexed: ok, message: msg };
    } catch (e) {
      await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), 'インデックス確認', '全メディア', NULL, NULL, 'ERROR', @m)`, { m: String(e.message).slice(0, 1000) }).catch(() => {});
      return { ok: false, error: e.message };
    }
  }

  function routes(api) {
    // 公開記事一覧の INDEX：ok＝インデックス済み、pending＝申請ボタンを押したあと、まだ登録が確認できていない、ng＝インデックスされていない、null＝まだ確認していない
    api.get('/index-status', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        const rows = (await latest()).filter(r => allowedMedia(req.user, r.media) && (!media || media === '__all__' || r.media === media));
        const reqs = {}; (await col.get()).docs.forEach(d => { const v = d.data(); reqs[v.url] = v.requestedAt ? v.requestedAt.toDate().toISOString() : ''; });
        const out = {};
        rows.forEach(r => {
          /* 確認日時の形がいろいろでも止めない（「… UTC」などで Invalid time value の 500 になっていた。2026-11-06） */
          const ca = r.checked_at && typeof r.checked_at === 'object' && r.checked_at.value ? r.checked_at.value : r.checked_at;
          const toIso = v => { if (!v) return ''; const s = String(v).trim().replace(/\s*UTC$/i, 'Z').replace(' ', 'T'); for (const t of [s, s + 'Z']) { const d = new Date(t); if (!isNaN(d)) return d.toISOString(); } return ''; };
          const asked = reqs[r.url], checked = toIso(ca);
          const state = r.verdict === 'PASS' ? 'ok' : asked && asked > checked ? 'pending' : 'ng';
          out[r.url] = { state, coverage: r.coverage || '', checkedAt: r.checked_at, lastCrawl: r.last_crawl, site: r.site || '' };
        });
        Object.keys(reqs).forEach(u => { if (!out[u]) out[u] = { state: 'pending', coverage: '', checkedAt: null }; });
        res.json({ status: out });
      } catch (e) { next(e); }
    });
    // 申請ボタン：押した記録を残す（登録リクエストは Search Console の画面で行う）
    api.post('/index-request', async (req, res, next) => {
      try {
        const url = String((req.body || {}).url || '').trim(), media = String((req.body || {}).media || '');
        if (!/^https?:\/\//.test(url) || !allowedMedia(req.user, media)) return res.status(400).json({ error: '記事URLが正しくありません' });
        await col.doc(keyOf(url)).set({ url, media, requestedAt: admin.firestore.FieldValue.serverTimestamp(), requestedBy: req.user.email });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes, collect };
};
