// AI の API の費用（Claude・OpenAI）を Admin キーで読み、AI費に入れる（2026-10-29 ユーザー指定）
// ・キーは画面から Secret Manager に保存（anthropic-admin-key／openai-admin-key）。読むだけに使う
// ・Claude：GET /v1/organizations/cost_report（金額はセント単位の文字列）、OpenAI：GET /v1/organization/costs（金額はドル）
// ・月ごとの合計（ドル・税抜き）→ その月の月末のレートで円 → Ahrefs の順位追跡のKW数の割合でメディアに分ける（subscriptions.js と同じ）
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const KEYS = { anthropic: 'anthropic-admin-key', openai: 'openai-admin-key' };
const START = '2026-10';   // この月から支出に入れる
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

module.exports = function aiCosts({ PROJECT, db, admin, isFullAdmin, todayJst, subMod, onChanged }) {
  const sm = new SecretManagerServiceClient(), cacheCol = db.collection('ai_api_costs'), mem = {};
  const sname = id => `projects/${PROJECT}/secrets/${id}`;
  async function getKey(p) { try { const [v] = await sm.accessSecretVersion({ name: sname(KEYS[p]) + '/versions/latest' }); return v.payload.data.toString('utf8').trim(); } catch (e) { return ''; } }
  async function setKey(p, key) {
    try { await sm.getSecret({ name: sname(KEYS[p]) }); } catch (e) { if (e.code !== 5) throw e; await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: KEYS[p], secret: { replication: { automatic: {} } } }); }
    await sm.addSecretVersion({ parent: sname(KEYS[p]), payload: { data: Buffer.from(key, 'utf8') } });
  }
  const range = ym => { const [y, m] = ym.split('-').map(Number), to = new Date(Math.min(Date.UTC(y, m, 1) - 9 * 3600000, Date.now() - 60000)); return { from: new Date(Date.UTC(y, m - 1, 1) - 9 * 3600000), to }; };   // 終わりは今より先にしない（先の時刻はエラーになるため）   // 日本時間の月の初め〜次の月の初め
  /** Claude：その月の費用（ドル） */
  async function anthropicMonth(key, ym) {
    const { from, to } = range(ym); let usd = 0, page = '';
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ starting_at: from.toISOString(), ending_at: to.toISOString(), bucket_width: '1d', limit: '31' }); if (page) q.set('page', page);
      const r = await fetch('https://api.anthropic.com/v1/organizations/cost_report?' + q, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Claude：' + ((j.error && j.error.message) || r.status));
      (j.data || []).forEach(b => (b.results || []).forEach(x => { usd += (Number(x.amount) || 0) / 100; }));   // セント → ドル
      if (!j.has_more || !j.next_page) break; page = j.next_page;
    }
    return Math.round(usd * 100) / 100;
  }
  /** OpenAI：その月の費用（ドル） */
  async function openaiMonth(key, ym) {
    const { from, to } = range(ym); let usd = 0, page = '';
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ start_time: String(Math.floor(from / 1000)), end_time: String(Math.floor(to / 1000)), bucket_width: '1d', limit: '31' }); if (page) q.set('page', page);
      const r = await fetch('https://api.openai.com/v1/organization/costs?' + q, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('OpenAI：' + ((j.error && j.error.message) || r.status));
      (j.data || []).forEach(b => (b.results || []).forEach(x => { usd += Number((x.amount || {}).value) || 0; }));
      if (!j.has_more || !j.next_page) break; page = j.next_page;
    }
    return Math.round(usd * 100) / 100;
  }
  /** その月の費用（確定した月は保存して使う、今月は1時間ごとに取り直す） */
  async function month(p, ym) {
    const cur = todayJst().slice(0, 7), done = ym < cur, id = p + '_' + ym;
    if (mem[id] && (done || mem[id].until > Date.now())) return mem[id].usd;
    if (done) { const s = await cacheCol.doc(id).get(); if (s.exists) { mem[id] = { usd: s.data().usd }; return s.data().usd; } }
    const key = await getKey(p); if (!key) return null;
    const usd = p === 'anthropic' ? await anthropicMonth(key, ym) : await openaiMonth(key, ym);
    if (done) await cacheCol.doc(id).set({ usd, at: admin.firestore.FieldValue.serverTimestamp() });
    mem[id] = { usd, until: Date.now() + 3600 * 1000 };
    return usd;
  }
  /** 支出に入れる行（AI費） */
  async function rows() {
    const cur = todayJst().slice(0, 7), out = [];
    for (const p of Object.keys(KEYS)) {
      for (let ym = START; ym <= cur; ym = shiftYm(ym, 1)) {
        let usd; try { usd = await month(p, ym); } catch (e) { console.warn('ai cost ' + p + ' ' + ym + ': ' + e.message); continue; }
        if (!usd) continue;
        let fx; try { fx = await subMod.usdJpy(ym); } catch (e) { continue; }
        const yen = usd * fx.rate, sh = await subMod.kwShares(ym);
        Object.entries(sh).forEach(([m, r]) => out.push({ ym, media: m, block: '', item: 'cost_ai', value: yen * r, sub: p + '_api', usd: usd * r }));
      }
    }
    return out;
  }
  function routes(adminApi) {
    // API・連携設定：キーの有無と、今月・先月の費用
    adminApi.get('/ai-costs', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが見られます' });
        res.set('Cache-Control', 'no-store');
        const cur = todayJst().slice(0, 7), prev = shiftYm(cur, -1), out = {};
        for (const p of Object.keys(KEYS)) {
          const has = !!(await getKey(p)); out[p] = { hasKey: has };
          if (has) for (const ym of [prev, cur]) { try { const usd = await month(p, ym), fx = await subMod.usdJpy(ym); out[p][ym] = { usd, yen: Math.round(usd * fx.rate) }; } catch (e) { out[p].error = e.message; } }
        }
        res.json({ cur, prev, start: START, providers: out });
      } catch (e) { next(e); }
    });
    adminApi.put('/ai-costs', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが設定できます' });
        const b = req.body || {}, p = b.provider, key = String(b.key || '').trim();
        if (!KEYS[p]) return res.status(400).json({ error: '種類が正しくありません' });
        if (!/^sk-/.test(key) || key.length < 20) return res.status(400).json({ error: 'キーの形が正しくありません（sk- で始まるキーを入れてください）' });   // キーの頭の文字は変わることがあるので、読めるかどうかで判断する（2026-10-29）
        // 保存する前に、読めるか確かめる
        try { p === 'anthropic' ? await anthropicMonth(key, todayJst().slice(0, 7)) : await openaiMonth(key, todayJst().slice(0, 7)); } catch (e) { console.warn('ai-costs key test ' + p + ': ' + e.message); return res.status(400).json({ error: 'このキーでは費用を読めませんでした（' + e.message + '）' }); }
        await setKey(p, key);
        Object.keys(mem).filter(k => k.startsWith(p + '_')).forEach(k => delete mem[k]);
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'AI の API の Admin キーを保存：' + p, at: admin.firestore.FieldValue.serverTimestamp() });
        onChanged(); res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes, rows };
};
