/**
 * BEST社員管理（2026-10-27 ユーザー指定で作り直し）
 *
 * Firestore staff/{id}：社員
 *   name・email・birthDate（生年月日）・joinDate（入社日）・retireDate（退職日。空＝現職）・empType（正社員／契約社員／アルバイト／役員）
 *   retireType（退職／昇格）・promoTo（昇格先：役員／執行役員）・promoDate（昇格日）・promoPay（昇格後の報酬：役員＝月額、執行役員＝年俸）・execRetireDate（退任日）
 *   … 昇格したときは昇格日から役員・執行役員。入社日は最初の入社日のまま（2026-10-27 ユーザー指定）
 *   報酬の形：正社員・契約社員＝月給（＋想定年収）、アルバイト＝時給（initHourly）×月の勤務時間の目安（initHours）、役員＝月額報酬、執行役員＝年俸（initAnnual）
 *   initPosition・initAnnual（想定年収）・initMonthly（月の給与）＝入社時の内容
 *   docs：[{label（履歴書／職務経歴書）, name, object, at}] … PDF は公開できない保管場所（Cloud Storage）
 *   assign：{ 'YYYY-MM': [{media, sub, position}] } … 月ごとに、どのメディア（sub＝ディレクトリ。空＝メディア全体）をどのポジションで担当するか
 * staff/{id}/halves/{半期の最初の月}：bonusMonths（賞与＝何か月分。小数可。金額＝半期の最初の月の給与×か月数）・raise（昇給額）・評価（アルバイト・役員は評価なし）
 *   skillGroups：{大分類: {self, boss}}（MKTスキル指標は大分類ごとの合計点だけ。2026-10-27 ユーザー指定）
 *   position（その半期のポジション。月ごとの担当はこのポジションだけ選べる。2026-10-27 ユーザー指定）・evalPosition・skill：{項目ID: {self, boss}}（〇△×）・behavior：{分類: {self, boss}}（記述）・perf：{rank, comment}・selfNote・bossNote
 * staff/{id}/work/{YYYY-MM}：目標・稼働工数（本人が入力 → 申請 → 管理者が承認／却下）
 *   draft：{resource：{media: %}, targets：{行ID: {new, rewrite}}}・approved：承認された内容・status（draft／submitted／approved／rejected）
 *   承認された記事目標は記事目標設定（article_targets）に入る。承認済みの内容を直すときは、もう一度申請して承認が必要
 *
 * 見られる人：一覧・担当は管理者と「BEST社員管理」の権限がある人。
 *   生年月日・給与・賞与・昇給・評価・経歴書類は、管理者だけ（本人も見られない。2026-10-27 ユーザー指定）
 * 支出の「BEST人件費」：月の給与（入社時の月給＋それまでの昇給額）＋賞与÷6 を、承認された稼働工数の%でメディアに分ける
 *   （%がない月は、その月の担当メディアで等分）。管理者の画面だけで集計
 * BEST半期：上期＝5〜10月、下期＝11〜4月
 */
const isYm = s => /^\d{4}-\d{2}$/.test(String(s || ''));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const halfStartOf = ym => { const [y, m] = ym.split('-').map(Number); return m >= 5 && m <= 10 ? y + '-05' : (m >= 11 ? y : y - 1) + '-11'; };
/** 半期で決めた昇給の反映月：上期（YYYY-05）→ 同じ年の12月、下期（YYYY-11）→ 次の年の7月（2026-10-27 ユーザー指定） */
const raiseFrom = start => start.slice(5) === '05' ? start.slice(0, 4) + '-12' : (Number(start.slice(0, 4)) + 1) + '-07';
const halfMonths = start => Array.from({ length: 6 }, (_, i) => shiftYm(start, i));
const numOrNull = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,\s円¥]/g, '')); if (!isFinite(n) || n < 0) throw new Error('数値は0以上で入力してください'); return n; };
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const EMP_TYPES = ['正社員', '契約社員', 'アルバイト', '役員', '執行役員'];   // 役員（2026-10-27 ユーザー指定）
const RETIRE_TYPES = ['退職', '昇格'];
const PROMO_TO = ['役員', '執行役員'];
const EXEC_TYPES = ['役員', '執行役員'];
// 担当ポジション（2026-10-27 ユーザー指定）。アシスタント候補は契約社員だけ、サポートはアルバイトだけ
// 月ごとの担当のポジション。部長は入社時のポジションだけで選べる（担当では PM）（2026-10-27 ユーザー指定）
const STAFF_POSITIONS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント', 'アシスタント候補', 'サポート'];
const ROLE_POSITIONS = ['監修・記事サポート'];   // 担当のポジションとして、どの社員・月でも選べる（2026-10-27 ユーザー指定）
const INIT_EXTRA = ['部長'];   // 入社時のポジションだけで選べる（正社員・役員・執行役員）
const initPositionsFor = empType => (['正社員', '役員', '執行役員'].includes(empType) ? INIT_EXTRA : []).concat(positionsFor(empType));
const positionsFor = empType => STAFF_POSITIONS.filter(p => (p !== 'アシスタント候補' || empType === '契約社員') && (p !== 'サポート' || empType === 'アルバイト'));
// 評価シートの列：PM＝E列、ディレクター＝F列、アシスタントディレクター＝G列、アシスタント・アシスタント候補＝H列（2026-10-27 ユーザー指定）
const EVAL_COL = { PM: 'PM', ディレクター: 'D', アシスタントディレクター: 'AD', アシスタント: 'AS', アシスタント候補: 'AS' };
const EVAL = require('./eval-items.json');
const MARKS = ['〇', '△', '×', ''];
const RANKS = ['S', 'A', 'B', 'C', 'D', ''];
// ユーザー管理の役割と、社員の区分の対応（この区分の社員として登録されていないと、その役割のユーザーを追加できない）
// 担当の大枠：BEST MEDIA（今のメディア）と Eparkくらしのレスキュー（2026-10-27 ユーザー指定）。
// くらしのレスキューはまだダッシュボードがないので、担当・稼働の%・目標（文章）だけ持つ。BEST人件費には入れない
const KURASHI = '__kurashi';
const PRESS = '__press';   // プレスリリース（2026-10-27 ユーザー指定。管理表はこのあと作る）
const BM_REWARD = '__bm_reward', KURASHI_REWARD = '__kurashi_reward';   // 報酬サポート（BEST MEDIA／くらしのレスキュー）（2026-10-27 ユーザー指定）
const DEV_AI_SELF = '__dev_ai_self', DEV_AI_CORP = '__dev_ai_corp';   // 開発：AI自社開発・AI企業開発（2026-10-27 ユーザー指定）
const BM_OPS = '__bm_ops', KURASHI_OPS = '__kurashi_ops';   // 業務サポート（BEST MEDIA／くらしのレスキュー）（2026-10-27 ユーザー指定）
const BM_PM = '__bm_pm', KURASHI_PM = '__kurashi_pm';   // プロジェクトマネジメント（BEST MEDIA／くらしのレスキュー）（2026-10-27 ユーザー指定）
const BM_SUPPORT = '__bm_support', KURASHI_DIR = '__kurashi_dir';   // 監修・記事サポート（BEST MEDIA）／ディレクション・採用サポート（くらしのレスキュー）（2026-10-27 ユーザー指定）
const NON_MEDIA = [KURASHI, PRESS, BM_PM, KURASHI_PM, BM_REWARD, KURASHI_REWARD, BM_OPS, KURASHI_OPS, DEV_AI_SELF, DEV_AI_CORP, BM_SUPPORT, KURASHI_DIR];   // メディアではない担当（BEST人件費のメディアの配分に入れない）
const HOURS_TYPES = ['アルバイト', '契約社員', '正社員'];   // 月の稼働時間を入れられる区分（2026-10-27 ユーザー指定）
const NO_EVAL = ['アルバイト', '役員', '執行役員'];   // 半期の評価がない区分（2026-10-27 ユーザー指定）
const ROLE_EMP = { employee: '正社員', contract: '契約社員', parttime: 'アルバイト', exec: ['役員', '執行役員'] };

