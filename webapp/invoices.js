// 請求書（業務委託の毎月の請求。2026-10-28〜29 ユーザー指定）
// 流れ：請求者が請求（請求確認中）→ BEST社員の請求担当が確認（完了＝経理部確認中／差し戻し）→ …（経理部・アラートは次の段階）
// ・請求できるのは、その月の3日〜翌月2日。翌月3日・4日は「期日を過ぎた理由」が必須。翌月5日以降は受け付けない。1か月に1回だけ（差し戻しのときは直して出し直し）
// ・金額は報酬管理の計算（契約内容の単価×その月に完了した担当記事）。請求者が足せるのは「その他の項目」だけ
// ・消費税は全員10%、源泉所得税は個人だけ（税抜き小計の10.21%、100万円を超える分は20.42%）。支払期日は翌月25日（土日なら次の月曜）
const STATUS = { checking: '請求確認中', returned: '差し戻し', finance: '経理部確認中', finance_returned: '経理部確認中', done: '請求完了' };
const MARKETING = 'marketing@best-24.jp';
const FINANCE = 'finance@best-24.jp';
const FINANCE_DEMO = 'corporate_finance@best-24.jp';   // デモの経理部宛て（2026-10-30 ユーザー指定）
// 経理部の確認が完了したら、全員分の PDF を添付して送る先（2026-10-30 ユーザー指定）
const DONE_TO = 'best_428375157506@mj.na.smart-integration.ricoh.com';
const DONE_CC = 'corporate_finance@best-24.jp';
const HIBINO = 'yoshihiro.hibino@best-24.jp';   // 全員の確認が終わったら知らせる人（2026-10-29 ユーザー指定）
const { invoicePdf } = require('./invoice_pdf');
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
/** その月の分を請求できるか：open（期日内）／late（猶予・理由が必要）／before（まだ）／closed（受け付け終了） */
const INVOICE_START = '2026-11';   // このWEBアプリで請求できるのは 2026年11月分から（10月分以前は不可・お知らせもなし。2026-10-29 ユーザー指定）
function windowOf(ym, today) {
  const next = shiftYm(ym, 1);
  if (ym < INVOICE_START) return 'closed';
  if (today < ym + '-03') return 'before';
  if (today <= next + '-02') return 'open';
  if (today <= next + '-04') return 'late';
  return 'closed';
}
/** 支払期日：翌月25日。土日なら次の月曜（25日の前後に祝日はない） */
function dueDateOf(ym) {
  const next = shiftYm(ym, 1), d = new Date(next + '-25T00:00:00Z'), w = d.getUTCDay();
  if (w === 6) d.setUTCDate(d.getUTCDate() + 2); else if (w === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** 金額の計算（サーバーで計算し直す） */
function totals(items, entity) {
  const lines = items.map(x => Object.assign({}, x, { amount: Math.round((Number(x.qty) || 0) * (Number(x.unit) || 0)) }));
  const subtotal = lines.reduce((a, x) => a + x.amount, 0), tax = Math.floor(subtotal * 0.1);
  const withholding = entity === '個人' ? (subtotal <= 1000000 ? Math.floor(subtotal * 0.1021) : 102100 + Math.floor((subtotal - 1000000) * 0.2042)) : 0;
  return { lines, subtotal, tax, withholding, total: subtotal + tax - withholding };
}

module.exports = function invoices({ db, admin, isFullAdmin, expView, gmail, allContracts, activeContracts, contractsWithArticles, extraForBatch, todayJst, appUrl, mediaLabel }) {
  /** メールの件名の【】：担当メディア。ディレクトリごとの担当は「メディア｜ディレクトリ」、複数は「・」でつなぐ（2026-10-29 ユーザー指定） */
  const tagOf = c => { const ms = (c && c.medias) || [], L = m => (mediaLabel ? mediaLabel(m) : m); if (!ms.length) return '【BEST MEDIA】'; return '【' + ms.map(m => { const subs = ((c.subs || {})[m]) || []; return subs.length ? subs.map(x => L(m) + '｜' + x).join('・') : L(m); }).join('・') + '】'; };
  const tagById = async id => tagOf((await allContracts()).find(x => x.id === id));
  const isFinance = u => !!u && u.status === 'active' && (u.roleEff === 'finance' || isFullAdmin(u));
  const batchRef = ym => db.collection('invoice_batches').doc(ym);
  /** BEST の登録番号（インボイス番号）。請求書には保存せず、作るたびにこの値を入れる＝変えると全員の請求書が変わる（2026-10-30 ユーザー指定） */
  const metaRef = db.collection('settings').doc('invoice_meta');
  let bestNoCache = null;
  const bestNo = async () => { if (bestNoCache && bestNoCache.until > Date.now()) return bestNoCache.v; const v = String(((await metaRef.get()).data() || {}).bestInvoiceNo || ''); bestNoCache = { v, until: Date.now() + 60 * 1000 }; return v; };
  const pdfOf = async v => invoicePdf(Object.assign({}, v, { bestNo: await bestNo() }));
  const col = db.collection('invoices');
  const ts = v => v && v.toDate ? v.toDate().toISOString() : (v || null);
  const out = d => { const v = d.data ? d.data() : d; return Object.assign({ id: d.id }, v, { submittedAt: ts(v.submittedAt), updatedAt: ts(v.updatedAt), checkedAt: ts(v.checkedAt), sentAt: ts(v.sentAt), doneAt: ts(v.doneAt), statusLabel: STATUS[v.status] || v.status, history: (v.history || []).map(h => Object.assign({}, h, { at: ts(h.at) })) }); };
  const mail = (to, cc, subject, body) => to ? gmail.send({ to, cc, subject, body }).catch(e => console.warn('invoice mail: ' + e.message)) : null;
  async function staffOf(email) { const q = await db.collection('staff').where('email', '==', String(email || '').toLowerCase()).limit(1).get(); return q.empty ? null : Object.assign({ id: q.docs[0].id }, q.docs[0].data()); }
  async function staffById(id) { if (!id) return null; const d = await db.collection('staff').doc(id).get(); return d.exists ? Object.assign({ id: d.id }, d.data()) : null; }
  /** この人が請求担当（メインかサブ）か */
  async function billingRole(user, c) { if (isFullAdmin(user)) return 'admin'; const st = await staffOf(user.email); if (!st) return ''; return c.billingStaffId === st.id ? 'main' : c.billingSubStaffId === st.id ? 'sub' : ''; }
  const mine = (user, c) => !!c.email && String(c.email).toLowerCase() === String(user.email || '').toLowerCase();
  const fmt = n => Number(n || 0).toLocaleString('ja-JP') + '円';
  const ymJp = ym => ym.slice(0, 4) + '年' + Number(ym.slice(5)) + '月';

  function routes(api) {
    // 郵便番号から住所（zipcloud：日本郵便のデータの無料の住所検索。送るのは郵便番号だけ）
    api.get('/zip/:zip', async (req, res) => {
      try {
        const z = String(req.params.zip || '').replace(/[^\d]/g, ''); if (z.length !== 7) return res.status(400).json({ error: '郵便番号は7けたで入力してください' });
        const r = await fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + z, { signal: AbortSignal.timeout(8000) }), j = await r.json();
        const x = (j.results || [])[0]; if (!x) return res.status(404).json({ error: 'この郵便番号の住所が見つかりません' });
        res.json({ pref: x.address1, city: x.address2 + (x.address3 || '') });
      } catch (e) { res.status(502).json({ error: '住所を調べられませんでした。手で入力してください' }); }
    });
    // 請求者：自分の契約の請求（今月・前月）と、請求できるか
    api.get('/invoices/mine', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const today = todayJst(), cs = (await allContracts()).filter(c => mine(req.user, c));
        const list = [];
        for (const c of cs) for (const d of (await col.where('contractId', '==', c.id).get()).docs) list.push(out(d));
        res.json({ today, invoices: list.sort((a, b) => String(b.ym).localeCompare(a.ym)) });
      } catch (e) { next(e); }
    });
    // 請求する（差し戻しのあとの出し直しも）
    api.post('/invoices', async (req, res, next) => {
      try {
        const b = req.body || {}, ym = String(b.ym || ''), today = todayJst();
        if (!isYm(ym)) return res.status(400).json({ error: '請求の月が正しくありません' });
        const c = (await allContracts()).find(x => x.id === b.contractId);
        if (!c || !mine(req.user, c)) return res.status(404).json({ error: '契約が見つかりません' });
        const ref = col.doc(c.id + '_' + ym), cur = await ref.get(), resubmit = cur.exists && cur.data().status === 'returned';
        if (cur.exists && !resubmit) return res.status(400).json({ error: ymJp(ym) + '分はすでに請求しています（請求は1か月に1回です）' });
        const w = windowOf(ym, today);
        if (!resubmit && w === 'before') return res.status(400).json({ error: ymJp(ym) + '分は ' + ym + '-03 から請求できます' });
        if (ym < INVOICE_START) return res.status(400).json({ error: ymJp(ym) + '分は、このWEBアプリでは請求できません（' + ymJp(INVOICE_START) + '分から）' });
        if (!resubmit && w === 'closed') return res.status(400).json({ error: ymJp(ym) + '分の請求の受け付けは終わりました（翌月4日まで）' });
        const lateReason = String(b.lateReason || '').trim().slice(0, 1000);
        if (!resubmit && w === 'late' && !lateReason) return res.status(400).json({ error: '請求の期日（翌月2日）を過ぎています。期日を過ぎた理由を入力してください' });
        // 明細：自動の行（報酬管理の計算）と、その他の項目
        const clean = x => ({ media: String(x.media || '').slice(0, 40), kind: x.kind === 'other' ? 'other' : 'auto', label: String(x.label || '').trim().slice(0, 100), qty: Number(x.qty) || 0, unit: Number(x.unit) || 0, unitLabel: String(x.unitLabel || '').slice(0, 20) });
        const items = (Array.isArray(b.items) ? b.items : []).map(clean).filter(x => x.label && x.qty > 0);
        if (items.some(x => x.qty < 0 || x.unit < 0 || x.qty > 1e7 || x.unit > 1e7)) return res.status(400).json({ error: '数量・単価の値が正しくありません' });
        if (!items.length) return res.status(400).json({ error: '請求する項目がありません' });
        const t = totals(items, c.entity);
        const s = v => String(v || '').trim().slice(0, 100), bank = b.bank || {};
        const bk = { bankName: s(bank.bankName), branch: s(bank.branch), type: bank.type === '当座' ? '当座' : '普通', number: s(bank.number).replace(/[^\d]/g, '').slice(0, 8), holder: s(bank.holder) };
        if (!bk.bankName || !bk.branch || !bk.number || !bk.holder) return res.status(400).json({ error: '振込先（銀行名・支店名・口座番号・口座名義）をすべて入力してください' });
        // 住所：郵便番号・都道府県・市区町村・番地は必須、建物名・部屋番号は任意（2026-10-29 ユーザー指定）
        const a0 = b.addr || {}, ad = { zip: String(a0.zip || '').replace(/[^\d]/g, '').slice(0, 7), pref: s(a0.pref), city: s(a0.city), street: s(a0.street), building: s(a0.building) };
        if (ad.zip.length !== 7) return res.status(400).json({ error: '郵便番号（7けた）を入力してください' });
        if (!ad.pref || !ad.city || !ad.street) return res.status(400).json({ error: '住所（都道府県・市区町村・番地）を入力してください' });
        const address = '〒' + ad.zip.slice(0, 3) + '-' + ad.zip.slice(3) + '\n' + ad.pref + ad.city + ad.street + (ad.building ? '\n' + ad.building : '');
        const doc = {
          contractId: c.id, ym, name: c.name, email: String(c.email || '').toLowerCase(), entity: c.entity || '', company: c.company || '', invoiceNo: c.invoice || '',
          address, addr: ad, bank: bk, items: t.lines, subtotal: t.subtotal, tax: t.tax, withholding: t.withholding, total: t.total,
          remarks: String(b.remarks || '').slice(0, 6000), subject: String(b.subject || '').slice(0, 60),
          articles: (Array.isArray(b.articles) ? b.articles : []).map(String).slice(0, 3000), issueDate: today, dueDate: dueDateOf(ym), lateReason: lateReason || (resubmit ? cur.data().lateReason || '' : ''),
          billingStaffId: c.billingStaffId || '', billingSubStaffId: c.billingSubStaffId || '',
          status: 'checking', submittedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          history: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: c.name, action: resubmit ? '出し直し' : '請求', note: lateReason }),
        };
        if (!cur.exists || !cur.data().invoiceNumber) {   // 請求書番号：年月＋その月の通し番号（例 202610-001）
          const seq = await db.runTransaction(async tx => { const bref = batchRef(ym), bd = await tx.get(bref), n = ((bd.exists && bd.data().seq) || 0) + 1; tx.set(bref, { seq: n }, { merge: true }); return n; });
          doc.invoiceNumber = ym.replace('-', '') + '-' + String(seq).padStart(3, '0');
        }
        await ref.set(doc, { merge: true });
        // 請求担当（メイン、CC サブ）へ。請求担当がいなければ marketing@ へ
        const [m1, m2] = await Promise.all([staffById(c.billingStaffId), staffById(c.billingSubStaffId)]);
        mail(m1 && m1.email ? m1.email : MARKETING, m2 && m2.email ? m2.email : '', tagOf(c) + c.name + ' さんから' + ymJp(ym) + '分の請求が' + (resubmit ? '出し直されました' : '届きました'),
          [(m1 ? m1.name + ' さん' : '請求担当が未設定のため marketing@ に送っています'), '', c.name + ' さんから ' + ymJp(ym) + '分の請求が' + (resubmit ? '出し直されました' : '届きました') + '。', '請求金額：' + fmt(t.total) + '（税抜き小計 ' + fmt(t.subtotal) + '）', lateReason ? '期日を過ぎた理由：' + lateReason : '', '', '内容を確認して「完了」か「差し戻し」をしてください（報酬管理 →「担当者一覧」）。', appUrl(req)].join('\n'));
        res.json({ ok: true, invoice: out(Object.assign({ id: ref.id }, (await ref.get()).data())) });
      } catch (e) { next(e); }
    });
    // 自分が対応すべき請求（請求確認中・経理部から差し戻し）。画面のいちばん上の帯とメニューの件数（2026-10-29 ユーザー指定）
    api.get('/invoices-pending', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const full = isFullAdmin(req.user), st = full ? null : await staffOf(req.user.email);
        if (!full && !st) return res.json({ list: [] });
        const qs = await Promise.all(['checking', 'finance_returned'].map(x => col.where('status', '==', x).get()));
        const list = qs.flatMap(q => q.docs.map(out)).filter(v => full || v.billingStaffId === st.id || v.billingSubStaffId === st.id)
          .map(v => ({ id: v.id, ym: v.ym, name: v.name, status: v.status, role: full ? 'admin' : v.billingStaffId === st.id ? 'メイン' : 'サブ' }));
        res.json({ list });
      } catch (e) { next(e); }
    });
    // BEST社員（請求担当・管理者）：その月の請求の一覧
    api.get('/invoices', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const ym = String(req.query.ym || ''); if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        const full = isFullAdmin(req.user) || (!!expView && expView(req)), st = full ? null : await staffOf(req.user.email);   /* 支出情報の業務委託費（BEST社員）は全員分（2026-11-05） */
        if (!full && !st) return res.json({ invoices: [] });
        const list = (await col.where('ym', '==', ym).get()).docs.map(out).filter(v => full || v.billingStaffId === st.id || v.billingSubStaffId === st.id);
        res.json({ invoices: list });
      } catch (e) { next(e); }
    });
    // BEST社員：完了（経理部確認中へ）／差し戻し
    api.post('/invoices/:id/:action(approve|return)', async (req, res, next) => {
      try {
        const ref = col.doc(req.params.id), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
        const v = snap.data(), c = (await allContracts()).find(x => x.id === v.contractId) || { billingStaffId: v.billingStaffId, billingSubStaffId: v.billingSubStaffId };
        const role = await billingRole(req.user, c); if (!role) return res.status(403).json({ error: 'この請求の担当ではありません' });
        if (!['checking', 'finance_returned'].includes(v.status)) return res.status(400).json({ error: 'この請求は確認できる状態ではありません（' + (STATUS[v.status] || v.status) + '）' });
        const note = String((req.body || {}).note || '').trim().slice(0, 2000), who = req.user.name || req.user.email;
        if (req.params.action === 'return' && !note) return res.status(400).json({ error: '差し戻しの理由（直してほしいところ）を入力してください' });
        if (req.params.action === 'approve' && v.status === 'finance_returned') return res.status(400).json({ error: '経理部から差し戻された請求は、請求者に差し戻して直してもらってください' });
        const approve = req.params.action === 'approve';
        await ref.update({ status: approve ? 'finance' : 'returned', returnNote: approve ? '' : note, returnedBy: approve ? '' : who, checkedBy: who, checkedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          history: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: who, action: approve ? '確認完了（経理部確認中へ）' : '差し戻し', note }) });
        mail(v.email, '', tagOf(c) + ymJp(v.ym) + '分の請求：' + (approve ? '確認が完了しました' : '差し戻しがあります'),
          [v.name + ' 様', '', approve ? ymJp(v.ym) + '分の請求の確認が完了しました。経理部の確認に進みます（状態：経理部確認中）。' : ymJp(v.ym) + '分の請求が ' + who + ' さんから差し戻されました。内容を直して、もう一度「請求する」を押してください。', approve ? '' : '\n差し戻しの理由：\n' + note, '', appUrl(req)].join('\n'));
        if (approve) notifyIfReady(v.ym, req).catch(e => console.warn('invoice ready: ' + e.message));
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // ---- 第2段階：取りまとめ（日比野さん）と経理部 ----
    // PDF（請求者・請求担当・管理者・経理部）
    api.get('/invoices/:id/pdf', async (req, res, next) => {
      try {
        const snap = await col.doc(req.params.id).get(); if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
        const v = snap.data(), c = (await allContracts()).find(x => x.id === v.contractId) || {};
        const ok = mine(req.user, c) || String(v.email) === String(req.user.email || '').toLowerCase() || isFinance(req.user) || !!(await billingRole(req.user, { billingStaffId: v.billingStaffId, billingSubStaffId: v.billingSubStaffId }));
        if (!ok) return res.status(404).json({ error: '見つかりません' });
        // 業務委託の人（請求者本人）が PDF をダウンロードできるのは 2026年11月分から（2026-10-31 ユーザー指定）
        const staffSide = isFinance(req.user) || !!(await billingRole(req.user, { billingStaffId: v.billingStaffId, billingSubStaffId: v.billingSubStaffId }));
        if (!staffSide && String(v.ym || '') < INVOICE_START) return res.status(403).json({ error: 'PDF のダウンロードは 2026年11月分からです' });
        const pdf = await pdfOf(v);
        res.set('Content-Type', 'application/pdf'); res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(pdfName(v))); res.set('Cache-Control', 'no-store');
        res.send(pdf);
      } catch (e) { next(e); }
    });
    // その月の取りまとめ（管理者は全部と未請求の人、経理部は経理部に送った分）
    // BEST の登録番号：見るのはだれでも（請求書に載る）、変えられるのは管理者と経理部だけ（2026-10-30 ユーザー指定）
    api.get('/invoice-best-no', async (req, res, next) => {
      try { res.set('Cache-Control', 'no-store'); res.json({ no: await bestNo(), canEdit: isFinance(req.user) }); } catch (e) { next(e); }
    });
    api.put('/invoice-best-no', async (req, res, next) => {
      try {
        if (!isFinance(req.user)) return res.status(403).json({ error: '管理者と経理部だけが変えられます' });
        const no = String((req.body || {}).no || '').trim().toUpperCase().replace(/[‐－−-]/g, '');
        if (no && !/^T\d{13}$/.test(no)) return res.status(400).json({ error: '登録番号は「T」と13けたの数字で入力してください' });
        await metaRef.set({ bestInvoiceNo: no, bestInvoiceNoBy: req.user.name || req.user.email, bestInvoiceNoAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        bestNoCache = null; res.json({ ok: true, no });
      } catch (e) { next(e); }
    });
    api.get('/invoices-batch/:ym', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const ym = req.params.ym; if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        if (!isFinance(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        const full = isFullAdmin(req.user), all = (await col.where('ym', '==', ym).get()).docs.map(out);
        const list = full ? all : all.filter(v => v.sentAt || ['finance_returned', 'done'].includes(v.status));
        const b = (await batchRef(ym).get()).data() || {};
        const unrequested = full ? (await activeContracts()).filter(c => c.category !== 'site' && !all.some(v => v.contractId === c.id)).map(c => ({ id: c.id, name: c.name, email: c.email || '' })) : [];
        res.json({ ym, invoices: list.map(v => full ? v : Object.assign({}, v, { articles: undefined })), unrequested, batch: { sentAt: ts(b.sentAt), sentBy: b.sentBy || '', doneAt: ts(b.doneAt), doneBy: b.doneBy || '' }, canSend: full, canFinance: isFinance(req.user) });
      } catch (e) { next(e); }
    });
    // 日比野さん：「請求完了」→ finance@ へ（CC marketing@）一覧表と金額、全員分の PDF を添付。多いときは分けて送る
    api.post('/invoices-batch/:ym/send', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけができます' });
        const ym = req.params.ym; if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        const all = (await col.where('ym', '==', ym).get()).docs.map(d => Object.assign({ id: d.id, ref: d.ref }, d.data()));
        const wait = all.filter(v => ['checking', 'returned', 'finance_returned'].includes(v.status));
        if (wait.length) return res.status(400).json({ error: 'まだ確認が終わっていない請求があります：' + wait.map(v => v.name + '（' + STATUS[v.status] + '）').join('、') });
        const send = all.filter(v => v.status === 'finance' && !v.sentAt);   // まだ経理部に送っていない分（経理部の指摘のあと直した分も）
        const extra = extraForBatch ? await extraForBatch(ym) : [];   // 取り込んで確定した単発発注などの請求書（2026-10-29 ユーザー指定）
        if (!send.length && !extra.length) return res.status(400).json({ error: '経理部に送る請求がありません' });
        const pdfs = []; for (const v of send) pdfs.push({ v, filename: pdfName(v), type: 'application/pdf', content: await pdfOf(v) });
        extra.filter(x => x.pdf).forEach(x => pdfs.push({ v: { name: x.v.vendor }, filename: '請求書_' + ymJp(ym) + '分_単発発注_' + (x.v.vendor || '') + '.pdf', type: 'application/pdf', content: x.pdf }));
        const resend = all.some(v => v.sentAt);
        const table = send.map(v => '・' + v.name + (v.company ? '（' + v.company + '）' : '') + '　' + fmt(v.total) + '（税抜き小計 ' + fmt(v.subtotal) + '）').join('\n') + (extra.length ? '\n\n■ 単発発注・その他の請求（確認済み）\n' + extra.map(x => '・' + x.v.vendor + (x.v.subject ? '（' + x.v.subject + '）' : '') + '　' + fmt(x.v.total) + '（税抜き小計 ' + fmt(x.v.subtotal) + '）').join('\n') : ''), sum = send.reduce((a, v) => a + (v.total || 0), 0) + extra.reduce((a, x) => a + (x.v.total || 0), 0);
        // 1通あたり添付10件・合計15MBまでで分ける
        const chunks = []; let cur = [], size = 0;
        pdfs.forEach(x => { if (cur.length >= 10 || size + x.content.length > 15e6) { chunks.push(cur); cur = []; size = 0; } cur.push(x); size += x.content.length; }); if (cur.length) chunks.push(cur);
        for (let i = 0; i < chunks.length; i++) {
          await gmail.send({ to: FINANCE, cc: MARKETING, subject: '【BEST MEDIA】' + ymJp(ym) + '分 業務委託の請求' + (resend ? '（修正分）' : '') + (chunks.length > 1 ? '（' + (i + 1) + '/' + chunks.length + '）' : ''),
            body: ['経理部 御中', '', ymJp(ym) + '分の業務委託の請求' + (resend ? '（修正分）' : '') + 'をお送りします。BEST の請求担当の確認は完了しています。', '', '■ 請求者と請求金額（税込み）', table, '', '合計：' + fmt(sum) + '（' + (send.length + extra.length) + '件）', chunks.length > 1 ? '\n添付が多いため ' + chunks.length + '通に分けています（このメールは ' + (i + 1) + '通目：' + chunks[i].map(x => x.v.name).join('、') + '）' : '', '', '内容の確認・修正の指摘は、ダッシュボードの 報酬管理 →「経理部確認」からお願いします。', appUrl(req)].join('\n'),
            attachments: chunks[i].map(({ filename, type, content }) => ({ filename, type, content })) });
        }
        const now = admin.firestore.FieldValue.serverTimestamp(), who = req.user.name || req.user.email;
        for (const v of send) await v.ref.update({ sentAt: now, updatedAt: now, history: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: who, action: '経理部へ送付', note: '' }) });
        for (const x of extra) await x.ref.update({ sentAt: now, sentBy: who });
        await batchRef(ym).set({ sentAt: now, sentBy: who, mails: admin.firestore.FieldValue.increment(chunks.length) }, { merge: true });
        res.json({ ok: true, sent: send.length + extra.length, mails: chunks.length });
      } catch (e) { next(e); }
    });
    // デモ（2026-10-29 ユーザー指定）：保存せず、経理部へのメール（全員分の PDF 添付）と各お知らせの見本を、日比野さん宛てにだけ送る。件名・本文に【デモ】
    api.post('/invoices-demo', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけができます' });
        const b = req.body || {}, ym = String(b.ym || ''); if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        const today = todayJst(), cs = await allContracts();
        const list = (Array.isArray(b.invoices) ? b.invoices : []).slice(0, 80).map(x => {
          const c = cs.find(y => y.id === x.contractId) || {};
          const items = (Array.isArray(x.items) ? x.items : []).map(i => ({ kind: i.kind === 'other' ? 'other' : 'auto', label: String(i.label || '').slice(0, 100), qty: Number(i.qty) || 0, unit: Number(i.unit) || 0, unitLabel: String(i.unitLabel || '').slice(0, 20) })).filter(i => i.label && i.qty > 0);
          const t = totals(items, c.entity);
          return { tag: tagOf(c), ym, name: c.name || '', entity: c.entity || '', company: c.company || '', invoiceNo: c.invoice || '', email: c.email || '', address: '（デモ）住所はここに入ります', remarks: String(x.remarks || '').slice(0, 6000), invoiceNumber: ym.replace('-', '') + '-DEMO', bank: { bankName: '（デモ）〇〇銀行', branch: '〇〇支店', type: '普通', number: '0000000', holder: 'デモ' }, items: t.lines, subtotal: t.subtotal, tax: t.tax, withholding: t.withholding, total: t.total, issueDate: today, dueDate: dueDateOf(ym), billingStaffId: c.billingStaffId || '' };
        }).filter(v => v.name && v.items.length);
        if (!list.length) return res.status(400).json({ error: '請求の対象になる人がいません（その月に担当記事がある人がいない）' });
        const toFin = b.to === 'finance';
        if (b.to === 'done' || b.to === 'done_ricoh') {   // 報酬確認完了のメールのデモ（日比野さん宛て／リコー宛てに1件だけ）（2026-10-30 ユーザー指定）
          if (b.to === 'done_ricoh') list.splice(1);
          const pdfs = []; for (const v of list) pdfs.push({ v, filename: '【デモ】' + pdfName(v), type: 'application/pdf', content: await pdfOf(v) });
          const table = list.map(v => '・' + v.name + (v.company ? '（' + v.company + '）' : '') + '　' + fmt(v.total));
          const total = list.reduce((a, v) => a + v.total, 0), mails = await sendDoneMail(req, ym, pdfs, { table, sum: total, count: list.length }, b.to === 'done_ricoh' ? 'ricoh' : 'me');
          return res.json({ ok: true, people: list.length, mails, noEmail: list.filter(x => !x.email).length, total });
        }
        const D = '【デモ】', note = toFin ? '※これはデモです（ダッシュボードの請求のしくみの確認用）。実際の請求ではありません。本番では、この形のメールが届きます。' : '※これはデモです。実際の請求ではありません（保存もしていません）。本番では、この内容が finance@best-24.jp（CC marketing@best-24.jp）に届きます。';
        const pdfs = []; for (const v of list) pdfs.push({ v, filename: '【デモ】' + pdfName(v), type: 'application/pdf', content: await pdfOf(v) });
        const chunks = []; let cur = [], size = 0;
        pdfs.forEach(x => { if (cur.length >= 10 || size + x.content.length > 15e6) { chunks.push(cur); cur = []; size = 0; } cur.push(x); size += x.content.length; }); if (cur.length) chunks.push(cur);
        const sum = list.reduce((a, v) => a + v.total, 0), table = list.map(v => '・' + v.name + (v.company ? '（' + v.company + '）' : '') + '　' + fmt(v.total) + '（税抜き小計 ' + fmt(v.subtotal) + '）' + (v.email ? '' : '　※メール未登録')).join('\n');
        for (let i = 0; i < chunks.length; i++) {
          await gmail.send({ to: toFin ? FINANCE_DEMO : HIBINO, cc: toFin ? HIBINO : '', subject: D + '【BEST MEDIA】' + ymJp(ym) + '分 業務委託の請求' + (chunks.length > 1 ? '（' + (i + 1) + '/' + chunks.length + '）' : ''),
            body: [note, '', '経理部 御中', '', ymJp(ym) + '分の業務委託の請求をお送りします。BEST の請求担当の確認は完了しています。', '', '■ 請求者と請求金額（税込み）', table, '', '合計：' + fmt(sum) + '（' + list.length + '件）', chunks.length > 1 ? '\n添付が多いため ' + chunks.length + '通に分けています（このメールは ' + (i + 1) + '通目：' + chunks[i].map(x => x.v.name).join('、') + '）' : '', '', '内容の確認・修正の指摘は、ダッシュボードの 報酬管理 →「経理部確認」からお願いします。', appUrl(req)].join('\n'),
            attachments: chunks[i].map(({ filename, type, content }) => ({ filename, type, content })) });
        }
        if (toFin) return res.json({ ok: true, people: list.length, mails: chunks.length, noEmail: list.filter(x => !x.email).length, total: sum, to: FINANCE_DEMO });
        // ほかのお知らせの見本（1人目の内容で）
        // ほかのお知らせの見本（1人目の内容で）
        const v = list[0], st = await staffById(v.billingStaffId), url = appUrl(req), mk = (subject, lines) => gmail.send({ to: HIBINO, subject: D + subject, body: [note.replace('本番では、この内容が finance@best-24.jp（CC marketing@best-24.jp）に届きます。', '本番の宛先：' + lines[0]), ''].concat(lines.slice(1)).join('\n') });
        await mk(v.tag + v.name + ' さんから' + ymJp(ym) + '分の請求が届きました', ['メインの請求担当（' + (st ? st.name : '未設定のため marketing@') + '）、CC サブの請求担当', (st ? st.name + ' さん' : ''), '', v.name + ' さんから ' + ymJp(ym) + '分の請求が届きました。', '請求金額：' + fmt(v.total) + '（税抜き小計 ' + fmt(v.subtotal) + '）', '', '内容を確認して「完了」か「差し戻し」をしてください（報酬管理 →「担当者一覧」）。', url]);
        await mk(v.tag + ymJp(ym) + '分の請求：差し戻しがあります', ['請求者（' + v.name + ' さん）', v.name + ' 様', '', ymJp(ym) + '分の請求が ' + (st ? st.name : '請求担当') + ' さんから差し戻されました。内容を直して、もう一度「請求する」を押してください。', '', '差し戻しの理由：', '（ここに請求担当が書いた理由が入ります）', '', url]);
        await mk(v.tag + ymJp(ym) + '分の請求：確認が完了しました', ['請求者（' + v.name + ' さん）', v.name + ' 様', '', ymJp(ym) + '分の請求の確認が完了しました。経理部の確認に進みます（状態：経理部確認中）。', '', url]);
        await mk(v.tag + '【要対応】' + v.name + ' さんの' + ymJp(ym) + '分の請求が確認されていません', ['メインの請求担当、CC サブの請求担当・marketing@（請求から平日2日たったとき、毎朝9時）', (st ? st.name + ' さん' : ''), '', v.name + ' さんの ' + ymJp(ym) + '分の請求が、平日2日以上確認されていません。', '請求金額：' + fmt(v.total), '', '内容を確認して「完了」か「差し戻し」をしてください（報酬管理 →「担当者一覧」）。', url]);
        await mk(v.tag + ymJp(ym) + '分の請求がまだ届いていません', ['担当記事があるのに請求していない人（翌月3日 0:00）', v.name + ' 様', '', ymJp(ym) + 'に担当した記事がありますが、' + ymJp(ym) + '分の請求がまだ届いていません（期日：翌月2日）。', '', '翌月4日までは、期日を過ぎた理由を入れて請求できます。5日以降は受け付けられません。', 'ダッシュボードの 報酬管理 →「報酬」の「請求」から請求してください。', url]);
        await mk(v.tag + '経理部から' + v.name + ' さんの' + ymJp(ym) + '分の請求に修正の指摘があります', ['メインの請求担当、CC サブの請求担当', '経理部から ' + v.name + ' さんの ' + ymJp(ym) + '分の請求に修正の指摘がありました。', '', '指摘：', '（ここに経理部が書いた内容が入ります）', '', '内容を確認して、請求者に差し戻してください（報酬管理 →「担当者一覧」）。', url]);
        await mk('【BEST MEDIA】' + ymJp(ym) + '分の請求が完了しました', ['marketing@best-24.jp（経理部が「全員分の確認が完了」を押したとき）', ymJp(ym) + '分の業務委託の請求について、経理部の確認が完了しました（修正なし）。', '', '件数：' + list.length + '件　合計：' + fmt(sum), '', url]);
        res.json({ ok: true, people: list.length, mails: chunks.length + 6, noEmail: list.filter(x => !x.email).length, total: sum });
      } catch (e) { next(e); }
    });
    // 経理部：修正の指摘（その人の請求担当のメイン・サブへ。請求担当が確認して請求者に差し戻す）
    api.post('/invoices/:id/finance-return', async (req, res, next) => {
      try {
        if (!isFinance(req.user)) return res.status(403).json({ error: '経理部だけができます' });
        const ref = col.doc(req.params.id), snap = await ref.get(); if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
        const v = snap.data(), note = String((req.body || {}).note || '').trim().slice(0, 2000);
        if (v.status !== 'finance' || !v.sentAt) return res.status(400).json({ error: 'この請求は指摘できる状態ではありません' });
        if (!note) return res.status(400).json({ error: '修正してほしいところを入力してください' });
        await ref.update({ status: 'finance_returned', financeNote: note, sentAt: null, updatedAt: admin.firestore.FieldValue.serverTimestamp(), history: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: '経理部', action: '経理部から差し戻し', note }) });
        const [m1, m2] = await Promise.all([staffById(v.billingStaffId), staffById(v.billingSubStaffId)]);
        mail(m1 && m1.email ? m1.email : MARKETING, m2 && m2.email ? m2.email : '', (await tagById(v.contractId)) + '経理部から' + v.name + ' さんの' + ymJp(v.ym) + '分の請求に修正の指摘があります',
          ['経理部から ' + v.name + ' さんの ' + ymJp(v.ym) + '分の請求に修正の指摘がありました。', '', '指摘：', note, '', '内容を確認して、請求者に差し戻してください（報酬管理 →「担当者一覧」）。', appUrl(req)].join('\n'));
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    /** 報酬確認完了のメール：To リコー、CC corporate_finance@・日比野さん。件名【BEST MEDIA】◯年◯月分 報酬確認完了、全員分の PDF を添付（1通10件・15MBまでで分割）（2026-10-30 ユーザー指定）
     *  demo のときは日比野さんだけに送り、件名・本文に【デモ】 */
    async function sendDoneMail(req, ym, pdfs, lines, demo) {
      const chunks = []; let cur = [], size = 0;
      pdfs.forEach(x => { if (cur.length >= 10 || size + x.content.length > 15e6) { chunks.push(cur); cur = []; size = 0; } cur.push(x); size += x.content.length; }); if (cur.length) chunks.push(cur);
      if (!chunks.length) chunks.push([]);
      for (let i = 0; i < chunks.length; i++) {
        await gmail.send({ to: demo && demo !== 'ricoh' ? HIBINO : DONE_TO, cc: demo && demo !== 'ricoh' ? '' : DONE_CC + ', ' + HIBINO,
          subject: (demo ? '【デモ】' : '') + '【BEST MEDIA】' + ymJp(ym) + '分 報酬確認完了' + (chunks.length > 1 ? '（' + (i + 1) + '/' + chunks.length + '）' : ''),
          body: (demo ? ['※これはデモです（保存も状態の変更もしていません）。本番では、経理部が「全員分の確認が完了」を押したときに、To ' + DONE_TO + '、CC ' + DONE_CC + '・日比野さん に届きます。', ''] : [])
            .concat([ymJp(ym) + '分の業務委託の報酬について、経理部の確認が完了しました。全員分の請求書（PDF）を添付します。', '', '■ 請求者と請求金額（税込み）'], lines.table, ['', '合計：' + fmt(lines.sum) + '（' + lines.count + '件）'],
              chunks.length > 1 ? ['', '添付が多いため ' + chunks.length + '通に分けています（このメールは ' + (i + 1) + '通目：' + chunks[i].map(x => x.v.name).join('、') + '）'] : []).join('\n'),
          attachments: chunks[i].map(({ filename, type, content }) => ({ filename, type, content })) });
      }
      return chunks.length;
    }
    // 経理部：全員分の確認が完了（修正なし）→ 請求完了。marketing@ へ「今月の請求完了」
    api.post('/invoices-batch/:ym/finance-done', async (req, res, next) => {
      try {
        if (!isFinance(req.user)) return res.status(403).json({ error: '経理部だけができます' });
        const ym = req.params.ym; if (!isYm(ym)) return res.status(400).json({ error: '月が正しくありません' });
        const all = (await col.where('ym', '==', ym).get()).docs;
        const open = all.filter(d => !['done', 'finance'].includes(d.data().status) || (d.data().status === 'finance' && !d.data().sentAt));
        if (open.length) return res.status(400).json({ error: 'まだ修正中・送付前の請求があります：' + open.map(d => d.data().name + '（' + (STATUS[d.data().status] || '') + '）').join('、') });
        const fin = all.filter(d => d.data().status === 'finance'); if (!fin.length) return res.status(400).json({ error: '確認する請求がありません' });
        const now = admin.firestore.FieldValue.serverTimestamp(), who = (req.user.roleEff === 'finance' ? '経理部' : req.user.name || req.user.email);
        for (const d of fin) await d.ref.update({ status: 'done', doneAt: now, updatedAt: now, history: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: who, action: '請求完了', note: '' }) });
        await batchRef(ym).set({ doneAt: now, doneBy: who }, { merge: true });
        const sum = all.reduce((a, d) => a + (d.data().total || 0), 0);
        mail(MARKETING, '', '【BEST MEDIA】' + ymJp(ym) + '分の請求が完了しました', [ymJp(ym) + '分の業務委託の請求について、経理部の確認が完了しました（修正なし）。', '', '件数：' + all.length + '件　合計：' + fmt(sum), '', appUrl(req)].join('\n'));
        // 報酬確認完了のメール（全員分の PDF。単発発注など取り込んだ請求書も）（2026-10-30 ユーザー指定）
        let mails = 0;
        try {
          const invs = all.map(d => Object.assign({ id: d.id }, d.data())).filter(v => v.status === 'done' || fin.some(f => f.id === v.id)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
          const extra = extraForBatch ? await extraForBatch(ym, { all: true }) : [];
          const pdfs = []; for (const v of invs) pdfs.push({ v, filename: pdfName(v), type: 'application/pdf', content: await pdfOf(v) });
          extra.filter(x => x.pdf).forEach(x => pdfs.push({ v: { name: x.v.vendor }, filename: '請求書_' + ymJp(ym) + '分_単発発注_' + (x.v.vendor || '') + '.pdf', type: 'application/pdf', content: x.pdf }));
          const table = invs.map(v => '・' + v.name + (v.company ? '（' + v.company + '）' : '') + '　' + fmt(v.total)).concat(extra.map(x => '・' + x.v.vendor + '（単発発注）　' + fmt(x.v.total)));
          mails = await sendDoneMail(req, ym, pdfs, { table, sum: invs.reduce((a, v) => a + (v.total || 0), 0) + extra.reduce((a, x) => a + (x.v.total || 0), 0), count: table.length }, false);
          await batchRef(ym).set({ doneMailAt: admin.firestore.FieldValue.serverTimestamp(), doneMails: mails }, { merge: true });
        } catch (e) { console.warn('invoice done mail: ' + e.message); await batchRef(ym).set({ doneMailError: String(e.message).slice(0, 300) }, { merge: true }); }
        res.json({ ok: true, done: fin.length, mails });
      } catch (e) { next(e); }
    });
  }
  const pdfName = v => '請求書_' + ymJp(v.ym) + '分_' + (v.company || v.name || '') + '.pdf';
  /** その月の請求で、確認待ち（請求確認中・差し戻し・経理部から差し戻し）がなく、まだ経理部に送っていない分があれば日比野さんへ */
  async function notifyIfReady(ym, req) {
    const all = (await col.where('ym', '==', ym).get()).docs.map(d => d.data());
    if (all.some(v => ['checking', 'returned', 'finance_returned'].includes(v.status))) return;
    const ready = all.filter(v => v.status === 'finance' && !v.sentAt); if (!ready.length) return;
    mail(HIBINO, '', '【BEST MEDIA】' + ymJp(ym) + '分の請求：請求担当の確認がすべて完了しました', ['請求担当の確認が終わった請求が ' + ready.length + '件あります（確認待ちはありません）。', '', ready.map(v => '・' + v.name + '　' + fmt(v.total)).join('\n'), '', '内容を確認して「請求完了（経理部へ送る）」を押してください（報酬管理 →「請求の取りまとめ」）。', appUrl(req)].join('\n'));
  }
  /** 平日の日数（from の翌日から to まで。土日は数えない） */
  const weekdaysBetween = (from, to) => { let n = 0; const d = new Date(from + 'T00:00:00Z'), e = new Date(to + 'T00:00:00Z'); for (d.setUTCDate(d.getUTCDate() + 1); d <= e; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) n++; return n; };
  const jstDate = v => v && v.toDate ? new Date(v.toDate().getTime() + 9 * 3600000).toISOString().slice(0, 10) : String(v || '').slice(0, 10);
  /** 定期実行のアラート */
  async function alerts(mode, url) {
    const today = todayJst();
    if (mode === 'stale') {   // 請求から平日2日間、請求担当が確認していない → To メイン、CC サブ・marketing@（そのあとも平日2日ごとに）
      if ([0, 6].includes(new Date(today + 'T00:00:00Z').getUTCDay())) return { ok: true, skipped: '土日' };
      const list = (await col.where('status', '==', 'checking').get()).docs; let n = 0;
      for (const d of list) {
        const v = d.data(), since = v.staleAlertAt ? jstDate(v.staleAlertAt) : jstDate(v.submittedAt);
        if (!since || weekdaysBetween(since, today) < 2) continue;
        const [m1, m2] = await Promise.all([staffById(v.billingStaffId), staffById(v.billingSubStaffId)]);
        await mail(m1 && m1.email ? m1.email : MARKETING, [m2 && m2.email, MARKETING].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i && x !== (m1 && m1.email)).join(', '),
          (await tagById(v.contractId)) + '【要対応】' + v.name + ' さんの' + ymJp(v.ym) + '分の請求が確認されていません',
          [(m1 ? m1.name + ' さん' : '請求担当が未設定です'), '', v.name + ' さんの ' + ymJp(v.ym) + '分の請求（' + jstDate(v.submittedAt) + ' 請求）が、平日2日以上確認されていません。', '請求金額：' + fmt(v.total), '', '内容を確認して「完了」か「差し戻し」をしてください（報酬管理 →「担当者一覧」）。', url].join('\n'));
        await d.ref.update({ staleAlertAt: admin.firestore.FieldValue.serverTimestamp() }); n++;
      }
      return { ok: true, mode, alerted: n };
    }
    if (mode === 'unrequested') {   // 翌月3日 0:00：前の月に担当記事があるのに請求していない人へ（猶予は4日まで）
      const ym = shiftYm(today.slice(0, 7), -1);
      if (ym < INVOICE_START) return { ok: true, mode, skipped: ym + '分はこのWEBアプリでの請求の対象外（' + INVOICE_START + '分から）' };
      const ids = await contractsWithArticles(ym), done = new Set((await col.where('ym', '==', ym).get()).docs.map(d => d.data().contractId));
      const cs = (await activeContracts()).filter(c => ids.has(c.id) && !done.has(c.id) && c.category !== 'site'); let n = 0, noMail = [];
      for (const c of cs) {
        if (!c.email) { noMail.push(c.name); continue; }
        await mail(c.email, '', tagOf(c) + ymJp(ym) + '分の請求がまだ届いていません', [c.name + ' 様', '', ymJp(ym) + 'に担当した記事がありますが、' + ymJp(ym) + '分の請求がまだ届いていません（期日：' + Number(today.slice(5, 7)) + '月2日）。', '', Number(today.slice(5, 7)) + '月4日までは、期日を過ぎた理由を入れて請求できます。5日以降は受け付けられません。', 'ダッシュボードの 報酬管理 →「報酬」の「請求」から請求してください。', url].join('\n')); n++;
      }
      if (cs.length) await mail(MARKETING, '', '【BEST MEDIA】' + ymJp(ym) + '分の未請求：' + cs.length + '人', ['担当記事があるのに ' + ymJp(ym) + '分を請求していない人に、お知らせを送りました。', '', cs.map(c => '・' + c.name + (c.email ? '' : '（メール未登録のため送れていません）')).join('\n'), '', url].join('\n'));
      return { ok: true, mode, ym, alerted: n, noMail };
    }
    return { ok: false, error: 'mode が正しくありません' };
  }
  /** 支出の業務委託費（2026-10-29 ユーザー指定 B）：2026年11月分（INVOICE_START）から、請求担当が確認した請求（経理部確認中・請求完了）の税抜き小計をメディアごとに。
   *  メディアのない行（その他の項目・稼働表の時間）は、その請求のメディアの金額の割合で分ける（メディアの行がなければ契約の担当メディアで等分） */
  async function costRows() {
    const q = await col.where('ym', '>=', INVOICE_START).get(), cs = await allContracts(), out = [];
    q.docs.forEach(d => {
      const v = d.data(); if (!['finance', 'finance_returned', 'done'].includes(v.status)) return;
      const by = {}; let rest = 0;
      (v.items || []).forEach(i => { const a = Number(i.amount) || 0; if (i.media) by[i.media] = (by[i.media] || 0) + a; else rest += a; });
      let ms = Object.keys(by);
      if (!ms.length) { const c = cs.find(x => x.id === v.contractId) || {}; ms = (c.medias || []).slice(); ms.forEach(m => { by[m] = 0; }); }
      if (!ms.length) return;
      const base = ms.reduce((s, m) => s + by[m], 0);
      ms.forEach(m => { const val = by[m] + (base > 0 ? rest * by[m] / base : rest / ms.length); if (val) out.push({ ym: v.ym, media: m, block: '', item: 'cost_article', value: Math.round(val) }); });
    });
    return out;
  }
  return { routes, alerts, costRows, INVOICE_START, windowOf, dueDateOf, totals };
};
