// 定額のサービス（ツール・AI費）を毎月自動で支出に入れる（2026-10-29 ユーザー指定）
// ・金額は税抜き。ドルのサービスは、その月の月末の為替レート（欧州中央銀行の参照レート。frankfurter.dev）で円に換算（今月はいちばん新しいレート）
// ・メディアへの分け方：Ahrefs の順位追跡に登録しているKWの数の割合（kw_rank_monthly。その月より前でいちばん新しい月、なければいちばん古い月）
const CATS = { cost_tool: 'ツール', cost_ai: 'ツール利用費', cost_site: 'サイト制作・修正' };
/* ツール利用費の小項目（2026-11-02 ユーザー指定）。AIツールは支出の区分 AI費、ほかはツール */
const GROUPS = { server: 'サーバー・ドメイン利用料', image: '画像ツール利用料', seo: 'SEOツール利用料', ai: 'AIツール利用料', other: 'そのほかのツール' };
const groupOf = x => GROUPS[x.group] ? x.group : x.category === 'cost_ai' ? 'ai' : 'other';
const AHREFS_SHARE = 0.5;   /* Ahrefs の BEST MEDIA の負担（残りはくらしのレスキュー）（2026-11-05 ユーザー指定） */
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const DEFAULTS = [   // はじめの登録（2026-10-29 ユーザー指定：日比野さん1人分）
  { id: 'chatgpt', name: 'ChatGPT Team（Standard・日比野）', category: 'cost_ai', amount: 25, currency: 'USD', startYm: '2026-10', endYm: '', note: '1席・月払い' },
  { id: 'claude', name: 'Claude Team（Standard・日比野）', category: 'cost_ai', amount: 25, currency: 'USD', startYm: '2026-10', endYm: '', note: '1席・月払い' },
];

module.exports = function subscriptions({ db, admin, query, T, isFullAdmin, hasAdminCap, isBestStaff, todayJst, onChanged }) {
  const ref = db.collection('settings').doc('subscriptions'), fxCol = db.collection('fx_rates');
  const can = u => isFullAdmin(u) || hasAdminCap(u, 'admin_expenses') || (!!isBestStaff && isBestStaff(u));   /* BEST社員も入力できる（2026-11-05 ユーザー指定） */
  async function items() { const d = await ref.get(); return d.exists ? (d.data().items || []) : DEFAULTS; }
  /** その月の USD→JPY（月末。今月以降はいちばん新しいレート）。一度取ったら保存して使う */
  const fxMem = {};
  async function usdJpy(ym) {
    const cur = todayJst().slice(0, 7), done = ym < cur;
    if (fxMem[ym] && (done || fxMem[ym].until > Date.now())) return fxMem[ym].v;
    if (done) { const s = await fxCol.doc(ym).get(); if (s.exists) { fxMem[ym] = { v: s.data() }; return s.data(); } }
    const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const r = await fetch('https://api.frankfurter.dev/v1/' + (done ? last : 'latest') + '?from=USD&to=JPY', { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); const v = { rate: Number(j.rates && j.rates.JPY), date: j.date || '' };
    if (!(v.rate > 0)) throw new Error('為替レートを取れませんでした');
    if (done) await fxCol.doc(ym).set(Object.assign({ at: admin.firestore.FieldValue.serverTimestamp() }, v));
    fxMem[ym] = { v, until: Date.now() + 6 * 3600 * 1000 };
    return v;
  }
  /** メディアの割合（Ahrefs の順位追跡のKW数） */
  let kwCache = null;
  async function kwShares(ym) {
    if (!kwCache || kwCache.until < Date.now()) {
      const rows = await query("SELECT FORMAT_DATE('%Y-%m', month) ym, media, COUNT(DISTINCT keyword) n FROM " + T('kw_rank_monthly') + ' GROUP BY ym, media');
      const by = {}; rows.forEach(r => { (by[r.ym] = by[r.ym] || {})[r.media] = Number(r.n); });
      kwCache = { by, yms: Object.keys(by).sort(), until: Date.now() + 3600 * 1000 };
    }
    const yms = kwCache.yms; if (!yms.length) return {};
    const use = yms.filter(m => m <= ym).pop() || yms[0], c = kwCache.by[use], tot = Object.values(c).reduce((a, v) => a + v, 0);
    return Object.fromEntries(Object.entries(c).map(([m, n]) => [m, n / tot]));
  }
  /** 支出に入れる行（今月まで） */
  async function rows() {
    const list = await items(), cur = todayJst().slice(0, 7), out = [];
    for (const it of list) {
      if (!isYm(it.startYm) || !(it.amount > 0) || !CATS[it.category]) continue;
      for (let ym = it.startYm; ym <= cur && (!it.endYm || ym <= it.endYm); ym = shiftYm(ym, 1)) {
        let yen = Number(it.amount), usd = null;
        if (it.currency === 'USD') { try { const fx = await usdJpy(ym); usd = Number(it.amount); yen = Math.round(usd * fx.rate); } catch (e) { console.warn('fx: ' + e.message); continue; } }
        if (/ahrefs/i.test(it.name || '')) yen = yen * AHREFS_SHARE;   /* Ahrefs はくらしのレスキューと50%ずつ（BEST MEDIA の支出は半分）（2026-11-05 ユーザー指定） */
        const sh = await kwShares(ym), ms = Object.keys(sh);
        if (!ms.length) continue;
        ms.forEach(m => out.push({ ym, media: m, block: '', item: it.category, value: yen * sh[m], sub: it.id, usd }));
      }
    }
    return out;
  }
  function routes(api) {
    api.get('/subscriptions', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        res.set('Cache-Control', 'no-store');
        const list = await items(), ym = todayJst().slice(0, 7);
        let fx = null; try { fx = await usdJpy(ym); } catch (e) { /* 表示だけなので続ける */ }
        res.json({ items: list.map(x => Object.assign({}, x, { group: groupOf(x) })), cats: CATS, groups: GROUPS, fx, ym, shares: await kwShares(ym).catch(() => ({})) });
      } catch (e) { next(e); }
    });
    api.put('/subscriptions', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 80);
        const list = (Array.isArray((req.body || {}).items) ? req.body.items : []).slice(0, 50).map((x, i) => ({ id: s(x.id, 40) || 'sub' + Date.now() + i, name: s(x.name), category: CATS[x.category] ? x.category : '', amount: Number(x.amount) || 0, currency: x.currency === 'USD' ? 'USD' : 'JPY', startYm: isYm(x.startYm) ? x.startYm : '', endYm: isYm(x.endYm) ? x.endYm : '', note: s(x.note, 200), group: GROUPS[x.group] ? x.group : '' }));
        const bad = list.find(x => !x.name || !x.category || !(x.amount > 0) || !x.startYm);
        if (bad) return res.status(400).json({ error: 'サービス名・区分・金額（税抜き）・開始月を入れてください' + (bad.name ? '（' + bad.name + '）' : '') });
        await ref.set({ items: list, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        onChanged(); res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes, rows, usdJpy, kwShares, items, groupOf, GROUPS };
};