module.exports = function staff({ db, admin, isFullAdmin, hasAdminCap, allowedMedia, MEDIA_ORDER, onTargetsChanged, onContractsChanged, files }) {
  const col = db.collection('staff');
  const canManage = u => isFullAdmin(u) || hasAdminCap(u, 'admin_staff');
  const ts = v => v && v.toDate ? v.toDate().toISOString() : null;
  async function log(req, view) { await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view, at: admin.firestore.FieldValue.serverTimestamp() }); }
  async function byEmail(email) { const e = String(email || '').toLowerCase(); if (!e) return null; const s = await col.where('email', '==', e).limit(1).get(); return s.empty ? null : Object.assign({ id: s.docs[0].id }, s.docs[0].data()); }
  async function getStaff(id) { if (String(id).startsWith('c_')) return getContractor(String(id).slice(2)); const s = await col.doc(id).get(); return s.exists ? Object.assign({ id: s.id }, s.data()) : null; }
  // 業務委託（アシスタント兼ライター以上・契約中）は、契約の担当メディア・ディレクトリで記事目標だけ入力できる（2026-10-27 ユーザー指定）。
  // id は 'c_契約ID'、保存先は contracts/{id}/work/{月}。稼働工数はない
  const CONTRACTOR_GOAL_POS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター'];
  const contractorOk = c => CONTRACTOR_GOAL_POS.includes(c.position) && c.status !== '契約解除' && c.status !== '終了' && !(c.endDate && c.endDate < todayJst());
  const asContractor = (id, c) => { const assign = (c.medias || (c.media ? [c.media] : [])).flatMap(m => { const subs = (c.subs || {})[m] || []; return subs.length ? subs.map(sub => ({ media: m, sub, position: c.position })) : [{ media: m, sub: '', position: c.position }]; });
    return { id: 'c_' + id, contractId: id, contractor: true, name: c.name, email: String(c.email || '').toLowerCase(), empType: '業務委託', position: c.position, fixedAssign: assign, unitAssign: c.unitAssign || {}, pastPays: c.pastPays || [], startMonth: c.startMonth || '', endDate: c.endDate || '', status: c.status === '終了' ? '契約解除' : (c.status || '契約中') }; };
  const contractorAt = (st, ym) => { const u = st.unitAssign || {}; if (Array.isArray(u[ym])) return u[ym]; const k = Object.keys(u).filter(m => m <= ym && Array.isArray(u[m])).sort().pop(); if (k) return u[k]; const pp = (st.pastPays || []).find(x => x && x.from && x.from <= ym && (!x.to || ym <= x.to) && Array.isArray(x.medias) && x.medias.length); return pp ? pp.medias.map(m => ({ media: m, sub: '', position: st.position })) : st.fixedAssign; };   /* 登録がない過去の月は「以前の契約内容」の担当メディア */
  const contractorRange = (c, m) => { if (c.startMonth && m < c.startMonth) return false; if (c.endDate) return m <= c.endDate.slice(0, 7); return c.status !== '契約解除' || m < todayJst().slice(0, 7); };
  let unitDirCache = null;   // 月ごとのディレクション担当（/unit-directors）。担当・契約を変えたら作り直す
  const unitHorizon = () => shiftYm(halfStartOf(todayJst().slice(0, 7)), 11);
  /** 担当の行 → 契約の担当メディア・ディレクトリ（ディレクトリ全部＝subs なし） */
  const toMediaSubs = rows => { const medias = [], subs = {}; (rows || []).filter(r => !NON_MEDIA.includes(r.media)).forEach(r => { if (!medias.includes(r.media)) { medias.push(r.media); subs[r.media] = []; } if (!r.sub) subs[r.media] = null; else if (subs[r.media]) subs[r.media].push(r.sub); });
    Object.keys(subs).forEach(m => { if (!subs[m] || !subs[m].length) delete subs[m]; else subs[m] = [...new Set(subs[m])]; }); return { medias, subs }; };
  const sameMS = (a, b) => JSON.stringify([[...(a.medias || [])].sort(), Object.keys(a.subs || {}).sort().map(k => [k, [...a.subs[k]].sort()])]) === JSON.stringify([[...(b.medias || [])].sort(), Object.keys(b.subs || {}).sort().map(k => [k, [...b.subs[k]].sort()])]);
  /** メディア担当管理で変えたあと：今の月の担当 → 契約の担当メディア、過去の月 → 「以前の契約内容」の担当メディア */
  async function syncContractFromUnits(cid, email) {
    const ref = db.collection('contracts').doc(cid), snap = await ref.get(); if (!snap.exists) return;
    const prev = snap.data(), st = asContractor(cid, prev), now = todayJst().slice(0, 7), up = {};
    if (contractorRange(st, now)) { const ms = toMediaSubs(contractorAt(st, now)); if (ms.medias.length && !sameMS(ms, { medias: st.fixedAssign.map(a => a.media).filter((m, i, a) => a.indexOf(m) === i), subs: prev.subs || {} })) Object.assign(up, ms); }
    if (Array.isArray(prev.pastPays) && prev.pastPays.length) {
      let changed = false;
      const pp = prev.pastPays.map(x => { if (!x || !x.from) return x; const to = x.to && x.to < now ? x.to : shiftYm(now, -1), set = new Set();
        for (let m = x.from, n = 0; m <= to && n < 120; m = shiftYm(m, 1), n++) toMediaSubs(contractorAt(st, m)).medias.forEach(v => set.add(v));
        const medias = [...set]; if (!medias.length || JSON.stringify([...medias].sort()) === JSON.stringify([...(x.medias || [])].sort())) return x; changed = true; return Object.assign({}, x, { medias }); });
      if (changed) up.pastPays = pp;
    }
    if (!Object.keys(up).length) return;
    await ref.collection('history').add(Object.assign({}, prev, { savedAt: admin.firestore.FieldValue.serverTimestamp(), replacedBy: email, replaceNote: 'メディア担当管理で担当を変更' }));
    await ref.update(Object.assign(up, { version: (prev.version || 1) + 1, lastChangeNote: 'メディア担当管理で担当を変更', updatedBy: email, updatedAt: admin.firestore.FieldValue.serverTimestamp() })); if (onContractsChanged) onContractsChanged();
  }
  /** 契約管理で担当メディア・ディレクトリ・ポジションを変えたあと：今の月から先のメディア担当に反映。「以前の契約内容」の担当メディアを変えたら、その期間にも反映 */
  async function syncUnitsFromContract(cid, before, after) {
    unitDirCache = null;
    const ref = db.collection('contracts').doc(cid), b = asContractor(cid, before), a = asContractor(cid, after), now = todayJst().slice(0, 7), patch = {};
    const keepNon = (m) => contractorAt(b, m).filter(r => NON_MEDIA.includes(r.media));
    if (!sameMS(toMediaSubs(b.fixedAssign), toMediaSubs(a.fixedAssign)) || b.position !== a.position) {
      const last = [unitHorizon(), Object.keys(b.unitAssign || {}).sort().pop() || now].sort().pop();
      for (let m = now, n = 0; m <= last && n < 60; m = shiftYm(m, 1), n++) patch['unitAssign.' + m] = keepNon(m).concat(a.fixedAssign);
    }
    const bp = before.pastPays || [];
    (after.pastPays || []).forEach(x => { if (!x || !x.from || !Array.isArray(x.medias) || !x.medias.length) return; const o = bp.find(y => y && y.from === x.from && y.to === x.to);
      if (o && JSON.stringify([...(o.medias || [])].sort()) === JSON.stringify([...x.medias].sort())) return;
      const to = x.to && x.to < now ? x.to : shiftYm(now, -1);
      for (let m = x.from, n = 0; m <= to && n < 120; m = shiftYm(m, 1), n++) { const cur = contractorAt(b, m), rows = cur.filter(r => NON_MEDIA.includes(r.media) || x.medias.includes(r.media));
        x.medias.filter(md => !rows.some(r => r.media === md)).forEach(md => rows.push({ media: md, sub: '', position: a.position })); patch['unitAssign.' + m] = rows.map(r => ({ media: r.media, sub: r.sub || '', position: r.position || a.position })); }
    });
    if (Object.keys(patch).length) await ref.update(patch);
  }
  async function getContractor(cid) { const s = await db.collection('contracts').doc(cid).get(); return s.exists && contractorOk(s.data()) ? asContractor(s.id, s.data()) : null; }
  async function contractorByEmail(email) { const e = String(email || '').toLowerCase(); if (!e) return null; const d = (await db.collection('contracts').get()).docs.find(x => String(x.data().email || '').toLowerCase() === e && contractorOk(x.data())); return d ? asContractor(d.id, d.data()) : null; }
  const workDoc = (st, m) => st.contractor ? db.collection('contracts').doc(st.contractId).collection('work').doc(m) : col.doc(st.id).collection('work').doc(m);
  const isSelf = (u, st) => !!st && !!st.email && st.email === String(u.email || '').toLowerCase();
  const canSecret = (u, st) => isFullAdmin(u);   // 生年月日・給与・賞与・昇給・評価・経歴書類は管理者だけ（2026-10-27 ユーザー指定。本人も見られない）
  // 昇格：以前の「役員昇格」（昇格日なし）は、退職日の翌日から役員として読む
  const promoted = st => (st.retireType === '昇格' || st.retireType === '役員昇格') && !!st.retireDate;
  const promoTo = st => st.promoTo || '役員';
  const promoDate = st => st.promoDate || (st.retireDate ? new Date(Date.parse(st.retireDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : null);
  /** 本当に辞める日（役員に昇格した人は役員の退任日） */
  const endDateOf = st => promoted(st) ? (st.execRetireDate || null) : (st.retireDate || null);
  /** その月の雇用区分（役員に昇格した人は、退職日の翌月から役員） */
  /** その月までで、いちばん新しい「半期の設定」（halfTypes／halfPays）。なければ null */
  const latestHalf = (map, ym) => { const hs = halfStartOf(ym); let k = null; Object.entries(map || {}).forEach(([h, v]) => { if (v != null && v !== '' && h <= hs && (!k || h > k)) k = h; }); return k; };
  /** その月までで、いちばん新しい変更（field の値が入っているもの）。{from, value} か null */
  const latestChange = (st, ym, field) => { let c = null; (st.changes || []).forEach(x => { const v = x[field]; if (v != null && v !== '' && x.from <= ym && (!c || x.from > c.from)) c = { from: x.from, value: v }; }); return c; };
  /** 月の変更と半期の値のうち、新しいほう */
  const pickLatest = (st, ym, field, map) => { const c = latestChange(st, ym, field), k = (st.changes || []).length ? null : latestHalf(map, ym);   /* 月単位の変更がある人は半期の値を使わない */ if (c && (!k || c.from >= k)) return c; return k ? { from: k, value: map[k] } : null; };
  const empTypeAt = (st, ym) => { if (promoted(st) && ym >= promoDate(st).slice(0, 7)) return promoTo(st); const c = pickLatest(st, ym, 'empType', st.halfTypes); return c ? c.value : (st.empType || '正社員'); };
  /** その月のポジション（月の変更。なければ ''）。半期のポジションは呼び出し側で見る */
  /** 評価に使う月：半期の最後の月（半期の途中なら今月） */
  const evalYmOf = start => { const end = shiftYm(halfStartOf(start), 5), now = todayJst().slice(0, 7); return now < end && now >= halfStartOf(start) ? now : end; };
  const positionAt = (st, ym) => { const c = latestChange(st, ym, 'position'); return c ? c.value : ''; };
  const empNow = st => promoted(st) && promoDate(st) <= todayJst() ? promoTo(st) : empTypeAt(st, todayJst().slice(0, 7));
  const statusOf = st => { const e = endDateOf(st), t = todayJst(); if (e) return e < t ? '退職済み' : '退職予定'; if (promoted(st) && promoDate(st) > t) return '昇格予定'; return '現職'; };
  const mediaOk = m => MEDIA_ORDER.some(([k]) => k === m);
  const unitOk = m => NON_MEDIA.includes(m) || mediaOk(m);   // 担当・稼働の%：BEST MEDIA のメディアか、くらしのレスキュー
  const BAD = /入力|選んで|正しく|数値|ポジション|%|メディア/;

  function cleanStaff(b, secret) {
    const o = {};
    const str = (k, n) => { if (b[k] !== undefined) o[k] = String(b[k] || '').trim().slice(0, n); };
    str('name', 60); if (o.name !== undefined && !o.name) throw new Error('名前を入力してください');
    if (b.email !== undefined) { o.email = String(b.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw new Error('メールアドレスを正しく入力してください'); }
    if (b.empType !== undefined) { if (!EMP_TYPES.includes(b.empType)) throw new Error('雇用区分（正社員・契約社員・アルバイト）を選んでください'); o.empType = b.empType; }
    if (b.retireType !== undefined) { if (b.retireType && !RETIRE_TYPES.includes(b.retireType)) throw new Error('退職の区分を選んでください'); o.retireType = b.retireType || '退職'; }
    if (b.promoTo !== undefined) { if (b.promoTo && !PROMO_TO.includes(b.promoTo)) throw new Error('昇格先（役員・執行役員）を選んでください'); o.promoTo = b.promoTo || ''; }
    if (o.retireType === '昇格' && !o.promoTo && b.promoTo !== undefined) throw new Error('昇格先（役員・執行役員）を選んでください');
    ['joinDate', 'retireDate', 'execRetireDate', 'promoDate'].forEach(k => { if (b[k] !== undefined) { const v = String(b[k] || ''); if (v && !isDate(v)) throw new Error('日付を正しく入力してください'); o[k] = v || null; } });
    if (b.joinDate !== undefined && !o.joinDate) throw new Error('入社日を入力してください');
    if (b.initPosition !== undefined) { if (b.initPosition && !STAFF_POSITIONS.concat(INIT_EXTRA).includes(b.initPosition)) throw new Error('入社時のポジションを選んでください'); o.initPosition = b.initPosition || ''; }
    str('memo', 1000);
    if (secret) {   // 管理者だけが入れる項目
      if (b.birthDate !== undefined) { const v = String(b.birthDate || ''); if (v && !isDate(v)) throw new Error('生年月日を正しく入力してください'); o.birthDate = v || null; }
      if (b.initAnnual !== undefined) o.initAnnual = numOrNull(b.initAnnual);
      if (b.initMonthly !== undefined) o.initMonthly = numOrNull(b.initMonthly);
      if (b.initHourly !== undefined) o.initHourly = numOrNull(b.initHourly);   // アルバイトの時給
      if (b.initHours !== undefined) o.initHours = numOrNull(b.initHours);      // アルバイトの月の勤務時間の目安
      if (b.promoPay !== undefined) o.promoPay = numOrNull(b.promoPay);         // 昇格後の報酬（役員＝月額、執行役員＝年俸）
    }
    return o;
  }
  /** 一覧・詳細に出す形。生年月日・給与・経歴書類は、管理者だけ */
  function out(u, st) {
    const secret = canSecret(u, st), cur = todayJst().slice(0, 7);
    const o = { id: st.id, name: st.name, email: st.email || '', empType: st.empType || '正社員', empNow: empNow(st), joinDate: st.joinDate || '', retireDate: st.retireDate || '', retireType: promoted(st) ? '昇格' : (st.retireType || '退職'), promoTo: promoted(st) ? promoTo(st) : '', promoDate: promoted(st) ? promoDate(st) : '', execRetireDate: st.execRetireDate || '', status: statusOf(st),
      initPosition: st.initPosition || '', assign: st.assign || {}, hours: st.hours || {}, overtime: st.overtime || {}, halfTypes: st.halfTypes || {}, changes: (st.changes || []).map(c => secret ? c : { from: c.from, empType: c.empType || '', position: c.position || '' }), current: (() => { const a = st.assign || {}; if (Array.isArray(a[cur])) return a[cur]; const k = Object.keys(a).filter(m => m <= cur && Array.isArray(a[m])).sort().pop(); return k ? a[k] : []; })()   /* 今月の登録がなければ、いちばん新しい月の担当を引き継ぐ（目標・工数と同じ。2026-11-06 ユーザー指摘：今月の担当が未設定になる） */, memo: st.memo || '', canSecret: secret };
    if (secret) Object.assign(o, { birthDate: st.birthDate || '', initAnnual: st.initAnnual ?? null, initMonthly: st.initMonthly ?? null, initHourly: st.initHourly ?? null, initHours: st.initHours ?? null, promoPay: st.promoPay ?? null, halfPays: st.halfPays || {}, payNow: payUnitNow(st), payNext: (() => { const now = payUnitNow(st); for (let i = 1, m = shiftYm(todayJst().slice(0, 7), 1); i <= 12; i++, m = shiftYm(m, 1)) { const v = payUnitNow(st, m); if (v.label !== now.label || v.value !== now.value) return Object.assign({ from: m }, v); } return null; })(), docs: (st.docs || []).map(d => ({ label: d.label, name: d.name, at: d.at })) });
    return o;
  }

  // ---------- 目標・稼働工数 ----------
  /** 稼働工数（%）が同じか（キーの順番は問わない） */
  const sameRes = (a, b) => { const ka = Object.keys(a || {}).filter(k => Number(a[k]) > 0), kb = Object.keys(b || {}).filter(k => Number(b[k]) > 0); return ka.length === kb.length && ka.every(k => Number(a[k]) === Number(b[k])); };
  function cleanWork(b, st, ym) {
    const assigned = ((st.assign || {})[ym] || []).map(a => a.media);
    const resource = {};
    Object.entries((b && b.resource) || {}).forEach(([m, v]) => { const n = numOrNull(v); if (n == null) return; if (!unitOk(String(m).split('|')[0])) throw new Error('メディアが正しくありません'); if (n > 100) throw new Error('稼働の%は100以下で入力してください'); if (n > 0) resource[m] = n; });
    const total = Object.values(resource).reduce((a, v) => a + v, 0);
    if (total > 100) throw new Error('稼働の%の合計が100%を超えています（今 ' + total + '%）');
    const targets = {};
    Object.entries((b && b.targets) || {}).forEach(([id, v]) => {
      if (typeof id !== 'string' || id.length > 100 || !mediaOk(id.split('|')[0])) return;
      const n = numOrNull((v || {}).new), r = numOrNull((v || {}).rewrite);
      if (n != null || r != null) targets[id] = { new: n == null ? null : Math.floor(n), rewrite: r == null ? null : Math.floor(r) };
    });
    const kurashiGoal = String((b && b.kurashiGoal) || '').slice(0, 3000);   // くらしのレスキューの目標（文章）
    return { resource, targets, kurashiGoal, note: String((b && b.note) || '').slice(0, 1000), total, assigned };
  }
  /** 承認された記事目標を、その月の記事目標設定に入れ直す（同じ月・同じ行は合計） */
  async function applyTargets(ym) {
    const sums = {};
    for (const s of (await col.get()).docs.concat((await db.collection('contracts').get()).docs)) {
      const w = await s.ref.collection('work').doc(ym).get();
      const ap = w.exists && w.data().approved;
      if (!ap) continue;
      Object.entries(ap.targets || {}).forEach(([id, v]) => {
        const c = (sums[id] = sums[id] || { new: null, rewrite: null });
        if (v.new != null) c.new = (c.new || 0) + v.new;
        if (v.rewrite != null) c.rewrite = (c.rewrite || 0) + v.rewrite;
      });
    }
    const ref = db.collection('article_targets').doc(ym), snap = await ref.get(), d = snap.exists ? snap.data() : {};
    const targets = Object.assign({}, d.targets || {}), prev = d.fromStaff || [], now = Object.keys(sums);
    prev.filter(id => !now.includes(id)).forEach(id => { delete targets[id]; });
    now.forEach(id => { targets[id] = sums[id]; });
    await ref.set({ targets, fromStaff: now, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: '目標・工数（承認）' });
    if (onTargetsChanged) onTargetsChanged();
  }

  // ---------- 給与・人件費 ----------
  /** その月の給与：入社時の月給＋その月までに始まった半期の昇給額の合計 */
  /** その月の報酬（月額に直したもの）。区分ごとに：月給／時給×月の勤務時間／役員の月額報酬／執行役員の年俸÷12。昇格後は昇格後の報酬 */
  function basePay(st, ym) {
    const t = empTypeAt(st, ym);
    if (promoted(st) && ym >= promoDate(st).slice(0, 7) && t === promoTo(st) && st.promoPay != null) return t === '執行役員' ? (st.promoPay || 0) / 12 : (st.promoPay || 0);
    const pc = pickLatest(st, ym, 'pay', st.halfPays);   // 月・半期で決めた報酬（区分ごと：月給／時給／月額報酬／年俸）
    if (pc) { const v = pc.value; if (t === 'アルバイト') { const hm = (st.hours || {})[ym]; return v * (hm != null ? hm : (st.initHours || 0)); } return t === '執行役員' ? v / 12 : v; }
    if (t === 'アルバイト') { const hm = (st.hours || {})[ym]; return (st.initHourly || 0) * (hm != null ? hm : (st.initHours || 0)); }   // 時給×その月の稼働時間（なければ目安）
    if (t === '執行役員') return (st.initAnnual || 0) / 12;
    return st.initMonthly || 0;
  }
  /** 半期の賞与（円）：か月数 × その半期の最初の月の給与。以前の金額の入力（bonus）も読む */
  function bonusOf(st, halves, h) { if (!h) return 0; if (h.bonusMonths != null) return h.bonusMonths * monthlyPay(st, halves, h.id); return h.bonus || 0; }
  /** 一覧に出す今の報酬：区分の単位で（月給・月額報酬＝昇給額込みの月額、時給＝時給、年俸＝昇給額込みの月額×12）。st._halves があれば昇給額を足す */
  function payUnitNow(st, at) {
    const ym = at || todayJst().slice(0, 7), t = empTypeAt(st, ym), m = monthlyPay(st, st._halves || [], ym);
    if (t === 'アルバイト') { const pc = pickLatest(st, ym, 'pay', st.halfPays); return { label: '時給', value: pc ? pc.value : (st.initHourly ?? null) }; }
    if (t === '執行役員') return { label: '年俸', value: Math.round(m * 12) };
    return { label: t === '役員' ? '月額' : '月給', value: Math.round(m) };
  }
  function monthlyPay(st, halves, ym) {
    let v = basePay(st, ym);
    const pc = pickLatest(st, ym, 'pay', st.halfPays), t = empTypeAt(st, ym);
    let pk = pc && pc.from;   /* 報酬を決め直した月。昇格して昇格後の報酬を入れたときは昇格月も（それより前の昇給額は足さない。2026-10-27） */
    if (promoted(st) && st.promoPay != null) { const pm = promoDate(st).slice(0, 7); if (ym >= pm && (!pk || pm > pk)) pk = pm; }
    if (t !== 'アルバイト') halves.forEach(h => { const eff = raiseFrom(h.id); if (h.raise && eff <= ym && (!pk || (eff > pk && h.id >= halfStartOf(pk)))) v += h.raise; });   /* 報酬を決め直した（昇格した）半期より前に決めた昇給は足さない */   /* 昇給の反映は7月・12月（2026-10-27 ユーザー指定） */   // 昇給額は、半期で報酬を決め直した後の分だけ足す（アルバイトは時給なので足さない）
    return v;
  }
  let costCache = null, activeMediaFn = null;   /* activeMediaFn：{メディア: データがある最初の月} を返す（server.js から） */
  const setActiveMedia = fn => { activeMediaFn = fn; costCache = null; };
  /** BEST人件費（社員単位）：社員ごと・月ごとの BEST MEDIA の分（給与＋賞与÷6 × BEST MEDIA の担当の割合。くらしのレスキュー・開発の担当の分は除く）。
   *  契約社員・アルバイトも含む。入社日・退職日・今の区分とポジションも返す（2026-11-02 ユーザー指定） */
  async function staffPersonCosts() {
    const out = [], last = todayJst().slice(0, 7), notBm = k => /^__(kurashi|dev)/.test(String(k).split('|')[0]);
    for (const s of (await col.get()).docs) {
      const stf = s.data(); if (!stf.joinDate) continue;
      const halves = (await s.ref.collection('halves').get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      const works = Object.fromEntries((await s.ref.collection('work').get()).docs.map(d => [d.id, d.data()]));
      const end = endDateOf(stf), endYm = end ? end.slice(0, 7) : last, months = {};
      let hasPay = false;
      const asg = ym => { const a = stf.assign || {}; if (Array.isArray(a[ym])) return a[ym]; const k = Object.keys(a).filter(m => m <= ym && Array.isArray(a[m])).sort().pop(); return k ? a[k] : []; };
      for (let ym = stf.joinDate.slice(0, 7); ym <= endYm && ym <= last; ym = shiftYm(ym, 1)) {
        const h = halves.find(x => x.id === halfStartOf(ym)), pay = monthlyPay(stf, halves, ym) + bonusOf(stf, halves, h) / 6;
        if (!pay) continue;
        hasPay = true;
        const resOf = m => ((works[m] || {}).approved || {}).resource || {}, sum = r => Object.values(r).reduce((a, v) => a + (Number(v) || 0), 0);
        let res = resOf(ym); if (!(sum(res) > 0)) { const pk = Object.keys(works).filter(m => m < ym && sum(resOf(m)) > 0).sort().pop(); if (pk) res = resOf(pk); }
        const tot = sum(res);
        let share;
        if (tot > 0) share = Object.entries(res).filter(([k]) => !notBm(k)).reduce((a, [, v]) => a + (Number(v) || 0), 0) / tot;
        else { const ms = [...new Set(asg(ym).map(a => a.media))]; share = ms.length ? ms.filter(m => !notBm(m)).length / ms.length : 1; }
        if (share > 0) months[ym] = pay * share;
      }
      const nowYm = end && end.slice(0, 7) < last ? end.slice(0, 7) : last;
      if (!hasPay) continue;   /* 給与が登録されていない人は出さない（2026-11-02 ユーザー指定） */
      out.push({ id: s.id, name: stf.name || '', joinDate: stf.joinDate, endDate: end || '', retired: !!(end && end < todayJst()), empType: empTypeAt(stf, nowYm), position: positionAt(stf, nowYm) || ((halves.filter(x => x.id <= halfStartOf(nowYm) && x.position).sort((a, b) => b.id.localeCompare(a.id))[0] || {}).position) || stf.initPosition || '', months });
    }
    return out;
  }
  /** BEST人件費（メディア単位）：社員ごとの月の報酬（給与＋賞与÷6）を承認された稼働%でメディアに配分。
   *  %は合計で割る（合計が100%でない月も割合で）。%がない月は担当（登録がない月は前の月の担当）で等分。
   *  BEST MEDIA の共通の担当（PM・プレスリリース・報酬サポート・業務サポート・監修サポート）は、その月の全社員のメディアに直接ついた人件費の割合で各メディアに分ける。
   *  くらしのレスキュー・開発の担当の分は入れない（2026-11-02 ユーザー指定） */
  async function staffCosts() {
    if (costCache && costCache.until > Date.now()) return costCache.value;
    const outRows = [], common = [], last = todayJst().slice(0, 7), notBm = k => /^__(kurashi|dev)/.test(k);
    for (const s of (await col.get()).docs) {
      const st = s.data();
      if (!st.joinDate) continue;
      const halves = (await s.ref.collection('halves').get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      const works = Object.fromEntries((await s.ref.collection('work').get()).docs.map(d => [d.id, d.data()]));
      const endYm = endDateOf(st) ? endDateOf(st).slice(0, 7) : last;
      const asg = ym => { const a = st.assign || {}; if (Array.isArray(a[ym])) return a[ym]; const k = Object.keys(a).filter(m => m <= ym && Array.isArray(a[m])).sort().pop(); return k ? a[k] : []; };
      const put = (ym, key, value) => { const m = String(key).split('|')[0]; if (!value || notBm(m)) return; if (NON_MEDIA.includes(m)) common.push({ ym, value, staff: st.name || '', pm: m === BM_PM }); else outRows.push({ ym, media: m, sub: String(key).split('|')[1] || '', value, staff: st.name || '' }); };   /* ディレクトリの%はメディアに合計（sub＝ディレクトリ。支出一覧のディレクトリ単位用） */
      for (let ym = st.joinDate.slice(0, 7); ym <= endYm && ym <= last; ym = shiftYm(ym, 1)) {
        const h = halves.find(x => x.id === halfStartOf(ym));
        const pay = monthlyPay(st, halves, ym) + bonusOf(st, halves, h) / 6;
        if (!pay) continue;
        const resOf = m => ((works[m] || {}).approved || {}).resource || {}, sum = r => Object.values(r).reduce((a, v) => a + (Number(v) || 0), 0);
        let res = resOf(ym); if (!(sum(res) > 0)) { const pk = Object.keys(works).filter(m => m < ym && sum(resOf(m)) > 0).sort().pop(); if (pk) res = resOf(pk); }
        const tot = sum(res);
        if (tot > 0) { Object.entries(res).forEach(([k, p]) => put(ym, k, pay * (Number(p) || 0) / tot)); continue; }
        const ms = [...new Set(asg(ym).map(a => a.media))];
        ms.forEach(m => put(ym, m, pay / ms.length));
      }
    }
    // 共通の担当の分：その月のメディアの直接の人件費の割合で分ける（その月に直接の分がなければ、いちばん近い前の月の割合）
    const byYm = {}; outRows.forEach(r => { (byYm[r.ym] = byYm[r.ym] || {})[r.media] = (byYm[r.ym][r.media] || 0) + r.value; });
    const ratioAt = ym => { const k = Object.keys(byYm).filter(m => m <= ym).sort().pop() || Object.keys(byYm).sort()[0]; return k ? byYm[k] : null; };
    let first = {}; try { first = activeMediaFn ? await activeMediaFn() : {}; } catch (e) { console.warn('active media: ' + e.message); }
    const pmMedia = ym => Object.keys(first).filter(m => first[m] <= ym);
    common.forEach(c => { { const ms = pmMedia(c.ym); if (ms.length) { ms.forEach(m => outRows.push({ ym: c.ym, media: m, value: c.value / ms.length, staff: c.staff, common: true })); return; } }   /* 共通の担当（PM・プレスリリース・サポート）は各メディアで均等。メディアがわからない月だけ人件費の割合（2026-11-02 ユーザー指定） */
      const r = ratioAt(c.ym); if (!r) return; const t = Object.values(r).reduce((a, v) => a + v, 0); Object.entries(r).forEach(([m, v]) => outRows.push({ ym: c.ym, media: m, value: c.value * v / t, staff: c.staff, common: true })); });
    costCache = { value: outRows, until: Date.now() + 10 * 60 * 1000 };
    return outRows;
  }


  // ---------- 評価 ----------
  function cleanHalf(b, cur, st, boss) {
    const o = {}, isPart = NO_EVAL.includes(empTypeAt(st, evalYmOf(cur.start || (b && b.start) || todayJst().slice(0, 7))));   // 評価の有無は、半期の終わり（途中なら今月）の区分で決める
    if (boss) {
      if (b.empType !== undefined) { if (b.empType && !EMP_TYPES.includes(b.empType)) throw new Error('この半期の雇用区分を選んでください'); o.empType = b.empType || ''; }
      if (b.payBase !== undefined) o.payBase = numOrNull(b.payBase);   // この半期からの報酬（区分ごと：月給／時給／月額報酬／年俸）
      if (b.bonus !== undefined) o.bonus = numOrNull(b.bonus);
      if (b.bonusMonths !== undefined) { const n = numOrNull(b.bonusMonths); if (n != null && n > 24) throw new Error('賞与は何か月分かを入力してください（24か月分まで）'); o.bonusMonths = n == null ? null : Math.round(n * 100) / 100; }
      if (b.raise !== undefined) { const n = b.raise === '' || b.raise == null ? null : Number(String(b.raise).replace(/[,\s円¥]/g, '')); if (n != null && !isFinite(n)) throw new Error('昇給額は数値で入力してください'); o.raise = n; }
      if (b.position !== undefined) { const t = b.empType || empTypeAt(st, b.start || ''); if (b.position && !positionsFor(t).includes(b.position)) throw new Error(b.position + 'は、' + t + 'では選べないポジションです'); o.position = b.position || ''; }
      if (b.evalPosition !== undefined) { if (b.evalPosition && !EVAL_COL[b.evalPosition]) throw new Error('評価のポジションを選んでください'); o.evalPosition = b.evalPosition || ''; }
      if (b.perf !== undefined) { const r = String((b.perf || {}).rank || ''); if (!RANKS.includes(r)) throw new Error('業績評価のランクを選んでください'); o.perf = { rank: r, comment: String((b.perf || {}).comment || '').slice(0, 3000) }; }
      if (b.bossNote !== undefined) o.bossNote = String(b.bossNote || '').slice(0, 3000);
    }
    if (isPart) return o;   // アルバイト・役員は評価の項目なし（2026-10-27 ユーザー指定）
    const whos = boss ? ['self', 'boss'] : ['self'], who = boss ? 'boss' : 'self';
    if (b.skillGroups !== undefined) {   // MKTスキル指標：大分類ごとの合計点
      const keys = new Set(EVAL.skills.map(x => x.cat + (x.sub ? '／' + x.sub : '')));
      const sg = JSON.parse(JSON.stringify(cur.skillGroups || {}));
      Object.entries(b.skillGroups || {}).forEach(([k, v]) => { if (!keys.has(k)) return; whos.forEach(w => { if ((v || {})[w] === undefined) return; const n = numOrNull(v[w]); if (n != null && n > 1000) throw new Error('スキルの点数が大きすぎます'); (sg[k] = sg[k] || {})[w] = n; }); });
      o.skillGroups = sg;
    }
    if (b.skill !== undefined) {
      const skill = JSON.parse(JSON.stringify(cur.skill || {}));
      Object.entries(b.skill || {}).forEach(([id, v]) => {
        if (!EVAL.skills.some(s => s.id === id)) return;
        const m = String((v || {})[who] ?? ''); if (!MARKS.includes(m)) throw new Error('スキルの評価は 〇・△・× から選んでください');
        (skill[id] = skill[id] || {})[who] = m;
      });
      o.skill = skill;
    }
    if (b.behavior !== undefined) {
      const beh = JSON.parse(JSON.stringify(cur.behavior || {}));
      Object.entries(b.behavior || {}).forEach(([k, v]) => { if (!EVAL.behavior.some(x => x.cat === k)) return; whos.forEach(w => { if ((v || {})[w] !== undefined) (beh[k] = beh[k] || {})[w] = String(v[w] || '').slice(0, 3000); }); });
      o.behavior = beh;
    }
    if (b.selfNote !== undefined) o.selfNote = String(b.selfNote || '').slice(0, 3000);   // 本人の振り返り（管理者も入力できる）
    return o;
  }

  let halfViewRef = null;
  function routes(api, adminApi) {
    // 一覧（管理者・BEST社員管理の権限）
    api.get('/staff', async (req, res, next) => {
      try {
        if (!canManage(req.user)) return res.status(403).json({ error: 'BEST社員管理を見る権限がありません' });
        const docs = (await col.get()).docs, halvesOf = isFullAdmin(req.user) ? await Promise.all(docs.map(d => d.ref.collection('halves').get().then(q => q.docs.map(x => Object.assign({ id: x.id }, x.data()))))) : docs.map(() => []);
        const list = docs.map((d, i) => out(req.user, Object.assign({ id: d.id, _halves: halvesOf[i] }, d.data()))).sort((a, b) => (a.status === '退職済み') - (b.status === '退職済み') || String(a.joinDate).localeCompare(String(b.joinDate)) || String(a.name).localeCompare(b.name, 'ja'));
        res.json({ staff: list, empTypes: EMP_TYPES, positions: STAFF_POSITIONS, canSecret: isFullAdmin(req.user), canApprove: isFullAdmin(req.user) });
      } catch (e) { next(e); }
    });
    api.post('/staff', async (req, res, next) => {
      try {
        if (!canManage(req.user)) return res.status(403).json({ error: '登録する権限がありません' });
        const b = req.body || {};
        const o = cleanStaff(Object.assign({ name: '', email: '', empType: '', joinDate: '' }, b), isFullAdmin(req.user));
        if (await byEmail(o.email)) return res.status(400).json({ error: 'このメールアドレスの社員は、すでに登録されています' });
        if (o.initPosition && !initPositionsFor(o.empType).includes(o.initPosition)) return res.status(400).json({ error: o.initPosition + 'は、' + o.empType + 'では選べないポジションです' });
        const ref = await col.add(Object.assign({ docs: [], assign: {} }, o, { createdBy: req.user.email, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
        await log(req, 'BEST社員を登録：' + o.name);
        res.json({ ok: true, id: ref.id });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    api.patch('/staff/:id', async (req, res, next) => {
      try {
        if (!canManage(req.user)) return res.status(403).json({ error: '変更する権限がありません' });
        const st = await getStaff(req.params.id); if (!st) return res.status(404).json({ error: '見つかりません' });
        const o = cleanStaff(req.body || {}, isFullAdmin(req.user));
        if (o.email && o.email !== st.email) { const other = await byEmail(o.email); if (other && other.id !== st.id) return res.status(400).json({ error: 'このメールアドレスの社員は、すでに登録されています' }); }
        await col.doc(st.id).update(Object.assign(o, { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
        costCache = null;
        await log(req, 'BEST社員を変更：' + (o.name || st.name));
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    // 月ごとの担当（メディア×ポジション）
    api.put('/staff/:id/assign/:ym', async (req, res, next) => {
      try {
        if (!canManage(req.user)) return res.status(403).json({ error: '変更する権限がありません' });
        const st = await getStaff(req.params.id); if (!st || !isYm(req.params.ym)) return res.status(404).json({ error: '見つかりません' });
        const ym0 = req.params.ym, joinYm = st.joinDate ? st.joinDate.slice(0, 7) : null, endYm = endDateOf(st) ? endDateOf(st).slice(0, 7) : null;
        if (joinYm && ym0 < joinYm) return res.status(400).json({ error: '入社（' + st.joinDate.replace(/-/g, '/') + '）より前の月には、担当を入れられません' });
        // 退職後の月：すでに担当が入っている月は直せる（消すのも可）。空の月に新しく入れるのはできない（2026-10-27 ユーザー指定）
        if (endYm && ym0 > endYm && !((st.assign || {})[ym0] || []).length) return res.status(400).json({ error: '退職（' + endDateOf(st).replace(/-/g, '/') + '）より後の月には、新しく担当を入れられません' });
        const halfPos = Object.fromEntries((await col.doc(st.id).collection('halves').get()).docs.map(d => [d.id, d.data().position || '']));
        const allowedAt = m => { const mp = positionAt(st, m); if (mp) return [mp].concat(ROLE_POSITIONS); const hp = (st.changes || []).length ? '' : halfPos[halfStartOf(m)]; return (hp ? [hp] : positionsFor(empTypeAt(st, m))).concat(ROLE_POSITIONS); };   // 半期のポジションがなければ、その区分で選べるもの
        const pos = allowedAt(ym0), seen = new Set();
        const rows = (Array.isArray((req.body || {}).rows) ? req.body.rows : []).map(r => ({ media: String((r || {}).media || ''), sub: NON_MEDIA.includes((r || {}).media) ? '' : String((r || {}).sub || '').slice(0, 60), position: String((r || {}).position || ''), pct: numOrNull((r || {}).pct) })).filter(r => r.media);
        for (const r of rows) {
          if (!unitOk(r.media)) return res.status(400).json({ error: 'メディアが正しくありません' });
          if (!pos.includes(r.position)) return res.status(400).json({ error: (r.position || 'ポジション') + 'は、' + ym0 + ' には選べません（この月のポジション：' + (positionAt(st, ym0) || halfPos[halfStartOf(ym0)] || '未設定・区分 ' + empTypeAt(st, ym0)) + '）' });
          const key = r.media + '|' + r.sub;
          if (seen.has(key)) return res.status(400).json({ error: '同じ担当（メディア・ディレクトリ）が2回入っています' }); seen.add(key);
          if (r.sub && seen.has(r.media + '|')) return res.status(400).json({ error: 'メディア全体とそのディレクトリを両方入れることはできません' });
        }
        const months = [req.params.ym];
        const until = (req.body || {}).until;   // 「この月から○月まで同じ」
        if (isYm(until) && until > req.params.ym) for (let m = shiftYm(req.params.ym, 1); m <= until && months.length < 36 && !(endYm && m > endYm); m = shiftYm(m, 1)) months.push(m);   // 退職後の月は入れない
        for (const m of months) { const ap = allowedAt(m); const bad = rows.find(r => !ap.includes(r.position)); if (bad) return res.status(400).json({ error: m + ' の半期のポジションは「' + ap.join('・') + '」なので、' + bad.position + 'では入れられません。期間を分けて保存してください' }); }
        // 稼働の%：入れた行があるときだけ。メディアごとに合計して、合計100%が必要（2026-10-27 ユーザー指定）
        const withPct = rows.filter(r => r.pct != null);
        let resource = null;
        if (withPct.length) {
          resource = {}; withPct.forEach(r => { const k = r.sub ? r.media + '|' + r.sub : r.media; if (r.pct > 0) resource[k] = (resource[k] || 0) + r.pct; });   /* ディレクトリごとに持つ */
          const tot = Object.values(resource).reduce((a, v) => a + Number(v || 0), 0);
          if (Math.round(tot) !== 100) return res.status(400).json({ error: '稼働の%の合計を100%にしてください（今 ' + tot + '%）' });
        }
        const patch = {}; months.forEach(m => { patch['assign.' + m] = rows.map(r => ({ media: r.media, sub: r.sub, position: r.position })); });
        // アルバイトの稼働時間（任意）：その月がアルバイトのときだけ。空欄で送ると消す
        if ((req.body || {}).overtime !== undefined) { const ov = numOrNull(req.body.overtime); if (ov != null && ov > 744) return res.status(400).json({ error: '残業時間が大きすぎます' }); months.forEach(m => { if (['正社員', '契約社員'].includes(empTypeAt(st, m))) patch['overtime.' + m] = ov; }); }   // 正社員・契約社員の残業時間（記録用）
        if ((req.body || {}).hours !== undefined) { const hv = numOrNull(req.body.hours); if (hv != null && hv > 744) return res.status(400).json({ error: '稼働時間が大きすぎます（1か月744時間まで）' }); months.forEach(m => { if (HOURS_TYPES.includes(empTypeAt(st, m))) patch['hours.' + m] = hv; }); }
        await col.doc(st.id).update(Object.assign(patch, { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
        costCache = null;
        if (resource) {   // 管理者が入れた%は、その月の稼働工数として承認済みにする（記事目標はそのまま）
          for (const m of months) {
            const ref = col.doc(st.id).collection('work').doc(m), cur = (await ref.get()).data() || {};
            const ap = Object.assign({ targets: {} }, cur.approved || {}, { resource }), dr = Object.assign({ targets: (cur.approved || {}).targets || {} }, cur.draft || {}, { resource });
            await ref.set({ ym: m, approved: ap, draft: dr, status: cur.status === 'submitted' ? 'submitted' : 'approved', approvedBy: req.user.email, approvedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            await ref.update({ 'approved.resource': resource, 'draft.resource': resource });   // 消した行が残らないように丸ごと置き換え（2026-10-29）
          }
        }
        await log(req, '担当メディアを変更：' + st.name + '（' + months[0] + (months.length > 1 ? '〜' + months[months.length - 1] : '') + '）' + (resource ? '・稼働の%も保存' : ''));
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    // 1人の、月ごとの稼働の%（承認済みを優先、なければ申請・下書き）。管理者・BEST社員管理の権限
    api.get('/staff/:id/work-all', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        if (!canManage(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        const st = await getStaff(req.params.id); if (!st) return res.status(404).json({ error: '見つかりません' });
        const months = {};
        (await col.doc(st.id).collection('work').get()).docs.forEach(d => { const v = d.data(); months[d.id] = { status: v.status || 'none', resource: (v.approved || {}).resource || (v.draft || {}).resource || null, approved: !!(v.approved && v.approved.resource) }; });
        const halves = Object.fromEntries((await col.doc(st.id).collection('halves').get()).docs.map(d => [d.id, d.data().position || '']));
        res.json({ months, halves, joinYm: st.joinDate ? st.joinDate.slice(0, 7) : null, endYm: endDateOf(st) ? endDateOf(st).slice(0, 7) : null });
      } catch (e) { next(e); }
    });
    // 雇用区分・ポジション・報酬の変更（月単位）。全部まとめて保存する（管理者だけ）（2026-10-27 ユーザー指定）
    api.put('/staff/:id/changes', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '変更は管理者だけが入力できます' });
        const st = await getStaff(req.params.id); if (!st) return res.status(404).json({ error: '見つかりません' });
        const list = (Array.isArray((req.body || {}).changes) ? req.body.changes : []).map(c => ({ from: String((c || {}).from || ''), empType: String((c || {}).empType || ''), position: String((c || {}).position || ''), pay: numOrNull((c || {}).pay) }))
          .filter(c => c.from || c.empType || c.position || c.pay != null).sort((a, b) => a.from.localeCompare(b.from));
        const seen = new Set(), joinYm = st.joinDate ? st.joinDate.slice(0, 7) : null;
        for (const c of list) {
          if (!isYm(c.from)) return res.status(400).json({ error: '変更の開始月を選んでください' });
          if (joinYm && c.from < joinYm) return res.status(400).json({ error: '変更の開始月（' + c.from + '）が入社より前です' });
          if (seen.has(c.from)) return res.status(400).json({ error: '同じ開始月（' + c.from + '）の変更が2つあります。1つにまとめてください' }); seen.add(c.from);
          if (c.empType && !EMP_TYPES.includes(c.empType)) return res.status(400).json({ error: '雇用区分を選んでください' });
        }
        const tmp = Object.assign({}, st, { changes: list });
        for (const c of list) { if (c.position && !positionsFor(empTypeAt(tmp, c.from)).includes(c.position)) return res.status(400).json({ error: c.from + ' の' + c.position + 'は、' + empTypeAt(tmp, c.from) + 'では選べないポジションです' }); }
        // 月単位の変更を保存したら、前の半期の区分・報酬は消す（どちらが正しいか迷わないように）
        await col.doc(st.id).update({ changes: list, halfTypes: admin.firestore.FieldValue.delete(), halfPays: admin.firestore.FieldValue.delete(), updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        costCache = null;
        await log(req, '雇用区分・ポジション・報酬の変更を保存：' + st.name + '（' + list.length + '件）');
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    // 評価項目（MKTスキル指標・行動評価）と、ポジションの選択肢
    api.get('/staff-eval', (req, res) => res.json({ kurashi: KURASHI, press: PRESS, eval: EVAL, evalCol: EVAL_COL, positions: STAFF_POSITIONS, empTypes: EMP_TYPES, ranks: RANKS.filter(Boolean) }));
    // 自分
    api.get('/staff/me', async (req, res, next) => {
      try { res.set('Cache-Control', 'no-store'); const st = await byEmail(req.user.email); if (st) return res.json({ staff: out(req.user, st) }); const c = await contractorByEmail(req.user.email); res.json({ staff: c ? { id: c.id, name: c.name, empType: '業務委託', contractor: true } : null }); }
      catch (e) { next(e); }
    });
    // 経歴（履歴書・職務経歴書の PDF）：追加も表示も管理者だけ
    api.post('/staff/:id/docs', require('express').raw({ type: 'application/pdf', limit: '20mb' }), async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '経歴書類は管理者だけが追加できます' });
        if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'PDFファイルを選んでください' });
        const st = await getStaff(req.params.id); if (!st) return res.status(404).json({ error: '見つかりません' });
        const label = ['履歴書', '職務経歴書'].includes(req.query.label) ? req.query.label : '経歴書類', name = String(req.query.name || 'document.pdf').slice(0, 120);
        const object = 'staff/' + st.id + '/' + Date.now() + '.pdf';
        await files.putObject(object, req.body, 'application/pdf');
        await col.doc(st.id).update({ docs: admin.firestore.FieldValue.arrayUnion({ label, name, object, at: new Date().toISOString() }) });
        await log(req, '経歴書類を追加：' + st.name + '（' + label + '）');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    api.get('/staff/:id/docs/:n', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const st = await getStaff(req.params.id), f = st && (st.docs || [])[Number(req.params.n)];
        if (!st || !f || !canSecret(req.user, st)) return res.status(404).json({ error: '見つかりません' });
        const o = await files.getObject(f.object);
        await log(req, '経歴書類を表示：' + st.name + '（' + f.label + '）');
        res.set({ 'Content-Type': o.type, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' }).send(o.body);
      } catch (e) { next(e); }
    });
    api.delete('/staff/:id/docs/:n', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '経歴書類は管理者だけが削除できます' });
        const st = await getStaff(req.params.id), n = Number(req.params.n); if (!st || !(st.docs || [])[n]) return res.status(404).json({ error: '見つかりません' });
        const docs = st.docs.slice(); const [f] = docs.splice(n, 1);
        await col.doc(st.id).update({ docs });
        await log(req, '経歴書類を削除：' + st.name + '（' + f.label + '）');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

    // 半期（賞与・昇給額・評価）：管理者だけ。本人の欄も管理者が入力する（面談で聞いた内容など）
    api.get('/staff/:id/half/:start', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null;
        if (!st || !start || !canSecret(req.user, st)) return res.status(404).json({ error: '見つかりません' });
        const h = await col.doc(st.id).collection('halves').doc(start).get(), d = h.exists ? h.data() : {};
        const halves = (await col.doc(st.id).collection('halves').get()).docs.map(x => Object.assign({ id: x.id }, x.data()));
        // 評価のポジション：決めていなければ、その半期にいちばん多く担当したポジション（なければ入社時のポジション）
        const cnt = {}; halfMonths(start).forEach(m => ((st.assign || {})[m] || []).forEach(a => { cnt[a.position] = (cnt[a.position] || 0) + 1; }));
        const guess = Object.entries(cnt).filter(([p]) => EVAL_COL[p]).sort((a, b) => b[1] - a[1])[0];
        res.json({ staff: out(req.user, st), start, months: halfMonths(start), half: Object.assign({ bonus: null, bonusMonths: null, raise: null, skill: {}, skillGroups: {}, behavior: {}, perf: { rank: '', comment: '' }, selfNote: '', bossNote: '' }, d, { updatedAt: ts(d.updatedAt) }),
          position: d.position || '', positions: positionsFor(empTypeAt(st, start)),
          evalPosition: d.evalPosition || (EVAL_COL[d.position] ? d.position : '') || (guess && guess[0]) || (EVAL_COL[st.initPosition] ? st.initPosition : st.initPosition === '部長' ? 'PM' : ''), raiseFrom: raiseFrom(start), monthlyPay: Object.fromEntries(halfMonths(start).map(m => [m, monthlyPay(st, halves, m)])),
          noEval: NO_EVAL.includes(empTypeAt(st, evalYmOf(start))), empTypeHalf: empTypeAt(st, evalYmOf(start)), empTypes: EMP_TYPES, payNowHalf: (() => { const t = empTypeAt(st, start), pk = latestHalf(st.halfPays, start); if (pk) return st.halfPays[pk]; return t === 'アルバイト' ? st.initHourly ?? null : t === '執行役員' ? st.initAnnual ?? null : st.initMonthly ?? null; })(), isSelf: isSelf(req.user, st), isBoss: isFullAdmin(req.user) });
      } catch (e) { next(e); }
    });
    api.put('/staff/:id/half/:start', async (req, res, next) => {
      try {
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null;
        if (!st || !start || !canSecret(req.user, st)) return res.status(404).json({ error: '見つかりません' });
        const ref = col.doc(st.id).collection('halves').doc(start), cur = (await ref.get()).data() || {};
        const boss = isFullAdmin(req.user) && (req.body || {}).as !== 'self';
        const o = cleanHalf(Object.assign({}, req.body || {}, { start }), cur, st, boss);
        await ref.set(Object.assign(o, { start, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge: true });
        if (o.empType !== undefined || o.payBase !== undefined) { const up = {}; if (o.empType !== undefined) up['halfTypes.' + start] = o.empType || null; if (o.payBase !== undefined) up['halfPays.' + start] = o.payBase; await col.doc(st.id).update(up); }
        costCache = null;
        await log(req, (boss ? '半期の評価・賞与を保存：' : '自己評価を保存：') + st.name + '（' + start + '〜）');
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message) || /評価|昇給|ランク|賞与|スキル/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });

    // 目標・稼働工数管理：月ごと。本人と、管理者・BEST社員管理の権限の人
    api.get('/work/:ym', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const ym = req.params.ym; if (!isYm(ym)) return res.status(400).json({ error: '月の指定が正しくありません' });
        const manage = canManage(req.user), meSt = await byEmail(req.user.email);
        const docs = manage ? (await col.get()).docs.map(d => Object.assign({ id: d.id }, d.data())) : meSt ? [meSt] : [];
        const list = [];
        for (const st of docs) {
          if (st.joinDate && st.joinDate.slice(0, 7) > ym) continue;            // 入社前の月
          if (endDateOf(st) && endDateOf(st).slice(0, 7) < ym) continue;        // 退職後の月（役員に昇格した人は役員の退任後）
          const w = await col.doc(st.id).collection('work').doc(ym).get(), d = w.exists ? w.data() : {};
          list.push({ id: st.id, name: st.name, empType: empTypeAt(st, ym), status: statusOf(st), assign: (st.assign || {})[ym] || [], self: isSelf(req.user, st),
            work: { status: d.status || 'none', draft: d.draft || null, approved: d.approved || null, note: d.note || '', rejectNote: d.rejectNote || '', submittedAt: ts(d.submittedAt), approvedAt: ts(d.approvedAt), approvedBy: d.approvedBy || '' } });
        }
        list.sort((a, b) => b.self - a.self || String(a.name).localeCompare(b.name, 'ja'));
        res.json({ ym, list, canApprove: isFullAdmin(req.user), canManage: manage });
      } catch (e) { next(e); }
    });
    // 保存・申請：本人（申請中は変えられない）。管理者・BEST社員管理の権限の人は代わりに入力できる
    api.put('/work/:id/:ym', async (req, res, next) => {
      try {
        const st = await getStaff(req.params.id), ym = req.params.ym;
        if (!st || !isYm(ym) || !(isSelf(req.user, st) || canManage(req.user))) return res.status(404).json({ error: '見つかりません' });
        const ref = col.doc(st.id).collection('work').doc(ym), cur = (await ref.get()).data() || {};
        if (cur.status === 'submitted' && !canManage(req.user)) return res.status(400).json({ error: '申請中は変更できません。管理者が承認か却下をするまで待ってください' });
        const w = cleanWork(req.body || {}, st, ym), submit = (req.body || {}).action === 'submit';
        if (submit && Math.round(w.total) !== 100) return res.status(400).json({ error: '稼働の%の合計を100%にしてから申請してください（今 ' + w.total + '%）' });
        await ref.set({ ym, draft: { resource: w.resource, targets: w.targets, kurashiGoal: w.kurashiGoal }, note: w.note, status: submit ? 'submitted' : 'draft', updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(submit ? { submittedAt: admin.firestore.FieldValue.serverTimestamp(), submittedBy: req.user.email, rejectNote: '' } : {}) }, { merge: true });
        await log(req, (submit ? '目標・稼働工数を申請：' : '目標・稼働工数を保存：') + st.name + '（' + ym + '）');
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    // ===== メディア担当管理（2026-10-27 ユーザー指定） =====
    // メディア・ディレクトリ（と BEST MEDIA 以外の担当）ごとに、月単位で担当者（BEST社員とポジション）を決める。
    // 保存先は社員の assign（月ごとの担当）と同じ。ここで変えると、社員の担当・稼働工数の行・業績評価の表示も変わる。過去の月も直せる
    const allowedPos = async st => { const hp = Object.fromEntries((await col.doc(st.id).collection('halves').get()).docs.map(d => [d.id, d.data().position || ''])); return m => { const mp = positionAt(st, m); if (mp) return [mp].concat(ROLE_POSITIONS); const h = (st.changes || []).length ? '' : hp[halfStartOf(m)]; return (h ? [h] : positionsFor(empTypeAt(st, m))).concat(ROLE_POSITIONS); }; };
    // 半期（6か月）まとめて表示。担当は前の月から引き継ぐ（assignAt）。2026-10-27 ユーザー指定
    async function unitPeople() {
      const out = [];
      for (const d of (await col.get()).docs) { const st = Object.assign({ id: d.id }, d.data()), e = endDateOf(st); out.push({ st, allow: await allowedPos(st), on: m => inRangeAt(st, m), emp: m => empTypeAt(st, m), ref: col.doc(st.id), field: 'assign', end: e ? { date: e, label: promoted(st) ? '退任' : '退職' } : null }); }
      for (const d of (await db.collection('contracts').get()).docs) { const c = d.data(); if (!c.position || c.position === 'サイト作成・修正') continue; const st = asContractor(d.id, c); out.push({ st, allow: () => [c.position], on: m => contractorRange(st, m), emp: () => '業務委託', ref: d.ref, field: 'unitAssign', stored: st.unitAssign, leave: c.leaveStart ? { start: c.leaveStart, end: c.leaveEnd || '' } : null, end: st.endDate ? { date: st.endDate, label: '契約解除' } : st.status === '契約解除' ? { date: '', label: '契約解除' } : null }); }
      return out;
    }
    const inRangeAt = (st, m) => { const j = st.joinDate ? st.joinDate.slice(0, 7) : null, e = endDateOf(st) ? endDateOf(st).slice(0, 7) : null; return !(j && m < j) && !(e && m > e); };
    // 月ごと・メディア（ディレクトリ）ごとのディレクション担当：ディレクター＞アシスタントディレクター＞PM＞アシスタント兼ライター＞アシスタント の順で、
    // そのディレクトリの担当とメディア全体の担当から1人（同じ順位ならディレクトリの担当）。休職中（契約の休職期間）の人は除く
    const DIR_RANK = ['ディレクター', 'アシスタントディレクター', 'PM', 'アシスタント兼ライター', 'アシスタント', 'アシスタント候補'];
    api.get('/unit-directors', async (req, res, next) => {
      try {
        /* 見られるメディア・ディレクトリの分だけ返す（2026-11-04 ユーザー指定）。キーは「メディア|ディレクトリ」。ディレクトリ空はメディア全体の担当なので、メディアが見られれば返す */
        const u = req.user, okKey = k => { if (u.scope === 'all') return true; const i = k.indexOf('|'), md = k.slice(0, i), sub = k.slice(i + 1); if (!allowedMedia(u, md)) return false; const s = u.subScope && u.subScope[md]; return !sub || !Array.isArray(s) || s.includes(sub); };
        const pick = v => u.scope === 'all' ? v : { months: Object.fromEntries(Object.entries(v.months).map(([m, x]) => [m, Object.fromEntries(Object.entries(x).filter(([k]) => okKey(k)))])), sups: Object.fromEntries(Object.entries(v.sups).map(([m, x]) => [m, Object.fromEntries(Object.entries(x).filter(([k]) => okKey(k)))])) };
        if (unitDirCache && unitDirCache.until > Date.now()) return res.json(pick(unitDirCache.value));
        const people = await unitPeople(), first = '2024-01', last = unitHorizon(), out = {}, sups = {};
        const onLeave = (u, m) => { const l = u.leave; return !!(l && l.start && l.start.slice(0, 7) <= m && (!l.end || m <= l.end.slice(0, 7))); };
        for (let m = first, n = 0; m <= last && n < 60; m = shiftYm(m, 1), n++) {
          const rows = [], srows = [];
          people.forEach(u => { if (!u.on(m) || onLeave(u, m)) return; assignAt(u.st, m).forEach(a => { if (a.position === '監修者' && !NON_MEDIA.includes(a.media)) srows.push({ media: a.media, sub: a.sub || '', name: u.st.name }); const r = DIR_RANK.indexOf(a.position); if (r >= 0 && !NON_MEDIA.includes(a.media)) rows.push({ media: a.media, sub: a.sub || '', r, name: u.st.name }); }); });
          const best = list => list.sort((a, b) => a.r - b.r || (b.sub ? 1 : 0) - (a.sub ? 1 : 0))[0];
          const map = {};
          [...new Set(rows.map(x => x.media + '|' + x.sub))].forEach(k => { const [md, sub] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; const b = best(rows.filter(x => x.media === md && (x.sub === sub || !x.sub))); if (b) map[k] = b.name; });
          [...new Set(rows.map(x => x.media))].forEach(md => { if (!map[md + '|']) { const b = best(rows.filter(x => x.media === md && !x.sub)); if (b) map[md + '|'] = b.name; } });
          out[m] = map;
          const smap = {}; srows.forEach(x => { const k = x.media + '|' + x.sub; if (!smap[k]) smap[k] = x.name; }); sups[m] = smap;
        }
        const value = { months: out, sups };
        unitDirCache = { value, until: Date.now() + 10 * 60 * 1000 };
        res.json(pick(value));
      } catch (e) { next(e); }
    });
    api.get('/unit-assign/:ym', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        if (!canManage(req.user)) return res.status(403).json({ error: '見る権限がありません' });
        if (!isYm(req.params.ym)) return res.status(400).json({ error: '月の指定が正しくありません' });
        const start = halfStartOf(req.params.ym), months = halfMonths(start), list = [], at = isYm(req.query.at) ? req.query.at : null, horizon = unitHorizon();
        const key = x => x.media + '|' + (x.sub || '') + '|' + x.position;
        for (const u of await unitPeople()) {
          let chart = null;
          if (at && u.on(at)) {   // その月の担当ごとに、この先で外れる（ポジションが変わる）最初の月
            const cur = assignAt(u.st, at), changes = {}, endYm = u.end && u.end.date ? u.end.date.slice(0, 7) : null;
            for (let m = shiftYm(at, 1), n = 0; m <= horizon && n < 60 && cur.some(x => !changes[key(x)]); m = shiftYm(m, 1), n++) {
              if (!u.on(m)) break;
              const nx = assignAt(u.st, m).map(key); cur.forEach(x => { if (!changes[key(x)] && !nx.includes(key(x))) changes[key(x)] = m; });
            }
            chart = { assign: cur, changes, end: u.end && (!endYm || endYm >= at) ? { ym: endYm || '', label: u.end.label } : null };
          }
          list.push({ id: u.st.id, name: u.st.name, contractor: !!u.st.contractor, chart, leave: u.leave || null, end: u.end || null, byMonth: Object.fromEntries(months.map(m => { const on = u.on(m); return [m, { inRange: on, empType: u.emp(m), positions: u.allow(m), assign: on ? assignAt(u.st, m) : [] }]; })) });
        }
        list.sort((x, y) => (x.contractor - y.contractor) || String(x.name).localeCompare(y.name, 'ja'));
        res.json({ start, months, at, staff: list });
      } catch (e) { next(e); }
    });
    // 担当の変更：選んだ月から「〜まで」（空欄なら次の半期の終わり、またはその人の登録済みのいちばん先の月まで）に書く。
    // メディア担当は基本的に変わらないので、ここで変えない限り同じ担当が続く（2026-10-27 ユーザー指定）
    api.put('/unit-assign/:ym', async (req, res, next) => {
      try {
        if (!canManage(req.user)) return res.status(403).json({ error: '変更する権限がありません' });
        const ym0 = req.params.ym, b = req.body || {}; if (!isYm(ym0)) return res.status(400).json({ error: '月の指定が正しくありません' });
        const units = (Array.isArray(b.units) ? b.units : [b]).slice(0, 40).map(x => { const media = String((x || {}).media || ''); return { media, sub: NON_MEDIA.includes(media) ? '' : String((x || {}).sub || '').slice(0, 60),
          members: (Array.isArray(x.members) ? x.members : []).map(y => ({ staffId: String((y || {}).staffId || ''), position: String((y || {}).position || '') })).filter(y => y.staffId) }; });
        if (!units.length || units.some(x => !unitOk(x.media))) return res.status(400).json({ error: 'メディアが正しくありません' });
        const inUnit = (x, un) => x.media === un.media && (x.sub || '') === un.sub;
        const horizon = unitHorizon(), skipped = [], writes = [];
        for (const u of await unitPeople()) {
          const st = u.st, mine = units.map(un => ({ un, mem: un.members.find(x => x.staffId === st.id) })), allow = u.allow;
          const last = Object.keys((u.field === 'assign' ? st.assign : st.unitAssign) || {}).sort().pop() || ym0;
          const to = isYm(b.until) && b.until >= ym0 ? b.until : [horizon, last, ym0].sort().pop();
          const patch = {};
          for (let m = ym0, n = 0; m <= to && n < 60; m = shiftYm(m, 1), n++) {
            const cur = assignAt(st, m), anyMem = mine.some(x => x.mem);
            if (!anyMem && !cur.some(x => units.some(un => inUnit(x, un)))) continue;
            if (!u.on(m)) { if (anyMem && m === ym0) skipped.push(st.name + '：' + m); continue; }
            const rows = cur.filter(x => !units.some(un => inUnit(x, un))).map(x => ({ media: x.media, sub: x.sub || '', position: x.position }));
            for (const { un, mem } of mine) {
              if (!mem) continue;
              if (!allow(m).includes(mem.position) && m === ym0) return res.status(400).json({ error: st.name + ' さんの ' + m + ' のポジションは「' + allow(m).join('・') + '」です（' + (mem.position || '未選択') + 'は選べません）' });
              rows.push({ media: un.media, sub: un.sub, position: allow(m).includes(mem.position) ? mem.position : allow(m)[0] });
            }
            patch[u.field + '.' + m] = rows;
          }
          if (Object.keys(patch).length) writes.push({ u, patch });
        }
        // 業務委託：今の月の担当がメディア0件になると契約の担当メディアが空になるので止める
        const now = todayJst().slice(0, 7);
        for (const w of writes.filter(x => x.u.st.contractor)) {
          const ua = Object.assign({}, w.u.st.unitAssign); Object.keys(w.patch).forEach(k => { ua[k.slice('unitAssign.'.length)] = w.patch[k]; });
          const st2 = Object.assign({}, w.u.st, { unitAssign: ua });
          if (contractorRange(st2, now) && !toMediaSubs(contractorAt(st2, now)).medias.length) return res.status(400).json({ error: w.u.st.name + ' さん（業務委託）の今月の担当メディアがなくなります。契約を終えるときは契約管理で「契約解除」にしてください' });
        }
        for (const w of writes) {
          await w.u.ref.update(Object.assign(w.patch, w.u.st.contractor ? {} : { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
          if (w.u.st.contractor) await syncContractFromUnits(w.u.st.contractId, req.user.email);
        }
        costCache = null; unitDirCache = null;
        await log(req, 'メディア担当を変更：' + [...new Set(units.map(un => un.media + (un.sub ? '／' + un.sub : '')))].join('・') + '（' + ym0 + '〜' + (isYm(b.until) ? b.until : '') + '）');
        res.json({ ok: true, skipped });
      } catch (e) { next(e); }
    });

    // ===== 目標・稼働工数設定（半期まとめて）（2026-10-27 ユーザー指定） =====
    // ・見られるのは自分（ログインしたアカウントに紐づく社員）だけ。管理者は承認のために見られる
    // ・稼働工数（%）は本人がそのまま保存（承認不要。保存した内容がそのまま人件費の配分に使われる）
    // ・記事目標は本人が申請 → 管理者が承認／却下（承認で記事目標設定に反映）
    /** その月の担当（入っていなければ、その月より前でいちばん新しい担当を引き継ぐ） */
    const assignAt = (st, ym) => { if (st.contractor) return contractorAt(st, ym); const a = st.assign || {}; if (Array.isArray(a[ym])) return a[ym]; const k = Object.keys(a).filter(m => m <= ym && Array.isArray(a[m])).sort().pop(); return k ? a[k] : []; };
    halfViewRef = (st, start) => halfView(st, start);   /* halfMedias から使う */
    async function halfView(st, start) {
      const months = halfMonths(start), work = {};
      for (const m of months) {
        const d = (await workDoc(st, m).get()).data() || {};
        work[m] = { status: d.status || 'none', resource: (d.approved || {}).resource || (d.draft || {}).resource || {}, targets: (d.draft || {}).targets || (d.approved || {}).targets || {}, approvedTargets: (d.approved || {}).targets || null,
          kurashiGoal: (d.draft || {}).kurashiGoal || '', rejectNote: d.rejectNote || '', submittedAt: ts(d.submittedAt), approvedAt: ts(d.approvedAt),
          resLocked: Object.keys((d.approved || {}).resource || {}).length > 0,   // 保存済みの月は本人では変えられない（修正は申請。2026-10-29 ユーザー指定）
          resReq: d.resRequest ? { resource: d.resRequest.resource || {}, note: d.resRequest.note || '', by: d.resRequest.by || '', at: ts(d.resRequest.at), status: d.resRequest.status || 'pending', rejectNote: d.resRequest.rejectNote || '' } : null };
      }
      return { staff: { id: st.id, name: st.name, empType: st.contractor ? '業務委託' : empTypeAt(st, start), contractor: !!st.contractor }, start, months, assign: Object.fromEntries(months.map(m => [m, assignAt(st, m)])), work };
    }
    api.get('/work-half/:id/:start', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const st = req.params.id === 'me' ? (await byEmail(req.user.email)) || (await contractorByEmail(req.user.email)) : await getStaff(req.params.id);
        if (!st) return res.json({ staff: null });
        if (!(isSelf(req.user, st) || isFullAdmin(req.user))) return res.status(404).json({ error: '見つかりません' });
        const start = isYm(req.params.start) ? halfStartOf(req.params.start) : halfStartOf(todayJst().slice(0, 7));
        res.json(Object.assign(await halfView(st, start), { isSelf: isSelf(req.user, st), canApprove: isFullAdmin(req.user) }));
      } catch (e) { next(e); }
    });
    api.put('/work-half/:id/:start', async (req, res, next) => {
      try {
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null;
        if (!st || !start || !(isSelf(req.user, st) || isFullAdmin(req.user))) return res.status(404).json({ error: '見つかりません' });
        const b = req.body || {}, months = halfMonths(start), action = b.action || 'save';
        // 稼働工数は月ごとに合計100%でないと保存しない（何も入れていない月は除く。2026-10-29 ユーザー指定）
        if (b.resource && !st.contractor) {
          const bad = months.filter(m => b.resource[m] !== undefined).map(m => [m, cleanWork({ resource: b.resource[m] }, st, m)]).filter(([, w]) => Object.keys(w.resource).length && Math.round(w.total * 100) !== 10000);
          if (bad.length) return res.status(400).json({ error: '稼働工数の合計を100%にしてください：' + bad.map(([m, w]) => m.replace('-', '/') + '（' + w.total + '%）').join('、'), months: bad.map(([m]) => m) });
        }
        // 一度保存した月の稼働工数は、本人は変えられない（メディアの支出が変わるため。修正は申請 → 管理者が承認。2026-10-29 ユーザー指定）
        if (b.resource && !st.contractor && !isFullAdmin(req.user)) {
          const locked = [];
          for (const m of months) {
            if (b.resource[m] === undefined) continue;
            const cur = ((await workDoc(st, m).get()).data() || {}), old = (cur.approved || {}).resource || {};
            if (!Object.keys(old).length) continue;
            if (!sameRes(old, cleanWork({ resource: b.resource[m] }, st, m).resource)) locked.push(m);
          }
          if (locked.length) return res.status(400).json({ error: locked.map(m => m.replace('-', '/')).join('、') + ' の稼働工数は保存済みのため変更できません。「修正を申請」から申請してください', months: locked });
        }
        for (const m of months) {
          const ref = workDoc(st, m), cur = (await ref.get()).data() || {}, up = { ym: m, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (b.resource && b.resource[m] !== undefined && !st.contractor) {   // 稼働工数：はじめての保存は承認不要（保存済みの月は上で止める）
            const w = cleanWork({ resource: b.resource[m] }, st, m);
            if (!isFullAdmin(req.user) && sameRes((cur.approved || {}).resource || {}, w.resource)) { /* 変わっていない月は書かない */ }
            else {
            up.approved = Object.assign({}, cur.approved || {}, { resource: w.resource }); up.draft = Object.assign({}, cur.draft || {}, { resource: w.resource });
            }
          }
          if (b.targets && b.targets[m] !== undefined) {   // 記事目標：申請 → 承認
            if (cur.status === 'submitted' && !isFullAdmin(req.user)) return res.status(400).json({ error: '記事目標は申請中のため変更できません。管理者が承認か却下をするまで待ってください' });
            const w = cleanWork({ targets: b.targets[m], kurashiGoal: (b.kurashiGoal || {})[m] }, st, m);
            up.draft = Object.assign({}, up.draft || cur.draft || {}, { targets: w.targets, kurashiGoal: w.kurashiGoal });
            if (action === 'submit') Object.assign(up, { status: 'submitted', submittedAt: admin.firestore.FieldValue.serverTimestamp(), submittedBy: req.user.email, rejectNote: '' });
            else if (!cur.status || cur.status === 'none') up.status = 'draft';
          }
          await ref.set(up, { merge: true });
          if (up.approved && up.approved.resource) await ref.update({ 'approved.resource': up.approved.resource, 'draft.resource': up.approved.resource });   // 消した行が残らないように丸ごと置き換え
        }
        costCache = null;
        await log(req, (action === 'submit' ? '記事目標を申請：' : '目標・稼働工数を保存：') + st.name + '（' + start + '〜）');
        res.json({ ok: true });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    api.post('/work-half/:id/:start/:action(approve|reject)', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '承認・却下は管理者だけができます' });
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null;
        if (!st || !start) return res.status(404).json({ error: '見つかりません' });
        const note = String((req.body || {}).note || '').slice(0, 1000);
        if (req.params.action === 'reject' && !note) return res.status(400).json({ error: '却下の理由を入力してください' });
        let n = 0;
        for (const m of halfMonths(start)) {
          const ref = workDoc(st, m), cur = (await ref.get()).data();
          if (!cur || cur.status !== 'submitted') continue;
          n++;
          if (req.params.action === 'approve') { await ref.update({ status: 'approved', approved: Object.assign({}, cur.approved || {}, { targets: (cur.draft || {}).targets || {}, kurashiGoal: (cur.draft || {}).kurashiGoal || '' }), approvedBy: req.user.email, approvedAt: admin.firestore.FieldValue.serverTimestamp(), rejectNote: '' }); await applyTargets(m); }
          else await ref.update({ status: 'rejected', rejectNote: note });
        }
        if (!n) return res.status(400).json({ error: '申請中の記事目標がありません' });
        await log(req, (req.params.action === 'approve' ? '記事目標を承認：' : '記事目標を却下：') + st.name + '（' + start + '〜）');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // ---- 稼働工数の修正申請（保存済みの月を変えたいとき。2026-10-29 ユーザー指定） ----
    api.post('/work-half/:id/:start/res-request', async (req, res, next) => {
      try {
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null;
        if (!st || st.contractor || !start || !(isSelf(req.user, st) || isFullAdmin(req.user))) return res.status(404).json({ error: '見つかりません' });
        const b = req.body || {}, note = String(b.note || '').trim().slice(0, 1000);
        if (!note) return res.status(400).json({ error: '修正の理由を入力してください' });
        const reqs = [];
        for (const m of halfMonths(start)) {
          if (!b.resource || b.resource[m] === undefined) continue;
          const cur = (await workDoc(st, m).get()).data() || {}, old = (cur.approved || {}).resource || {};
          if (!Object.keys(old).length) continue;   // 保存前の月は申請ではなく保存
          const w = cleanWork({ resource: b.resource[m] }, st, m);
          if (sameRes(old, w.resource)) continue;
          if (Math.round(w.total * 100) !== 10000) return res.status(400).json({ error: '稼働工数の合計を100%にしてください：' + m.replace('-', '/') + '（' + w.total + '%）', months: [m] });
          reqs.push([m, w.resource]);
        }
        if (!reqs.length) return res.status(400).json({ error: '変更した月がありません' });
        for (const [m, r] of reqs) await workDoc(st, m).set({ ym: m, resRequest: { resource: r, note, by: req.user.email, at: admin.firestore.FieldValue.serverTimestamp(), status: 'pending', rejectNote: '' } }, { merge: true }).then(() => workDoc(st, m).update({ 'resRequest.resource': r }));
        await log(req, '稼働工数の修正を申請：' + st.name + '（' + reqs.map(([m]) => m).join('・') + '）');
        res.json({ ok: true, months: reqs.map(([m]) => m) });
      } catch (e) { if (BAD.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    api.post('/work-half/:id/:start/res-:action(approve|reject|cancel)', async (req, res, next) => {
      try {
        const st = await getStaff(req.params.id), start = isYm(req.params.start) ? halfStartOf(req.params.start) : null, act = req.params.action;
        if (!st || !start) return res.status(404).json({ error: '見つかりません' });
        if (act === 'cancel' ? !(isSelf(req.user, st) || isFullAdmin(req.user)) : !isFullAdmin(req.user)) return res.status(403).json({ error: '承認・却下は管理者だけができます' });
        const note = String((req.body || {}).note || '').slice(0, 1000);
        if (act === 'reject' && !note) return res.status(400).json({ error: '却下の理由を入力してください' });
        let n = 0;
        for (const m of halfMonths(start)) {
          const ref = workDoc(st, m), cur = (await ref.get()).data() || {}, rq = cur.resRequest;
          if (!rq || rq.status !== 'pending') continue;
          n++;
          if (act === 'approve') { await ref.update({ 'approved.resource': rq.resource || {}, 'draft.resource': rq.resource || {}, resRequest: admin.firestore.FieldValue.delete(), approvedBy: req.user.email, approvedAt: admin.firestore.FieldValue.serverTimestamp() }); }
          else if (act === 'reject') await ref.update({ 'resRequest.status': 'rejected', 'resRequest.rejectNote': note });
          else await ref.update({ resRequest: admin.firestore.FieldValue.delete() });
        }
        if (!n) return res.status(400).json({ error: '申請中の稼働工数の修正がありません' });
        costCache = null;
        await log(req, { approve: '稼働工数の修正を承認：', reject: '稼働工数の修正を却下：', cancel: '稼働工数の修正申請を取り下げ：' }[act] + st.name + '（' + start + '〜）');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 管理者：承認待ちの一覧（社員×半期）
    api.get('/work-pending', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.json({ list: [] });
        res.json({ list: await pendingWork() });
      } catch (e) { next(e); }
    });
    // 承認・却下（管理者だけ）。承認すると記事目標設定に反映し、人件費の配分にも使う
    api.post('/work/:id/:ym/:action(approve|reject)', async (req, res, next) => {
      try {
        if (!isFullAdmin(req.user)) return res.status(403).json({ error: '承認・却下は管理者だけができます' });
        const st = await getStaff(req.params.id), ym = req.params.ym;
        if (!st || !isYm(ym)) return res.status(404).json({ error: '見つかりません' });
        const ref = col.doc(st.id).collection('work').doc(ym), cur = (await ref.get()).data();
        if (!cur || cur.status !== 'submitted') return res.status(400).json({ error: '申請中の内容がありません' });
        if (req.params.action === 'approve') {
          await ref.update({ status: 'approved', approved: cur.draft, approvedBy: req.user.email, approvedAt: admin.firestore.FieldValue.serverTimestamp(), rejectNote: '' });
          await applyTargets(ym); costCache = null;
        } else {
          const note = String((req.body || {}).note || '').slice(0, 1000);
          if (!note) return res.status(400).json({ error: '却下の理由を入力してください' });
          await ref.update({ status: 'rejected', rejectNote: note });
        }
        await log(req, (req.params.action === 'approve' ? '目標・稼働工数を承認：' : '目標・稼働工数を却下：') + st.name + '（' + ym + '）');
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }

  /** ユーザー追加のときの確認：正社員・契約社員・アルバイトの役割は、同じ名前・メールアドレス・区分の社員が登録されていること */
  async function checkUserInvite(role, email, name) {
    const emp = ROLE_EMP[role]; if (!emp) return '';
    const empLabel = [].concat(emp).join('・');
    const st = await byEmail(email);
    const norm = s => String(s || '').normalize('NFKC').replace(/\s/g, '');
    if (!st) return empLabel + 'の役割にするには、BEST社員管理にこのメールアドレス（' + email + '）の社員を先に登録してください';
    if (name != null && norm(st.name) !== norm(name)) return 'BEST社員管理に登録されている名前（' + st.name + '）と同じ名前を入れてください';
    if (![].concat(emp).includes(empNow(st))) return 'BEST社員管理ではこの人は今「' + empNow(st) + '」です。役割も同じ区分を選んでください';
    if (statusOf(st) === '退職済み') return 'この人は退職済みのため、ユーザーに追加できません';
    return '';
  }

  /** ユーザー追加で選べる社員（退職済みは除く。役割は今の区分から）（2026-10-28 ユーザー指定） */
  async function userCandidates() {
    const ROLE_OF = { 正社員: 'employee', 契約社員: 'contract', アルバイト: 'parttime', 役員: 'exec', 執行役員: 'exec' };
    return (await col.get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(st => st.email && statusOf(st) !== '退職済み')
      .map(st => { const emp = empNow(st); return { name: st.name, email: String(st.email).toLowerCase(), empType: emp, role: ROLE_OF[emp] || '' }; });
  }

  /** 進行管理の担当者の候補にする社員：退職済み以外で、今月メディアを担当している人（BEST MEDIA の PM は全メディア）（2026-10-28 ユーザー指定） */
  async function mediaStaff() {
    const ym = todayJst().slice(0, 7), all = MEDIA_ORDER.map(([k]) => k), docs = (await col.get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
    return { all: docs.map(st => st.name).filter(Boolean), list: docs.filter(st => st.name && statusOf(st) !== '退職済み').map(st => {
      const a = st.assign || {}, k = Array.isArray(a[ym]) ? ym : Object.keys(a).filter(m => m <= ym && Array.isArray(a[m])).sort().pop(), rows = k ? a[k] : [];
      const medias = rows.some(x => x.media === BM_PM) ? all : [...new Set(rows.map(x => x.media).filter(mediaOk))];
      return { name: st.name, medias };
    }).filter(x => x.medias.length) };
  }

  /** 承認待ち（記事目標の申請・稼働工数の修正申請）の一覧。タスク通知でも使う（2026-10-29） */
  async function pendingWork() {
        const list = [];
        for (const d of (await col.get()).docs) {
          const w = await d.ref.collection('work').where('status', '==', 'submitted').get();
          const halves = [...new Set(w.docs.map(x => halfStartOf(x.id)))];
          halves.forEach(h => list.push({ id: d.id, name: d.data().name, start: h }));
          const rq = await d.ref.collection('work').where('resRequest.status', '==', 'pending').get();   // 稼働工数の修正申請
          [...new Set(rq.docs.map(x => halfStartOf(x.id)))].forEach(h => list.push({ id: d.id, name: d.data().name, start: h, kind: 'res' }));
        }
        for (const d of (await db.collection('contracts').get()).docs) {
          const w = await d.ref.collection('work').where('status', '==', 'submitted').get();
          [...new Set(w.docs.map(x => halfStartOf(x.id)))].forEach(h => list.push({ id: 'c_' + d.id, name: d.data().name + '（業務委託）', start: h }));
        }
        return list;
  }
  /** その人（メールアドレス）の半期の担当メディア（担当メディア数値進捗で、メディア数値の権限がない社員にも担当分の実績を見せるため。2026-11-06） */
  async function halfMedias(email, start) {
    const st = (await byEmail(email)) || (await contractorByEmail(email)); if (!st) return [];
    if (!halfViewRef) return []; const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(start) ? start : new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7); const v = await halfViewRef(st, halfStartOf(ym));
    return [...new Set(Object.values(v.assign || {}).flat().map(a => a && a.media).filter(Boolean))];
  }
  return { halfMedias, routes, pendingWork, staffCosts, staffPersonCosts, setActiveMedia, halfStartOf, checkUserInvite, EVAL, syncUnitsFromContract, syncContractFromUnits, userCandidates, mediaStaff };
  // 役員昇格の考え方：同じ社員のまま、退職日の翌月から役員。入社日（勤続）は最初の入社日から数える（2026-10-27 ユーザー指定）
};
