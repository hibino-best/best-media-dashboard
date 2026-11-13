// 単発発注などの請求書の取り込み（2026-10-29 ユーザー指定）
// ・支出管理で PDF をアップロード → 文字を読み取って項目を下書き（pdf-parse。文字のない画像の PDF は手で入力）
// ・確認の画面で人が確認・修正 →「確定」で支出（区分・メディアの配分）に入り、その月の経理部宛ての請求メールに PDF と一緒に入る
// ・取り込み・確定できるのは管理者と、権限管理で「支出管理」の権限がある人
const pdf = require('pdf-parse/lib/pdf-parse.js');
const CATS = { cost_staff: 'BEST人件費', cost_tool: 'ツール', cost_site: 'サイト制作・修正', cost_article: '業務委託費', cost_press: 'プレスリリース費', cost_ai: 'ツール利用費' };   /* AI費はツール利用費（2026-11-13 ユーザー指定） */   // 2026-10-29 ユーザー指定の名前
const isYm = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const num = s => Number(String(s || '').replace(/[,，\s円¥￥]/g, '')) || 0;
const z2 = n => String(n).padStart(2, '0');

/** 読み取った文字から項目を推定する（推定なので、確認の画面で人が直す） */
function extract(text) {
  const t = String(text || '').replace(/\r/g, ''), lines = t.split('\n').map(x => x.trim()).filter(Boolean), o = {};
  const inv = t.match(/T\d{13}/); if (inv) o.invoiceNo = inv[0];
  const dates = [...t.matchAll(/(20\d{2})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?/g)].map(m => m[1] + '-' + z2(m[2]) + '-' + z2(m[3]));
  const near = re => { const i = lines.findIndex(l => re.test(l)); if (i < 0) return ''; for (let k = i; k < Math.min(lines.length, i + 3); k++) { const m = lines[k].match(/(20\d{2})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/); if (m) return m[1] + '-' + z2(m[2]) + '-' + z2(m[3]); } return ''; };
  o.issueDate = near(/請求日|発行日/) || dates[0] || '';
  o.dueDate = near(/支払期日|入金期日|お支払期限|振込期日|支払期限/) || (dates.length > 1 ? dates.filter(d => d > o.issueDate).sort()[0] || '' : '');
  const sub = t.match(/(20\d{2})年\s*(\d{1,2})月分/); if (sub) o.ym = sub[1] + '-' + z2(sub[2]);
  const subj = lines.find(l => /月分/.test(l) && l.length < 60); if (subj) o.subject = subj.replace(/^件名[:：\s]*/, '');
  o.vendor = (lines.find(l => /(株式会社|有限会社|合同会社|合資会社|一般社団法人|事務所)/.test(l) && !/BEST/i.test(l)) || '').replace(/\s*御中$/, '').slice(0, 80);
  o.toBest = /BEST株式会社|株式会社BEST|BEST\s*株式会社/i.test(t);
  // 金額：「円」の付いた数字（なければ桁区切りの数字）。合計＝いちばん大きい額、小計＋消費税＝合計 になる組を探す
  let amts = [...t.matchAll(/([\d,，]{3,})\s*円/g)].map(m => num(m[1])).filter(v => v > 0);
  if (!amts.length) amts = [...t.matchAll(/¥\s*([\d,]{3,})/g)].map(m => num(m[1])).filter(v => v > 0);
  const uniq = [...new Set(amts)].sort((a, b) => b - a);
  if (uniq.length) {
    o.total = uniq[0];
    for (const s of uniq) { const tx = o.total - s; if (s < o.total && tx > 0 && Math.abs(tx - Math.floor(s * 0.1)) <= 1) { o.subtotal = s; o.tax = tx; break; } }
    if (o.subtotal == null) { const w = t.match(/源泉[^\d]{0,12}([\d,]{3,})/); if (w) o.withholding = num(w[1]); }
  }
  const wh = t.match(/源泉[^\n]{0,20}?([\d,]{3,})/); if (wh) o.withholding = num(wh[1]);
  // 振込先
  const bi = lines.findIndex(l => /銀行|信用金庫|信金|ゆうちょ/.test(l));
  if (bi >= 0) { o.bank = { bankName: lines[bi].replace(/^振込先[:：\s]*/, '').slice(0, 40) }; const br = lines.slice(bi, bi + 4).find(l => /支店|営業部|出張所/.test(l) && l !== lines[bi]); if (br) o.bank.branch = br.slice(0, 40); const ac = lines.slice(bi, bi + 5).join(' ').match(/(普通|当座|（普）|\(普\)|（当）)\s*(\d{6,8})/); if (ac) { o.bank.type = /当/.test(ac[1]) ? '当座' : '普通'; o.bank.number = ac[2]; } const hd = lines.slice(bi, bi + 6).find(l => /^[ァ-ヶー（）()\s．.・]+$|^カ[）)]|名義/.test(l)); if (hd) o.bank.holder = hd.replace(/^.*名義[:：\s]*/, '').slice(0, 40); }
  return o;
}
/** 確認の画面のアラート（level：ng＝確定できない、warn＝注意） */
function checks(v) {
  const a = [], add = (level, msg) => a.push({ level, msg });
  if (!v.textLength) add('warn', 'PDF から文字を読み取れませんでした（画像の PDF の可能性）。項目をすべて手で入力してください');
  if (!v.vendor) add('ng', '請求元（会社名・氏名）が入っていません');
  if (!v.issueDate) add('ng', '請求日が入っていません');
  if (!isYm(v.ym)) add('ng', '計上する月（何月分の支出か）が入っていません');
  if (!(v.total > 0)) add('ng', '請求金額（税込み）が入っていません');
  if (!(v.subtotal > 0)) add('ng', '小計（税抜き）が入っていません');
  if (!CATS[v.category]) add('ng', '支出の区分を選んでください');
  const alloc = (v.allocations || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (!(v.allocations || []).length || (v.allocations || []).some(x => !x.media)) add('ng', 'メディアを選んでください');
  else if (v.subtotal > 0 && Math.round(alloc) !== Math.round(v.subtotal)) add('ng', 'メディアの配分の合計（' + alloc.toLocaleString('ja-JP') + '円）が小計（税抜き）と合っていません');
  if (v.subtotal > 0 && v.total > 0 && Math.round(v.subtotal + (v.tax || 0) - (v.withholding || 0)) !== Math.round(v.total)) add('warn', '小計＋消費税' + (v.withholding ? '−源泉所得税' : '') + ' が請求金額と合っていません');
  if (v.subtotal > 0 && v.tax != null && Math.abs((v.tax || 0) - Math.floor(v.subtotal * 0.1)) > 1) add('warn', '消費税が小計の10%ではありません（軽減税率・端数・免税などを確認してください）');
  if (!/^T\d{13}$/.test(String(v.invoiceNo || ''))) add('warn', 'インボイス登録番号（T＋13けた）がありません。免税事業者の場合は仕入税額控除の対象外です');
  if (v.toBest === false) add('warn', '宛名に「BEST株式会社」が見つかりません。宛名を確認してください');
  if (!v.dueDate) add('warn', '支払期日が入っていません');
  const b = v.bank || {}; if (!b.bankName || !b.number) add('warn', '振込先（銀行名・口座番号）が入っていません');
  return a;
}

module.exports = function expenseInvoices({ db, admin, isFullAdmin, hasAdminCap, isBestStaff, files, MEDIA_ORDER, onChanged }) {
  const col = db.collection('expense_invoices');
  const can = u => isFullAdmin(u) || hasAdminCap(u, 'admin_expenses') || (!!isBestStaff && isBestStaff(u));   /* BEST社員も入力できる（2026-11-05 ユーザー指定） */
  const ts = v => v && v.toDate ? v.toDate().toISOString() : (v || null);
  const out = d => { const v = d.data(); return Object.assign({ id: d.id }, v, { uploadedAt: ts(v.uploadedAt), confirmedAt: ts(v.confirmedAt), sentAt: ts(v.sentAt), updatedAt: ts(v.updatedAt), checks: checks(v) }); };
  const medias = MEDIA_ORDER.map(x => x[0]);
  const clean = b => {
    const s = (x, n) => String(x == null ? '' : x).trim().slice(0, n || 100), d = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? x : '';
    const bank = b.bank || {};
    return { vendor: s(b.vendor), subject: s(b.subject), issueDate: d(b.issueDate), dueDate: d(b.dueDate), ym: isYm(b.ym) ? b.ym : '', invoiceNo: s(b.invoiceNo, 20), subtotal: num(b.subtotal), tax: num(b.tax), withholding: num(b.withholding), total: num(b.total),
      category: CATS[b.category] ? b.category : '', note: s(b.note, 1000), bank: { bankName: s(bank.bankName, 40), branch: s(bank.branch, 40), type: bank.type === '当座' ? '当座' : '普通', number: s(bank.number, 8).replace(/[^\d]/g, ''), holder: s(bank.holder, 40) },
      allocations: (Array.isArray(b.allocations) ? b.allocations : []).slice(0, 12).map(x => ({ media: medias.includes(x.media) ? x.media : '', amount: num(x.amount) })).filter(x => x.media || x.amount),
      links: (Array.isArray(b.links) ? b.links : []).slice(0, 60).map(x => ({ releaseId: s(x.releaseId, 200), phase: s(x.phase, 40), amount: num(x.amount) })).filter(x => x.releaseId) };   /* プレスリリース費：どのリリースのどのフェーズに使ったか（2026-11-02 ユーザー指定） */
  };

  function routes(api, express) {
    api.get('/expense-invoices', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        res.set('Cache-Control', 'no-store');
        res.json({ list: (await col.orderBy('uploadedAt', 'desc').limit(300).get()).docs.map(out), cats: CATS, medias: MEDIA_ORDER });
      } catch (e) { next(e); }
    });
    // アップロード → 読み取り → 下書き
    api.post('/expense-invoices', express.raw({ type: 'application/pdf', limit: '20mb' }), async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'PDFファイルを選んでください' });
        const ref = col.doc(), object = 'expenses/' + ref.id + '.pdf';
        await files.putObject(object, req.body, 'application/pdf');
        let text = ''; try { text = (await pdf(req.body)).text || ''; } catch (e) { console.warn('expense pdf parse: ' + e.message); }
        const x = extract(text), today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
        const v = Object.assign({ vendor: '', subject: '', issueDate: '', dueDate: '', ym: '', invoiceNo: '', subtotal: 0, tax: 0, withholding: 0, total: 0, category: '', note: '', bank: {}, allocations: [] }, x);
        if (!v.ym && v.issueDate) v.ym = v.issueDate.slice(0, 7);
        Object.assign(v, { status: 'draft', fileObject: object, fileName: String(req.query.name || 'invoice.pdf').slice(0, 120), textLength: text.replace(/\s/g, '').length, uploadedBy: req.user.email, uploadedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        await ref.set(v);
        res.json({ ok: true, invoice: out(await ref.get()) });
      } catch (e) { next(e); }
    });
    // 手で入力する支出（PDF なし）。区分と支払い先（PR TIMES・freaaasy など）を決めて下書きを作る（2026-11-02 ユーザー指定）
    api.post('/expense-invoices/manual', express.json(), async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        const b = req.body || {}, ref = col.doc();
        await ref.set({ vendor: String(b.vendor || '').slice(0, 100), subject: '', issueDate: '', dueDate: '', ym: '', invoiceNo: '', subtotal: 0, tax: 0, withholding: 0, total: 0, category: CATS[b.category] ? b.category : '', note: '', bank: {}, allocations: [],
          status: 'draft', manual: true, fileObject: '', fileName: '（この画面から入力）', textLength: 1, uploadedBy: req.user.email, uploadedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true, invoice: out(await ref.get()) });
      } catch (e) { next(e); }
    });
    api.get('/expense-invoices/:id/file', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(404).json({ error: '見つかりません' });
        const d = await col.doc(req.params.id).get(); if (!d.exists) return res.status(404).json({ error: '見つかりません' });
        if (!d.data().fileObject) return res.status(404).json({ error: 'PDFはありません（この画面から入力した支出）' });
        const o = await files.getObject(d.data().fileObject);
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).send(o.body);
      } catch (e) { next(e); }
    });
    // 保存（下書きのまま）・確定・確定の取り消し・削除
    api.put('/expense-invoices/:id', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        const ref = col.doc(req.params.id), d = await ref.get(); if (!d.exists) return res.status(404).json({ error: '見つかりません' });
        if (d.data().sentAt) return res.status(400).json({ error: '経理部に送った請求書は変更できません' });
        const v = clean(req.body || {}), action = (req.body || {}).action;
        const merged = Object.assign({}, d.data(), v);
        if (action === 'confirm') { const ng = checks(merged).filter(x => x.level === 'ng'); if (ng.length) return res.status(400).json({ error: '確定できません：' + ng.map(x => x.msg).join('／'), checks: checks(merged) }); }
        await ref.update(Object.assign(v, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, action === 'confirm' ? { status: 'confirmed', confirmedBy: req.user.email, confirmedAt: admin.firestore.FieldValue.serverTimestamp() } : action === 'unconfirm' ? { status: 'draft', confirmedBy: '', confirmedAt: null } : {}));
        if (action) onChanged();
        res.json({ ok: true, invoice: out(await ref.get()) });
      } catch (e) { next(e); }
    });
    api.delete('/expense-invoices/:id', async (req, res, next) => {
      try {
        if (!can(req.user)) return res.status(403).json({ error: '支出管理の権限がありません' });
        const ref = col.doc(req.params.id), d = await ref.get(); if (!d.exists) return res.status(404).json({ error: '見つかりません' });
        if (d.data().status === 'confirmed') return res.status(400).json({ error: '確定した請求書は消せません。先に「確定を取り消す」を押してください' });
        await ref.delete(); res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  /** プレスリリース費のうち、リリースごとに分ける支払い先（PR TIMES＝配信費、freaaasy＝調査費）（2026-11-02 ユーザー指定） */
  const pressKind = v => v.category !== 'cost_press' ? '' : /PR\s*TIMES/i.test(v.vendor || '') ? 'dist' : /free?a+sy|フリージー/i.test(v.vendor || '') ? 'research' : '';
  async function pressExpenses() {
    const q = await col.where('status', '==', 'confirmed').get();
    return q.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(v => pressKind(v)).map(v => ({ id: v.id, vendor: v.vendor, ym: v.ym, kind: pressKind(v), amount: Number(v.subtotal) || 0, links: (v.links || []).map(l => ({ releaseId: l.releaseId, phase: l.phase || '', amount: Number(l.amount) || 0 })), allocations: (v.allocations || []).map(a => ({ media: a.media, amount: Number(a.amount) || 0 })) }));
  }
  /** 支出に入れる行（確定したものだけ。配分ごと）。PR TIMES・freaaasy は press.js の行で入れるので除く */
  async function rows() {
    const q = await col.where('status', '==', 'confirmed').get(), out = [];
    q.docs.forEach(d => { const v = d.data(); if (pressKind(v)) return; (v.allocations || []).forEach(a => { if (a.media && a.amount) out.push({ ym: v.ym, media: a.media, block: '', item: v.category, value: Number(a.amount) }); }); });
    return out;
  }
  /** 経理部への送付に入れる分（その月に計上・確定・まだ送っていない） */
  async function forBatch(ym, opt = {}) {   // opt.all：経理部へ送ったものも含める（報酬確認完了のメール用）
    const q = await col.where('status', '==', 'confirmed').get();
    const list = q.docs.filter(d => d.data().ym === ym && (opt.all || !d.data().sentAt));
    const items = []; for (const d of list) { const v = d.data(); let body = null; try { body = (await files.getObject(v.fileObject)).body; } catch (e) { console.warn('expense file: ' + e.message); } items.push({ ref: d.ref, v, pdf: body }); }
    return items;
  }
  return { routes, rows, forBatch, pressExpenses, CATS };
};
