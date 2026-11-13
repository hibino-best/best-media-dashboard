// 機能改善依頼とタスク通知（2026-10-29 ユーザー指定）
// ・依頼できるのは BEST正社員と業務委託ディレクターだけ。各表示（パネル）の「改善依頼」から、どのタブ・どの画面・どの表示かを自動で付けて送る
// ・送ると管理者に通知（タスク通知＋メール）。管理者が「対応済み」か「対応不可（理由）」にすると、依頼した人に通知（メール＋画面）
// ・タスク通知（全体管理）：改善依頼・記事目標の承認待ち・稼働工数の修正申請・ユーザーの承認待ちをまとめて出す
const FB_ROLES = ['employee', 'out_director', 'exec', 'out_ad', 'out_aw'];   /* BEST役員・業務委託アシスタントディレクター・アシスタント兼ライターも（2026-11-06 ユーザー指定） */
const ADMIN_TO = 'yoshihiro.hibino@best-24.jp';   // 管理者への通知の宛先（AI検知のお知らせと同じ）
const STATUS = { open: '未対応', done: '対応済み', declined: '対応不可' };

module.exports = function feedback({ db, admin, isFullAdmin, capOk, gmail, pendingWork, appUrl, errPending }) {
  const col = db.collection('feedback');
  const ts = v => v && v.toDate ? v.toDate().toISOString() : null;
  const out = d => { const v = d.data(); return { id: d.id, text: v.text, ctx: v.ctx || {}, by: v.by || {}, status: v.status || 'open', reply: v.reply || '', doneBy: v.doneBy || '', createdAt: ts(v.createdAt), doneAt: ts(v.doneAt), seen: !!v.seen }; };
  const canSend = u => !!u && u.status === 'active' && (capOk ? capOk(u, 'feedback_send', x => FB_ROLES.includes(x.roleEff)) : (FB_ROLES.includes(u.roleEff) || isFullAdmin(u)));   /* 権限管理の feedback_send（2026-11-06） */
  const ctxText = c => [c.dash, c.view, c.panel].filter(Boolean).join(' ＞ ') + (c.media ? '（' + c.media + (c.sub ? '／' + c.sub : '') + '）' : '');
  const mail = (to, subject, body) => gmail.send({ to, subject, body }).catch(e => console.warn('feedback mail: ' + e.message));

  function routes(api, adminApi) {
    // 依頼を送る
    api.post('/feedback', async (req, res, next) => {
      try {
        if (!canSend(req.user)) return res.status(403).json({ error: '改善依頼は BEST正社員と業務委託ディレクターだけが送れます' });
        const b = req.body || {}, text = String(b.text || '').trim().slice(0, 3000);
        if (!text) return res.status(400).json({ error: '改善してほしい内容を入力してください' });
        const c = b.ctx || {}, s = v => String(v || '').slice(0, 200);
        const ctx = { dash: s(c.dash), view: s(c.view), viewId: s(c.viewId), panel: s(c.panel), media: s(c.media), sub: s(c.sub) };
        const by = { uid: req.user.uid, email: req.user.email || '', name: req.user.name || '', role: req.user.roleEff || '' };
        const ref = await col.add({ text, ctx, by, status: 'open', createdAt: admin.firestore.FieldValue.serverTimestamp() });
        mail(ADMIN_TO, '【BEST MEDIA】機能改善の依頼が届きました', [by.name + ' さんから機能改善の依頼が届きました。', '', '場所：' + ctxText(ctx), '', '内容：', text, '', '確認・対応は、ダッシュボードの 全体管理 →「タスク通知」から。', appUrl(req)].join('\n'));
        res.json({ ok: true, id: ref.id });
      } catch (e) { next(e); }
    });
    // 自分の依頼（結果のお知らせにも使う）
    api.get('/feedback/mine', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        if (!canSend(req.user)) return res.json({ list: [], canSend: false });
        const list = (await col.where('by.uid', '==', req.user.uid).get()).docs.map(out).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        res.json({ list, canSend: true });
      } catch (e) { next(e); }
    });
    // 結果を見た（お知らせを消す）
    api.post('/feedback/seen', async (req, res, next) => {
      try {
        const q = await col.where('by.uid', '==', req.user.uid).get();
        await Promise.all(q.docs.filter(d => d.data().status !== 'open' && !d.data().seen).map(d => d.ref.update({ seen: true })));
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 管理者：一覧と対応
    adminApi.get('/feedback', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが見られます' });
        res.set('Cache-Control', 'no-store');
        res.json({ list: (await col.orderBy('createdAt', 'desc').limit(300).get()).docs.map(out) });
      } catch (e) { next(e); }
    });
    adminApi.patch('/feedback/:id', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '対応の記録は管理者だけができます' });
        const b = req.body || {}, status = b.status, reply = String(b.reply || '').trim().slice(0, 3000);
        if (!['done', 'declined', 'open'].includes(status)) return res.status(400).json({ error: '状態が正しくありません' });
        if (status === 'declined' && !reply) return res.status(400).json({ error: '対応不可の理由を入力してください' });
        const ref = col.doc(req.params.id), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
        await ref.update({ status, reply, doneBy: req.user.email || '', doneAt: status === 'open' ? null : admin.firestore.FieldValue.serverTimestamp(), seen: false });
        const v = snap.data();
        if (status !== 'open' && v.by && v.by.email) mail(v.by.email, '【BEST MEDIA】機能改善の依頼：' + STATUS[status], [(v.by.name || '') + ' 様', '', '機能改善の依頼が「' + STATUS[status] + '」になりました。', '', '場所：' + ctxText(v.ctx || {}), '依頼の内容：', v.text, '', status === 'declined' ? '対応できない理由：\n' + reply : reply ? '対応の内容：\n' + reply : '', '', appUrl(req)].join('\n'));
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // タスク通知：まとめて
    adminApi.get('/tasks', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        if (!isFullAdmin(req.user)) return res.json({ count: 0 });
        const [fb, work, users, errc] = await Promise.all([
          col.where('status', '==', 'open').get().then(q => q.docs.map(out)),
          pendingWork().catch(() => []),
          db.collection('users').where('status', '==', 'pending').get().then(q => q.docs.map(d => ({ uid: d.id, name: d.data().name || '', email: d.data().email || '' }))),
          errPending ? errPending().catch(() => ({ count: 0, runs: [] })) : { count: 0, runs: [] },   /* AIエラーチェッカーの判断待ち（2026-11-13） */
        ]);
        res.json({ feedback: fb, work, users, errcheck: errc.runs, count: fb.length + work.length + users.length + errc.count });
      } catch (e) { next(e); }
    });
  }
  return { routes };
};
