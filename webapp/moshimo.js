/**
 * もしもアフィリエイト（成果報酬レポート・月別のCSVを取り込む。公開APIがないため）
 *
 * - CSV：管理画面の「レポート → 報酬 → 月次」。メディア全体（アカウント全体）と、メディアごとにダウンロードできる
 *   見出し：期間,インプレッション数,クリック数,クリック金額,発生成果数,発生成果金額,承認成果数,承認成果金額,報酬額（Shift_JIS）
 * - 取り込み方は2つ
 *   1. 画面からCSVをアップロード（収益管理 →「もしもアフィリエイト」）
 *   2. 自動取得：毎月2日・15日 5:30（Cloud Scheduler「moshimo-collect」→ /tasks/moshimo）。2026-10-14 ユーザー指定
 *      ログイン（ID・パスワードは Secret Manager の moshimo-login）→ メディア全体＋メディアごとに直近3か月分のCSVを取る
 *      ログイン画面は ID・パスワードだけ（画像認証・二段階認証なし）。あれば止まる（突破はしない）
 *      規約（メディア利用規約）に自動取得の禁止はない。負荷をかけないよう、1回の取得ごとに少し間をあける
 * - BigQuery moshimo_monthly に追記。同じ月・同じメディアは、最後に取り込んだ値を使う（承認は後から増えるため、取り込み直せば新しい値になる）
 * - 収益として数えるのは承認成果金額。発生成果金額は参考として並べて表示（2026-10-14 ユーザー指定）
 * - CSVの金額は税込み。収益に使うときは 1.1 で割って税抜きにする（2026-10-14 ユーザー指定）
 * - CSVを取り込んだ月・メディアは、スプレッドシートの「アフィリエイト」の行よりCSVを優先（2026-10-14 ユーザー指定）
 * - メディア全体のCSVはメディアに分けられないので、収益の集計には使わず、もしもの画面で「各メディアの合計との差」を見るのに使う
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const ALL_KEY = '_all';
const TAX = 1.1;
const NUM_COLS = ['imp', 'clicks', 'click_amount', 'occ_count', 'occ_amount', 'apr_count', 'apr_amount', 'reward'];
const BASE = 'https://af.moshimo.com';
const SECRET_ID = 'moshimo-login';
const MONTHS_BACK = 3;   // 毎回取り直す月数（承認が後から増えるため）
const COLS = { '期間': 'ym', 'インプレッション数': 'imp', 'クリック数': 'clicks', 'クリック金額': 'click_amount', '発生成果数': 'occ_count', '発生成果金額': 'occ_amount', '承認成果数': 'apr_count', '承認成果金額': 'apr_amount', '報酬額': 'reward' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// もしも側のメディア（サイト）の番号（2026-10-14 時点。ふだんはログイン後の画面のプルダウンから読む）
const KNOWN_SITES = [['618078', '害獣お助け本舗'], ['619334', 'ハチお助け本舗'], ['633641', 'カギお助け本舗'], ['633643', 'ガラスお助け本舗'], ['633644', '屋根外壁お助け本舗'],
  ['633646', 'BEST365'], ['648925', '害虫害獣コンシェルジュ'], ['651542', 'シロアリお助け本舗'], ['658144', '水まわりお助け本舗']].map(([id, name]) => ({ id, name }));

/** CSVを行・列に分ける（"" で囲まれた値・中のカンマに対応） */
function csvRows(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); out.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.some(x => x.trim()));
}
/** もしものCSV（Shift_JIS）→ 月ごとの行。画面側（app.js の parseMoshimo）と同じ読み方 */
function parseCsv(buf) {
  let text = new TextDecoder('shift_jis').decode(buf);
  if (!text.includes('期間')) text = new TextDecoder('utf-8').decode(buf);
  const rows = csvRows(text.replace(/^﻿/, ''));
  const head = (rows[0] || []).map(h => COLS[h.trim()] || null);
  if (!head.includes('ym') || !head.includes('apr_amount')) throw new Error('CSVの見出しが想定と違います（もしもの画面が変わった可能性があります）');
  const num = s => { const t = String(s || '').replace(/[\\¥￥,\s円]/g, ''); return t === '' || t === '-' ? null : Number(t); };
  const out = [];
  rows.slice(1).forEach(r => {
    const o = {};
    head.forEach((k, i) => { if (k) o[k] = k === 'ym' ? String(r[i] || '').trim() : num(r[i]); });
    const m = o.ym.match(/^(\d{4})\D+(\d{1,2})/);
    if (!m) return;   // 合計の行など
    o.ym = m[1] + '-' + m[2].padStart(2, '0');
    out.push(o);
  });
  return out;
}

