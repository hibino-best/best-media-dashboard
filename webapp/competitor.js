/**
 * 競合調査（構成シートの「競合調査」タブ。2026-11-13 ユーザー指定）
 *
 * 記事の検索KWを Brave で検索し、上位の「コンテンツとみなせるページ」（地図・SNS・通販・データベース系などは除く）を5件まで開いて、
 * 見出し（H1〜H4）と本文の文字数を読む。結果は article_outlines/{id}/competitors に、取得日時・取得した人・使った検索回数・費用と一緒に残す。
 * - Brave の無料分はアカウント全体で月 約1,000回（コピペチェックと同じ数え方。copycheck.js の braveWeb）
 * - メディアごとに今月の上限（初期値 50回。API・連携設定で変えられる）。超えたらそのメディアは今月使えない
 * - 費用は Brave の料金（1,000回あたり5ドル＝1回0.005ドル）で記録。無料分の中でも、いくらぶん使ったかが分かるように
 */
const crypto = require('crypto');
const TOP = 5, PRICE_USD = 0.005, DEFAULT_LIMIT = 50;
const ymNow = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
/** コンテンツとみなさないサイト（地図・SNS・動画・通販・比較／口コミのデータベース・電話帳など）（2026-11-13 ユーザー指定） */
const NON_CONTENT = ['google.com', 'google.co.jp', 'goo.gl', 'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'threads.net', 'pinterest.com', 'pinterest.jp', 'line.me', 'linkedin.com', 'note.com/hashtag',
  'amazon.co.jp', 'amazon.com', 'rakuten.co.jp', 'shopping.yahoo.co.jp', 'auctions.yahoo.co.jp', 'paypaymall.yahoo.co.jp', 'store.shopping.yahoo.co.jp', 'mercari.com', 'jp.mercari.com', 'kakaku.com', 'monotaro.com', 'askul.co.jp', 'lohaco.yahoo.co.jp', 'yodobashi.com', 'biccamera.com', 'qoo10.jp', 'aliexpress.com', 'temu.com', 'shein.com',
  'maps.apple.com', 'navitime.co.jp', 'mapion.co.jp', 'its-mo.com', 'zenrin.co.jp', 'itp.ne.jp', 'ekiten.jp', 'tabelog.com', 'hotpepper.jp', 'beauty.hotpepper.jp', 'retty.me', 'jalan.net', 'gurunavi.com', 'r.gnavi.co.jp', 'minkou.jp', 'homes.co.jp', 'suumo.jp', 'athome.co.jp',
  'indeed.com', 'jp.indeed.com', 'townwork.net', 'baitoru.com', 'mynavi.jp', 'rikunabi.com', 'doda.jp', 'en-japan.com', 'wantedly.com', 'zehitomo.com', 'meetsmore.com', 'curama.jp', 'minnano-kuchikomi.com',
  'apps.apple.com', 'play.google.com', 'wikipedia.org', 'weblio.jp', 'kotobank.jp', 'chiebukuro.yahoo.co.jp', 'detail.chiebukuro.yahoo.co.jp', 'oshiete.goo.ne.jp', 'okwave.jp', 'jpo.go.jp', 'j-platpat.inpit.go.jp'];
