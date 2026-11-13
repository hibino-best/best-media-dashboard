/**
 * 担当者の紐づけ（2026-10-27 ユーザー指定）
 *
 * 記事管理（記事管理シート・進行管理）に書かれた担当者名を、BEST社員・業務委託（契約管理）の人に紐づける対応表。
 * Firestore person_links/{ID}：alias（記事管理に書かれた名前）・media（空＝全メディア。メディアを決めた行が優先）
 *   action：link（紐づける）／none（担当なし：「不要」「ー」など）／skip（紐づけない：カギお助け本舗の幸谷さん独自の契約の人など）
 *   contractId・staffId … 両方あるときは、社員の入社日より前は業務委託、入社日からは社員として数える
 *   note
 * スプレッドシートは書き換えない。見る・直すのは管理者と「BEST社員管理」「契約管理」の権限がある人
 */
const crypto = require('crypto');
const ROLE_FIELDS = { director: 'ディレクション', writer: '執筆', upload_owner: 'アップロード', supervisor: '監修', image_owner: '画像' };

module.exports = function personLinks({ db, admin, query, T, isFullAdmin, hasAdminCap, allowedMedia, pressNames }) {
  const col = db.collection('person_links');
  const can = u => isFullAdmin(u) || hasAdminCap(u, 'admin_staff') || hasAdminCap(u, 'admin_contracts');
  const idOf = (alias, media) => crypto.createHash('sha1').update((media || '') + '|' + alias).digest('hex').slice(0, 24);
  let cache = null;
  async function links() { if (cache && cache.until > Date.now()) return cache.value; const v = (await col.get()).docs.map(d => Object.assign({ id: d.id }, d.data())); cache = { value: v, until: Date.now() + 5 * 60 * 1000 }; return v; }
  /* メディアごとに記事（シート・進行管理）とプレスリリースに出てくる担当者名。10分残す */
  let aliasCache = null;
  async function aliasesByMedia() {
    if (aliasCache && aliasCache.until > Date.now()) return aliasCache.value;
    const by = {}, add = (media, name) => { const k = String(name || '').trim(); if (!k) return; (by[media || ''] = by[media || ''] || new Set()).add(k); };
    const rows = await query('SELECT DISTINCT media, TRIM(name) name FROM (' + Object.keys(ROLE_FIELDS).map(f => 'SELECT ' + f + ' name, media FROM ' + T('article_items')).join(' UNION ALL ') + ") WHERE name IS NOT NULL AND TRIM(name) != ''");
    rows.forEach(r => add(r.media, r.name));
    for (const c of ['article_overrides', 'article_entries']) (await db.collection(c).get()).docs.forEach(d => { const v = d.data(); Object.keys(ROLE_FIELDS).forEach(f => add(v.media, v[f])); });
    if (pressNames) { try { (await pressNames()).forEach(x => add(x.media, x.name)); } catch (e) { console.warn('person-names press: ' + e.message); } }
    aliasCache = { value: by, until: Date.now() + 10 * 60 * 1000 };
    return by;
  }
  async function visibleAliases(ok) { const by = await aliasesByMedia(), out = new Set(); Object.keys(by).forEach(m => { if (m && ok(m)) by[m].forEach(a => out.add(a)); }); return out; }

  /** 名前（とメディア・日付）から、紐づく人を決める。{ kind: 'staff'|'contract', id } か null（担当なし・紐づけない・未設定は null） */
  async function resolve(alias, media, date) {
    const a = String(alias || '').trim(); if (!a) return null;
    const ls = await links(), l = ls.find(x => x.alias === a && x.media === media) || ls.find(x => x.alias === a && !x.media);
    if (!l || l.action !== 'link') return null;
    if (l.staffId && l.contractId) {
      const st = await db.collection('staff').doc(l.staffId).get(), join = st.exists ? st.data().joinDate : null;
      return join && date && String(date) < join ? { kind: 'contract', id: l.contractId } : { kind: 'staff', id: l.staffId };
    }
    return l.staffId ? { kind: 'staff', id: l.staffId } : l.contractId ? { kind: 'contract', id: l.contractId } : null;
  }

  function routes(api) {
    // 一覧：記事管理に出てくる名前（役割・メディア・件数）と、今の紐づけ、紐づけ先の候補
    api.get('/person-links', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '担当者の紐づけを見る権限がありません' });
        const names = {};
        const add = (name, role, media, n) => { const k = String(name || '').trim(); if (!k) return; const x = (names[k] = names[k] || { alias: k, roles: {}, medias: {}, count: 0 }); x.roles[role] = (x.roles[role] || 0) + n; x.medias[media] = (x.medias[media] || 0) + n; x.count += n; };
        const rows = await query('SELECT role, TRIM(name) name, media, COUNT(*) n FROM (' + Object.keys(ROLE_FIELDS).map(f => "SELECT '" + f + "' role, " + f + ' name, media FROM ' + T('article_items')).join(' UNION ALL ') + ") WHERE name IS NOT NULL AND TRIM(name) != '' GROUP BY 1, 2, 3");
        rows.forEach(r => add(r.name, ROLE_FIELDS[r.role], r.media, Number(r.n)));
        for (const c of ['article_overrides', 'article_entries']) (await db.collection(c).get()).docs.forEach(d => { const v = d.data(); Object.keys(ROLE_FIELDS).forEach(f => add(v[f], ROLE_FIELDS[f], v.media || '', 1)); });
        const staff = (await db.collection('staff').get()).docs.map(d => ({ kind: 'staff', id: d.id, name: d.data().name, joinDate: d.data().joinDate || '', retireDate: d.data().retireDate || '' }));
        const contracts = (await db.collection('contracts').get()).docs.map(d => ({ kind: 'contract', id: d.id, name: d.data().name, position: d.data().position || '', status: d.data().status || '契約中' }));
        res.json({ names: Object.values(names).sort((a, b) => b.count - a.count), links: await links(), staff, contracts });
      } catch (e) { next(e); }
    });
    // 表示用：記事管理に書かれた名前 → 紐づけた人の名前（ログインしている人なら使える。名前だけを返す）
    api.get('/person-names', async (req, res, next) => {
      try {
        /* 見られるメディアの分だけ返す（2026-11-04 ユーザー指定）。メディアを決めた行はそのメディアが見られるとき、
           全メディアの行は見られるメディアの記事・プレスリリースに出てくる名前のときだけ */
        const u = req.user, all = !allowedMedia || u.scope === 'all';
        const aliases = all ? null : await visibleAliases(m => allowedMedia(u, m));
        const ls = (await links()).filter(l => all || (l.media ? allowedMedia(u, l.media) : aliases.has(l.alias))), staff = {}, contracts = {};
        (await db.collection('staff').get()).docs.forEach(d => { staff[d.id] = d.data().name || ''; });
        (await db.collection('contracts').get()).docs.forEach(d => { contracts[d.id] = d.data().name || ''; });
        res.json({ list: ls.map(l => ({ alias: l.alias, media: l.media || '', action: l.action, name: l.action === 'link' ? (staff[l.staffId] || contracts[l.contractId] || '') : '' })) });
      } catch (e) { next(e); }
    });
    api.put('/person-links', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '担当者の紐づけを変更する権限がありません' });
        const b = req.body || {}, alias = String(b.alias || '').trim().slice(0, 200), media = String(b.media || '').slice(0, 60);
        if (!alias) return res.status(400).json({ error: '名前がありません' });
        if (!['link', 'none', 'skip'].includes(b.action)) return res.status(400).json({ error: '扱いを選んでください' });
        if (b.action === 'link' && !b.contractId && !b.staffId) return res.status(400).json({ error: '紐づける人（業務委託か BEST社員）を選んでください' });
        await col.doc(idOf(alias, media)).set({ alias, media, action: b.action, contractId: b.action === 'link' ? String(b.contractId || '') : '', staffId: b.action === 'link' ? String(b.staffId || '') : '', note: String(b.note || '').slice(0, 300), updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        cache = null;
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '担当者の紐づけを保存：' + alias + (media ? '（' + media + '）' : ''), at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    api.delete('/person-links/:id', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '担当者の紐づけを変更する権限がありません' });
        await col.doc(req.params.id).delete(); cache = null;
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  /** 契約に紐づけた別名（例：「尾崎」→ 尾崎 兼太さんの契約）。自分の担当の記事を探すときに使う（2026-11-13） */
  async function aliasesOfContracts(ids) { const set = new Set(ids || []); if (!set.size) return []; return (await links()).filter(l => l.action === 'link' && l.contractId && set.has(l.contractId) && l.alias).map(l => String(l.alias).trim()); }
  return { routes, resolve, idOf, aliasesOfContracts };
};
