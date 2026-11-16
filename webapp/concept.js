/**
 * コンセプト（コンテンツ作成。2026-11-13 ユーザー指定）
 *
 * メディアごとに「コンセプト（趣旨・URL・制作目的・求めるもの・コンセプト・CV・目標・記事クオリティ）」「ペルソナ（メディア1つ＋ディレクトリごと）」
 * 「サイトのガイドライン」「競合サイト（Ahrefs。ボタンを押したときだけ）」を持つ。
 * - 保存先：Firestore media_concepts/{sha1('concept|'+メディア)}。直す前の内容は media_concepts/{id}/history に残す
 * - 競合サイトの取得結果：media_concepts/{id}/competitors（取得日時・取得した人・使ったユニット）
 * - 競合サイトKW比較の取得結果：media_concepts/{id}/kwgaps（KWごとの自メディア・競合サイトの順位。2026-11-16 ユーザー指定）
 * - 記事ごとのガイドライン確認：article_guidechecks/{sha1(記事のキー)}（項目IDごとに ok か、未対応の理由）。直す前は history に残す
 *   将来 AI でチェックするので、項目は ID を持つ（by: 'ai' などを足せる形）
 * - 「完了」にできるのは、今のガイドラインの全項目が「チェック済み」か「理由あり」のときだけ（画面の missingFor と PATCH /article-items の両方で止める）
 */
