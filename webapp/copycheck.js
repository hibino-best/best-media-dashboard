/**
 * コピペチェック（2026-10-28 ユーザー指定）
 *
 * 進行管理の記事URL（と公開前の原稿＝ライティングURLの Google ドキュメント。dashboard-app@ に共有されたものを Drive API で読む）の本文から特徴のある文を最大10か所選び、Brave Search API で「"文"」を検索して、
 * 自社メディア以外のページに同じ文があるかを確かめる。一致率＝他サイトで見つかった文 ÷ 調べた文。
 * - 自社メディア（ahrefs.js の SITE_URLS のドメインと、その親ドメイン）と、設定で足したドメインは除く
 * - Brave の無料分（毎月5ドル＝約1,000回）を超えないよう、1か月 MONTH_LIMIT 回で止める（止まった記事は「今月の上限」）
 * - APIキーは Secret Manager（brave-search-api-key）。画面には表示しない
 * - 結果は Firestore copy_checks/{URLのハッシュ}、使った回数は settings/copycheck.usage.{YYYY-MM}
 */
const crypto = require('crypto');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const SECRET_ID = 'brave-search-api-key';
const MONTH_LIMIT = 950;          // 無料分（約1,000回）の手前で止める
const SA_EMAIL = 'dashboard-app@bestmedia-510909.iam.gserviceaccount.com';   // 原稿の Google ドキュメントを共有してもらう先
const SENTENCES = 10;            // 1記事で調べる文の数
const QUERY_LEN = 38;             // 検索に使う文字数
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymNow = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
const norm = s => String(s || '').normalize('NFKC').replace(/[\s　、，,・「」『』（）()【】"'“”‘’！!？?：:；;…ー―-]/g, '').toLowerCase();
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const baseOf = h => { const p = h.split('.'); return p.length > 2 && /^(co|ne|or|ac|go)$/.test(p[p.length - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.'); };
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
/** HTML → 本文の文字（見出し・段落・表・リストを残し、スクリプト・メニューなどは除く） */
function htmlText(html) {
  return decode(String(html || '')
    .replace(/<(script|style|noscript|svg|header|footer|nav|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr|td|th|section|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}
/** 調べる文を選ぶ：句点・改行で区切り、20〜100文字の文から、長いもの優先で記事全体に散らばるように */
function pickSentences(text) {
  const all = text.split(/[。！？!?\n]/).map(s => s.trim()).filter(s => s.length >= 20 && s.length <= 100 && !/^https?:/.test(s) && (s.match(/\d/g) || []).length < s.length / 3);
  const uniq = [...new Set(all)];
  if (uniq.length <= SENTENCES) return uniq;
  const step = uniq.length / SENTENCES, out = [];
  for (let i = 0; i < SENTENCES; i++) { const seg = uniq.slice(Math.floor(i * step), Math.floor((i + 1) * step)); out.push(seg.sort((a, b) => b.length - a.length)[0]); }
  return out;
}
/** 文の一部（15文字ずつ）が相手の文字の中にあるか */
/** 文字数（スペース・改行・見えない文字を除く。絵文字などは1文字） */
const countChars = t => [...String(t || '').replace(/[\s​-‍⁠﻿]/g, '')].length;
const contains = (hay, s) => { const h = norm(hay), n = norm(s); if (n.length < 15) return h.includes(n); for (let i = 0; i + 15 <= n.length; i += 8) if (h.includes(n.slice(i, i + 15))) return true; return false; };

module.exports = function copycheck({ PROJECT, db, admin, ownUrls, canEdit, urlAllowed }) {
  const sm = new SecretManagerServiceClient();
  const secretName = `projects/${PROJECT}/secrets/${SECRET_ID}`;
  const settingsRef = db.collection('settings').doc('copycheck');
  const col = db.collection('copy_checks');
  const idOf = url => crypto.createHash('sha1').update(String(url).trim()).digest('hex').slice(0, 24);
  let keyCache = null;
  async function loadKey() {
    if (keyCache && keyCache.until > Date.now()) return keyCache.v;
    try { const [v] = await sm.accessSecretVersion({ name: secretName + '/versions/latest' }); keyCache = { v: v.payload.data.toString('utf8').trim(), until: Date.now() + 10 * 60 * 1000 }; return keyCache.v; } catch (e) { return ''; }
  }
  async function saveKey(key) {
    try { await sm.getSecret({ name: secretName }); } catch (e) {
      if (e.code !== 5) throw e;
      await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: SECRET_ID, secret: { replication: { automatic: {} } } });
    }
    await sm.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(key, 'utf8') } });
    keyCache = null;
  }
  async function settings() { const s = await settingsRef.get(); return s.exists ? s.data() : {}; }
  /** 除くドメイン：自社メディアのドメインと親ドメイン（例：otasuke-honpo.com・best24.co.jp）＋設定で足したもの */
  async function excluded() {
    const s = await settings(), own = ownUrls().map(hostOf).filter(Boolean);
    return [...new Set(own.concat(own.map(baseOf), (s.exclude || []).map(x => String(x).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))).filter(Boolean))];
  }
  const isExcluded = (host, ex) => ex.some(d => host === d || host.endsWith('.' + d));

  /** 記事の本文：WordPress の API（スラッグ）→ だめならページの HTML */
  async function articleText(url) {
    const get = async (u, json) => { const r = await fetch(u, { headers: { 'User-Agent': 'BEST-MEDIA-dashboard copycheck' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('記事を読み込めませんでした（' + r.status + '）'); return json ? r.json() : r.text(); };
    if (/^https:\/\/docs\.google\.com\//.test(url)) return docText(url);
    try {
      const u = new URL(url), slug = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() || '');
      if (slug) for (const type of ['posts', 'pages']) {
        const list = await get(u.origin + '/wp-json/wp/v2/' + type + '?slug=' + encodeURIComponent(slug) + '&_fields=content', true).catch(() => null);
        if (Array.isArray(list) && list[0] && list[0].content) return htmlText(list[0].content.rendered);
      }
    } catch (e) { /* 次の方法へ */ }
    const html = await get(url, false);
    const m = html.match(/<article[\s\S]*<\/article>/i) || html.match(/<main[\s\S]*<\/main>/i);
    return htmlText(m ? m[0] : html);
  }
  /** 公開前の原稿（Google ドキュメント）：ダッシュボードのアカウント（dashboard-app@…）に閲覧者で共有されたものを Drive API で読む（2026-10-28 ユーザー指定 B） */
  async function docText(url) {
    const m = url.match(/\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/);
    if (!m) throw new Error('Google ドキュメントのURLではありません（スプレッドシートなどはチェックできません）');
    const t = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=' + encodeURIComponent('https://www.googleapis.com/auth/documents.readonly,https://www.googleapis.com/auth/drive.readonly'), { headers: { 'Metadata-Flavor': 'Google' } });
    if (!t.ok) throw new Error('Google ドキュメントを読む準備ができませんでした（' + t.status + '）');
    const tok = (await t.json()).access_token;
    // Docs API で本文だけを読む（テキストの書き出しはコメント・脚注なども入り、文字数が多くなるため。2026-10-28）。
    // ヘッダー・フッター・脚注・コメント・提案中の追加は数えない（Google ドキュメントの「文字数」に合わせる）
    const r = await fetch('https://docs.googleapis.com/v1/documents/' + m[1] + '?fields=body', { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(20000) });
    if (r.status === 403 || r.status === 404) throw new Error('ドキュメントを読めません。ドキュメント（またはフォルダ）を ' + SA_EMAIL + ' に「閲覧者」で共有してください');
    if (!r.ok) throw new Error('ドキュメントを読めませんでした（' + r.status + '）');
    const body = ((await r.json()).body || {}).content || [];
    lastDocStats = docStats(body);
    return docBodyText(body);
  }
  let lastDocStats = null;
  /** 文字数の内訳（ずれの確認用。本文は残さず数だけ） */
  function docStats(content) {
    const st = { body: 0, table: 0, sugIns: 0, sugDel: 0, toc: 0, surrogate: 0, zw: 0, kuten: 0, kakko: 0, symbol: 0, ascii: 0, zenAlnum: 0, link: 0, heading: 0, bullet: 0, zenSpace: 0, nbsp: 0, vtab: 0, tab: 0, bulletParas: 0, paras: 0 };
    // 文字の種類ごとの数（Google の文字数とのずれの確認用）
    const kinds = (t, ps, link) => { st.zenSpace += (t.match(/\u3000/g) || []).length; st.nbsp += (t.match(/\u00a0/g) || []).length; st.vtab += (t.match(/\u000b/g) || []).length; st.tab += (t.match(/\t/g) || []).length; const c = t.replace(/[\s​-‍⁠﻿]/g, '');
      st.kuten += (c.match(/[、。，．]/g) || []).length; st.kakko += (c.match(/[「」『』（）【】［］〈〉《》()[\]]/g) || []).length;
      st.ascii += (c.match(/[A-Za-z0-9]/g) || []).length; st.zenAlnum += (c.match(/[Ａ-Ｚａ-ｚ０-９]/g) || []).length;
      st.symbol += (c.match(/[^\p{L}\p{N}、。，．「」『』（）【】［］〈〉《》()[\]]/gu) || []).length;
      if (link) st.link += [...c].length; if (/^HEADING|^TITLE|^SUBTITLE/.test(ps || '')) st.heading += [...c].length; };
    const walk = (cs, inTable) => (cs || []).forEach(el => {
      if (el.paragraph) { st.paras++; if (el.paragraph.bullet) st.bulletParas++; }
      if (el.paragraph) (el.paragraph.elements || []).forEach(pe => {
        const tr = pe.textRun;
        if (!tr) { const k = Object.keys(pe).find(x => x !== 'startIndex' && x !== 'endIndex'); if (k) st['el_' + k] = (st['el_' + k] || 0) + 1; return; }   // 画像・チップ・区切り線など（数だけ）
        if (!tr.content) return; const n = countChars(tr.content);
        if (!(tr.suggestedInsertionIds && tr.suggestedInsertionIds.length)) { kinds(tr.content, (el.paragraph.paragraphStyle || {}).namedStyleType, tr.textStyle && tr.textStyle.link); if (el.paragraph.bullet) st.bullet += n; }
        if (tr.suggestedInsertionIds && tr.suggestedInsertionIds.length) st.sugIns += n;
        else { if (tr.suggestedDeletionIds && tr.suggestedDeletionIds.length) st.sugDel += n; if (inTable) st.table += n; else st.body += n; }
        st.surrogate += tr.content.replace(/\s/g, '').length - [...tr.content.replace(/\s/g, '')].length; st.zw += (tr.content.match(/[​-‍⁠﻿]/g) || []).length;
      });
      else if (el.table) (el.table.tableRows || []).forEach(row => (row.tableCells || []).forEach(cell => walk(cell.content, true)));
      else if (el.tableOfContents) { const before = st.body; walk(el.tableOfContents.content, false); st.toc += st.body - before; st.body = before; }
    });
    walk(content, false);
    return st;
  }
  function docBodyText(content) {
    let out = '';
    (content || []).forEach(el => {
      if (el.paragraph) (el.paragraph.elements || []).forEach(pe => { const tr = pe.textRun; if (tr && tr.content && !(tr.suggestedInsertionIds && tr.suggestedInsertionIds.length)) out += tr.content; });
      else if (el.table) (el.table.tableRows || []).forEach(row => (row.tableCells || []).forEach(cell => { out += docBodyText(cell.content) + '\n'; }));
      // 目次（tableOfContents）は数えない
    });
    return out;
  }
  async function brave(key, q) {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?' + new URLSearchParams({ q, country: 'JP', search_lang: 'jp', count: '10' }), { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Brave の APIキーが正しくありません（' + r.status + '）'), { code: 'key' });
    if (r.status === 429) throw Object.assign(new Error('Brave の検索回数の上限に達しました'), { code: 'limit' });
    if (!r.ok) throw new Error('Brave の検索に失敗しました（' + r.status + '）');
    const d = await r.json();
    return ((d.web || {}).results || []).map(x => ({ url: x.url, text: decode([x.title, x.description].concat(x.extra_snippets || []).join(' ').replace(/<[^>]+>/g, '')) }));   // 抜粋の <strong> などは外して照合
  }
  async function useQuota(n) { await settingsRef.set({ usage: { [ymNow()]: admin.firestore.FieldValue.increment(n) } }, { merge: true }); }

  /** 1記事をチェックして保存する */
  async function run(url, by) {
    url = String(url || '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('記事URLが正しくありません');
    const ref = col.doc(idOf(url)), save = o => ref.set(Object.assign({ url, by: by || '', checkedAt: admin.firestore.FieldValue.serverTimestamp(), ym: ymNow() }, o)).then(() => Object.assign({ url, ym: ymNow(), checkedAt: new Date().toISOString() }, o));
    let text; try { text = await articleText(url); } catch (e) { return save({ status: 'error', error: e.message }); }   // 先に本文を読む（原稿の共有がないときは、キーの有無より先に知らせる）
    const key = await loadKey();
    if (!key) return save({ status: 'nokey', error: 'Brave の APIキーが未設定です（API・連携設定）' });
    const s = await settings(), used = (s.usage || {})[ymNow()] || 0;
    if (used + SENTENCES > MONTH_LIMIT) return save({ status: 'limit', error: '今月の無料分の上限（' + MONTH_LIMIT + '回）に達しました。来月チェックします' });
    const sents = pickSentences(text);
    if (sents.length < 3) return save({ status: 'error', error: '本文を読み取れませんでした（文が少ない・ページが開けないなど）' });
    const ex = await excluded(), hits = new Array(sents.length).fill(null), cand = {};
    let q = 0;
    try {
      for (let i = 0; i < sents.length; i++) {
        const s0 = sents[i], part = s0.length > QUERY_LEN ? s0.slice(Math.floor((s0.length - QUERY_LEN) / 2), Math.floor((s0.length - QUERY_LEN) / 2) + QUERY_LEN) : s0;
        if (q) await sleep(1100);   // 無料プランは1秒に1回まで
        // 「"文"」の完全一致の検索は日本語では見つからないことが多い（2026-10-28 確認：Wikipedia の文も0件）ので、引用符なしで検索し、抜粋・ページ本文で同じ文があるかを確かめる
        const res = (await brave(key, part)).filter(x => !isExcluded(hostOf(x.url), ex)); q++;
        const hit = res.find(x => contains(x.text, s0));
        if (hit) hits[i] = hit.url; else res.slice(0, 3).forEach(x => { cand[x.url] = (cand[x.url] || 0) + 1; });
      }
    } catch (e) {
      if (q) await useQuota(q);
      return save({ status: e.code === 'limit' ? 'limit' : 'error', error: e.message });
    }
    await useQuota(q);
    // 検索結果の抜粋で見つからなかった文は、よく出てきたページ（6件まで）の本文で確かめる
    const pages = Object.entries(cand).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
    for (const p of pages) {
      if (hits.every(Boolean)) break;
      let t = ''; try { const r = await fetch(p, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BEST-MEDIA-copycheck)' }, signal: AbortSignal.timeout(15000) }); if (r.ok) t = htmlText(await r.text()); } catch (e) { /* 読めないページは飛ばす */ }
      if (t) sents.forEach((s0, i) => { if (!hits[i] && contains(t, s0)) hits[i] = p; });
    }
    const n = hits.filter(Boolean).length, by2 = {};
    hits.forEach(u => { if (u) by2[u] = (by2[u] || 0) + 1; });
    return save({ status: 'done', pct: Math.round(n / sents.length * 100), checked: sents.length, matched: n, queries: q, error: '',
      matches: Object.entries(by2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([u, c]) => ({ url: u, n: c })),
      samples: sents.map((s0, i) => ({ text: s0.slice(0, 100), url: hits[i] || '' })) });
  }

  const iso = v => v && v.toDate ? v.toDate().toISOString() : v || null;
  function routes(api, adminApi) {
    // 進行管理：全記事の結果（URL → 一致率など）
    api.get('/copycheck', async (req, res, next) => {
      try { res.json({ results: (await col.get()).docs.filter(d => !urlAllowed || urlAllowed(req.user, d.data().url)).map(d => { const v = d.data(); return { url: v.url, status: v.status, pct: v.pct, checked: v.checked, matched: v.matched, error: v.error || '', ym: v.ym, checkedAt: iso(v.checkedAt), matches: v.matches || [], samples: v.samples || [] }; }) }); } catch (e) { next(e); }
    });
    // CCD でチェックするときに除くドメイン（自社メディア＋設定で足したもの）。コピペ率（CCD）の入力画面でコピーして使う（2026-11-05 ユーザー指定）
    api.get('/copycheck/exclude', async (req, res, next) => {
      try { res.json({ domains: await excluded() }); } catch (e) { next(e); }
    });
    // 1記事をチェック（進行管理の入力の権限がある人）
    api.post('/copycheck', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: 'コピペチェックは進行管理の入力の権限がある人だけです' });
        const r = await run((req.body || {}).url, req.user.email); r.checkedAt = r.checkedAt || new Date().toISOString(); res.json(r);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    // 原稿（Google ドキュメント）の文字数（スペース・改行を除く）。進行管理の文字数に自動で入れる（2026-10-28 ユーザー指定）
    api.post('/doc-chars', async (req, res) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理の入力の権限がありません' });
        const url = String((req.body || {}).url || '').trim();
        if (!/^https:\/\/docs\.google\.com\//.test(url)) return res.status(400).json({ error: 'Google ドキュメントのURLではありません' });
        const text = await docText(url), st = lastDocStats || {};
        // Google ドキュメントの「文字数（スペースを除く）」に合わせる（2026-10-28 確認）：除くのは半角スペースと段落の改行だけ。
        // 全角スペース・タブ・行内の改行（Shift+Enter）は1文字、画像も1つ1文字として数える
        const n = [...String(text || '').replace(/[ \n\r​-‍⁠﻿]/g, '')].length + (st.el_inlineObjectElement || 0);
        console.log('doc-chars', JSON.stringify(Object.assign({ chars: n }, lastDocStats || {})));   // ずれの確認用（数だけ）
        res.json({ chars: n });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    // API・連携設定
    adminApi.get('/copycheck', async (req, res, next) => {
      try { const s = await settings(); res.json({ saEmail: SA_EMAIL, hasKey: !!(await loadKey()), used: (s.usage || {})[ymNow()] || 0, limit: MONTH_LIMIT, perArticle: SENTENCES, exclude: s.exclude || [], excluded: await excluded(), checks: (await col.count().get()).data().count }); } catch (e) { next(e); }
    });
    adminApi.put('/copycheck', async (req, res, next) => {
      try {
        const b = req.body || {};
        if (b.apiKey) await saveKey(String(b.apiKey).trim());
        if (Array.isArray(b.exclude)) await settingsRef.set({ exclude: b.exclude.map(x => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(x => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)).slice(0, 50) }, { merge: true });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  /** 原稿の文字数（/doc-chars と同じ数え方）（2026-10-31 プレスリリースで使う） */
  async function docChars(url) { const text = await docText(url), st = lastDocStats || {}; return [...String(text || '').replace(/[ \n\r\u200b-\u200d\u2060\ufeff]/g, '')].length + (st.el_inlineObjectElement || 0); }
  /** \u7af6\u5408\u8abf\u67fb\uff08\u69cb\u6210\u30b7\u30fc\u30c8\uff09\u7528\uff1aBrave \u3067\u30a6\u30a7\u30d6\u691c\u7d22\u30921\u56de\uff08\u30b3\u30d4\u30da\u30c1\u30a7\u30c3\u30af\u3068\u540c\u3058\u6708\u306e\u7121\u6599\u5206\u3092\u6570\u3048\u308b\u30022026-11-13 \u30e6\u30fc\u30b6\u30fc\u6307\u5b9a\uff09 */
  async function braveWeb(q, count) {
    const key = await loadKey();
    if (!key) throw Object.assign(new Error('Brave \u306e API\u30ad\u30fc\u304c\u672a\u8a2d\u5b9a\u3067\u3059\uff08\u7ba1\u7406 \u2192 API\u30fb\u9023\u643a\u8a2d\u5b9a\uff09'), { code: 'key' });
    const s = await settings(), used = (s.usage || {})[ymNow()] || 0;
    if (used + 1 > MONTH_LIMIT) throw Object.assign(new Error('Brave \u306e\u4eca\u6708\u306e\u7121\u6599\u5206\uff08\u5168\u4f53\u3067' + MONTH_LIMIT + '\u56de\uff09\u306b\u9054\u3057\u307e\u3057\u305f\u3002\u6765\u6708\u304b\u3089\u4f7f\u3048\u307e\u3059'), { code: 'limit' });
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?' + new URLSearchParams({ q, country: 'JP', search_lang: 'jp', count: String(count || 20) }), { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Brave \u306e API\u30ad\u30fc\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093\uff08' + r.status + '\uff09'), { code: 'key' });
    if (r.status === 429) throw Object.assign(new Error('Brave \u306e\u691c\u7d22\u56de\u6570\u306e\u4e0a\u9650\u306b\u9054\u3057\u307e\u3057\u305f'), { code: 'limit' });
    if (!r.ok) throw new Error('Brave \u306e\u691c\u7d22\u306b\u5931\u6557\u3057\u307e\u3057\u305f\uff08' + r.status + '\uff09');
    await useQuota(1);
    const d = await r.json();
    return ((d.web || {}).results || []).map(x => ({ url: x.url, title: decode(String(x.title || '').replace(/<[^>]+>/g, '')) }));
  }
  return { routes, run, docChars, braveWeb, MONTH_LIMIT, ownHosts: async () => (await excluded()) };
};