const KNOWN_NAMES = { 'youtube.com': 'YouTube', 'x.com': 'X', 'twitter.com': 'X', 'facebook.com': 'Facebook', 'instagram.com': 'Instagram', 'tiktok.com': 'TikTok', 'amazon.co.jp': 'Amazon', 'rakuten.co.jp': '楽天市場', 'shopping.yahoo.co.jp': 'Yahoo!ショッピング', 'monotaro.com': 'モノタロウ', 'askul.co.jp': 'アスクル', 'kakaku.com': '価格.com', 'google.com': 'Google', 'tabelog.com': '食べログ', 'ekiten.jp': 'エキテン', 'itp.ne.jp': 'iタウンページ', 'chiebukuro.yahoo.co.jp': 'Yahoo!知恵袋', 'detail.chiebukuro.yahoo.co.jp': 'Yahoo!知恵袋', 'ja.wikipedia.org': 'Wikipedia', 'mercari.com': 'メルカリ', 'jp.mercari.com': 'メルカリ', 'zehitomo.com': 'Zehitomo', 'meetsmore.com': 'ミツモア', 'curama.jp': 'くらしのマーケット' };
const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } };
const isNonContent = url => { const h = hostOf(url), p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (e) { return ''; } })(); if (!h) return true; if (/\.(pdf|xlsx?|docx?|pptx?|zip)$/.test(p)) return true; return NON_CONTENT.some(d => d.includes('/') ? (h + p).startsWith(d) : h === d || h.endsWith('.' + d)); };
const decode = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
const textOf = h => decode(String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 1ページを読んで、見出しと本文の文字数を出す */
async function readPage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BESTMediaDashboard/1.0; +competitor-research)', Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('ページを開けません（' + r.status + '）');
  const ct = r.headers.get('content-type') || ''; if (ct && !/html/i.test(ct)) throw new Error('HTMLのページではありません');
  const buf = Buffer.from(await r.arrayBuffer()).slice(0, 4 * 1024 * 1024);
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1] || (buf.slice(0, 3000).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  if (/^(shift[_-]?jis|sjis|x-sjis|windows-31j|ms932)$/i.test(cs)) cs = 'shift_jis';
  let html; try { html = new TextDecoder(cs.toLowerCase()).decode(buf); } catch (e) { html = buf.toString('utf8'); }
  html = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|form)[\s\S]*?<\/\1>/gi, ' ');
  const title = textOf((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const siteName = textOf((html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name/i) || html.match(/<meta[^>]+name=["']application-name["'][^>]*content=["']([^"']+)/i) || [])[1] || '') || (title.split(/\s*[|｜]\s*|\s+[-－–]\s+/).length > 1 ? title.split(/\s*[|｜]\s*|\s+[-－–]\s+/).pop() : '');
  // 本文の場所：<article> → <main> → class/id に content・entry・post がある塊 → <body>（ヘッダー・メニュー・サイドバー・フッターは除く）
  const body = (html.match(/<article[\s>][\s\S]*<\/article>/i) || html.match(/<main[\s>][\s\S]*<\/main>/i) || html.match(/<body[\s\S]*<\/body>/i) || [html])[0]
    .replace(/<(header|nav|aside|footer)[\s>][\s\S]*?<\/\1>/gi, ' ');
  const heads = []; const re = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  const h1 = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  if (h1 && !/<h1\b/i.test(body)) heads.push({ lv: 1, text: textOf(h1) });
  /* 記事の見出しでないもの（関連記事・人気記事・カテゴリー・コメント・シェア・プロフィールなどのサイドバーや記事下の部品）は除く */
  const NOT_HEAD = /^(関連記事|関連する記事|人気記事|人気の記事|おすすめ記事|おすすめの記事|新着記事|最新記事|最近の投稿|カテゴリー?|アーカイブ|タグ|タグ一覧|コメント|コメントを残す|この記事をシェア|シェアする|プロフィール|この記事を書いた人|この記事の監修者|目次|検索|メニュー|お問い合わせ|you may also like|related( posts| articles)?|popular( posts)?|recent posts|categor(y|ies)|archives?|tags?|share|comments?|leave a reply|search|menu)[\s:：!！…]*$/i;
  while ((m = re.exec(body)) && heads.length < 150) { const t = textOf(m[2]); if (t && t.length <= 200 && !NOT_HEAD.test(t)) heads.push({ lv: Number(m[1]), text: t }); }
  const chars = [...textOf(body).replace(/\s/g, '')].length;
  if (chars < 300 && heads.length < 2) throw new Error('本文が読み取れません');
  return { title, siteName: siteName.slice(0, 80), chars, heads };
}

module.exports = function competitor({ db, admin, braveWeb, ownHosts, ahrefsKey, onChanged }) {
  /** ドメインパワー＝Ahrefs のドメインレーティング（DR。0〜100）（2026-11-13 ユーザー指定）。1ドメイン50ユニット。同じドメインは30日間 Firestore の domain_ratings を使う */
  const drCol = db.collection('domain_ratings');
  async function domainRatings(hosts) {
    const out = {}; let units = 0; const list = [...new Set(hosts.filter(Boolean))];
    const need = [];
    await Promise.all(list.map(async h => { const s = await drCol.doc(h).get().catch(() => null); const d = s && s.exists ? s.data() : null; if (d && d.at && Date.now() - Date.parse(d.at) < 30 * 86400000) out[h] = d.dr; else need.push(h); }));
    if (!need.length) return { out, units };
    let key = ''; try { key = ahrefsKey ? await ahrefsKey() : ''; } catch (e) { key = ''; }
    if (!key) return { out, units };
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const h of need) {
      try {
        const r = await fetch('https://api.ahrefs.com/v3/site-explorer/domain-rating?' + new URLSearchParams({ target: h, date }), { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const dr = ((await r.json()).domain_rating || {}).domain_rating; units += 50;
        if (dr != null) { out[h] = Math.round(dr * 10) / 10; await drCol.doc(h).set({ dr: out[h], at: new Date().toISOString() }); }
      } catch (e) { /* 取れなければ空欄 */ }
    }
    return { out, units };
  }
  const setRef = db.collection('settings').doc('competitor');
  const now = () => admin.firestore.FieldValue.serverTimestamp();
  const iso = v => v && v.toDate ? v.toDate().toISOString() : v || null;
  const mkey = m => crypto.createHash('sha1').update(m).digest('hex').slice(0, 12);   // Firestore のフィールド名にメディア名を使わない
  async function conf() { const s = await setRef.get(); return s.exists ? s.data() : {}; }
  const limitOf = (c, media) => { const v = (c.limits || {})[mkey(media)]; return v == null ? (c.defaultLimit != null ? c.defaultLimit : DEFAULT_LIMIT) : v; };
  const usedOf = (c, media, ym) => (((c.usage || {})[ym || ymNow()] || {})[mkey(media)] || {});

  /** 取得（KW を Brave で1回検索 → コンテンツのページを上位5件まで読む） */
  async function run({ media, kw, ref, user }) {
    const c = await conf(), ym = ymNow(), u = usedOf(c, media, ym), lim = limitOf(c, media);
    if ((u.queries || 0) >= lim) throw Object.assign(new Error(media + 'は今月の上限（' + lim + '回）に達しました。来月から使えます'), { status: 429 });
    const results = await braveWeb(kw, 20);
    const own = new Set(await ownHosts().catch(() => [])), skipped = [], picked = [];
    const cand = results.filter(x => { if (isNonContent(x.url)) { skipped.push({ url: x.url, why: 'コンテンツでない' }); return false; } return true; });
    for (const x of cand) {
      if (picked.length >= TOP) break;
      try { const pg = await readPage(x.url); picked.push(Object.assign({ rank: results.indexOf(x) + 1, url: x.url, own: own.has(hostOf(x.url)) || [...own].some(o => hostOf(x.url).endsWith('.' + o)) }, pg, { title: pg.title || x.title })); }
      catch (e) { skipped.push({ url: x.url, why: e.message }); }
    }
    const costUsd = PRICE_USD;
    // メディア名（サイト名）とドメインパワー（除いたページも）
    const dr = await domainRatings(picked.map(p => hostOf(p.url)).concat(skipped.slice(0, 30).map(k => hostOf(k.url))));
    picked.forEach(p => { p.domain = hostOf(p.url); p.dr = dr.out[p.domain] != null ? dr.out[p.domain] : null; if (!p.siteName) p.siteName = KNOWN_NAMES[p.domain] || p.domain; });
    skipped.forEach(k => { k.domain = hostOf(k.url); k.dr = dr.out[k.domain] != null ? dr.out[k.domain] : null; k.siteName = KNOWN_NAMES[k.domain] || KNOWN_NAMES[k.domain.split('.').slice(-2).join('.')] || k.domain; });
    const avg = picked.length ? Math.round(picked.reduce((a, p) => a + p.chars, 0) / picked.length) : null;
    const doc = { kw, media, at: now(), by: user.email, name: user.name || user.email, queries: 1, costUsd, ahrefsUnits: dr.units, sites: picked, avgChars: avg, skipped: skipped.slice(0, 30), ym };
    const add = await ref.collection('competitors').add(doc);
    await setRef.set({ usage: { [ym]: { [mkey(media)]: { media, queries: admin.firestore.FieldValue.increment(1), costUsd: admin.firestore.FieldValue.increment(costUsd), ahrefsUnits: admin.firestore.FieldValue.increment(dr.units) } } } }, { merge: true });
    if (onChanged) onChanged();   // 支出（ツール利用費）の集計を新しくする
    await db.collection('competitor_runs').add({ at: now(), media, kw, by: user.email, queries: 1, costUsd, ahrefsUnits: dr.units, sites: picked.length });
    return Object.assign({ id: add.id }, doc, { at: new Date().toISOString() });
  }
  async function latest(ref) {
    const s = await ref.collection('competitors').orderBy('at', 'desc').limit(5).get();
    return s.docs.map(d => Object.assign({ id: d.id }, d.data(), { at: iso(d.data().at) }));
  }
  /** メディアの今月の使用量 */
  async function usage(media) { const c = await conf(), u = usedOf(c, media); return { media, ym: ymNow(), queries: u.queries || 0, costUsd: Math.round((u.costUsd || 0) * 1000) / 1000, ahrefsUnits: u.ahrefsUnits || 0, limit: limitOf(c, media), priceUsd: PRICE_USD }; }

  function adminRoutes(adminApi, medias) {
    adminApi.get('/competitor', async (req, res, next) => {
      try {
        const c = await conf(), ym = ymNow(), prev = (() => { const d = new Date(ym + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
        res.json({ ym, prev, priceUsd: PRICE_USD, defaultLimit: c.defaultLimit != null ? c.defaultLimit : DEFAULT_LIMIT, top: TOP, nonContent: NON_CONTENT,
          rows: medias().map(m => ({ media: m, limit: limitOf(c, m), limitSet: (c.limits || {})[mkey(m)] != null, now: usedOf(c, m, ym), prev: usedOf(c, m, prev) })) });
      } catch (e) { next(e); }
    });
    adminApi.put('/competitor', async (req, res, next) => {
      try {
        const b = req.body || {}, limits = {};
        Object.entries(b.limits || {}).forEach(([m, v]) => { const n = Number(v); if (v !== '' && v != null && isFinite(n) && n >= 0 && n <= 1000) limits[mkey(m)] = Math.round(n); });
        await setRef.set({ limits }, { mergeFields: ['limits'] });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  /** 支出（ツール利用費）に入れる行：メディアごと・月ごとの Brave の費用（ドル）を、その月の月末のレートで円に（2026-11-13 ユーザー指定：今から支出に入れる） */
  async function costRows(usdJpy) {
    const c = await conf(), out = [];
    for (const [ym, o] of Object.entries(c.usage || {})) {
      let fx; try { fx = await usdJpy(ym); } catch (e) { continue; }
      Object.values(o || {}).forEach(u => { if (u && u.media && u.costUsd > 0) out.push({ ym, media: u.media, block: '', item: 'cost_tool', value: u.costUsd * fx.rate, sub: 'brave-competitor', usd: u.costUsd }); });
    }
    return out;
  }
  return { run, latest, usage, adminRoutes, costRows, _test: { readPage, isNonContent } };
};
