// REsta社員管理（2026-10-30 ユーザー指定）
// ・BEST社員管理と同じ形で、操作は「編集」と「担当」だけ
// ・項目：名前・メールアドレス・役員・生年月日・ポジション（生年月日はフル管理者だけが見られる）
// ・担当のメディアは今は「Eparkくらしのレスキュー」だけ（これから細分化する予定）。ポジションは BEST社員と同じ（PM〜監修・記事サポート）
const POSITIONS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント', 'アシスタント候補', 'サポート', '監修・記事サポート'];
const UNITS = { __kurashi: 'Eparkくらしのレスキュー' };
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

module.exports = function resta({ db, admin, isFullAdmin, hasAdminCap, todayJst }) {
  const col = db.collection('resta_staff');
  const can = u => isFullAdmin(u) || hasAdminCap(u, 'admin_staff');
  const assignAt = (st, ym) => { const a = st.assign || {}; if (Array.isArray(a[ym])) return a[ym]; const k = Object.keys(a).filter(m => m <= ym && Array.isArray(a[m])).sort().pop(); return k ? a[k] : []; };
  const out = (d, full) => { const v = d.data(), ym = todayJst().slice(0, 7); return { id: d.id, name: v.name || '', email: v.email || '', exec: !!v.exec, position: v.position || '', birthDate: full ? (v.birthDate || '') : undefined, assign: v.assign || {}, current: assignAt(v, ym) }; };
  const log = (req, view) => db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view, at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  const clean = b => {
    const s = (x, n) => String(x == null ? '' : x).trim().slice(0, n || 60);
    const v = { name: s(b.name), email: s(b.email, 120).toLowerCase(), exec: !!b.exec, position: POSITIONS.includes(b.position) ? b.position : '' };
    if (b.birthDate !== undefined) v.birthDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.birthDate || '')) ? b.birthDate : '';
    return v;
  };
  function routes(api) {
    api.get('/resta-staff', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: 'REsta社員管理の権限がありません' });
        res.set('Cache-Control', 'no-store');
        const full = isFullAdmin(req.user);
        res.json({ staff: (await col.get()).docs.map(d => out(d, full)).sort((a, b) => a.name.localeCompare(b.name, 'ja')), positions: POSITIONS, units: UNITS, canSecret: full });
      } catch (e) { next(e); }
    });
    // 追加・編集
    api.post('/resta-staff', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: 'REsta社員管理の権限がありません' });
        const v = clean(req.body || {}); if (!v.name) return res.status(400).json({ error: '名前を入れてください' });
        if (v.email && !/^[^@\s]+@[^@\s]+$/.test(v.email)) return res.status(400).json({ error: 'メールアドレスが正しくありません' });
        if (!isFullAdmin(req.user)) delete v.birthDate;
        const ref = await col.add(Object.assign(v, { assign: {}, createdBy: req.user.email, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
        await log(req, 'REsta社員を追加：' + v.name); res.json({ ok: true, id: ref.id });
      } catch (e) { next(e); }
    });
    api.put('/resta-staff/:id', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: 'REsta社員管理の権限がありません' });
        const ref = col.doc(req.params.id), d = await ref.get(); if (!d.exists) return res.status(404).json({ error: '見つかりません' });
        const v = clean(req.body || {}); if (!v.name) return res.status(400).json({ error: '名前を入れてください' });
        if (v.email && !/^[^@\s]+@[^@\s]+$/.test(v.email)) return res.status(400).json({ error: 'メールアドレスが正しくありません' });
        if (!isFullAdmin(req.user)) delete v.birthDate;   // 生年月日はフル管理者だけ
        await ref.update(Object.assign(v, { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
        await log(req, 'REsta社員を編集：' + v.name); res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 担当：その月から（until まで）同じ担当にする。rows＝[{media, position}]（空＝担当なし）
    api.put('/resta-staff/:id/assign/:ym', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: 'REsta社員管理の権限がありません' });
        const ym = req.params.ym, until = (req.body || {}).until; if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        const ref = col.doc(req.params.id), d = await ref.get(); if (!d.exists) return res.status(404).json({ error: '見つかりません' });
        const rows = (Array.isArray((req.body || {}).rows) ? req.body.rows : []).filter(r => UNITS[r.media]).map(r => ({ media: r.media, sub: '', position: POSITIONS.includes(r.position) ? r.position : '' }));
        if (rows.some(r => !r.position)) return res.status(400).json({ error: 'ポジションを選んでください' });
        const months = [ym]; if (isYm(until) && until > ym) for (let m = shiftYm(ym, 1); m <= until && months.length < 36; m = shiftYm(m, 1)) months.push(m);
        const patch = {}; months.forEach(m => { patch['assign.' + m] = rows; });
        await ref.update(Object.assign(patch, { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
        await log(req, 'REsta社員の担当を変更：' + d.data().name + '（' + months[0] + (months.length > 1 ? '〜' + months[months.length - 1] : '') + '）'); res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { routes };
};
