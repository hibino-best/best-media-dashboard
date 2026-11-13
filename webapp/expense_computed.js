/**
 * 支出の計算値（2026-11-05 ユーザー指定：支出は SEO数値管理シートを参考にせず、業務委託・人件費などから計算した値を出す）
 *
 * 支出一覧と同じ計算（業務委託費＝報酬管理一覧の支払額、サイト制作・修正費＝契約管理シートのテクノグラム・businessbay＋確定した請求、
 * プレスリリース費＝リリースごとの調査費・配信費）を、管理者の画面が裏で計算して Firestore settings/expense_computed に保存する（12時間ごと）。
 * /monthly・/daily（月次・サマリ・日次・シミュレーションなど）は、保存がある間はシートの記事制作費・ディレクション費・サイト制作費・プレスリリース費と
 * 請求書・取り込んだ請求のそれらの項目の代わりに、この値を使う。BEST人件費はここには入れない（給与が推測されないよう、これまでどおり管理者の画面だけ）。
 * ツール・AI費はこれまでどおり（定額のサービス・API・取り込んだ請求）。
 */
const ITEMS = ['cost_article', 'cost_site', 'cost_press'];
const DROP = ['cost_article', 'cost_direction', 'cost_site', 'cost_press'];   /* 計算値があるとき、ほかの元から入れない項目 */
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

module.exports = function expenseComputed({ db, admin, isFullAdmin, onChanged }) {
  const ref = db.collection('settings').doc('expense_computed');
  let cache = null;
  async function get() { if (cache && cache.until > Date.now()) return cache.v; const s = await ref.get(); const v = s.exists ? s.data() : null; cache = { v, until: Date.now() + 5 * 60 * 1000 }; return v; }
  /** 支出の行（{ ym, media, block, item, value }）。保存がなければ null（そのときは今までどおりシートなどの値） */
  async function rows() {
    const v = await get(); if (!v || !v.media) return null;
    const out = [];
    Object.entries(v.media || {}).forEach(([item, o]) => Object.entries(o || {}).forEach(([m, ys]) => Object.entries(ys || {}).forEach(([ym, val]) => out.push({ ym, media: m, block: '', item, value: Number(val) || 0 }))));
    Object.entries(v.dirs || {}).forEach(([item, o]) => Object.entries(o || {}).forEach(([k, ys]) => { const i = k.indexOf('|'), m = k.slice(0, i), sub = k.slice(i + 1); if (!sub) return; Object.entries(ys || {}).forEach(([ym, val]) => out.push({ ym, media: m, block: sub, item, value: Number(val) || 0 })); }));
    return out;
  }
  const clean = o => { const r = {}; ITEMS.forEach(item => { const x = (o || {})[item] || {}; const t = {}; Object.entries(x).slice(0, 400).forEach(([k, ys]) => { const y = {}; Object.entries(ys || {}).forEach(([ym, val]) => { const n = Number(val); if (isYm(ym) && Number.isFinite(n) && n !== 0) y[ym] = Math.round(n); }); if (Object.keys(y).length) t[String(k).slice(0, 120)] = y; }); r[item] = t; }); return r; };
  function routes(api) {
    api.get('/expenses/computed-meta', async (req, res, next) => { try { const v = await get(); res.json({ at: v && v.at ? v.at : null }); } catch (e) { next(e); } });
    api.put('/expenses/computed', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが保存できます' });
        const b = req.body || {};
        await ref.set({ media: clean(b.media), dirs: clean(b.dirs), miss: Array.isArray(b.miss) ? b.miss.slice(0, 10).map(String) : [], at: new Date().toISOString(), by: req.user.email || '' });
        cache = null; if (onChanged) onChanged();
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { rows, routes, DROP, ITEMS };
};
