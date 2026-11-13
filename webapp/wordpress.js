/**
 * WordPress 連携
 *
 * - 接続情報（URL・ユーザー名・目標本数）は Firestore の media_settings、アプリケーションパスワードは Secret Manager に保存
 * - 記事数は REST API の件数（X-WP-Total ヘッダー）だけを読む。本文などは取得しない
 * - 数え方（投稿のみ）
 *     公開記事数（累計）… その月末までに公開された投稿（現在も公開中のもの）
 *     新規公開数       … その月に公開された投稿
 *     リライト数       … その月に更新され、公開はその月より前の投稿（更新日で判定）
 *     予約・レビュー待ち・下書き … 収集した時点の件数
 */
const crypto = require('crypto');
/** 通信が一時的に失敗したとき（fetch failed・タイムアウト）は、少し待って最大3回までやり直す（2026-11-06：カギお助け本舗で 10/30・11/05 に「fetch failed」。サイトはその後ふつうにつながる） */
async function fetchR(url, opt) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, Object.assign({}, opt, { signal: AbortSignal.timeout(20000) })); }
    catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
}
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const BACKFILL_FROM = '2024-01';

module.exports = function wordpress({ PROJECT, db, query, T, admin, allowedMedia, onDataChanged }) {
  const sm = new SecretManagerServiceClient();
  const keyOf = media => crypto.createHash('sha1').update(media).digest('hex').slice(0, 16);
  const secretName = media => `projects/${PROJECT}/secrets/wp-pass-${keyOf(media)}`;
  const settingsRef = media => db.collection('media_settings').doc(keyOf(media));

  // ---------- 設定 ----------
  async function getSettings(media) {
    const snap = await settingsRef(media).get();
    return snap.exists ? snap.data() : null;
  }
  async function listSettings() {
    const snap = await db.collection('media_settings').get();
    return snap.docs.map(d => d.data());
  }
  async function savePassword(media, pass) {
    const name = secretName(media);
    try { await sm.getSecret({ name }); } catch (e) {
      if (e.code !== 5) throw e;   // 5 = NOT_FOUND
      await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: name.split('/').pop(), secret: { replication: { automatic: {} } } });
    }
    await sm.addSecretVersion({ parent: name, payload: { data: Buffer.from(pass, 'utf8') } });
  }
  async function loadPassword(media) {
    const [v] = await sm.accessSecretVersion({ name: secretName(media) + '/versions/latest' });
    return v.payload.data.toString('utf8');
  }

  // ---------- WordPress REST API ----------
  function checkUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('サイトのURLの形式が正しくありません'); }
    if (u.protocol !== 'https:') throw new Error('サイトのURLは https:// で始まるものを入力してください');
    if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || /(^|\.)internal$|^localhost$/i.test(u.hostname)) throw new Error('このURLは指定できません');
    return u.origin + u.pathname.replace(/\/+$/, '');
  }
  function headersFor(cfg, withAuth) {
    const h = { 'User-Agent': 'BESTMediaDashboard/1.0', Accept: 'application/json' };
    if (withAuth) h.Authorization = 'Basic ' + Buffer.from(cfg.user + ':' + cfg.pass).toString('base64');
    return h;
  }
  /** 件数を数える。公開記事は認証なし、下書きなどは認証あり（withAuth） */
  async function wpCount(cfg, params, withAuth) {
    const base = checkUrl(cfg.url);
    const qs = new URLSearchParams(Object.assign({ per_page: '1', _fields: 'id' }, params));
    const headers = headersFor(cfg, withAuth);
    // パーマリンクが「基本」のサイトは /wp-json/ が使えないので ?rest_route= で再試行する
    const urls = [base + '/wp-json/wp/v2/posts?' + qs, base + '/?rest_route=/wp/v2/posts&' + qs];
    let last;
    for (const url of urls) {
      const res = await fetchR(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const total = res.headers.get('x-wp-total');
        if (total === null) throw new Error('記事数を読み取れませんでした（REST APIの応答に件数がありません）');
        return Number(total);
      }
      last = res;
      if (res.status !== 404) break;
    }
    const text = await last.text().catch(() => '');
    let code = '';
    try { code = JSON.parse(text).code || ''; } catch (e) { /* HTMLが返ることもある */ }
    let wpMsg = '';
    try { wpMsg = JSON.parse(text).message || ''; } catch (e) { /* HTML */ }
    if (code === 'invalid_username' || code === 'incorrect_password') throw new Error('ユーザー名かアプリケーションパスワードが違います');
    if (code === 'rest_invalid_param' && /status/.test(text)) throw new Error('下書きなどの件数を読む権限がありません（認証が通っていません）');
    if (last.status === 403) throw new Error('アクセスが拒否されました（セキュリティ系プラグインやサーバー設定でREST APIが制限されている可能性があります）');
    if (last.status === 404) throw new Error('REST APIが見つかりません。URLが正しいか、REST APIが無効になっていないか確認してください');
    throw new Error('WordPressからエラーが返りました（' + last.status + (wpMsg ? '：' + wpMsg : '') + '）');
  }

  /** 認証の確認。ok / reason を返す */
  async function checkAuth(cfg) {
    if (!cfg.user || !cfg.pass) return { ok: false, reason: 'ユーザー名とアプリケーションパスワードが未登録です' };
    const base = checkUrl(cfg.url);
    for (const url of [base + '/wp-json/wp/v2/users/me?context=edit&_fields=id,roles', base + '/?rest_route=/wp/v2/users/me&context=edit&_fields=id,roles']) {
      const res = await fetchR(url, { headers: headersFor(cfg, true), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) continue;
      if (res.ok) return { ok: true };
      let code = '';
      try { code = (await res.json()).code || ''; } catch (e) { /* HTML */ }
      if (code === 'invalid_username' || code === 'incorrect_password') return { ok: false, reason: 'ユーザー名かアプリケーションパスワードが違います' };
      if (code === 'rest_not_logged_in') return { ok: false, reason: 'HEADER', detail: 'サーバーが認証情報を受け取れていません（Authorizationヘッダーがサーバーで削除されています）' };
      return { ok: false, reason: '認証できませんでした（' + res.status + (code ? '：' + code : '') + '）' };
    }
    return { ok: false, reason: 'REST APIが見つかりません' };
  }

  const pad = n => String(n).padStart(2, '0');
  function monthBounds(ym) {
    const [y, m] = ym.split('-').map(Number);
    const prevEnd = new Date(Date.UTC(y, m - 1, 0));            // 前月末日
    const next = new Date(Date.UTC(y, m, 1));                  // 翌月1日
    const d = x => x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate());
    return { start: ym + '-01T00:00:00', prevEnd: d(prevEnd) + 'T23:59:59', next: d(next) + 'T00:00:00' };
  }
  async function countMonth(cfg, ym) {
    const b = monthBounds(ym);
    const [postsTotal, postsNew, rewrites] = await Promise.all([
      wpCount(cfg, { status: 'publish', before: b.next }),
      wpCount(cfg, { status: 'publish', after: b.prevEnd, before: b.next }),
      wpCount(cfg, { status: 'publish', modified_after: b.prevEnd, modified_before: b.next, before: b.start }),
    ]);
    return { posts_total: postsTotal, posts_new: postsNew, rewrites };
  }
  /** その月の新規公開・リライトの記事一覧（公開記事のみ。タイトル・URL・日付だけ） */
  async function listMonth(cfg, ym) {
    const b = monthBounds(ym), base = checkUrl(cfg.url);
    const decode = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;/g, '–');
    async function fetchList(params) {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const qs = new URLSearchParams(Object.assign({ status: 'publish', per_page: '100', page: String(page), _fields: 'id,date,modified,link,title' }, params));
        let res = await fetchR(base + '/wp-json/wp/v2/posts?' + qs, { headers: headersFor(cfg, false), signal: AbortSignal.timeout(20000) });
        if (res.status === 404) res = await fetchR(base + '/?rest_route=/wp/v2/posts&' + qs, { headers: headersFor(cfg, false), signal: AbortSignal.timeout(20000) });
        if (!res.ok) break;
        const rows = await res.json();
        out.push(...rows);
        if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
      }
      return out;
    }
    const [news, rws] = await Promise.all([
      fetchList({ after: b.prevEnd, before: b.next, orderby: 'date', order: 'desc' }),
      fetchList({ modified_after: b.prevEnd, modified_before: b.next, before: b.start, orderby: 'modified', order: 'desc' }),
    ]);
    const row = (p, kind) => ({ kind, date: String(kind === 'new' ? p.date : p.modified).slice(0, 10), published: String(p.date).slice(0, 10), title: decode(p.title && p.title.rendered), link: p.link });
    return news.map(p => row(p, 'new')).concat(rws.map(p => row(p, 'rewrite')));
  }
  const listCache = new Map();
  async function listAll(ym) {
    const hit = listCache.get(ym);
    if (hit && hit.until > Date.now()) return hit.value;
    const out = [];
    for (const s of (await listSettings()).filter(x => x.url)) {
      try { (await listMonth({ url: s.url }, ym)).forEach(r => out.push(Object.assign({ media: s.media }, r))); }
      catch (e) { console.warn('listMonth ' + s.media + ': ' + e.message); }
    }
    listCache.set(ym, { value: out, until: Date.now() + 10 * 60 * 1000 });
    return out;
  }

  const titleCache = new Map();
  /** そのメディアの公開記事のタイトル（記事ID・URL → タイトル） */
  async function titlesFor(media) {
    const hit = titleCache.get(media);
    if (hit && hit.until > Date.now()) return hit.value;
    const s = await getSettings(media);
    if (!s || !s.url) return null;
    const base = checkUrl(s.url);
    const decode = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const norm = u => String(u || '').replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    const value = { byId: {}, byUrl: {}, idByUrl: {}, tagsById: {}, catsById: {} };
    for (let page = 1; page <= 30; page++) {
      const qs = new URLSearchParams({ status: 'publish', per_page: '100', page: String(page), _fields: 'id,link,title,tags,categories' });
      let res = await fetchR(base + '/wp-json/wp/v2/posts?' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) res = await fetchR(base + '/?rest_route=/wp/v2/posts&' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) });
      if (!res.ok) break;
      (await res.json()).forEach(p => { const t = decode(p.title && p.title.rendered); value.byId[String(p.id)] = t; value.byUrl[norm(p.link)] = t; value.idByUrl[norm(p.link)] = String(p.id); value.tagsById[String(p.id)] = p.tags || []; value.catsById[String(p.id)] = p.categories || []; });
      if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
    }
    titleCache.set(media, { value, until: Date.now() + 60 * 60 * 1000 });
    return value;
  }

  const termCache = new Map();
  /** そのメディアの WordPress のカテゴリ・タグ（公開APIから。1時間キャッシュ） */
  async function termsFor(media) {
    const hit = termCache.get(media);
    if (hit && hit.until > Date.now()) return hit.value;
    const s = await getSettings(media);
    const value = { categories: [], tags: [], connected: !!(s && s.url) };
    if (s && s.url) {
      const base = checkUrl(s.url);
      const decode = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      for (const kind of ['categories', 'tags']) {
        for (let page = 1; page <= 20; page++) {
          const qs = new URLSearchParams({ per_page: '100', page: String(page), _fields: 'id,name,slug,count,parent' });
          let res = await fetchR(base + '/wp-json/wp/v2/' + kind + '?' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) }).catch(() => null);
          if (res && res.status === 404) res = await fetchR(base + '/?rest_route=/wp/v2/' + kind + '&' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) }).catch(() => null);
          if (!res || !res.ok) break;
          (await res.json()).forEach(t => value[kind].push({ id: t.id, name: decode(t.name), slug: t.slug, count: t.count, parent: t.parent || 0 }));
          if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
        }
      }
    }
    termCache.set(media, { value, until: Date.now() + 60 * 60 * 1000 });
    return value;
  }

  const myBlockCache = new Map();
  /**
   * そのメディアの「マイブロック」（AFFINGER の st_block_pattern。公開APIから。30分キャッシュ）（2026-10-26 ユーザー指定）
   * タイトルに「CTA」→ CTA、「訴求」→ 訴求ブロック、それ以外 → 記事用コンテンツ。ショートコードは [st-myblock id="ID"]
   */
  async function myBlocksFor(media) {
    const hit = myBlockCache.get(media);
    if (hit && hit.until > Date.now()) return hit.value;
    const s = await getSettings(media);
    const value = { cta: [], appeal: [], content: [], available: false };
    if (s && s.url) {
      const base = checkUrl(s.url);
      const decode = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      for (let page = 1; page <= 10; page++) {
        const qs = new URLSearchParams({ per_page: '100', page: String(page), _fields: 'id,title,modified', orderby: 'title', order: 'asc' });
        let res = await fetchR(base + '/wp-json/wp/v2/st_block_pattern?' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) }).catch(() => null);
        if (res && res.status === 404) res = await fetchR(base + '/?rest_route=/wp/v2/st_block_pattern&' + qs, { headers: headersFor({}, false), signal: AbortSignal.timeout(20000) }).catch(() => null);
        if (!res || !res.ok) break;   // マイブロックがないサイト（害虫害獣コンシェルジュ・BEST365 など）
        value.available = true;
        (await res.json()).forEach(b => {
          const name = decode(b.title && b.title.rendered) || '（タイトルなし）';
          const kind = /CTA/i.test(name) ? 'cta' : /訴求/.test(name) ? 'appeal' : 'content';
          value[kind].push({ id: b.id, name, code: '[st-myblock id="' + b.id + '"]', updatedAt: b.modified || '' });
        });
        if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
      }
    }
    myBlockCache.set(media, { value, until: Date.now() + 30 * 60 * 1000 });
    return value;
  }

  /** 各サイトに置いた mu-plugin（best-dashboard-counts.php）から件数だけを読む。なければ null */
  async function countsFromPlugin(cfg) {
    const base = checkUrl(cfg.url);
    for (const url of [base + '/wp-json/best-dashboard/v1/counts', base + '/?rest_route=/best-dashboard/v1/counts']) {
      const res = await fetchR(url, { headers: headersFor(cfg, false), signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (!res || res.status === 404) continue;
      if (!res.ok) return null;
      const j = await res.json().catch(() => null);
      if (j && typeof j.publish === 'number') return { published: j.publish, scheduled: j.future, pending: j.pending, draft: j.draft, auth: { ok: true, via: 'plugin' } };
      return null;
    }
    return null;
  }
  async function countStatus(cfg) {
    const viaPlugin = await countsFromPlugin(cfg);
    if (viaPlugin) return viaPlugin;
    const published = await wpCount(cfg, { status: 'publish' }, false);
    const auth = await checkAuth(cfg).catch(e => ({ ok: false, reason: e.message }));
    if (!auth.ok) return { published, scheduled: null, pending: null, draft: null, auth };
    const [scheduled, pending, draft] = await Promise.all(['future', 'pending', 'draft'].map(status => wpCount(cfg, { status }, true)));
    return { published, scheduled, pending, draft, auth };
  }

  // ---------- BigQuery ----------
  let tablesReady = false;
  async function ensureTables() {
    if (tablesReady) return;
    await query(`CREATE TABLE IF NOT EXISTS ${T('wp_monthly')} (month DATE, media STRING, posts_total INT64, posts_new INT64, rewrites INT64, collected_at TIMESTAMP) PARTITION BY month`);
    await query(`CREATE TABLE IF NOT EXISTS ${T('wp_status')} (date DATE, media STRING, published INT64, scheduled INT64, pending INT64, draft INT64, collected_at TIMESTAMP) PARTITION BY date`);
    tablesReady = true;
  }
  async function writeJobLog(job, media, status, message) {
    await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), @job, @media, NULL, NULL, @status, @message)`,
      { job, media, status, message: String(message).slice(0, 1000) }).catch(e => console.warn('job_log: ' + e.message));
  }

  const ymNow = () => { const d = new Date(Date.now() + 9 * 3600000); return d.toISOString().slice(0, 7); };
  const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

  /** 1メディア分を取得して保存。初回は2024年1月からさかのぼる */
  async function collectMedia(media) {
    await ensureTables();
    const s = await getSettings(media);
    if (!s || !s.url) throw new Error('WordPressのURLが未登録です');
    const cfg = { url: s.url, user: s.user || '', pass: s.hasPassword ? await loadPassword(media).catch(() => '') : '' };
    const has = await query(`SELECT COUNT(*) n FROM ${T('wp_monthly')} WHERE media = @media`, { media });
    const cur = ymNow();
    const months = [];
    if (Number(has[0].n) === 0) { for (let m = BACKFILL_FROM; m <= cur; m = shiftYm(m, 1)) months.push(m); }
    else months.push(shiftYm(cur, -1), cur);
    const rows = [];
    for (const ym of months) rows.push(Object.assign({ month: ym + '-01', media }, await countMonth(cfg, ym)));
    const st = await countStatus(cfg);
    const authNote = st.auth && st.auth.ok ? '' : '（予約・下書きは未取得：' + (st.auth.reason === 'HEADER' ? 'サーバーが認証情報を受け取れていません' : st.auth.reason) + '）';
    await query(`DELETE FROM ${T('wp_monthly')} WHERE media = @media AND month >= DATE(@from)`, { media, from: rows[0].month });   // 取り直す月以降を消してから入れる
    await query(`INSERT INTO ${T('wp_monthly')} (month, media, posts_total, posts_new, rewrites, collected_at)
      SELECT DATE(r.month), r.media, r.posts_total, r.posts_new, r.rewrites, CURRENT_TIMESTAMP() FROM UNNEST(@rows) r`, { rows });
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    await query(`DELETE FROM ${T('wp_status')} WHERE media = @media AND date = @d`, { media, d: today }, { d: 'DATE' });
    await query(`INSERT INTO ${T('wp_status')} (date, media, published, scheduled, pending, draft, collected_at) VALUES (@d, @media, @published, @scheduled, @pending, @draft, CURRENT_TIMESTAMP())`,
      { d: today, media, published: st.published, scheduled: st.scheduled, pending: st.pending, draft: st.draft },
      { d: 'DATE', published: 'INT64', scheduled: 'INT64', pending: 'INT64', draft: 'INT64' });
    const result = months.length + 'か月分（今月 新規' + rows[rows.length - 1].posts_new + '・リライト' + rows[rows.length - 1].rewrites + '）' + authNote;
    await settingsRef(media).set({ lastCollectedAt: admin.firestore.FieldValue.serverTimestamp(), lastResult: 'OK ' + result, lastError: null }, { merge: true });
    await writeJobLog('WordPress取得', media, 'OK', result);
    onDataChanged();
    return { months: months.length, status: st, current: rows[rows.length - 1] };
  }
  async function collectAll() {
    const list = (await listSettings()).filter(s => s.url);
    const results = [];
    for (const s of list) {
      try { results.push({ media: s.media, ok: true, detail: await collectMedia(s.media) }); }
      catch (e) {
        results.push({ media: s.media, ok: false, error: e.message });
        await settingsRef(s.media).set({ lastError: e.message, lastResult: 'エラー', lastCollectedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await writeJobLog('WordPress取得', s.media, 'ERROR', e.message);
      }
    }
    return results;
  }

  // ---------- 画面用 ----------
  const publicView = s => ({
    media: s.media, url: s.url || '', user: s.user || '', hasPassword: !!s.hasPassword, passHint: s.passHint || '',
    targetNew: s.targetNew != null ? s.targetNew : null, targetRewrite: s.targetRewrite != null ? s.targetRewrite : null,
    lastCollectedAt: s.lastCollectedAt && s.lastCollectedAt.toDate ? s.lastCollectedAt.toDate().toISOString() : null,
    lastResult: s.lastResult || '', lastError: s.lastError || '',
  });

  function routes(adminApi, api) {
    adminApi.get('/wp', async (req, res, next) => {
      try { res.json((await listSettings()).map(publicView)); } catch (e) { next(e); }
    });
    adminApi.put('/wp/:media', async (req, res, next) => {
      try {
        const media = req.params.media, b = req.body || {};
        const url = checkUrl(String(b.url || '').trim()), user = String(b.user || '').trim();
        const num = v => v === '' || v == null ? null : Math.max(0, Math.floor(Number(v)));
        const patch = { media, url, user, targetNew: num(b.targetNew), targetRewrite: num(b.targetRewrite), updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.email };
        if (b.password) {
          const pass = String(b.password).trim();
          await savePassword(media, pass);
          patch.hasPassword = true; patch.passHint = '…' + pass.replace(/\s/g, '').slice(-4);
        }
        await settingsRef(media).set(patch, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'WordPress設定を保存：' + media, at: admin.firestore.FieldValue.serverTimestamp() });
        onDataChanged();
        res.json({ ok: true });
      } catch (e) { if (/URL|入力/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    adminApi.post('/wp/:media/test', async (req, res) => {
      try {
        const media = req.params.media, b = req.body || {};
        const pass = b.password ? String(b.password).trim() : await loadPassword(media).catch(() => '');
        const st = await countStatus({ url: String(b.url || '').trim(), user: String(b.user || '').trim(), pass: pass || '' });
        res.json({ ok: true, status: st });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    adminApi.post('/wp/:media/collect', async (req, res) => {
      try { res.json({ ok: true, detail: await collectMedia(req.params.media) }); }
      catch (e) {
        await writeJobLog('WordPress取得', req.params.media, 'ERROR', e.message);
        res.status(400).json({ error: e.message });
      }
    });
    // 閲覧ユーザー向け：その月の記事一覧（日別推移と一覧に使う）
    api.get('/articles/list', async (req, res, next) => {
      try {
        const ym = String(req.query.ym || '');
        if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: '月（ym）を YYYY-MM で指定してください' });
        res.json((await listAll(ym)).filter(r => allowedMedia(req.user, r.media)));
      } catch (e) { next(e); }
    });
    // 閲覧ユーザー向け：記事進捗タブ用（目標本数と最新の件数）
    api.get('/articles', async (req, res, next) => {
      try {
        const settings = (await listSettings()).filter(s => allowedMedia(req.user, s.media)).map(s => ({ media: s.media, targetNew: s.targetNew != null ? s.targetNew : null, targetRewrite: s.targetRewrite != null ? s.targetRewrite : null, connected: !!s.url, lastCollectedAt: publicView(s).lastCollectedAt }));
        let status = [];
        try {
          status = await query(`SELECT media, CAST(date AS STRING) date, published, scheduled, pending, draft FROM ${T('wp_status')}
            QUALIFY ROW_NUMBER() OVER (PARTITION BY media ORDER BY date DESC) = 1`);
        } catch (e) { /* まだ表がない */ }
        res.json({ settings, status: status.filter(r => allowedMedia(req.user, r.media)) });
      } catch (e) { next(e); }
    });
  }

  /** 公開中の記事の構成（H2〜H4・マイブロック・再利用ブロック）を、WordPress にログインして本文（ブロックのコード）から読む（2026-11-13 ユーザー指定：リライトの構成シート）。
   *  記事ID（wp_id）がなければ記事URLのスラッグで探す。ログインできないときは公開ページの本文（マイブロックは判定できない）から見出しだけ読む */
  async function postStructure(media, { id, url }) {
    const s = await getSettings(media);
    if (!s || !s.url) throw new Error('このメディアは WordPress とつながっていません（管理 → メディア管理）');
    const base = checkUrl(s.url);
    let pass = null; try { pass = await loadPassword(media); } catch (e) { /* ログインなしで読む */ }
    const cfg = { user: s.user, pass }, auth = !!(s.user && pass);
    const get = async (path, withAuth) => {
      for (const u of [base + '/wp-json/wp/v2/' + path, base + '/?rest_route=/wp/v2/' + path.replace('?', '&')]) {
        const r = await fetchR(u, { headers: headersFor(cfg, withAuth) }).catch(() => null);
        if (r && r.status === 404 && u.includes('/wp-json/')) continue;
        if (!r || !r.ok) return null;
        return r.json();
      }
      return null;
    };
    let pid = String(id || '').trim(), kind = 'posts';
    if (!/^\d+$/.test(pid)) {
      let slug = ''; try { slug = decodeURIComponent(new URL(String(url || '')).pathname.replace(/\/+$/, '').split('/').pop() || ''); } catch (e) { /* URLなし */ }
      if (!slug) throw new Error('記事URLがないため、既存記事を探せません');
      for (const k of ['posts', 'pages']) { const l = await get(k + '?slug=' + encodeURIComponent(slug) + '&_fields=id&status=publish', false); if (Array.isArray(l) && l[0]) { pid = String(l[0].id); kind = k; break; } }
      if (!/^\d+$/.test(pid)) throw new Error('WordPress で記事が見つかりませんでした（' + slug + '）');
    }
    let p = auth ? await get(kind + '/' + pid + '?context=edit&_fields=id,title,content,link', true) : null, raw = p && p.content && p.content.raw;
    if (!raw) { p = await get(kind + '/' + pid + '?_fields=id,title,content,link', false); raw = p && p.content && p.content.rendered; }
    if (!p || !raw) throw new Error('記事の本文を読めませんでした');
    const blocks = await myBlocksFor(media).catch(() => ({ cta: [], appeal: [], content: [] }));
    const byId = {}; ['cta', 'appeal', 'content'].forEach(k => (blocks[k] || []).forEach(b => { byId[String(b.id)] = { kind: k, name: b.name, code: b.code }; }));
    const text = h => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();
    const fromEditor = !!(p.content && p.content.raw);
    let items = [];
    if (fromEditor) {
      const re = /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>|\[st-myblock\s+id=["']?(\d+)["']?[^\]]*\]|<!--\s*wp:block\s+\{[^}]*"ref"\s*:\s*(\d+)[^}]*\}\s*\/-->/gi;
      let m;
      while ((m = re.exec(raw))) {
        if (m[1]) { const t = text(m[2]); if (t) items.push({ type: 'h' + m[1], text: t }); }
        else { const bid = m[3] || m[4], b = byId[bid]; items.push(b ? { type: b.kind, name: b.name, code: b.code } : { type: 'content', name: (m[3] ? 'マイブロック' : '再利用ブロック') + ' ID ' + bid, code: m[0] }); }
      }
    } else {
      /* ログインなし：公開ページの本文に、マイブロックの中身（公開されている本文）と同じ文章があるかで判定する。マイブロックの中の見出しは、ブロックとして数える */
      const norm = h => text(h).replace(/\s+/g, '');
      let flat = ''; const heads = [], re = /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi; let m, last = 0;
      while ((m = re.exec(raw))) { flat += norm(raw.slice(last, m.index)); const t = text(m[2]); if (t) heads.push({ pos: flat.length, type: 'h' + m[1], text: t }); flat += norm(m[2]); last = m.index + m[0].length; }
      flat += norm(raw.slice(last));
      const blocks = [];
      (await myBlockTexts(media).catch(() => [])).forEach(b => {
        const t = b.text; if (t.length < 20 || !byId[String(b.id)]) return;
        let i = flat.indexOf(t.slice(0, 40));
        const score = (b.feats || []).filter(f => raw.includes(f)).length;   // 文章が同じブロック（CTA01〜07 など）は、画像・リンクのファイル名が記事にあるかで見分ける
        while (i >= 0) { blocks.push({ pos: i, end: i + t.length, exact: flat.slice(i, i + t.length) === t, score, b: byId[String(b.id)] }); i = flat.indexOf(t.slice(0, 40), i + 1); }
      });
      /* 書き出しが同じブロック（CTA など）は、中身が全部同じもの → 画像・リンクが記事にあるもの → 長いもの の順 */
      blocks.sort((x, y) => x.pos - y.pos || (y.exact - x.exact) || (y.score - x.score) || (y.end - y.pos) - (x.end - x.pos));
      const used = []; blocks.forEach(x => { if (!used.some(u => x.pos < u.end && x.end > u.pos)) used.push(x); });
      items = heads.filter(h => !used.some(u => h.pos >= u.pos && h.pos < u.end)).map(h => ({ pos: h.pos, type: h.type, text: h.text }))
        .concat(used.map(u => ({ pos: u.pos, type: u.b.kind, name: u.b.name, code: u.b.code })))
        .sort((x, y) => x.pos - y.pos).map(x => { delete x.pos; return x; });
    }
    return { id: Number(pid), title: text(p.title && (p.title.raw || p.title.rendered)), link: p.link || '', fromEditor, items };
  }
  /** マイブロックの中身の文章（公開されている本文。判定用）。30分キャッシュ */
  const myBlockTextCache = new Map();
  async function myBlockTexts(media) {
    const hit = myBlockTextCache.get(media); if (hit && hit.until > Date.now()) return hit.value;
    const s = await getSettings(media), base = checkUrl(s.url), out = [];
    for (let page = 1; page <= 10; page++) {
      const qs = new URLSearchParams({ per_page: '100', page: String(page), _fields: 'id,content' });
      let res = await fetchR(base + '/wp-json/wp/v2/st_block_pattern?' + qs, { headers: headersFor({}, false) }).catch(() => null);
      if (res && res.status === 404) res = await fetchR(base + '/?rest_route=/wp/v2/st_block_pattern&' + qs, { headers: headersFor({}, false) }).catch(() => null);
      if (!res || !res.ok) break;
      (await res.json()).forEach(b => out.push({ id: b.id, heads: (String((b.content && b.content.rendered) || '').match(/<h[2-4]\b[^>]*>[\s\S]*?<\/h[2-4]>/gi) || []).map(h => ({ type: 'h' + h[2], text: h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim() })).filter(h => h.text).slice(0, 50), feats: [...new Set((String((b.content && b.content.rendered) || '').match(/(?:src|href)="[^"]+"/g) || []).map(x => x.replace(/^(src|href)="/, '').replace(/"$/, '').replace(/[?#].*$/, '').split('/').pop()).filter(x => x && x.length > 4))], text:String((b.content && b.content.rendered) || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, '') }));
      if (page >= Number(res.headers.get('x-wp-totalpages') || 1)) break;
    }
    myBlockTextCache.set(media, { value: out, until: Date.now() + 30 * 60 * 1000 });
    return out;
  }

  /** マイブロック（記事用コンテンツなど）の中の見出し（H2〜H4）（2026-11-13 ユーザー指定） */
  async function myBlockHeads(media, id) { const b = (await myBlockTexts(media)).find(x => String(x.id) === String(id)); return b ? b.heads || [] : null; }

  return { routes, collectAll, ensureTables, titlesFor, listAll, termsFor, myBlocksFor, postStructure, myBlockHeads, _test: { countStatus, countMonth, listMonth } };
};