module.exports = function moshimo({ PROJECT, db, query, T, admin, mediaKeys, mediaName }) {
  const sm = new SecretManagerServiceClient();
  const secretName = `projects/${PROJECT}/secrets/${SECRET_ID}`;
  const settingsRef = db.collection('settings').doc('moshimo');
  async function getSettings() { const s = await settingsRef.get(); return s.exists ? s.data() : {}; }

  let tableReady = false;
  async function ensureTable() {
    if (tableReady) return;
    await query(`CREATE TABLE IF NOT EXISTS ${T('moshimo_monthly')} (month DATE, media STRING, imp INT64, clicks INT64, click_amount INT64, occ_count INT64, occ_amount INT64, apr_count INT64, apr_amount INT64, reward INT64, file STRING, uploaded_at TIMESTAMP, uploaded_by STRING) PARTITION BY DATE_TRUNC(month, YEAR) CLUSTER BY media`);
    tableReady = true;
  }
  async function jobLog(status, message) {
    await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), 'もしもアフィリエイト', '全メディア', NULL, NULL, @status, @message)`,
      { status, message: String(message).slice(0, 1000) }).catch(e => console.warn('job_log: ' + e.message));
  }

  /** 取り込み（画面・自動取得で共通）。rows：[{ ym: 'YYYY-MM', imp, ... }] */
  async function saveRows(media, rows, file, by) {
    const clean = rows.map(r => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(r.ym || ''))) throw new Error('期間の形式が正しくありません：' + String(r.ym).slice(0, 20));
      const o = { month: r.ym + '-01' };
      NUM_COLS.forEach(k => { const v = r[k]; if (v != null && !(Number.isFinite(Number(v)) && Number(v) >= 0)) throw new Error('数値が正しくありません（' + r.ym + '・' + k + '）'); o[k] = v == null ? null : Math.round(Number(v)); });
      return o;
    });
    if (!clean.length) return 0;
    await ensureTable();
    await query(`INSERT INTO ${T('moshimo_monthly')} (month, media, ${NUM_COLS.join(', ')}, file, uploaded_at, uploaded_by)
      SELECT DATE(r.month), @media, ${NUM_COLS.map(k => 'r.' + k).join(', ')}, @file, CURRENT_TIMESTAMP(), @by FROM UNNEST(@rows) r`,
      { media, file: String(file || '').slice(0, 200), by, rows: clean },
      { media: 'STRING', file: 'STRING', by: 'STRING', rows: [Object.assign({ month: 'STRING' }, ...NUM_COLS.map(k => ({ [k]: 'INT64' })))] });
    cache = null;
    return clean.length;
  }

  /** 月・メディアごとの最新の取り込み値 */
  let cache = null;
  async function latest() {
    if (cache && cache.until > Date.now()) return cache.value;
    let rows = [];
    try {
      rows = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, ${NUM_COLS.join(', ')}, file, FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', uploaded_at, 'Asia/Tokyo') uploaded_at, uploaded_by
        FROM ${T('moshimo_monthly')} QUALIFY ROW_NUMBER() OVER (PARTITION BY media, month ORDER BY uploaded_at DESC) = 1 ORDER BY ym, media`);
    } catch (e) { /* まだ表がない */ }
    rows.forEach(r => NUM_COLS.forEach(k => { r[k] = r[k] == null ? null : Number(r[k]); }));
    cache = { value: rows, until: Date.now() + 10 * 60 * 1000 };
    return rows;
  }
  /** 収益の集計用：メディアごと・月ごとの承認成果金額（税抜き）。メディア全体の行は含めない */
  async function affiliateRevenue() {
    return (await latest()).filter(r => r.media !== ALL_KEY && r.apr_amount != null).map(r => ({ ym: r.ym, media: r.media, value: Math.round(r.apr_amount / TAX * 100) / 100 }));   // 3300 ÷ 1.1 が 2999.99… にならないよう小数2けたで丸める
  }

  // ---------- 自動取得 ----------
  async function saveLogin(account, password) {
    try { await sm.getSecret({ name: secretName }); } catch (e) {
      if (e.code !== 5) throw e;
      await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: SECRET_ID, secret: { replication: { automatic: {} } } });
    }
    await sm.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(JSON.stringify({ account, password }), 'utf8') } });
  }
  async function loadLogin() {
    const [v] = await sm.accessSecretVersion({ name: secretName + '/versions/latest' });
    return JSON.parse(v.payload.data.toString('utf8'));
  }
  /** クッキーを持ち回る、かんたんなブラウザ代わり */
  function session() {
    const jar = new Map();
    async function req(url, opt = {}, hops = 0) {
      const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (BEST media dashboard)', 'Accept-Language': 'ja' }, opt.headers || {});
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => k + '=' + v).join('; ');
      const res = await fetch(url, { method: opt.method || 'GET', headers, body: opt.body, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < 5) {
        await res.arrayBuffer().catch(() => {});
        return req(new URL(res.headers.get('location'), url).href, {}, hops + 1);   // リダイレクトは GET で追う
      }
      return { res, url };
    }
    return { req };
  }
  const form = o => new URLSearchParams(o).toString();
  const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

  /** ログイン → メディア（サイト）の一覧を返す */
  async function login(s, cred) {
    await s.req(BASE + '/af/shop/login');   // 最初のクッキー
    await s.req(BASE + '/af/shop/login/execute', { method: 'POST', headers: FORM_HEADERS, body: form({ ref: '', account: cred.account, password: cred.password }) });
    const { res, url } = await s.req(BASE + '/af/shop/report/payment/monthly');
    const html = await res.text();
    if (/\/login/.test(url) || !/report-form/.test(html)) {
      if (/captcha|認証コード|ワンタイム/i.test(html)) throw new Error('ログイン画面に追加の認証（画像認証やコード入力）が出ました。自動取得はできないので、画面からCSVを取り込んでください');
      throw new Error('ログインできませんでした（IDかパスワードが違う可能性があります）');
    }
    const opts = name => [...((html.match(new RegExp('<select[^>]*name="' + name + '"[^>]*>([\\s\\S]*?)<\\/select>')) || [])[1] || '').matchAll(/<option[^>]*value=["']?(\d+)["']?[^>]*>([^<]*)<\/option>/g)].map(m => ({ id: m[1], name: m[2].trim() }));
    const sites = opts('shop_site_id'), years = opts('year').map(x => Number(x.id)).filter(y => y >= 2000);
    return { sites: sites.length ? sites : KNOWN_SITES, years };   // 画面から読めなかったときは、2026-10-14 時点の番号を使う
  }
  /** 1つのメディア（空＝全体）・1年分のCSV */
  async function downloadYear(s, siteId, year) {
    const body = form({ shop_site_id: siteId, promotion_id: '', promotion_condition_id: '', year: String(year), order: '', limit: '' });
    // もしもは「レポート表示」で選んだ条件を覚えて、ダウンロードはその条件で出す。先に表示してから取る（2026-10-14 確認）
    const view = await s.req(BASE + '/af/shop/report/payment/monthly', { method: 'POST', headers: FORM_HEADERS, body });
    await view.res.arrayBuffer().catch(() => {});
    await sleep(800);
    const { res } = await s.req(BASE + '/af/shop/report/payment/monthly/download', { method: 'POST', headers: FORM_HEADERS, body });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error('CSVをダウンロードできませんでした（' + res.status + '）');
    return parseCsv(buf);
  }

  /**
   * 自動取得：メディア全体＋メディアごと
   * - ふだん（毎月2日・15日）：直近3か月分
   * - all：もしもの画面で選べる年（2021年〜）の過去分すべて（2026-10-14 ユーザー指定）。すべて0の月は保存しない
   */
  async function collect(by, opt = {}) {
    try {
      const st = await getSettings();
      if (!st.hasLogin) throw new Error('もしもアフィリエイトのIDとパスワードが未登録です（API・連携設定 → もしもアフィリエイト）');
      const cred = await loadLogin(), s = session();
      const { sites, years: pageYears } = await login(s, cred);
      const now = new Date(Date.now() + 9 * 3600000), thisYm = now.toISOString().slice(0, 7);
      let yms, years;
      if (opt.all) {
        years = (pageYears.length ? pageYears : [2021]).slice().sort();
        for (let y = years[years.length - 1] + 1; y <= now.getUTCFullYear(); y++) years.push(y);
        yms = null;   // 今月までの全部
      } else {
        yms = []; for (let i = MONTHS_BACK - 1; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); yms.push(d.toISOString().slice(0, 7)); }
        years = [...new Set(yms.map(x => Number(x.slice(0, 4))))];
      }
      const inRange = r => yms ? yms.includes(r.ym) : r.ym <= thisYm && NUM_COLS.some(k => r[k]);   // 過去分は、すべて0の月を除く
      // メディア名（もしも側）→ ダッシュボードのメディア
      const targets = [{ id: '', media: ALL_KEY, name: 'メディア全体' }];
      const unknown = [];
      sites.forEach(x => { const key = mediaKeys.find(k => mediaName(k) === x.name); if (key) targets.push({ id: x.id, media: key, name: x.name }); else unknown.push(x.name); });
      // まず全部取ってから保存する（途中で失敗したら何も保存しない）
      const got = [];
      for (const t of targets) {
        let rows = [];
        for (const y of years) { rows = rows.concat(await downloadYear(s, t.id, y)); await sleep(1500); }
        got.push({ t, rows: rows.filter(inRange) });
      }
      // 安全確認：メディアの数字が全月「メディア全体」と同じなら、メディアの切り替えが効いていない（2026-10-14 に一度起きた）
      const all = got[0].rows, sig = rows => rows.map(r => r.ym + ':' + r.apr_amount + ':' + r.occ_amount + ':' + r.imp).join('|');
      const same = got.slice(1).filter(g => g.rows.length && sig(g.rows) === sig(all) && all.some(r => r.imp));
      if (got.length > 2 && same.length === got.length - 1) throw new Error('メディアごとの数字が、すべて「メディア全体」と同じでした。もしも側でメディアの切り替えができていない可能性があるため、保存していません');
      const done = [];
      for (const g of got) { const n = await saveRows(g.t.media, g.rows, '自動取得', by); done.push(g.t.name + ' ' + n + 'か月'); }
      const msg = (yms ? yms[0].replace('-', '/') + '〜' + yms[yms.length - 1].replace('-', '/') : '過去分すべて（' + years[0] + '年〜）') + 'を取得：' + done.join('、') + (unknown.length ? '／ダッシュボードにないメディア（取り込まず）：' + unknown.join('、') : '');
      await settingsRef.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastResult: msg, lastError: null }, { merge: true });
      await jobLog('OK', msg);
      return { ok: true, message: msg };
    } catch (e) {
      await settingsRef.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastError: e.message }, { merge: true });
      await jobLog('ERROR', e.message);
      return { ok: false, error: e.message };
    }
  }

  function routes(api, adminApi, opts) {
    const canUpload = u => u.status === 'active' && (u.perms.media === 'admin' || u.perms.revenue === 'admin');
    const allMediaOK = u => mediaKeys.every(m => opts.allowedMedia(u, m));
    api.get('/revenue/moshimo', async (req, res, next) => {
      try {
        if (!opts.canRevenue(req.user)) return res.status(403).json({ error: '収益管理を見る権限がありません' });
        const rows = (await latest()).filter(r => r.media === ALL_KEY ? allMediaOK(req.user) : opts.allowedMedia(req.user, r.media));
        res.json({ rows, canUpload: canUpload(req.user), tax: TAX });
      } catch (e) { next(e); }
    });
    api.post('/revenue/moshimo', async (req, res, next) => {
      try {
        if (!canUpload(req.user)) return res.status(403).json({ error: 'CSVを取り込む権限がありません（管理者か、収益管理の編集権限が必要です）' });
        const b = req.body || {}, media = String(b.media || '');
        if (media !== ALL_KEY && !mediaKeys.includes(media)) return res.status(400).json({ error: 'メディアを選んでください' });
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (!rows.length || rows.length > 240) return res.status(400).json({ error: 'CSVに取り込める行がありません' });
        let n;
        try { n = await saveRows(media, rows, b.file, req.user.email); } catch (e) { return res.status(400).json({ error: e.message }); }
        if (opts.onDataChanged) opts.onDataChanged();
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'もしもアフィリエイトのCSVを取り込み（' + (media === ALL_KEY ? 'メディア全体' : media) + '・' + n + 'か月）', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true, months: n });
      } catch (e) { next(e); }
    });
    // API・連携設定（自動取得のID・パスワード）
    adminApi.get('/moshimo', async (req, res, next) => {
      try { const s = await getSettings(); res.json({ hasLogin: !!s.hasLogin, account: s.accountMasked || '', lastRunAt: s.lastRunAt && s.lastRunAt.toDate ? s.lastRunAt.toDate().toISOString() : null, lastResult: s.lastResult || '', lastError: s.lastError || '' }); }
      catch (e) { next(e); }
    });
    adminApi.put('/moshimo', async (req, res, next) => {
      try {
        const b = req.body || {}, account = String(b.account || '').trim(), password = String(b.password || '');
        if (!account || !password) return res.status(400).json({ error: 'IDとパスワードを両方入力してください' });
        if (account.length > 200 || password.length > 200) return res.status(400).json({ error: 'IDかパスワードが長すぎます' });
        await saveLogin(account, password);
        const masked = account.length <= 3 ? '***' : account.slice(0, 2) + '***' + account.slice(-1);
        await settingsRef.set({ hasLogin: true, accountMasked: masked, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'もしもアフィリエイトのログイン情報を保存', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    adminApi.post('/moshimo/run', async (req, res) => {
      const r = await collect(req.user.email, { all: !!(req.body || {}).all });
      if (r.ok && opts.onDataChanged) opts.onDataChanged();
      res.json(r);
    });
  }

  return { routes, collect, affiliateRevenue, ALL_KEY };
};
