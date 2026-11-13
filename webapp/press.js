// プレスリリース（2026-10-31 ユーザー指定）
// 元：プレスリリースのシート（1INIPILlxqCqPMbnTpc4AVUoV-RLl7EyNlQOCxgq01EA）の「スケジュール◯年◯月〜◯月」のタブ
//   GAS sheet_peek.gs の importPressSheetRaw（手動）で BigQuery press_sheet_raw にそのまま入れたものを、ここで読み取る
// ・担当者（だれのリリースか）はシートにないので、各メディアのディレクション担当（画面で補う）。画面で直した担当は Firestore press_overrides
// ・支出（プレスリリース費）：調査費（スクリーニング＋アンケート）はそのリリースのメディア、配信の月額（リリース費）はその月に配信したメディアで本数に応じて分ける
const SKIP_TAB = /成果まとめ|中止|^×|修正前|アワード|下部|REsta/;
const SUBS_365 = [['水回り', /水回り/], ['カギ', /カギ/], ['電気設備', /電気/], ['外壁屋根', /屋根|外壁/]];
const SUBS_GC = ['ハチ', 'コウモリ', 'ネズミ', 'シロアリ', 'その他害獣'];
const yenOf = v => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };

/** シートのメディア名 → ダッシュボードのメディア・ディレクトリ。「→」があれば移った先 */
function mapMedia(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^※/.test(s));
  const t = (lines.find(s => /^→/.test(s)) || lines[0] || '').replace(/^→/, '').trim();
  if (!t) return { media: '', sub: '' };
  if (/くらしのレスキュー|epark/i.test(t)) return { media: '__kurashi', sub: '' };
  if (/^BEST365/.test(t)) { const s = SUBS_365.find(([, re]) => re.test(t)); return { media: 'BEST365', sub: s ? s[0] : '' }; }
  if (/害虫害獣コンシェルジュ/.test(t)) return { media: '害虫害獣コンシェルジュ', sub: SUBS_GC.find(s => t.includes(s)) || '' };
  if (/屋根外壁|屋根お助け|外壁お助け/.test(t)) return { media: '屋根外壁お助け', sub: /屋根お助け/.test(t) ? '屋根' : /外壁お助け/.test(t) ? '外壁' : '' };
  const M = [['水まわり', '水まわりお助け'], ['カギ', 'カギお助け'], ['ガラス', 'ガラスお助け'], ['シロアリお助け', 'シロアリお助け'], ['害獣お助け', '害獣お助け'], ['ハチお助け', 'ハチお助け'], ['生活お助け', '生活お助け']];
  const hit = M.find(([k]) => t.includes(k));
  return { media: hit ? hit[1] : '', sub: '' };
}