const crypto = require('crypto');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const txt = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n || 3000);
const newId = () => 'g' + crypto.randomBytes(4).toString('hex');
const hostOf = u => { try { return new URL(/^https?:\/\//.test(u) ? u : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } };

/** コンセプトの項目（画面の並び順） */
const CONCEPT_KEYS = [['purpose', '趣旨'], ['url', 'URL'], ['article_purpose', '記事の制作目的'], ['wants', '求めるもの'], ['concept', 'コンセプト'], ['cv_tel', 'CV（電話番号）'], ['cv_form', 'CV（フォーム）'], ['goal', '目標'], ['quality', '記事クオリティ']];
/** ペルソナの項目（構成シートと同じ。outline.js の META_KEYS の persona_*） */
const PERSONA_KEYS = ['persona_gender', 'persona_age', 'persona_income', 'persona_family', 'persona_family_adult', 'persona_family_child', 'persona_family_elder', 'persona_family_total', 'persona_area', 'persona_station', 'persona_home_own', 'persona_home_type', 'persona_home_room', 'persona_home_note', 'persona_move', 'persona_hobby', 'persona_thought', 'persona_worry'];
/** 進行状況が「記事執筆完了」以降の記事にガイドライン確認を出す */
const CHECK_FROM = ['記事執筆完了', '記事チェック中', '記事監修者確認', 'アップロードチェック中', '完了'];

/** ガイドラインの初期値（2026-11-13 ユーザー指定：基本方針8・執筆ルール14・SEO対策視点11・CV向上視点3。メディアごとに画面で直せる） */
const it = (id, title, desc) => ({ id, title, desc });
const DEFAULT_GUIDELINE = {
  sections: [
    { id: 'basic', title: '基本方針', items: [
      it('basic1', '読者ファースト', '読者の悩みを解決することを最優先にし、会社の都合を押し付けない'),
      it('basic2', '正確な情報', '料金・法律・作業方法などは公的機関や一次情報で裏付けを取る'),
      it('basic3', '専門性と経験', '現場の知見・施工事例など、自社ならではの経験を盛り込む（E-E-A-T）'),
      it('basic4', '安全への配慮', '危険を伴う作業は無理をさせず、専門業者への相談を案内する'),
      it('basic5', '中立・公平', '他社や他の方法を根拠なくおとしめない'),
      it('basic6', '著作権の順守', '他サイトの文章・画像を無断で使わない。引用は出典を明記し、必要最小限にする'),
      it('basic7', '景品表示法の順守', '「業界No.1」「最安値」など根拠のない表現・誇大な表現を使わない'),
      it('basic8', 'AIの適切な利用', 'AIで作った文章は事実確認と独自の加筆をし、既存の著作物に似ていないか確認する'),
    ] },
    { id: 'write', title: '執筆ルール', items: [
      it('write1', '結論ファースト', '各見出しの冒頭で結論を先に書く'),
      it('write2', '一文は短く', '一文は60文字程度までを目安にする'),
      it('write3', '表記の統一', '漢字・ひらがな・数字（半角）・単位の表記をメディアのルールにそろえる'),
      it('write4', '専門用語の説明', '専門用語は初めて出たときにかみ砕いて説明する'),
      it('write5', '主語と述語', '主語と述語が対応しているか確認する'),
      it('write6', '文末', '「です・ます」調にそろえ、同じ文末を3回以上続けない'),
      it('write7', '箇条書き・表', '手順や比較は箇条書き・表で見やすくする'),
      it('write8', '根拠の明示', '数字・データには出典（公的機関など）を書く'),
      it('write9', '断定表現', '「必ず」「絶対」など効果を保証する表現を使わない'),
      it('write10', '料金の書き方', '料金は「目安」「税込／税抜」「条件」を明記する'),
      it('write11', '誤字脱字', '公開前に誤字脱字・変換ミスを確認する'),
      it('write12', 'コピペ率', 'コピペチェックで類似率を確認し、基準を超えたら書き直す'),
      it('write13', '画像', '自社撮影・許諾済みの素材だけを使い、代替テキスト（alt）を入れる'),
      it('write14', '構成どおり', '構成シートの見出し・意図から外れていない'),
    ] },
    { id: 'seo', title: 'SEO対策視点', items: [
      it('seo1', '検索意図', '検索KWの意図（知りたいこと・解決したいこと）に答えている'),
      it('seo2', 'タイトル', '検索KWを前半に入れ、32文字前後で内容がわかる'),
      it('seo3', 'ディスクリプション', '検索KWを含め、120文字前後で記事の要点を書く'),
      it('seo4', '見出し構成', 'H2・H3の階層が正しく、見出しだけで内容がわかる'),
      it('seo5', '関連KW・共起語', '関連KW・共起語を自然に含める（詰め込みすぎない）'),
      it('seo6', '網羅性と独自性', '競合上位の記事が扱う内容を押さえたうえで、独自の情報を加える'),
      it('seo7', '内部リンク', '関連する自社記事・サービスページへ内部リンクを張る'),
      it('seo8', '外部リンク', '公的機関など信頼できる情報源へのリンクを入れる'),
      it('seo9', '最新情報', '料金・制度などの情報が最新か確認する'),
      it('seo10', '文字数', '想定文字数・競合の文字数を参考に、過不足がない'),
      it('seo11', 'カニバリ', '同じメディアの既存記事とKW・内容が重複していない'),
    ] },
    { id: 'cv', title: 'CV向上視点', items: [
      it('cv1', 'CTAの配置', '記事の冒頭・途中・まとめにCTA（電話・フォーム）を自然に置く'),
      it('cv2', '相談したくなる流れ', '悩み → 解決策 → 自分でやる難しさ → プロに頼むメリット の流れになっている'),
      it('cv3', '安心材料', '料金の目安・対応エリア・実績・保証など、問い合わせの不安を減らす情報がある'),
    ] },
  ],
  refs: [
    { title: '著作権とは', url: 'https://fungry.co.jp/cnaps/blog/chosakuken/' },
    { title: '著作権（文化庁）', url: 'https://www.bunka.go.jp/seisaku/chosakuken/' },
    { title: '景品表示法（消費者庁）', url: 'https://www.caa.go.jp/policies/policy/representation/fair_labeling/' },
    { title: 'AIと著作権（文化庁）', url: 'https://www.bunka.go.jp/seisaku/chosakuken/pdf/93903601_01.pdf' },
  ],
};
const clone = o => JSON.parse(JSON.stringify(o));

/** 画面から来たガイドラインを整える（項目IDは残す。新しい項目には ID を付ける） */
function cleanGuideline(g) {
  if (!g || !Array.isArray(g.sections)) throw Object.assign(new Error('ガイドラインの形が正しくありません'), { status: 400 });
  const seen = new Set(), uid = v => { let id = typeof v === 'string' && /^[a-z0-9]{2,20}$/.test(v) && !seen.has(v) ? v : newId(); while (seen.has(id)) id = newId(); seen.add(id); return id; };
  const sections = g.sections.slice(0, 20).map(s => ({ id: uid(s && s.id), title: txt(s && s.title, 60).trim() || '（見出しなし）',
    items: (Array.isArray(s && s.items) ? s.items : []).slice(0, 60).map(x => ({ id: uid(x && x.id), title: txt(x && x.title, 100).trim(), desc: txt(x && x.desc, 500).trim() })).filter(x => x.title) }));
  const refs = (Array.isArray(g.refs) ? g.refs : []).slice(0, 20).map(r => ({ title: txt(r && r.title, 100).trim(), url: txt(r && r.url, 500).trim() })).filter(r => r.title && /^https?:\/\//.test(r.url));
  return { sections, refs };
}
const cleanPersona = p => Object.fromEntries(PERSONA_KEYS.map(k => [k, txt((p || {})[k], 2000).trim()]).filter(x => x[1]));
/** 今のガイドラインで、記事のチェックが終わっているか。終わっていない項目を返す */
function guideMissing(guide, check) {
  const items = (check && check.items) || {};
  return guide.sections.flatMap(s => s.items.filter(x => { const c = items[x.id]; return !(c && (c.ok === true || String(c.reason || '').trim())); }).map(x => s.title + '：' + x.title));
}

module.exports = function concept({ db, admin, allowedMedia, capOk, canEditArticles, ownsItem, ahrefsKey, siteUrls, medias }) {
  const col = db.collection('media_concepts'), checks = db.collection('article_guidechecks'), drCol = db.collection('domain_ratings');
  const now = () => admin.firestore.FieldValue.serverTimestamp();
  const iso = v => v && v.toDate ? v.toDate().toISOString() : v || null;
  const idOf = media => sha1('concept|' + media);
  /* 権限（2026-11-13 ユーザー指定：権限管理に項目を足す）。役割がない人はこれまでの権限から判断 */
  const canView = u => capOk(u, 'concept_view', x => !!x.perms && x.perms.articles !== 'none');
  const canEdit = u => capOk(u, 'concept_edit', x => !!x.perms && (x.perms.media === 'admin' || x.perms.articles === 'admin'));
  const okMedia = (u, m) => !!m && medias().includes(m) && allowedMedia(u, m) && u.status === 'active';

  async function load(media) { const s = await col.doc(idOf(media)).get(); return s.exists ? s.data() : null; }
  const guideOf = c => c && c.guideline && Array.isArray(c.guideline.sections) ? c.guideline : clone(DEFAULT_GUIDELINE);
  const pub = (media, c) => ({ media, concept: (c && c.concept) || {}, persona: (c && c.persona) || {}, subs: (c && c.subs) || [], guideline: guideOf(c), guidelineDefault: !(c && c.guideline), marks: (c && c.marks) || [],
    version: (c && c.version) || 0, updatedBy: (c && (c.updatedByName || c.updatedBy)) || '', updatedAt: iso(c && c.updatedAt), siteUrl: siteUrls[media] || '' });

  /** 記事のチェック（ガイドライン確認）が今のガイドラインでそろっているか（PATCH /article-items の「完了」で使う） */
  async function missingFor(key, media) {
    const [c, ck] = await Promise.all([load(media), checks.doc(sha1(key)).get()]);
    return guideMissing(guideOf(c), ck.exists ? ck.data() : null);
  }

  // ---------- Ahrefs（ボタンを押したときだけ。2026-11-13 ユーザー指定） ----------
  async function call(key, path, params) {
    const r = await fetch('https://api.ahrefs.com/v3/' + path + '?' + new URLSearchParams(Object.assign({ output: 'json' }, params)), { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    if (!r.ok) { const m = (() => { try { return JSON.parse(t).error; } catch (e) { return t.slice(0, 200); } })(); throw Object.assign(new Error(r.status === 401 ? 'Ahrefs のAPIキーが正しくありません（401）' : r.status === 403 ? 'このプランではこのAPIが使えないか、権限がありません（403）：' + m : r.status === 429 ? 'Ahrefs の呼び出しが多すぎます（429）。時間をおいてもう一度' : 'Ahrefs API エラー（' + r.status + '）：' + m), { status: r.status }); }
    return t ? JSON.parse(t) : {};
  }
  /** select の項目名が合わないとき（400）は、少ない項目でもう一度 */
  async function callSel(key, path, params, sels) {
    let last; for (const s of sels) { try { return await call(key, path, Object.assign({}, params, { select: s })); } catch (e) { last = e; if (e.status !== 400) throw e; } } throw last;
  }
  const date = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  async function domainRating(key, h) {
    const s = await drCol.doc(h).get().catch(() => null), d = s && s.exists ? s.data() : null;
    if (d && d.at && Date.now() - Date.parse(d.at) < 30 * 86400000) return { dr: d.dr, units: 0 };
    try { const dr = ((await call(key, 'site-explorer/domain-rating', { target: h, date: date() })).domain_rating || {}).domain_rating;
      if (dr != null) { const v = Math.round(dr * 10) / 10; await drCol.doc(h).set({ dr: v, at: new Date().toISOString() }); return { dr: v, units: 1 }; } } catch (e) { /* 取れなければ空欄 */ }
    return { dr: null, units: 1 };
  }
  async function orgTraffic(key, h) {
    try { const m = (await call(key, 'site-explorer/metrics', { target: h, date: date(), mode: 'subdomains' })).metrics || {}; return m.org_traffic != null ? Math.round(m.org_traffic) : null; } catch (e) { return null; }
  }
  /** サイト名：トップページの og:site_name か title */
  async function siteName(h) {
    try {
      const r = await fetch('https://' + h + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BESTMediaDashboard/1.0; +concept)', Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return '';
      const html = Buffer.from(await r.arrayBuffer()).slice(0, 300000).toString('utf8');
      const og = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name/i) || [])[1];
      const t = og || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      return t.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(/\s*[|｜]\s*/)[0].slice(0, 60);
    } catch (e) { return ''; }
  }
  /** (a) 競合サイト：site-explorer の organic competitors（ディレクトリはそのURL配下＝prefix）
   *  KW重複率（2026-11-16 ユーザー指定）＝共通KW数 ÷ 自メディアのKW数（keywords_target）。取れないときは Ahrefs の share */
  async function byOverlap(key, target, isDir) {
    const res = await callSel(key, 'site-explorer/organic-competitors', { target, country: 'jp', date: date(), mode: isDir ? 'prefix' : 'subdomains', limit: 15, order_by: 'keywords_common:desc' },
      ['competitor_domain,keywords_common,keywords_competitor,keywords_target,share,domain_rating,traffic,value', 'competitor_domain,keywords_common,keywords_competitor,keywords_target,share,domain_rating,traffic', 'competitor_domain,keywords_common,share,domain_rating,traffic', 'competitor_domain,keywords_common']);
    const rows = res.competitors || res.organic_competitors || res.domains || [];
    const num = v => v != null && isFinite(v) ? Number(v) : null;
    return rows.map(x => {
      const common = num(x.keywords_common), tgt = num(x.keywords_target), share = num(x.share);
      const rate = common != null && tgt ? Math.round(common / tgt * 1000) / 10 : share != null ? Math.round((share <= 1 ? share * 100 : share) * 10) / 10 : null;
      return { domain: hostOf(x.competitor_domain || x.domain || x.competitor_url || ''), common, kwComp: num(x.keywords_competitor), kwTarget: tgt, rate, share, dr: num(x.domain_rating), traffic: num(x.traffic) != null ? Math.round(x.traffic) : null, value: num(x.value) };
    }).filter(x => x.domain);
  }
  /** (c) 競合サイトKW比較（2026-11-16 ユーザー指定）：競合サイトの順位がついているKWと、自メディア（ディレクトリ）の順位を並べる
   *  organic-keywords を 自メディア1回＋競合サイトごとに1回。行数ぶんユニットを使う */
  async function orgKeywords(key, target, mode, limit) {
    const res = await callSel(key, 'site-explorer/organic-keywords', { target, country: 'jp', date: date(), mode, limit, order_by: 'sum_traffic:desc' },
      ['keyword,volume,keyword_difficulty,best_position,best_position_url,sum_traffic', 'keyword,volume,best_position,best_position_url', 'keyword,best_position']);
    return (res.keywords || res.organic_keywords || []).map(x => ({ kw: String(x.keyword || '').trim(), vol: x.volume != null ? Number(x.volume) : null, kd: x.keyword_difficulty != null ? Number(x.keyword_difficulty) : null, pos: x.best_position != null ? Number(x.best_position) : null, url: x.best_position_url || '', traffic: x.sum_traffic != null ? Math.round(x.sum_traffic) : null })).filter(x => x.kw);
  }
  async function byKwGap(key, ownTarget, isDir, domains, limit) {
    const ownLimit = Math.min(1000, limit * 5);
    const [own, ...comps] = await Promise.all([orgKeywords(key, ownTarget, isDir ? 'prefix' : 'subdomains', ownLimit)].concat(domains.map(d => orgKeywords(key, d, 'subdomains', limit))));
    const nk = s => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const map = {};
    const row = x => (map[nk(x.kw)] = map[nk(x.kw)] || { kw: x.kw, vol: null, kd: null, own: null, ranks: {} });
    comps.forEach((list, i) => list.forEach(x => { const r = row(x); r.ranks[domains[i]] = x.pos; if (r.vol == null) r.vol = x.vol; if (r.kd == null) r.kd = x.kd; }));
    own.forEach(x => { const r = map[nk(x.kw)]; if (r) { r.own = { pos: x.pos, url: x.url }; if (r.vol == null) r.vol = x.vol; } });
    const list = Object.values(map).sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 1500);
    return { list, units: own.length + comps.reduce((a, l) => a + l.length, 0), ownRows: own.length };
  }
  /** (b) 代表KWの検索上位：KWごとに検索上位10件を見て、出てきた回数の多いサイト */
  async function bySerp(key, kws) {
    const agg = {};
    for (const kw of kws) {
      let res; try { res = await callSel(key, 'serp-overview/serp-overview', { keyword: kw, country: 'jp', top_positions: 10 }, ['position,url,domain_rating', 'position,url']); } catch (e) { if (e.status === 401 || e.status === 403) throw e; continue; }
      (res.positions || []).forEach(p => { const h = hostOf(p.url || ''); if (!h || !p.position || p.position > 10) return; const a = agg[h] = agg[h] || { domain: h, hits: 0, best: 99, kws: [], dr: null }; a.hits++; a.best = Math.min(a.best, p.position); if (!a.kws.includes(kw)) a.kws.push(kw); if (p.domain_rating != null) a.dr = p.domain_rating; });
    }
    return Object.values(agg).sort((a, b) => b.hits - a.hits || a.best - b.best);
  }
  async function fetchCompetitors({ media, sub, method, kws, dirUrl, user, domains, limit, names: names0 }) {
    let key = ''; try { key = await ahrefsKey(); } catch (e) { key = ''; }
    if (!key) throw Object.assign(new Error('Ahrefs のAPIキーが登録されていません（管理 → API・連携設定）'), { status: 400 });
    const own = new Set(Object.values(siteUrls).map(hostOf));
    const isOwn = h => own.has(h) || [...own].some(o => h.endsWith('.' + o) || o.endsWith('.' + h));
    let list;
    if (method === 'kwgap') {
      const target = sub ? String(dirUrl || '').trim() : siteUrls[media];
      if (!target || !/^https?:\/\//.test(target)) throw Object.assign(new Error(sub ? 'ディレクトリのURL（https://〜）を入れてから取得してください' : 'メディアのURLがわかりません'), { status: 400 });
      const ds = [...new Set((Array.isArray(domains) ? domains : []).map(hostOf).filter(Boolean))].filter(h => !isOwn(h)).slice(0, 5);
      if (!ds.length) throw Object.assign(new Error('くらべる競合サイトを選んでください（最大5つ）'), { status: 400 });
      const lim = [100, 300, 500].includes(Number(limit)) ? Number(limit) : 100;
      const g = await byKwGap(key, target.replace(/^https?:\/\//, ''), !!sub, ds, lim);
      const names = {}; (names0 || []).forEach(x => { if (x && x.domain) names[hostOf(x.domain)] = txt(x.name, 80); });
      const doc = { sub: sub || '', method, at: now(), by: user.email, name: user.name || user.email, domains: ds.map(d => ({ domain: d, name: names[d] || d })), list: g.list, limit: lim, target, kws: [], calls: g.units };
      const ref = col.doc(idOf(media));
      if (!(await ref.get()).exists) await ref.set({ media, version: 0 }, { merge: true });
      const add = await ref.collection('kwgaps').add(doc);   /* 行が多いので competitors とは別に置き、タブを開いたときだけ読む */
      await db.collection('access_logs').add({ uid: user.uid, email: user.email, name: user.name, view: '競合サイトKW比較を取得：' + media + (sub ? '／' + sub : '') + '（' + ds.join('、') + '）', at: now() });
      return Object.assign({ id: add.id }, doc, { at: new Date().toISOString() });
    }
    if (method === 'overlap') {
      const target = sub ? String(dirUrl || '').trim() : siteUrls[media];
      if (!target || !/^https?:\/\//.test(target)) throw Object.assign(new Error(sub ? 'ディレクトリのURL（https://〜）を入れてから取得してください' : 'メディアのURLがわかりません'), { status: 400 });
      list = await byOverlap(key, target.replace(/^https?:\/\//, ''), !!sub);
    } else {
      const ks = (Array.isArray(kws) ? kws : []).map(k => txt(k, 100).trim()).filter(Boolean).slice(0, 10);
      if (!ks.length) throw Object.assign(new Error('代表KWがありません（進行管理に検索KWがある記事がありません）'), { status: 400 });
      list = await bySerp(key, ks); kws = ks;
    }
    /* 上位10件・大手も含む（自社メディアだけ除く）（2026-11-13 ユーザー指定） */
    list = list.filter(x => !isOwn(x.domain)).slice(0, 10);
    let units = 0;
    await Promise.all(list.map(async x => {
      if (x.dr == null) { const d = await domainRating(key, x.domain); x.dr = d.dr; units += d.units; }
      if (x.traffic == null) { x.traffic = await orgTraffic(key, x.domain); units += 1; }
      x.name = await siteName(x.domain) || x.domain;
    }));
    const doc = { sub: sub || '', method, at: now(), by: user.email, name: user.name || user.email, list, kws: method === 'serp' ? kws : [], target: method === 'overlap' ? (sub ? dirUrl : siteUrls[media]) : '', calls: units + (method === 'serp' ? kws.length : 1) };
    const ref = col.doc(idOf(media));
    if (!(await ref.get()).exists) await ref.set({ media, version: 0 }, { merge: true });
    const add = await ref.collection('competitors').add(doc);
    await db.collection('access_logs').add({ uid: user.uid, email: user.email, name: user.name, view: '競合サイトを取得：' + media + (sub ? '／' + sub : '') + '（' + (method === 'overlap' ? '競合サイト' : '代表KWの検索上位') + '）', at: now() });
    return Object.assign({ id: add.id }, doc, { at: new Date().toISOString() });
  }
  async function latestCompetitors(media) {
    const s = await col.doc(idOf(media)).collection('competitors').orderBy('at', 'desc').limit(60).get(), out = {};
    s.docs.forEach(d => { const x = d.data(), k = (x.sub || '') + '|' + x.method; if (!out[k]) out[k] = Object.assign({ id: d.id }, x, { at: iso(x.at) }); });
    return Object.values(out);
  }

  function routes(api) {
    // コンセプトを見る
    api.get('/concept', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        if (!okMedia(req.user, media) || !canView(req.user)) return res.status(403).json({ error: 'このメディアのコンセプトを見る権限がありません' });
        const c = await load(media);
        res.json(Object.assign(pub(media, c), { canEdit: canEdit(req.user), competitors: await latestCompetitors(media), keys: CONCEPT_KEYS }));
      } catch (e) { next(e); }
    });
    // 保存（送られた部分だけ置き換える。ほかの人が先に保存していたら止める。直す前は history に残す）
    api.put('/concept', async (req, res, next) => {
      try {
        const b = req.body || {}, media = String(b.media || '');
        if (!okMedia(req.user, media) || !canEdit(req.user)) return res.status(403).json({ error: 'コンセプトを編集する権限がありません' });
        const ref = col.doc(idOf(media)), cur = (await ref.get()).data() || {};
        if (b.version != null && Number(b.version) !== (cur.version || 0)) return res.status(409).json({ error: (cur.updatedByName || 'ほかの人') + 'が先に保存しました。画面を読み込み直してから、もう一度直してください' });
        const upd = {}, what = [];
        if (b.concept) { upd.concept = Object.fromEntries(CONCEPT_KEYS.map(([k]) => [k, txt(b.concept[k], 3000).trim()]).filter(x => x[1])); what.push('コンセプト'); }
        if (b.persona) { upd.persona = cleanPersona(b.persona); what.push('メディアのペルソナ'); }
        if (b.subs) { upd.subs = (Array.isArray(b.subs) ? b.subs : []).slice(0, 50).map(s => ({ sub: txt(s && s.sub, 60).trim(), url: /^https?:\/\//.test(String((s && s.url) || '').trim()) ? txt(s.url, 500).trim() : '', persona: cleanPersona(s && s.persona) })).filter(s => s.sub); what.push('ディレクトリ'); }
        if (b.guideline === null) { upd.guideline = admin.firestore.FieldValue.delete(); what.push('ガイドライン（初期値に戻す）'); }
        else if (b.guideline) { upd.guideline = cleanGuideline(b.guideline); what.push('ガイドライン'); }
        if (b.marks) { upd.marks = (Array.isArray(b.marks) ? b.marks : []).slice(0, 500).map(m => ({ domain: hostOf((m && m.domain) || ''), mark: ['exclude', 'star'].includes(m && m.mark) ? m.mark : '' })).filter(m => m.domain && m.mark); what.push('競合サイトの印'); }
        if (!what.length) return res.status(400).json({ error: '保存する内容がありません' });
        const who = req.user.name || req.user.email;
        Object.assign(upd, { media, version: (cur.version || 0) + 1, updatedBy: req.user.email, updatedByName: who, updatedAt: now() });
        await ref.collection('history').add({ at: now(), by: req.user.email, name: who, what, before: { concept: cur.concept || null, persona: cur.persona || null, subs: cur.subs || null, guideline: cur.guideline || null, marks: cur.marks || null } });
        await ref.set(upd, { merge: true });
        if (!b.marks || what.length > 1) await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'コンセプトを保存：' + media + '（' + what.join('・') + '）', at: now() });
        res.json(Object.assign(pub(media, (await ref.get()).data()), { canEdit: true }));
      } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
    });
    // 競合サイトを取得（Ahrefs。ボタンを押したときだけ）
    api.post('/concept/competitors', async (req, res) => {
      try {
        const b = req.body || {}, media = String(b.media || '');
        if (!okMedia(req.user, media) || !canEdit(req.user)) return res.status(403).json({ error: '競合サイトを取得する権限がありません' });
        if (!['overlap', 'serp', 'kwgap'].includes(b.method)) return res.status(400).json({ error: '取得のしかたが正しくありません' });
        res.json({ result: await fetchCompetitors({ media, sub: txt(b.sub, 60).trim(), method: b.method, kws: b.kws, dirUrl: b.dirUrl, user: req.user, domains: b.domains, limit: b.limit, names: b.names }) });
      } catch (e) { res.status(e.status && e.status < 500 ? e.status : 400).json({ error: e.message }); }
    });
    // 競合サイトKW比較：メディア（＋ディレクトリ）ごとの最新の取得結果（2026-11-16 ユーザー指定）
    api.get('/concept/kwgap', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        if (!okMedia(req.user, media) || !canView(req.user)) return res.status(403).json({ error: 'このメディアのコンセプトを見る権限がありません' });
        const s = await col.doc(idOf(media)).collection('kwgaps').orderBy('at', 'desc').limit(40).get(), out = {};
        s.docs.forEach(d => { const x = d.data(), k = x.sub || ''; if (!out[k]) out[k] = Object.assign({ id: d.id }, x, { at: iso(x.at) }); });
        res.json({ results: Object.values(out) });
      } catch (e) { next(e); }
    });
    // 構成シートの「ペルソナをコピー」（メディアから／ディレクトリから）
    api.get('/concept/personas', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        if (!okMedia(req.user, media) || !req.user.perms || req.user.perms.articles === 'none') return res.status(400).json({ error: 'メディアの指定が正しくありません' });
        const c = await load(media) || {};
        res.json({ media: c.persona || {}, subs: (c.subs || []).filter(s => Object.keys(s.persona || {}).length).map(s => ({ sub: s.sub, persona: s.persona })) });
      } catch (e) { next(e); }
    });
    // ガイドライン確認：見られるメディアの今のガイドラインと、記事ごとのチェック
    api.get('/guide-checks', async (req, res, next) => {
      try {
        if (!req.user.perms || req.user.perms.articles === 'none') return res.status(403).json({ error: '権限がありません' });
        const ms = medias().filter(m => allowedMedia(req.user, m)), guides = {}, out = {};
        const cs = await Promise.all(ms.map(m => load(m)));
        ms.forEach((m, i) => { guides[m] = guideOf(cs[i]); });
        const snap = await checks.get();
        snap.docs.forEach(d => { const x = d.data(); if (x.key && ms.includes(x.media)) out[x.key] = { items: x.items || {}, by: x.byName || x.by || '', at: iso(x.at) }; });
        res.json({ guides, checks: out, from: CHECK_FROM });
      } catch (e) { next(e); }
    });
    api.put('/guide-checks', async (req, res, next) => {
      try {
        if (!canEditArticles(req.user)) return res.status(403).json({ error: '記事を編集する権限がありません' });
        const b = req.body || {}, key = String(b.key || ''), media = String(b.media || '');
        if (!key || !okMedia(req.user, media) || (!key.startsWith('entry:') && key.split('|')[0] !== media)) return res.status(400).json({ error: '記事の指定が正しくありません' });
        if (key.startsWith('entry:')) { const s = await db.collection('article_entries').doc(key.slice(6)).get(); if (!s.exists || s.data().media !== media) return res.status(404).json({ error: '記事が見つかりません' }); }
        if (req.user.perms.own && !(await ownsItem(req.user, key))) return res.status(403).json({ error: '自分が担当の記事だけチェックできます' });
        const guide = guideOf(await load(media)), ids = new Set(guide.sections.flatMap(s => s.items.map(x => x.id))), items = {};
        Object.entries(b.items || {}).forEach(([id, v]) => { if (!ids.has(id) || !v) return; const reason = txt(v.reason, 500).trim(); if (v.ok === true) items[id] = { ok: true, by: 'human' }; else if (reason) items[id] = { ok: false, reason, by: 'human' }; });
        const ref = checks.doc(sha1(key)), cur = await ref.get(), who = req.user.name || req.user.email;
        /* 今のガイドラインにない項目（消した項目）のチェックも残しておく（ガイドラインを戻したときのため） */
        const keep = cur.exists ? Object.fromEntries(Object.entries(cur.data().items || {}).filter(([id]) => !ids.has(id))) : {};
        if (cur.exists) await ref.collection('history').add({ at: now(), by: req.user.email, name: who, before: cur.data().items || {} });
        await ref.set({ key, media, items: Object.assign(keep, items), by: req.user.email, byName: who, at: now() });
        res.json({ ok: true, items: Object.assign(keep, items), missing: guideMissing(guide, { items }) });
      } catch (e) { next(e); }
    });
  }
  return { routes, missingFor, CHECK_FROM, _test: { cleanGuideline, guideMissing, DEFAULT_GUIDELINE } };
};
module.exports.DEFAULT_GUIDELINE = DEFAULT_GUIDELINE;
module.exports.CHECK_FROM = CHECK_FROM;