/** 画面で入れられる項目：担当（進行・構成・ライティング＝owner・画像・アップロード）、URL（構成・ライティング・アップロード＝公開）、画像枚数 */
const EDIT_FIELDS = ['manager', 'outlineOwner', 'owner', 'imageOwner', 'uploadOwner', 'outlineUrl', 'draftUrl', 'url', 'imageCount', 'billYm', 'deleted', 'status', 'no', 'chars', 'sub'];   /* sub：ディレクトリ（画面で選べる。2026-11-02） */   /* status：状態（プルダウン）、no：No.（画面で直せる）（2026-11-02） */   /* deleted：画面で削除（シートの行は隠すだけ。2026-11-02） */   /* billYm：報酬を数える月（シートの請求月に合わせる。2026-11-02） */
module.exports = function press({ db, query, T, todayJst, docChars }) {
  let filling = false;
  /** 公開済みで原稿があり、文字数がまだのリリースを少しずつ数えて press_chars に保存（1回6件まで。読めなかったものは1日あけて読み直す） */
  async function fillChars(list, have) {
    if (filling || !docChars) return; filling = true;
    try {
      const todo = list.filter(x => x.published && /docs\.google\.com\/document/.test(x.draftUrl) && !(have[x.id] && (have[x.id].chars || (have[x.id].errorAt && Date.now() - Date.parse(have[x.id].errorAt) < 864e5)))).slice(0, 6);
      for (const x of todo) {
        try { const n = await docChars(x.draftUrl); await db.collection('press_chars').doc(encodeURIComponent(x.id)).set({ chars: n, url: x.draftUrl, at: new Date().toISOString() }); }
        catch (e) { await db.collection('press_chars').doc(encodeURIComponent(x.id)).set({ error: String(e.message).slice(0, 200), errorAt: new Date().toISOString(), url: x.draftUrl }); }
      }
      if (todo.length) cache = null;
    } finally { filling = false; }
  }
  let titling = false;
  /** 公開されたプレスリリース（PR TIMES）のページのタイトルを取って press_titles に保存（1回8件まで）（2026-11-02 ユーザー指定） */
  async function fillTitles(todo) {
    if (titling || !todo.length) return; titling = true;
    try {
      for (const x of todo.slice(0, 8)) {
        try {
          const r = await fetch(x.url, { headers: { 'User-Agent': 'Mozilla/5.0 (BEST MEDIA dashboard)' }, redirect: 'follow' });
          const html = await r.text(), m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<title>([^<]+)<\/title>/i);
          const dec = t => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s*[|｜]\s*.*?(株式会社|PR TIMES).*$/, '').trim();
          if (!m) throw new Error('タイトルが見つかりません');
          await db.collection('press_titles').doc(encodeURIComponent(x.id)).set({ title: dec(m[1]).slice(0, 300), url: x.url, at: new Date().toISOString() });
        } catch (e) { await db.collection('press_titles').doc(encodeURIComponent(x.id)).set({ error: String(e.message).slice(0, 200), errorAt: new Date().toISOString(), url: x.url }); }
      }
      cache = null;
    } finally { titling = false; }
  }
  let cache = null;
  /** シートの行 → リリースの一覧（画面で直した担当も入れる） */
  async function items() {
    if (cache && cache.until > Date.now()) return cache.v;
    let rows = []; try { rows = await query('SELECT tab, row_no, cells FROM ' + T('press_sheet_raw')); } catch (e) { return []; }
    const byTab = {}; rows.forEach(r => { if (!SKIP_TAB.test(String(r.tab).trim())) (byTab[r.tab] = byTab[r.tab] || []).push({ n: Number(r.row_no), c: JSON.parse(r.cells || '[]') }); });
    const out = [], fees = [];
    Object.entries(byTab).forEach(([tab, rs]) => {
      rs.sort((a, b) => a.n - b.n);
      const h = rs.find(r => r.c.includes('メディア') && r.c.some(x => /リリース日/.test(x))); if (!h) return;
      const col = re => h.c.findIndex(x => re.test(String(x).replace(/\s/g, '')));
      const C = { consult: col(/ディレクター相談/), media: col(/^メディア$/), no: col(/^No/), title: col(/^タイトル$/), kind: col(/^データお渡し/), scr: col(/スクリーニング費用/), svy: col(/アンケート費用/), outline: col(/^構成案$/), draft: col(/^原稿/), url: col(/^(公開URL|URL)$/), date: col(/^リリース日$/) };
      const ym0 = String(tab).match(/(\d{4})年(\d{1,2})月/), y0 = ym0 ? Number(ym0[1]) : 2025, m0 = ym0 ? Number(ym0[2]) : 1;
      const yOf = mo => mo - m0 < -6 ? y0 + 1 : y0;   // 年をまたぐタブ（11月〜1月など）
      const g = (r, k) => C[k] >= 0 ? String(r.c[C[k]] || '').trim() : '';
      let ended = false;
      rs.filter(r => r.n > h.n).forEach(r => {
        const raw = g(r, 'media');
        if (r.c.slice(0, 8).some(x => /^(合計|全体)$/.test(String(x).trim()))) ended = true;   // 下の集計表から先（予定の表のくり返しなど）はリリースとして読まない
        // 下の集計表：「リリース費」の月額
        const lab = r.c.map(x => String(x).trim());
        const fi = lab.findIndex(x => x === 'リリース費');
        if (fi >= 0) { const mm2 = lab.slice(fi + 1).join(' ').match(/[¥￥]\s*([\d,]+)/); const amt = mm2 ? Number(mm2[1].replace(/,/g, '')) : 0; if (amt) fees.push({ tab, y0, m0, amount: amt }); return; }
        if (ended) return;
        if (!raw || /^(全体|スクリーニング|アンケート|データお渡し|トータル)$/.test(raw)) return;
        const ds = [...g(r, 'date').matchAll(/(\d{1,2})\/(\d{1,2})/g)].pop();   // 「4/23→4/24」は後ろの日
        const date = ds ? yOf(Number(ds[1])) + '-' + String(ds[1]).padStart(2, '0') + '-' + String(ds[2]).padStart(2, '0') : '';
        const url = g(r, 'url'), mm = mapMedia(raw);
        const cm = g(r, 'consult').match(/[（(]\s*([^）)]+?)\s*[）)]/), sheetOwner = cm ? cm[1].replace(/さん$/, '').trim() : '';   // 「〇（幸谷さん）」＝ディレクション担当
        out.push({ sheetOwner, id: String(tab).trim() + '#' + r.n, tab: String(tab).trim(), row: r.n, mediaRaw: raw, media: mm.media, sub: mm.sub, no: g(r, 'no'), title: g(r, 'title'), kind: g(r, 'kind'),
          scr: yenOf(g(r, 'scr')), svy: yenOf(g(r, 'svy')), outlineUrl: /^http/.test(g(r, 'outline')) ? g(r, 'outline') : '', draftUrl: /^http/.test(g(r, 'draft')) ? g(r, 'draft') : '',
          url: /^http/.test(url) ? url : '', date, published: /^http/.test(url) });
      });
    });
    // 月額（リリース費）：タブの期間の月ごと
    const feeByYm = {};
    fees.forEach(f => { const m2 = (String(f.tab).match(/～\s*(?:(\d{4})年)?(\d{1,2})月/) || []); const y2 = m2[1] ? Number(m2[1]) : (Number(m2[2]) < f.m0 ? f.y0 + 1 : f.y0), mo2 = m2[2] ? Number(m2[2]) : f.m0;
      for (let y = f.y0, m = f.m0; y < y2 || (y === y2 && m <= mo2); m === 12 ? (y++, m = 1) : m++) feeByYm[y + '-' + String(m).padStart(2, '0')] = f.amount; });
    // 画面で追加したリリース（2026-10-31 ユーザー指定）
    try { (await db.collection('press_entries').get()).docs.forEach(d => { const e = d.data(); out.push(Object.assign({ id: 'entry:' + d.id, tab: '画面で追加', row: 0, mediaRaw: '', sheetOwner: '', kind: '', scr: 0, svy: 0, outlineUrl: '', draftUrl: '', url: '', added: true }, e, { published: /^http/.test(e.url || '') || e.status === '公開済み' })); }); } catch (e) { /* まだない */ }
    const ov = {}; try { (await db.collection('press_overrides').get()).docs.forEach(d => { ov[d.id] = d.data(); }); } catch (e) { /* まだない */ }
    // 画面で入れた値（担当・URL・画像枚数）はシートより優先（2026-10-31 ユーザー指定）
    out.forEach(x => { const o = ov[encodeURIComponent(x.id)]; if (!o) return; EDIT_FIELDS.forEach(k => { if (o[k] !== undefined) x[k] = o[k]; }); x.ownerBy = o.by || ''; x.published = /^http/.test(x.url || '') || x.status === '公開済み'; });
    const tt = {}; try { (await db.collection('press_titles').get()).docs.forEach(d => { tt[decodeURIComponent(d.id)] = d.data(); }); } catch (e) { /* まだない */ }
    out.forEach(x => { const t = tt[x.id]; if (t && t.url === x.url && t.title) x.prTitle = t.title; });
    fillTitles(out.filter(x => /^https?:\/\/prtimes\.jp\//.test(x.url || '') && !(tt[x.id] && tt[x.id].url === x.url && (tt[x.id].title || (tt[x.id].errorAt && Date.now() - Date.parse(tt[x.id].errorAt) < 864e5))))).catch(e => console.warn('press titles: ' + e.message));
    const ch = {}; try { (await db.collection('press_chars').get()).docs.forEach(d => { ch[decodeURIComponent(d.id)] = d.data(); }); } catch (e) { /* まだない */ }
    out.forEach(x => { const c = ch[x.id]; if (c && c.url === x.draftUrl) { if (c.chars && !(Number(x.chars) > 0)) x.chars = c.chars;   /* 画面で入れた文字数があればそちらを優先（2026-11-02） */ else if (c.error) x.charsError = c.error; } });
    fillChars(out, Object.fromEntries(Object.entries(ch).filter(([id, c]) => (out.find(x => x.id === id) || {}).draftUrl === c.url))).catch(e => console.warn('press chars: ' + e.message));
    const v = { items: out.filter(x => !x.deleted).sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9'))), feeByYm };
    cache = { v, until: Date.now() + 10 * 60 * 1000 };
    return v;
  }
  /** 支出管理で確定したプレスリリース費（PR TIMES・freaaasy）を読む関数（server.js から） */
  let expenseFn = null; const setExpenses = fn => { expenseFn = fn; cache = null; };
  /** リリースごとの調査費・配信費（2026-11-02 ユーザー指定）
   *  配信費：その月の PR TIMES の支出（支出管理で確定）÷ その月に配信したリリースの本数。支出がない月はシートの集計表の「リリース費」（月額）。
   *  調査費：その月の freaaasy の支出があれば、その月のリリースに（シートの調査費の割合、なければ均等で）分ける。なければシートのスクリーニング＋アンケート費用。 */
  async function feePlan() {
    const { items: list, feeByYm } = await items(), today = todayJst();
    let ex = []; try { ex = expenseFn ? await expenseFn() : []; } catch (e) { console.warn('press expenses: ' + e.message); }
    const sum = (ym, k) => ex.filter(x => x.ym === ym && x.kind === k).reduce((a, x) => a + x.amount, 0), has = (ym, k) => ex.some(x => x.ym === ym && x.kind === k);
    const pub = list.filter(x => x.published && x.date && x.date <= today), byYm = {};
    pub.forEach(x => { (byYm[x.date.slice(0, 7)] = byYm[x.date.slice(0, 7)] || []).push(x); });
    const plan = {}, orphan = [];   // orphan：支出はあるのにその月に配信したリリースがない（支出の配分のメディアのまま入れる）
    list.forEach(x => { plan[x.id] = { research: (x.scr || 0) + (x.svy || 0), dist: null, links: [], src: { research: 'sheet', dist: 'sheet' } }; });
    /* 紐づけ（支出のリリース・フェーズ）：紐づけた金額はそのリリースに。紐づけていない残りは、支出の月に配信したリリース（その種類の紐づけがないもの）で分ける */
    const linked = {}, rest = {};   // linked[id][kind]＝紐づけた金額、rest[ym][kind]＝紐づけていない残り
    ex.forEach(x => { let l = 0; x.links.forEach(k => { if (!plan[k.releaseId]) return; ((linked[k.releaseId] = linked[k.releaseId] || {})[x.kind] = (linked[k.releaseId][x.kind] || 0) + k.amount); plan[k.releaseId].links.push({ expenseId: x.id, vendor: x.vendor, kind: x.kind, phase: k.phase, amount: k.amount }); l += k.amount; }); ((rest[x.ym] = rest[x.ym] || {})[x.kind] = (rest[x.ym][x.kind] || 0) + Math.max(0, x.amount - l)); });
    Object.entries(byYm).forEach(([ym, L]) => {
      const free = k => L.filter(x => !(linked[x.id] || {})[k]);
      const dL = free('dist'), dTot = has(ym, 'dist') ? ((rest[ym] || {}).dist || 0) : (feeByYm[ym] || 0); dL.forEach(x => { plan[x.id].dist = dL.length ? dTot / dL.length : 0; if (has(ym, 'dist')) plan[x.id].src.dist = 'expense'; });
      if (has(ym, 'research')) { const rL = free('research'), base = rL.reduce((a, x) => a + (x.scr || 0) + (x.svy || 0), 0), r = (rest[ym] || {}).research || 0; rL.forEach(x => { plan[x.id].research = base > 0 ? r * ((x.scr || 0) + (x.svy || 0)) / base : r / rL.length; plan[x.id].src.research = 'expense'; }); }
    });
    Object.entries(linked).forEach(([id, o]) => { if (o.dist != null) { plan[id].dist = o.dist; plan[id].src.dist = 'link'; } if (o.research != null) { plan[id].research = o.research; plan[id].src.research = 'link'; } });
    ex.forEach(x => { const r = ((rest[x.ym] || {})[x.kind] || 0); if (!byYm[x.ym] && r > 0) orphan.push(Object.assign({}, x, { allocations: x.allocations.map(a => Object.assign({}, a, { amount: x.amount ? a.amount * r / x.amount : 0 })) })); });
    return { list, pub, plan, orphan };
  }
  const PRESS_FROM = '2025-04';   // プレスリリース費をこのシートから出す最初の月（それより前はSEO数値管理シートのまま）
  /** 支出（cost_press）の行：調査費はそのメディア、月額は配信したメディアで本数割り（くらしのレスキューの分は BEST MEDIA に入れない） */
  async function costRows() {
    const { list, pub, plan, orphan } = await feePlan(), out = [];   /* 調査費・配信費はリリースの表と同じ値（feePlan） */
    const pubIds = new Set(pub.map(x => x.id));
    pub.forEach(x => { if (!x.media || x.media === '__kurashi') return; const v = (plan[x.id].research || 0) + (plan[x.id].dist || 0); if (v) out.push({ ym: x.date.slice(0, 7), media: x.media, item: 'cost_press', value: v }); });
    list.filter(x => !pubIds.has(x.id) && plan[x.id].links.length && x.media && x.media !== '__kurashi').forEach(x => { const v = plan[x.id].links.reduce((a, l) => a + l.amount, 0); const ym = x.date ? x.date.slice(0, 7) : ''; if (v && /^\d{4}-\d{2}/.test(ym || '')) out.push({ ym, media: x.media, item: 'cost_press', value: v }); });
    orphan.forEach(x => x.allocations.forEach(a => { if (a.media && a.amount) out.push({ ym: x.ym, media: a.media, item: 'cost_press', value: a.amount }); }));
    return out;
  }
  function routes(api, { canEdit, noMoney, allowedMedia, isStaff }) {
    api.get('/press-items', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const v = await items(), hide = noMoney(req.user), plan = hide ? {} : (await feePlan()).plan;
        res.json({ items: v.items.map(x => hide ? x : Object.assign({}, x, { research: (plan[x.id] || {}).research ?? null, dist: (plan[x.id] || {}).dist ?? null, feeLinks: (plan[x.id] || {}).links || [], feeSrc: (plan[x.id] || {}).src || {} })).filter(x => !allowedMedia || x.media === '__kurashi' ? isStaff(req.user) || !allowedMedia : allowedMedia(req.user, x.media)).map(x => hide ? Object.assign({}, x, { scr: undefined, svy: undefined }) : x), feeByYm: hide ? {} : v.feeByYm });
      } catch (e) { next(e); }
    });
    api.post('/press-items', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理を編集する権限がありません' });
        const b = req.body || {}, date = String(b.date || '').trim(), media = String(b.media || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'リリース日を入れてください' });
        if (!media) return res.status(400).json({ error: 'メディアを選んでください' });
        const ref = await db.collection('press_entries').add({ date, media, sub: String(b.sub || '').trim().slice(0, 50), no: String(b.no || '').trim().slice(0, 20), title: String(b.title || '').trim().slice(0, 300), createdBy: req.user.name || req.user.email, createdAt: new Date().toISOString() });
        cache = null; res.json({ ok: true, id: 'entry:' + ref.id });
      } catch (e) { next(e); }
    });
    // 削除（画面で追加したものは消す。シートの行はシートに書き込まないので「削除」の印で隠す）（2026-11-02 ユーザー指定）
    api.delete('/press-items/:id', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理を編集する権限がありません' });
        const id = req.params.id, by = req.user.name || req.user.email, at = new Date().toISOString();
        if (id.startsWith('entry:')) await db.collection('press_entries').doc(id.slice(6)).delete();
        else await db.collection('press_overrides').doc(encodeURIComponent(id)).set({ deleted: '1', by, at }, { merge: true });
        cache = null; res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 文字数をいま数え直す（ライティングURLの Google ドキュメントから。コンテンツ進行管理と同じ数え方）（2026-11-02 ユーザー指定）
    api.post('/press-items/:id/chars', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理を編集する権限がありません' });
        const x = (await items()).items.find(y => y.id === req.params.id);
        if (!x || !/docs\.google\.com\/document/.test(x.draftUrl || '')) return res.status(400).json({ error: 'ライティングURL（Google ドキュメント）が入っていません' });
        try { const n = await docChars(x.draftUrl); await db.collection('press_chars').doc(encodeURIComponent(x.id)).set({ chars: n, url: x.draftUrl, at: new Date().toISOString() }); cache = null; res.json({ ok: true, chars: n }); }
        catch (e) { await db.collection('press_chars').doc(encodeURIComponent(x.id)).set({ error: String(e.message).slice(0, 200), errorAt: new Date().toISOString(), url: x.draftUrl }); cache = null; res.status(400).json({ error: '原稿を読めませんでした。原稿を dashboard-app@bestmedia-510909.iam.gserviceaccount.com に「閲覧者」で共有してから、もう一度押してください。（' + String(e.message).slice(0, 120) + '）' }); }
      } catch (e) { next(e); }
    });
    /* プレスリリースのプロジェクト（スケジュールのタブの期間）ごとのプロジェクト進行担当（2026-11-02 ユーザー指定）。Firestore settings/press_projects.managers＝{期間: 名前} */
    const PROJ_DEFAULT = { '2025年4月～7月': '日比野 吉弘', '2025年11月～12月': '日比野 吉弘', '2026年3月～5月': '永澤 美寿生', '2026年7月～8月': '星 百美' };   /* はじめの担当（2026-11-02 ユーザー指定） */
    const projRef = db.collection('settings').doc('press_projects');
    api.get('/press-projects', async (req, res, next) => {
      try { const d = await projRef.get(); res.set('Cache-Control', 'no-store'); res.json({ managers: Object.assign({}, PROJ_DEFAULT, d.exists ? d.data().managers || {} : {}) }); } catch (e) { next(e); }
    });
    api.put('/press-projects', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理を編集する権限がありません' });
        const label = String((req.body || {}).label || '').trim().slice(0, 40), manager = String((req.body || {}).manager || '').trim().slice(0, 60);
        if (!label) return res.status(400).json({ error: 'プロジェクトを選んでください' });
        await projRef.set({ managers: { [label]: manager }, updatedBy: req.user.email, updatedAt: new Date().toISOString() }, { merge: true });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    api.put('/press-items/:id', async (req, res, next) => {
      try {
        if (!canEdit(req.user)) return res.status(403).json({ error: '進行管理を編集する権限がありません' });
        const b = req.body || {}, upd = {};
        for (const k of EDIT_FIELDS) { if (!(k in b)) continue; const v = String(b[k] == null ? '' : b[k]).trim();
          if (/Url$|^url$/.test(k) && v && !/^https?:\/\//.test(v)) return res.status(400).json({ error: 'URLは http:// か https:// で始まる形で入力してください' });
          if ((k === 'imageCount' || k === 'chars') && v && !/^\d+$/.test(v)) return res.status(400).json({ error: '数字で入力してください' });
          if (k === 'status' && v && !['未着手', '構成作成中', 'ライティング中', '社内チェック中', '入稿・配信設定済み', '公開済み', '中止'].includes(v)) return res.status(400).json({ error: '状態の値が正しくありません' });
          upd[k] = k === 'imageCount' || k === 'chars' ? (v ? Number(v) : null) : v.slice(0, k.endsWith('Url') || k === 'url' ? 1000 : 100); }
        if (!Object.keys(upd).length) return res.status(400).json({ error: '変更する項目がありません' });
        const isEntry = req.params.id.startsWith('entry:');
        await (isEntry ? db.collection('press_entries').doc(req.params.id.slice(6)) : db.collection('press_overrides').doc(encodeURIComponent(req.params.id))).set(Object.assign(upd, { by: req.user.name || req.user.email, at: new Date().toISOString() }), { merge: true });
        cache = null;
        if ('draftUrl' in upd) items().catch(() => {});   // ライティングURLを入れたら、文字数をすぐ数える
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { items, costRows, routes, PRESS_FROM, mapMedia, setExpenses, clear: () => { cache = null; } };
};
