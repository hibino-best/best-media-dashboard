/**
 * BESTメディア 数値ダッシュボード — サーバー（Cloud Run）
 *
 * - 画面（public/）を配信し、/api/* で BigQuery のデータを返す
 * - ログインは Firebase Authentication。ユーザー・権限・アクセスログは Firestore に保存
 * - 新規ユーザーは「承認待ち」。ADMIN_EMAILS のユーザーだけは最初から管理者
 */
const path = require('path');
const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');

const PROJECT = process.env.GCP_PROJECT || 'bestmedia-510909';
const DATASET = process.env.BQ_DATASET || 'best_media';
const LOCATION = process.env.BQ_LOCATION || 'asia-northeast1';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const FIREBASE_WEB_CONFIG = process.env.FIREBASE_WEB_CONFIG || '{}';   // Firebase の「ウェブアプリ」の設定（公開して問題ない値）
const PORT = process.env.PORT || 8080;
const SERVICE_URL = process.env.SERVICE_URL || '';          // 定期実行（Cloud Scheduler）の呼び出し先の確認用
const TASK_SA_EMAIL = process.env.TASK_SA_EMAIL || '';      // 定期実行に使うサービスアカウント

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const bq = new BigQuery({ projectId: PROJECT });
const T = name => '`' + PROJECT + '.' + DATASET + '.' + name + '`';

// ---------- メディアの表示名と並び順（BigQuery の media / block の値に対応） ----------
const MEDIA_ORDER = [
  ['生活お助け', '生活お助け本舗'], ['害獣お助け', '害獣お助け本舗'], ['ハチお助け', 'ハチお助け本舗'], ['水まわりお助け', '水まわりお助け本舗'],
  ['カギお助け', 'カギお助け本舗'], ['ガラスお助け', 'ガラスお助け本舗'], ['屋根外壁お助け', '屋根外壁お助け本舗'], ['シロアリお助け', 'シロアリお助け本舗'],
  ['BEST365', 'BEST365'], ['害虫害獣コンシェルジュ', '害虫害獣コンシェルジュ'],
];
const BLOCK_ORDER = ['害虫', 'ゴキブリ', 'シロアリ', 'ハチ', 'その他害虫', '害獣', 'コウモリ', 'ネズミ', 'その他害獣'];
const BLOCK_GROUPS = { '害虫': ['ゴキブリ', 'シロアリ', 'ハチ', 'その他害虫'], '害獣': ['コウモリ', 'ネズミ', 'その他害獣'] };
const mediaId = (media, block) => block ? media + '|' + block : media;
/** まとめのディレクトリ（BLOCK_GROUPS）の値：GA4・SC はまとめ自身の値があるのでそのまま。記事数・支出・kintone・収益は下のディレクトリにだけ入るので合計する（2026-11-06） */
const ROLLUP_KEYS = ['posts', 'rewrites', 'lite', 'tweak', 'cost', 'kCalls', 'visits', 'contracts', 'revPartner', 'revAffiliate'];
function rollupGroups(out) {
  /* ディレクトリの公開記事数（累計）：シートの値は2026/09まで。値がない月（またはまとめで0の月）は、前の月の累計＋その月の新規公開（進行管理）で続ける（2026-11-06 ユーザー指摘：10月から0・—になる） */
  const groupIds = new Set(Object.keys(out).filter(id => { const b = id.split('|')[1]; return b && BLOCK_GROUPS[b]; }));
  Object.keys(out).filter(id => id.includes('|') && !groupIds.has(id)).forEach(id => {
    let prev = null; Object.keys(out[id]).filter(p => p.length === 7).sort().forEach(p => { const o = out[id][p]; if (o.postsTotal != null && !(o.postsTotal === 0 && prev > 0)) { prev = Number(o.postsTotal); return; } if (prev != null) { prev += Number(o.posts) || 0; o.postsTotal = prev; } });
  });
  const medias = new Set(Object.keys(out).map(id => id.split('|')[0]));
  medias.forEach(media => Object.entries(BLOCK_GROUPS).forEach(([g, leaves]) => {
    const kids = leaves.map(l => out[mediaId(media, l)]).filter(Boolean); if (!kids.length) return;
    const gid = mediaId(media, g), periods = new Set(kids.flatMap(k => Object.keys(k)));
    periods.forEach(p => {
      const rows = kids.map(k => k[p]).filter(Boolean); if (!rows.length) return;
      const o = ((out[gid] = out[gid] || {})[p] = out[gid][p] || (p.length === 7 ? { ch: {} } : {}));
      ROLLUP_KEYS.forEach(k => { const vals = rows.map(r => r[k]).filter(v => v != null); if (!vals.length) return; const sum = vals.reduce((a, v) => a + Number(v || 0), 0);
        if (o[k] == null || ['posts', 'rewrites', 'lite', 'tweak'].includes(k)) o[k] = sum; });   /* 記事数はまとめに0が入っているので常に合計で置きかえる */
      if (p.length === 7) { const pt = rows.map(r => r.postsTotal).filter(v => v != null); if (pt.length) o.postsTotal = pt.reduce((a, v) => a + Number(v || 0), 0); }   /* まとめの公開記事数（累計）＝下のディレクトリの合計 */
      const costs = {}; rows.forEach(r => Object.entries(r.costs || {}).forEach(([k, v]) => { costs[k] = (costs[k] || 0) + Number(v || 0); }));
      if (Object.keys(costs).length && !o.costs) o.costs = costs;
    });
  }));
}
// スプレッドシートのアフィリエイトの値は税込み（もしものCSVの承認成果金額と同じ）なので、税抜きにする（2026-10-14 ユーザー指定）
const affExTax = v => Math.round(Number(v) / 1.1 * 100) / 100;

// ---------- 小さなキャッシュ（BigQuery の問い合わせ回数と待ち時間を減らす） ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  return value;
}
const TEN_MIN = 10 * 60 * 1000;

async function query(sql, params, types) {
  const [rows] = await bq.query({ query: sql, params, types, location: LOCATION });
  return rows;
}
const dateStr = v => (v && typeof v === 'object' && 'value' in v) ? v.value : String(v);
const tsStr = v => (v && typeof v === 'object' && 'value' in v) ? v.value : v;

// ---------- ユーザー ----------
async function loadUser(tok) {
  const ref = db.collection('users').doc(tok.uid);
  const snap = await ref.get();
  const email = (tok.email || '').toLowerCase();
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (!snap.exists) {
    const isAdmin = ADMIN_EMAILS.includes(email) && tok.email_verified === true;   // なりすまし登録で管理者にならないように
    // ユーザー管理で先に追加された人（user_invites）だけを登録する。追加されていない人は登録せず、入れない（2026-10-14 ユーザー指定）
    const inviteRef = email ? db.collection('user_invites').doc(email) : null;
    const invite = !isAdmin && inviteRef ? await inviteRef.get() : null;
    if (!isAdmin && !(invite && invite.exists)) return { uid: tok.uid, email, name: tok.name || email.split('@')[0], status: 'unregistered', perms: { media: 'none', revenue: 'none', articles: 'none' }, scope: [] };
    if (!isAdmin && tok.email_verified !== true) return { uid: tok.uid, email, name: tok.name || email.split('@')[0], status: 'invited', perms: { media: 'none', revenue: 'none', articles: 'none' }, scope: [] };   // メール確認が済むまでは登録しない
    const inv = invite ? invite.data() : {};
    const user = {
      email, name: inv.name || tok.name || email.split('@')[0],
      status: 'active',
      perms: { media: isAdmin ? 'admin' : 'none', revenue: isAdmin ? 'admin' : 'none', articles: isAdmin ? 'admin' : 'none' },
      scope: isAdmin ? 'all' : (inv.scope || 'all'), createdAt: now, lastLoginAt: now,
    };
    if (!isAdmin && inv.role) user.role = inv.role;
    if (!isAdmin) { user.invitedBy = inv.createdBy || null; }
    await ref.set(user);
    if (!isAdmin) await inviteRef.delete().catch(() => {});
    return Object.assign({ uid: tok.uid }, user);
  }
  const user = Object.assign({ uid: tok.uid }, snap.data());
  // 最終ログインは5分に1回だけ更新
  const last = user.lastLoginAt && user.lastLoginAt.toMillis ? user.lastLoginAt.toMillis() : 0;
  if (Date.now() - last > 5 * 60 * 1000) ref.update({ lastLoginAt: now }).catch(() => {});
  return user;
}

// ---------- 役割と操作権限（権限管理） ----------
const ROLES = [['admin', '管理者'], ['exec', 'BEST役員'], ['employee', 'BEST正社員'], ['contract', 'BEST契約社員'], ['parttime', 'BESTアルバイト'],
  ['out_director', '業務委託ディレクター'], ['out_ad', '業務委託アシスタントディレクター'], ['out_aw', '業務委託アシスタント兼ライター'], ['out_writer', '業務委託ライター'], ['supervisor', '監修者'], ['free_writer', '契約外ライター'], ['finance', 'BEST経理部'], ['resta', 'REsta社員']];   // REsta社員（2026-10-30 ユーザー指定）   // 経理部：請求書の確認だけ（2026-10-29 ユーザー指定）
const CAPS = [['media_view', 'メディア数値', '閲覧'], ['articles_view', 'コンテンツ作成', '閲覧（記事一覧・制作状況など）'], ['articles_edit', 'コンテンツ作成', '進行管理の入力'],
  ['articles_bulk', '記事管理', '一括操作・KWの削除'], ['articles_settings', '記事管理', '各種設定（カテゴリ・タグ・CTA・訴求ブロック）の表示と編集'], ['articles_own', '記事管理', '自分が担当の記事だけ表示'],
  ['revenue_view', '収益情報', '閲覧'], ['rewards_view', '報酬管理', '閲覧'],
  /* 2026-10 以降に足した機能（2026-11-06 ユーザー指定：権限管理で切り替えられるように） */
  ['sim_view', 'メディア数値', 'シミュレーション・シミュレーション比較'], ['expenses_view', '支出情報', '閲覧・入力（サイト制作・プレスリリース・ツール・業務委託など）'], ['goals_view', '目標・工数', '目標・稼働工数の入力と進捗（BEST社員管理に登録がある人）'],
  ['press_view', 'コンテンツ作成', 'プレスリリース進行管理の閲覧'], ['outline_edit', 'コンテンツ作成', '構成シートの作成・編集（ライターへの編集の受け渡しも）'], ['outline_compete', 'コンテンツ作成', '構成シートの競合調査（閲覧・取得）'],['feedback_send', '機能改善依頼', '各画面からの依頼の送信'], ['ai_tools', 'AIツール', 'AI MEDIAシミュレーションの閲覧'], ['ai_errcheck', 'AIツール', 'AIエラーチェッカー（週次の点検の報告を見る）'],
  ['admin_users', '管理メニュー', 'ユーザー管理（役割の設定。管理者の役割は付けられない）'], ['admin_roles', '管理メニュー', '権限管理'], ['admin_logs', '管理メニュー', 'アクセスログ'], ['admin_media', '管理メニュー', 'メディア管理（WordPressの接続）'],
  ['admin_contracts', '管理メニュー', '契約管理'], ['admin_expenses', '管理メニュー', '支出管理'], ['admin_staff', '管理メニュー', 'BEST社員管理'], ['admin_targets', '管理メニュー', '記事目標設定'], ['admin_api', '管理メニュー', 'API・連携設定（Google広告・kintone）'], ['admin_jobs', '管理メニュー', '収集ジョブ'], ['admin_system', '管理メニュー', 'システム構造']];
/** 新しく足した権限の初期値＝足す前の見せ方と同じ（保存済みの役割にも、その権限をまだ保存したことがなければこれを入れる）（2026-11-06） */
const NEW_CAP_DEFAULT = {
  sim_view: (role, caps) => caps.includes('media_view') && role !== 'resta',
  expenses_view: role => ['exec', 'employee'].includes(role),   /* 画面で支出情報を出していた役割 */
  goals_view: role => !['finance', 'resta'].includes(role),
  press_view: role => ['exec', 'employee', 'contract', 'parttime', 'out_director', 'out_ad', 'out_aw'].includes(role),
  feedback_send: role => ['employee', 'out_director', 'exec', 'out_ad', 'out_aw'].includes(role),
  ai_tools: () => false,
  ai_errcheck: () => false,   /* AIエラーチェッカーは管理者だけ（2026-11-13） */
  outline_edit: role => ['exec', 'employee', 'contract', 'parttime', 'out_director', 'out_ad'].includes(role),   /* 構成シートは基本ディレクターだけ（2026-11-12 ユーザー指定） */
  outline_compete: role => ['exec', 'employee', 'out_director', 'out_ad', 'out_aw'].includes(role),   /* 競合調査は業務委託のディレクション担当（アシスタント以上）とBEST役員・正社員だけ（2026-11-13 ユーザー指定） */
  admin_system: role => role !== 'finance',
};
/** その人がその権限を持つか。役割がない人（これまでの個別の権限）は fallback（足す前の判定） */
const capOk = (u, cap, fallback) => isFullAdmin(u) || (!!u && Array.isArray(u.caps) ? u.caps.includes(cap) : !!(fallback && fallback(u)));
// 管理APIのパス → 必要な権限
const ADMIN_PATH_CAP = [[/^\/users/, 'admin_users'], [/^\/roles/, 'admin_roles'], [/^\/logs/, 'admin_logs'], [/^\/jobs/, 'admin_jobs'], [/^\/wp/, 'admin_media'], [/^\/(ads|kwvol|kintone|ahrefs|moshimo|ai-access|copycheck|competitor)/, 'admin_api'], [/^\/targets/, 'admin_targets'], [/^\/contract-import/, 'admin_contracts']];
const isFullAdmin = u => !!u && u.status === 'active' && !!u.perms && u.perms.media === 'admin';
const hasAdminCap = (u, cap) => isFullAdmin(u) || (!!u && u.status === 'active' && !!u.perms && (u.perms.adminMenus || []).includes(cap));
// 初期値（権限管理の画面で変更できる）。管理者はすべての権限と管理メニュー
const DEFAULT_ROLE_CAPS = {
  exec: ['media_view', 'articles_view', 'articles_edit', 'articles_bulk', 'articles_settings', 'revenue_view', 'rewards_view'],
  employee: ['media_view', 'articles_view', 'articles_edit', 'articles_bulk', 'articles_settings', 'revenue_view'],
  contract: ['media_view', 'articles_view', 'articles_edit'],
  parttime: ['articles_view', 'articles_edit'],
  out_director: ['articles_view', 'articles_edit', 'articles_bulk', 'articles_settings'],
  out_ad: ['articles_view', 'articles_edit'],
  out_aw: ['articles_view', 'articles_edit', 'articles_own'],
  out_writer: ['articles_view', 'articles_edit', 'articles_own'],
  supervisor: ['articles_view', 'articles_edit', 'articles_own'],
  free_writer: ['articles_view', 'articles_own'],
  finance: ['rewards_view'],
  resta: ['media_view', 'articles_view'],   // REsta社員：メディア数値・コンテンツ作成の閲覧だけ（収益と支出はサーバーで外す）   // 経理部：報酬管理の「経理部確認」だけ（契約の一覧は見せない）
};
// 契約管理のポジション → 役割（契約から自動のとき）。複数の契約があれば上の役割
const POSITION_ROLE = { 'PM': 'out_director', 'ディレクター': 'out_director', 'アシスタントディレクター': 'out_ad', 'アシスタント兼ライター': 'out_aw', 'ライター': 'out_writer', '監修者': 'supervisor', 'サイト作成・修正': 'free_writer' };   // サイト作成・修正は記事の担当にはならない
const AUTO_RANK = ['out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'];
let roleCapsCache = null;
async function roleCaps() {
  if (roleCapsCache && roleCapsCache.until > Date.now()) return roleCapsCache.value;
  const snap = await db.collection('settings').doc('roles').get();
  const saved = (snap.exists && snap.data().caps) || {};
  const value = {};
  const known = (snap.exists && Array.isArray(snap.data().known)) ? snap.data().known : CAPS.map(c => c[0]).filter(k => !NEW_CAP_DEFAULT[k]);   /* 保存したときにあった権限 */
  ROLES.forEach(([id]) => { if (id === 'admin') { value[id] = CAPS.map(c => c[0]); return; } const base = Array.isArray(saved[id]) ? saved[id].slice() : (DEFAULT_ROLE_CAPS[id] || []).slice();
    Object.entries(NEW_CAP_DEFAULT).forEach(([k, f]) => { if ((!Array.isArray(saved[id]) || !known.includes(k)) && !base.includes(k) && f(id, base)) base.push(k); }); value[id] = base; });
  roleCapsCache = { value, until: Date.now() + 60 * 1000 };
  return value;
}
/** 役割から、画面・APIで使う権限（perms）を作る */
function permsOf(role, caps) {
  const has = k => role === 'admin' || caps.includes(k);
  return {
    media: role === 'admin' ? 'admin' : has('media_view') ? 'viewer' : 'none',
    articles: role === 'admin' ? 'admin' : has('articles_settings') ? 'admin' : has('articles_edit') || caps.includes('articles_own') ? 'editor' : has('articles_view') ? 'viewer' : 'none',
    revenue: role === 'admin' ? 'admin' : has('revenue_view') ? 'viewer' : 'none',
    rewards: has('rewards_view') ? 'viewer' : 'none',
    bulk: has('articles_bulk'), own: role !== 'admin' && caps.includes('articles_own'),
    adminMenus: CAPS.map(c => c[0]).filter(k => k.startsWith('admin_') && has(k)),
  };
}
/** ユーザーの役割を反映する（役割が未設定の人は、これまでの個別の権限のまま） */
async function applyRole(user) {
  if (!user.role) return user;
  const mine = (await activeContracts()).filter(c => c.email && String(c.email).toLowerCase() === String(user.email || '').toLowerCase());
  let role = user.role, scope = user.scope, subScope = null;
  const fromContract = role === 'auto' || ['out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'].includes(role);   /* 業務委託・監修者は、役割を直接選んでいても契約の担当メディアだけ（2026-11-02） */
  if (fromContract) {
    if (role === 'auto') role = mine.map(c => POSITION_ROLE[c.position] || 'out_writer').sort((a, b) => AUTO_RANK.indexOf(a) - AUTO_RANK.indexOf(b))[0] || 'free_writer';
    scope = mine.length ? [...new Set(mine.flatMap(c => c.medias))] : (role === 'free_writer' ? (user.scope || []) : []);
    // 担当ディレクトリ（契約で選んだメディアだけ。選んでいないメディアは全ディレクトリ）（2026-10-14 ユーザー指定）
    if (mine.length) {
      subScope = {};
      mine.forEach(c => c.medias.forEach(m => { const s = (c.subs || {})[m]; if (subScope[m] === null) return; subScope[m] = s && s.length ? [...new Set((subScope[m] || []).concat(s))] : null; }));
    }
  }
  const caps = (await roleCaps())[role] || [];
  /* 「担当者の紐づけ」で自分の契約に紐づけた別名（名字だけの「尾崎」など）も自分の名前として扱う（月次進行管理などに出ないため。2026-11-13） */
  let aliases = []; try { if (typeof personLinks !== 'undefined') aliases = await personLinks.aliasesOfContracts(mine.map(c => c.id)); } catch (e) { console.warn('aliases: ' + e.message); }
  return Object.assign(user, { roleEff: role, caps, perms: permsOf(role, caps), scope, subScope, personNames: [...new Set(mine.map(c => c.name).concat(user.name ? [user.name] : [], aliases))] });
}
const hasAnyPerm = u => !!u.perms && ['media', 'articles', 'revenue', 'rewards'].some(k => u.perms[k] && u.perms[k] !== 'none');
function needMedia(req, res, next) { if (!req.user.perms || req.user.perms.media === 'none') return res.status(403).json({ error: 'メディア数値を見る権限がありません' }); next(); }

async function auth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'ログインしてください' });
  try {
    req.tok = await admin.auth().verifyIdToken(m[1]);
    if ((req.tok.firebase || {}).sign_in_provider !== 'google.com') return res.status(403).json({ error: 'ログインは Googleアカウントだけです。いったんログアウトして「Googleアカウントでログイン」から入ってください' });   // 2026-10-28 ユーザー指定
    req.user = await applyRole(await loadUser(req.tok));
    // UI確認（人ごと）：フル管理者だけ、その人として読み込みだけできる（保存はできない）（2026-10-28 ユーザー指定）
    const pv = String(req.headers['x-preview-uid'] || '');
    if (pv && isFullAdmin(req.user)) {
      if (req.method !== 'GET') return res.status(403).json({ error: 'UI確認中は保存できません（画面の確認だけです）' });
      // 利用中でない人（まだログインしていない追加済みの人＝invite:メール、承認待ちなど）も、登録されている役割で表示する（2026-10-28 ユーザー指定）
      const inv = pv.startsWith('invite:') ? decodeURIComponent(pv.slice(7)) : '';
      let snap = await db.collection(inv ? 'user_invites' : 'users').doc(inv || pv).get(), inUsers = '';
      /* 招待中に選んだあと本人がログインすると、招待は利用中のユーザーに変わる。そのときはメールアドレスで本人を探す（2026-11-06：「UI確認の相手が見つかりません」になっていた） */
      if (!snap.exists && inv) { const q = await db.collection('users').where('email', '==', inv).limit(1).get(); if (!q.empty) { snap = q.docs[0]; inUsers = snap.id; } }
      if (!snap.exists) return res.status(404).json({ error: 'UI確認の相手が見つかりません' });
      const d = snap.data();
      req.realUser = req.user;
      req.user = await applyRole(Object.assign({ uid: inUsers || pv, perms: { media: 'none', revenue: 'none', articles: 'none' }, scope: 'all' }, d, inv ? { email: inv, name: d.name || inv } : {}, { status: 'active' }));
      req.tok = Object.assign({}, req.tok, { uid: inUsers || pv, email: req.user.email, email_verified: true, name: req.user.name });
    }
    next();
  } catch (e) {
    res.status(401).json({ error: 'ログインの有効期限が切れました。もう一度ログインしてください' });
  }
}
function canView(req, res, next) {
  const u = req.user;
  if (req.tok.email_verified !== true) return res.status(403).json({ error: 'メールアドレスの確認が済んでいません。届いたメールのリンクを開いてから、もう一度ログインしてください', status: 'unverified' });
  if (u.status !== 'active') return res.status(403).json({ error: u.status === 'pending' ? '管理者の承認待ちです' : u.status === 'unregistered' ? 'このアカウントは登録されていません' : u.status === 'invited' ? 'メールアドレスの確認が済んでいません' : 'このアカウントは停止されています', status: u.status });
  if (!hasAnyPerm(u)) return res.status(403).json({ error: 'ダッシュボードの権限がありません' });
  next();
}
function isAdmin(req, res, next) {
  if (req.tok.email_verified === true && req.user.perms && req.user.perms.media === 'admin' && req.user.status === 'active') return next();
  const need = (ADMIN_PATH_CAP.find(([re]) => re.test(req.path)) || [])[1];
  if (req.tok.email_verified === true && need && hasAdminCap(req.user, need)) return next();
  res.status(403).json({ error: '管理者だけが使える機能です' });
}
/** 見られるメディアに絞る（scope が 'all' 以外なら、メディア名の配列） */
function allowedMedia(user, media) {
  return user.scope === 'all' || (Array.isArray(user.scope) && user.scope.includes(media));
}
/* BEST社員（役員・正社員・契約社員・アルバイト）は支出情報のサイト制作・修正費・業務委託費・プレスリリース費・ツール利用費を見て入力できる（2026-11-05 ユーザー指定）。
   支出情報の画面からの読み込み（ヘッダー X-Exp: 1）のときだけ、契約・請求を全員分返す */
function isBestStaff(u) { return capOk(u, 'expenses_view', x => ['exec', 'employee', 'contract', 'parttime'].includes(x.roleEff)); }   /* 支出情報（権限管理の expenses_view） */
function expView(req) { return req.headers['x-exp'] === '1' && isBestStaff(req.user); }

// アクセスログ：画面側が X-View ヘッダーで「何を見たか」を送る。同じ画面は1分に1回だけ記録
const lastLogged = new Map();
function accessLog(req, res, next) {
  const view = req.headers['x-view'] ? decodeURIComponent(String(req.headers['x-view'])).slice(0, 200) : '';
  if (view) {
    const key = req.user.uid + '|' + view;
    if (Date.now() - (lastLogged.get(key) || 0) > 60 * 1000) {
      lastLogged.set(key, Date.now());
      db.collection('access_logs').add({
        uid: req.user.uid, email: req.user.email, name: req.user.name, view,
        ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
        at: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }
  next();
}

// ---------- アプリ ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => express.json({ limit: req.path === '/api/expenses/computed' || req.path === '/api/outline/image' ? '2mb' : '100kb' })(req, res, next));   /* 支出の計算値の保存だけ大きめ（2026-11-05） */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// ---------- AI からの抜き取りを防ぐ（2026-10-28 ユーザー指定） ----------
const aiG = require('./ai_guard')({ db, admin, onQueued: () => gmail.flush() });
app.use(aiG.botBlock);   // B：名乗っている AI の収集ロボットは断る
app.use(aiG.noIndex);    // C：検索・AI 学習の対象外
app.get('/robots.txt', aiG.robots);
// A：画面のプログラム（app.js・styles.css・管理画面の index.html）は、ログインの通行証（__session クッキー）がある人だけに配る。
//    通行証は、登録済み・利用中のアカウントでログインしたときに /auth/session で発行（5日）。ないときはログイン画面（login.html）だけ
const SESSION_DAYS = 5, sessionOk = new Map();
const cookieOf = req => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)__session=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
let sessionKey = null;
async function getSessionKey() {
  if (sessionKey) return sessionKey;
  const ref = db.collection('settings').doc('session_key'), d = (await ref.get()).data();
  if (d && d.key) return (sessionKey = d.key);
  const key = require('crypto').randomBytes(48).toString('base64');
  await ref.set({ key, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return (sessionKey = key);
}
const b64u = b => Buffer.from(b).toString('base64url');
async function signSession(uid, email) {
  const body = b64u(JSON.stringify({ uid, email, exp: Date.now() + SESSION_DAYS * 86400 * 1000 }));
  return body + '.' + b64u(require('crypto').createHmac('sha256', await getSessionKey()).update(body).digest());
}
async function hasSession(req) {
  const c = cookieOf(req); if (!c) return false;
  const hit = sessionOk.get(c); if (hit && hit > Date.now()) return true;
  try {
    const [body, sig] = c.split('.'); if (!body || !sig) return false;
    const want = b64u(require('crypto').createHmac('sha256', await getSessionKey()).update(body).digest());
    if (want.length !== sig.length || !require('crypto').timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return false;
    const d = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); if (!(d.exp > Date.now())) return false;
    sessionOk.set(c, Math.min(d.exp, Date.now() + 10 * 60 * 1000)); return true;
  } catch (e) { return false; }
}
app.post('/auth/session', async (req, res) => {
  try {
    const idToken = String((req.body || {}).idToken || '');
    const tok = await admin.auth().verifyIdToken(idToken);
    const user = await applyRole(await loadUser(tok));
    if ((tok.firebase || {}).sign_in_provider !== 'google.com') return res.status(403).json({ error: 'ログインは Googleアカウントだけです。「Googleアカウントでログイン」から入ってください', code: 'google_only' });   // 2026-10-28 ユーザー指定
    if (tok.email_verified !== true) return res.status(403).json({ error: 'メールアドレスの確認が済んでいません。届いたメールのリンクを開いてから、もう一度ログインしてください', code: 'unverified' });
    if (user.status !== 'active' || !hasAnyPerm(user)) return res.status(403).json({ error: user.status === 'pending' ? '管理者の承認待ちです。承認後に、このページを再読み込みしてください' : 'このアカウントは登録されていません。管理者にお問い合わせください', code: user.status || 'unregistered' });
    const cookie = await signSession(tok.uid, tok.email || '');
    res.set('Set-Cookie', '__session=' + encodeURIComponent(cookie) + '; Max-Age=' + SESSION_DAYS * 86400 + '; Path=/; HttpOnly; Secure; SameSite=Lax');
    res.json({ ok: true });
  } catch (e) { res.status(401).json({ error: 'ログインできませんでした。もう一度試してください' }); }
});
app.post('/auth/logout', (req, res) => { res.set('Set-Cookie', '__session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'); res.json({ ok: true }); });

app.get('/api/config', (req, res) => {
  res.json({ firebase: JSON.parse(FIREBASE_WEB_CONFIG) });
});

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({ uid: u.uid, email: u.email, name: u.name, status: u.status, perms: u.perms, scope: u.scope, role: u.role || '', roleEff: u.roleEff || '', caps: u.caps || null, personNames: u.personNames || [], emailVerified: req.tok.email_verified === true });
});

const api = express.Router();
api.use(auth, canView, accessLog, (req, res, next) => { (isFullAdmin(req.user) ? Promise.resolve() : aiG.rateWatch(req, res)).catch(() => {}).finally(next); });   // 大量の読み込みの検知は管理者を対象外（自分の画面の読み込みで出ていたため。2026-10-30 ユーザー指定）

/** ブックマーク：ユーザーごとに、画面とプルダウンなどの表示設定を最大5つ（users/{uid}.bookmarks）（2026-10-28 ユーザー指定） */
api.get('/bookmarks', async (req, res, next) => {
  try { const d = await db.collection('users').doc(req.user.uid).get(); res.json({ bookmarks: (d.exists && d.data().bookmarks) || [] }); } catch (e) { next(e); }
});
api.put('/bookmarks', async (req, res, next) => {
  try {
    const list = Array.isArray((req.body || {}).bookmarks) ? req.body.bookmarks : null;
    if (!list) return res.status(400).json({ error: 'ブックマークが正しくありません' });
    if (list.length > 5) return res.status(400).json({ error: 'ブックマークは5つまでです' });
    const clean = list.map(b => ({ name: String((b || {}).name || '').trim().slice(0, 30) || 'ブックマーク', state: (b || {}).state && typeof b.state === 'object' ? b.state : {} }));
    if (JSON.stringify(clean).length > 40000) return res.status(400).json({ error: '表示設定が大きすぎて保存できません' });
    await db.collection('users').doc(req.user.uid).set({ bookmarks: clean }, { merge: true });
    res.json({ bookmarks: clean });
  } catch (e) { next(e); }
});

/** メディア一覧・データの期間・最終収集 */
api.get('/meta', async (req, res, next) => {
  try {
    const meta = await cached('meta', TEN_MIN, async () => {
      const rows = await query(`SELECT media, block, MIN(date) first_day, MAX(date) last_day FROM ${T('ga4_daily')} WHERE channel = '(all)' GROUP BY media, block`);
      const sc = await query(`SELECT media, MIN(date) first_day, MAX(date) last_day FROM ${T('sc_daily')} GROUP BY media`);
      const job = await query(`SELECT FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MAX(run_at), 'Asia/Tokyo') last_run,
        COUNTIF(status = 'ERROR' AND run_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)) errors_24h,
        /* GA4・Search Console のジョブだけ（API・連携設定の「Google」の枠用。2026-10-13 ユーザー指定） */
        FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', MAX(IF(REGEXP_CONTAINS(job, r'GA4|SC'), run_at, NULL)), 'Asia/Tokyo') ga_last_run,
        COUNTIF(REGEXP_CONTAINS(job, r'GA4|SC') AND status = 'ERROR' AND run_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)) ga_errors_24h FROM ${T('job_log')}`);
      return { rows, sc, job: job[0] };
    });
    const scMap = Object.fromEntries(meta.sc.map(r => [r.media, { first: dateStr(r.first_day), last: dateStr(r.last_day) }]));
    const list = [];
    MEDIA_ORDER.forEach(([media, name]) => {
      if (!allowedMedia(req.user, media)) return;
      const top = meta.rows.find(r => r.media === media && !r.block);
      if (!top && !scMap[media]) return;
      list.push({ id: mediaId(media, ''), media, block: '', name, ga4From: top ? dateStr(top.first_day) : null, ga4To: top ? dateStr(top.last_day) : null, sc: scMap[media] || null });
      BLOCK_ORDER.forEach(block => {
        const r = meta.rows.find(x => x.media === media && x.block === block);
        if (r) list.push({ id: mediaId(media, block), media, block, name: block, parent: media, group: !!BLOCK_GROUPS[block], ga4From: dateStr(r.first_day), ga4To: dateStr(r.last_day) });
      });
    });
    res.json({ media: list, lastRun: meta.job.last_run, errors24h: meta.job.errors_24h, gaLastRun: meta.job.ga_last_run, gaErrors24h: meta.job.ga_errors_24h });
  } catch (e) { next(e); }
});

// ---------- kintone（SEO回線）を月次・日次・エリアに重ねる ----------
const mediaOfLine = line => (MEDIA_ORDER.find(([, name]) => String(line || '').startsWith(name)) || [])[0] || '';
// 害虫害獣コンシェルジュの回線名「害虫害獣コンシェルジュ(シロアリ)回線」などはディレクトリにも入れる
const blockOfLine = (media, line) => { if (media !== '害虫害獣コンシェルジュ') return ''; const m = String(line || '').match(/\((.+?)\)/); return (m && BLOCK_ORDER.find(b => !BLOCK_GROUPS[b] && m[1].startsWith(b))) || ''; };
const groupOfBlock = block => (Object.entries(BLOCK_GROUPS).find(([, kids]) => kids.includes(block)) || [])[0] || '';
async function kinRows() {
  return cached('kin-seo', TEN_MIN, async () => {
    try {
      const st = await kin.getSettings(), map = st.mediaMap || {};
      const { rows } = await kin.seoRows();
      return rows.map(r => { const media = map[r.line_name] || mediaOfLine(r.line_name); return Object.assign({}, r, { media, block: blockOfLine(media, r.line_name) }); }).filter(r => r.media);
    } catch (e) { console.warn('kintone集計: ' + e.message); return []; }
  });
}
/** kintone の1行を、メディア・ディレクトリ・グループの id ごとに足す */
function addKin(r, slotOf) {
  const ids = [mediaId(r.media, '')];
  if (r.block) { ids.push(mediaId(r.media, r.block)); const g = groupOfBlock(r.block); if (g) ids.push(mediaId(r.media, g)); }
  ids.forEach(id => { const o = slotOf(id); o.kCalls = (o.kCalls || 0) + Number(r.calls || 0); o.visits = (o.visits || 0) + Number(r.visits || 0); o.contracts = (o.contracts || 0) + Number(r.contracts || 0); o.revPartner = (o.revPartner || 0) + Number(r.revenue || 0); });
}
// kintone（SEO回線）の値を使うのはこの月から。それより前はスプレッドシートの値を使う
// （2026-10-26：回線種別が空欄の「(SEO)」回線も取り込んだら、2024/01 以降のコール・訪問確定・成約・収益がスプレッドシートとほぼ一致。kintone は 2023/01 からある）
const KINTONE_FROM = '2023-01';
const KIN_SHEET_KEY = { k_calls: 'kCalls', k_visits: 'visits', k_contracts: 'contracts', rev_partner: 'revPartner' };
const nextYm = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };

/** 月次：全メディア×全月（GA4は月単位の表、Search Consoleは日別を合計） */
/** 月次の数値（メディア・ディレクトリ × 月）。user の見られるメディアだけ（2026-11-06：担当メディア数値進捗でも使うため関数にした） */
async function buildMonthly(user) {
    const data = await cached('monthly', TEN_MIN, async () => {
      const ga4 = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, block, channel, pageviews, sessions, total_users, active_users, new_users, engagement_sec, key_events
        FROM ${T('ga4_monthly')}`);
      const sc = await query(`SELECT FORMAT_DATE('%Y-%m', date) ym, media, IFNULL(block, '') block, SUM(impressions) imp, SUM(clicks) clicks, SUM(position * impressions) pos_w
        FROM ${T('sc_daily')} GROUP BY ym, media, block`);
      // 月単位の表がまだない月は、日別の合計で代用する（ユーザー数は重複を含むので approx を付ける）
      const daily = await query(`SELECT FORMAT_DATE('%Y-%m', d.date) ym, d.media, d.block, d.channel,
          SUM(d.pageviews) pageviews, SUM(d.sessions) sessions, SUM(d.total_users) total_users, SUM(d.active_users) active_users,
          SUM(d.new_users) new_users, SUM(d.engagement_sec) engagement_sec, SUM(d.key_events) key_events
        FROM ${T('ga4_daily')} d
        LEFT JOIN (SELECT DISTINCT FORMAT_DATE('%Y-%m', month) ym, media, block FROM ${T('ga4_monthly')}) m
          ON m.ym = FORMAT_DATE('%Y-%m', d.date) AND m.media = d.media AND m.block = d.block
        WHERE m.ym IS NULL
        GROUP BY ym, media, block, channel`);
      // スプレッドシートの月次値（WordPress・kintone・アフィリエイト・支出）。表がまだなければ空
      let sheet = [];
      try {
        sheet = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, block, item, SUM(value) value FROM ${T('sheet_monthly')} GROUP BY ym, media, block, item`);
      } catch (e) { console.warn('sheet_monthly: ' + e.message); }
      let wpm = [];
      try { wpm = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, posts_total, posts_new, rewrites FROM ${T('wp_monthly')} QUALIFY ROW_NUMBER() OVER (PARTITION BY media, month ORDER BY collected_at DESC) = 1`); } catch (e) { /* まだ表がない */ }
      return { ga4: ga4.concat(daily.map(r => Object.assign(r, { approx: true }))), sc, sheet, wpm };
    });
    const out = {};
    const slot = (id, ym) => ((out[id] = out[id] || {})[ym] = out[id][ym] || { ch: {} });
    const cc = await ecMod.rows().catch(e => { console.warn('expense computed: ' + e.message); return null; });
    data.ga4.forEach(r => {
      if (r.approx && r.channel === '(all)' && allowedMedia(user, r.media)) slot(mediaId(r.media, r.block), r.ym).approx = true;
      if (!allowedMedia(user, r.media)) return;
      const s = slot(mediaId(r.media, r.block), r.ym);
      if (r.channel === '(all)') Object.assign(s, { pv: r.pageviews, sessions: r.sessions, users: r.total_users, active: r.active_users, newUsers: r.new_users, engSec: r.engagement_sec, keyEvents: r.key_events });
      else s.ch[r.channel] = { pv: r.pageviews, sessions: r.sessions };
    });
    data.sc.forEach(r => {
      if (!allowedMedia(user, r.media)) return;
      Object.assign(slot(mediaId(r.media, r.block), r.ym), { imp: Number(r.imp), clicks: Number(r.clicks), posW: Number(r.pos_w) });
    });
    const SHEET_KEY = { posts_new: 'posts', rewrites: 'rewrites', posts_total: 'postsTotal', k_calls: 'kCalls', k_visits: 'visits', k_contracts: 'contracts', rev_partner: 'revPartner', rev_affiliate: 'revAffiliate' };
    data.sheet.forEach(r => {
      if (!allowedMedia(user, r.media)) return;
      const s = slot(mediaId(r.media, r.block), r.ym), v = r.item === 'rev_affiliate' ? affExTax(r.value) : Number(r.value);
      if (r.item === 'cost_other') return;   // 「その他」は支出に入れない（2026-10-14 ユーザー指定）
      if (cc && ecMod.DROP.includes(r.item)) return;   /* 支出の計算値があるときはシートの業務委託費・サイト制作費・プレスリリース費は使わない（2026-11-05 ユーザー指定） */
      if ((r.item === 'cost_article' || r.item === 'cost_direction') && r.ym >= invoiceMod.INVOICE_START) return;   // 11月分からの業務委託費は請求書の金額（2026-10-29 ユーザー指定）
      if (r.item === 'cost_press' && r.ym >= pressMod.PRESS_FROM) return;   // プレスリリース費はプレスリリースのシートから（2026-10-31 ユーザー指定）
      if (r.item.indexOf('cost_') === 0) { s.cost = (s.cost || 0) + v; s.costs = s.costs || {}; s.costs[r.item] = (s.costs[r.item] || 0) + v; }
      else if (SHEET_KEY[r.item]) s[SHEET_KEY[r.item]] = v;
    });
    // アフィリエイト：もしものCSVを取り込んだ月・メディアはCSVの承認成果金額（税抜き）を優先（2026-10-14 ユーザー指定）
    try { (await msm.affiliateRevenue()).forEach(r => { if (allowedMedia(user, r.media)) slot(mediaId(r.media, ''), r.ym).revAffiliate = r.value; }); } catch (e) { console.warn('moshimo: ' + e.message); }
    // 業務委託費：11月分からは請求担当が確認した請求書の金額（2026-10-29 ユーザー指定）
    if (!cc) try { (await invoiceMod.costRows()).forEach(r => { if (!allowedMedia(user, r.media)) return; const s = slot(mediaId(r.media, ''), r.ym); s.cost = (s.cost || 0) + r.value; s.costs = s.costs || {}; s.costs.cost_article = (s.costs.cost_article || 0) + r.value; }); } catch (e) { console.warn('invoice cost: ' + e.message); }
    // 取り込んで確定した請求書（単発発注など）の支出（2026-10-29 ユーザー指定）
    try { (await expenseMod.rows()).concat(await subRows()).forEach(r => { if (!allowedMedia(user, r.media) || (cc && ecMod.DROP.includes(r.item))) return; const s = slot(mediaId(r.media, ''), r.ym); s.cost = (s.cost || 0) + r.value; s.costs = s.costs || {}; s.costs[r.item] = (s.costs[r.item] || 0) + r.value; }); } catch (e) { console.warn('expense: ' + e.message); }
    if (cc) cc.forEach(r => { if (!allowedMedia(user, r.media)) return; const id = mediaId(r.media, r.block); if (r.block && !out[id]) return; const s = slot(id, r.ym); s.cost = (s.cost || 0) + r.value; s.costs = s.costs || {}; s.costs[r.item] = (s.costs[r.item] || 0) + r.value; });   /* 支出の計算値（業務委託費・サイト制作費・プレスリリース費） */
    // BEST人件費（正社員の給料。管理者の画面だけ。給料が推測されないように）（2026-10-14 ユーザー指定）
    if (isFullAdmin(user)) { try { (await staffMod.staffCosts()).forEach(r => { const s = slot(mediaId(r.media, ''), r.ym); s.cost = (s.cost || 0) + r.value; s.costs = s.costs || {}; s.costs.cost_staff = (s.costs.cost_staff || 0) + r.value; }); } catch (e) { console.warn('staff: ' + e.message); } }
    data.wpm.forEach(r => {   // WordPress連携済みのメディアは API の値で上書き
      if (!allowedMedia(user, r.media)) return;
      Object.assign(slot(mediaId(r.media, ''), r.ym), { postsTotal: Number(r.posts_total), posts: Number(r.posts_new), rewrites: Number(r.rewrites), wpApi: true });
    });
    // 新規・リライト・簡易リライト：進行管理の本数にする（WordPressの値は照合用）
    try { applyArtCounts(out, await articleCounts(), user, p => p.length === 7); } catch (e) { console.warn('articleCounts: ' + e.message); }
    // kintone（SEO回線）があるメディア・月は、コール数・訪問確定・成約・加盟店収益を kintone の値にする（スプレッドシートの値は使わない）
    const kr = (await kinRows()).filter(r => allowedMedia(user, r.media) && r.date && r.date.slice(0, 7) >= KINTONE_FROM);
    if (kr.length) {
      const kMedia = new Set(kr.map(r => r.media));
      Object.entries(out).forEach(([id, byYm]) => { if (!kMedia.has(id.split('|')[0])) return; Object.entries(byYm).forEach(([ym, o]) => { if (ym >= KINTONE_FROM) { delete o.kCalls; delete o.visits; delete o.contracts; delete o.revPartner; } }); });
      kr.forEach(r => addKin(r, id => slot(id, r.date.slice(0, 7))));
    }
    if (user.roleEff === 'resta') Object.values(out).forEach(byK => Object.values(byK).forEach(o => { ['revPartner', 'revAffiliate', 'cost', 'costs'].forEach(k => { delete o[k]; }); }));   // REsta社員には収益と支出を返さない（2026-10-30 ユーザー指定）
    rollupGroups(out);   /* 害虫・害獣（まとめのディレクトリ）に、下のディレクトリの記事数・支出・kintone などを合計して入れる（2026-11-06 ユーザー指摘：害虫・害獣で単価が出ない） */
    return out;
}
api.get('/monthly', needMedia, async (req, res, next) => { try { res.json(await buildMonthly(req.user)); } catch (e) { next(e); } });
/* シミュレーションの参考メディアの率（2026-11-06 ユーザー指摘：種石さんの画面でシロアリお助け本舗が「10年以内に届かない」。
   シロアリ・ハチは CV のあとの率（CV→コール・成約率・成約1件の収益）を害獣お助け本舗から借りるが、害獣お助け本舗を見られない人は借りられず収益がほぼ0になっていた）。
   参考に使うメディアだけ、直近12か月の「率」だけを返す（件数・金額の合計は返さない）。計算は画面の simInputsRaw と同じ */
const SIM_REF_MEDIA = ['害獣お助け', 'シロアリお助け', 'ハチお助け'];
api.get('/sim/ref-rates', needMedia, async (req, res, next) => {
  try {
    if (req.user.roleEff === 'resta' || !capOk(req.user, 'sim_view', x => x.roleEff !== 'resta')) return res.json({});
    const full = await buildMonthly(Object.assign({}, req.user, { status: 'active', scope: 'all', subScope: null, perms: Object.assign({}, req.user.perms, { media: 'admin' }) }));   /* 参考メディアは担当外でも率を出すので、担当の絞り込みを外す */
    const cur = todayJst().slice(0, 7), last12 = Array.from({ length: 12 }, (_, i) => { const [y, m] = cur.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + i - 12, 1)); return d.toISOString().slice(0, 7); });
    const pct = (a, p) => { if (!a.length) return null; const x = a.slice().sort((u, v) => u - v), i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
    const out = {};
    SIM_REF_MEDIA.forEach(mk => {
      const h = full[mk]; if (!h) return;
      const num = (r, k) => r && r[k] != null ? Number(r[k]) : null, sum = k => last12.reduce((a, ym) => a + (num(h[ym], k) || 0), 0), tot = (n, d) => { const D = sum(d); return D > 0 ? sum(n) / D : 0; };
      const monthly = (n, d) => last12.map(ym => { const a = num(h[ym], n), b = num(h[ym], d); return a != null && b > 0 ? a / b : null; }).filter(v => v != null && isFinite(v));
      const cvrs = monthly('keyEvents', 'sessions'), crs = monthly('contracts', 'kCalls'), cvr = tot('keyEvents', 'sessions'), cr = tot('contracts', 'kCalls');
      out[mk] = { cvr: { real: cvr, ideal: pct(cvrs, .75) ?? cvr, pess: pct(cvrs, .25) ?? cvr }, rCall: tot('kCalls', 'keyEvents'), cr: { real: cr, ideal: pct(crs, .75) ?? cr, pess: pct(crs, .25) ?? cr }, revPerContract: tot('revPartner', 'contracts'), affPerPv: tot('revAffiliate', 'pv') };
    });
    res.json(out);
  } catch (e) { next(e); }
});
/* シミュレーションの支出（予測）には BEST人件費を含める（2026-11-06 ユーザー指定：「人件費含めないと意味ない」）。
   フル管理者以外にも、シミュレーションを見られる人（sim_view）には、メディアごと・月ごとの人件費の合計だけを返す（社員ごとの内訳は出さない・千円単位に丸める）。フル管理者は月次データに入っているので空 */
api.get('/sim/staff-costs', needMedia, async (req, res, next) => {
  try {
    if (isFullAdmin(req.user) || req.user.roleEff === 'resta' || !capOk(req.user, 'sim_view', x => x.roleEff !== 'resta')) return res.json({});
    const out = {};
    (await staffMod.staffCosts()).forEach(r => { if (!allowedMedia(req.user, r.media)) return; const id = mediaId(r.media, ''); out[id] = out[id] || {}; out[id][r.ym] = (out[id][r.ym] || 0) + Number(r.value || 0); });
    Object.values(out).forEach(byYm => Object.keys(byYm).forEach(m => { byYm[m] = Math.round(byYm[m] / 1000) * 1000; }));
    res.json(out);
  } catch (e) { next(e); }
});
/* シミュレーションの「達成済み」（単月で黒字・累計で収益が上回る）は、BEST人件費を含めた支出で判定する（2026-11-06 ユーザー指摘：菅原さんの画面で水まわりの単月が「達成済み」。
   人件費を見られない人は支出が少なく見え、黒字と判定されていた）。人件費が推測されないよう、返すのは「達成した月」だけで金額は返さない。判定は画面の simAchieved と同じ */
api.get('/sim/achieved', needMedia, async (req, res, next) => {
  try {
    if (req.user.roleEff === 'resta') return res.json({});
    const full = await buildMonthly(Object.assign({}, req.user, { status: 'active', perms: Object.assign({}, req.user.perms, { media: 'admin' }) }));
    const today = todayJst(), cur = today.slice(0, 7), next5 = m => { const [y, mo] = m.split('-').map(Number), d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7) + '-05'; };
    const judge = byYm => {
      const ms = Object.keys(byYm || {}).sort().filter(m => m < cur && today >= next5(m)).filter(m => { const o = byYm[m]; return (o.revPartner != null || o.revAffiliate != null) && o.cost != null; });
      const pf = m => (Number(byYm[m].revPartner) || 0) + (Number(byYm[m].revAffiliate) || 0) - (Number(byYm[m].cost) || 0);
      let mon = null; for (let i = ms.length - 1; i >= 0 && pf(ms[i]) >= 0; i--) mon = ms[i];
      let cum = 0, cumYm = null; ms.forEach(m => { cum += pf(m); if (cum < 0) cumYm = null; else if (cumYm == null) cumYm = m; });
      return { mon, cum: ms.length && cum >= 0 ? cumYm : null };
    };
    const out = {}, ids = Object.keys(full).filter(id => allowedMedia(req.user, id.split('|')[0]));
    ids.forEach(id => { out[id] = judge(full[id]); });
    const all = {}; ids.filter(id => !id.includes('|')).forEach(id => Object.entries(full[id]).forEach(([m, o]) => { const a = all[m] = all[m] || {}; ['revPartner', 'revAffiliate', 'cost'].forEach(k => { if (o[k] != null) a[k] = (a[k] || 0) + Number(o[k]); }); }));
    out.__all__ = judge(all);
    res.json(out);
  } catch (e) { next(e); }
});
/* 担当メディア数値進捗：メディア数値の権限がない社員にも、その半期の担当メディアの分だけ実績を返す（2026-11-06 ユーザー指定） */
api.get('/monthly/mine/:start', async (req, res, next) => {
  try {
    if (!capOk(req.user, 'goals_view', x => !['finance', 'resta'].includes(x.roleEff))) return res.status(403).json({ error: '見る権限がありません' });
    const medias = await staffMod.halfMedias(req.user.email, String(req.params.start || ''));
    res.json(await buildMonthly(Object.assign({}, req.user, { scope: medias })));
  } catch (e) { next(e); }
});
/* 担当メディア数値進捗の目標：その半期の担当メディアのシミュレーション結果（理想）（2026-11-06 ユーザー指定） */
api.get('/sim/predictions/mine/:start', async (req, res, next) => {
  try {
    if (!capOk(req.user, 'goals_view', x => !['finance', 'resta'].includes(x.roleEff))) return res.status(403).json({ error: '見る権限がありません' });
    const medias = await staffMod.halfMedias(req.user.email, String(req.params.start || ''));
    let rows = []; try { rows = await query(`SELECT snapshot_ym, media, scenario, ym, metric, value FROM ${T('sim_predictions')} WHERE scenario = 'ideal' QUALIFY ROW_NUMBER() OVER (PARTITION BY snapshot_ym, media, scenario, ym, metric ORDER BY saved_at DESC) = 1`); } catch (e) { /* まだない */ }
    res.json({ rows: rows.filter(r => medias.includes(r.media)) });
  } catch (e) { next(e); }
});

// ---------- 進行管理の本数（アップロード日で数える） ----------
/** 制作判断 → 新規・リライト・簡易リライト（空欄は新規。保留は数えない） */
function artKind(type, media, sub) {
  const z = String(type || '').trim().replace(/[％]/g, '%').replace(/[〜~]/g, '～');
  if (z === '保留') return null;
  if (/^簡易リライト/.test(z) || /^リライト[（(]30%～50%[）)]/.test(z)) return 'lite';
  if (/^リライト/.test(z) || z === '既存記事差し替え') return 'rewrite';
  if (!z && media === 'ガラスお助け' && sub === '過去記事②') return 'rewrite';
  return 'new';
}
/** メディア|ディレクトリ|月（または日）ごとの本数と、そのメディアの最初の月 */
async function articleCounts() {
  return cached('art-counts', TEN_MIN, async () => {
    const rows = await query("SELECT media, IFNULL(sub, '') sub, `no`, row_no, kw, type, status, CAST(upload_date AS STRING) upload_date FROM " + T('article_items')).catch(() => []);
    const ex = await articleExtras();
    const ov = Object.fromEntries(ex.overrides.map(o => [o.key, o]));
    const items = dropDupSheetRows(rows.map(r => { const o = Object.assign({}, r), x = ov[keyOfItem(r)]; if (x) Object.keys(x).filter(k => k.startsWith('f_')).forEach(k => { o[k.slice(2)] = x[k]; }); return o; }), ex.entries, () => true)   /* 進行管理で追加した記事と同じシートの行は数えない */
      .concat(ex.entries.map(e => ({ media: e.media, sub: e.sub || '', type: e.type, status: e.status, upload_date: e.upload_date, deleted: e.deleted })));
    const byKey = {}, first = {};
    items.forEach(o => {
      const d = String(o.upload_date || '').slice(0, 10);
      if (o.deleted || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayJst() || /移管/.test(o.status || '')) return;   // 先の日付（予定）は数えない
      const kind = artKind(o.type, o.media, o.sub); if (!kind) return;
      const ym = d.slice(0, 7);
      // ディレクトリごとの本数も（メディア|ディレクトリ。制作状況でディレクトリを選んだとき用）（2026-10-28 ユーザー指定）
      const blocks = [''].concat(o.media === '害虫害獣コンシェルジュ' && BLOCK_ORDER.includes(o.sub) ? [o.sub] : o.sub ? [o.sub] : []);
      blocks.forEach(b => [ym, d].forEach(p => { const k = o.media + '|' + b + '|' + p, c = byKey[k] = byKey[k] || { new: 0, rewrite: 0, lite: 0 }; c[kind]++; }));
      if (!first[o.media] || ym < first[o.media]) first[o.media] = ym;
    });
    return { byKey, first };
  });
}
/** 枠（月または日）に進行管理の本数を入れる。WordPressの値は wpPosts・wpRewrites に残す */
function setArt(o, c) {
  if (o.artSrc) return;
  o.wpPosts = o.posts != null ? o.posts : null; o.wpRewrites = o.rewrites != null ? o.rewrites : null;
  o.posts = c.new; o.rewrites = c.rewrite; o.lite = c.lite;
  o.tweak = o.wpRewrites == null ? null : Math.max(0, o.wpRewrites - c.rewrite - c.lite);
  o.artSrc = true;
}
/** out（id → 月または日 → 値）に進行管理の本数を反映する。進行管理に記事があるメディアの、最初の月以降だけ */
function applyArtCounts(out, ac, user, inRange) {
  const zero = { new: 0, rewrite: 0, lite: 0 };
  Object.entries(out).forEach(([id, byP]) => {
    const [media, block = ''] = id.split('|');
    if (!ac.first[media] || !allowedMedia(user, media)) return;
    Object.entries(byP).forEach(([p, o]) => { if (p.slice(0, 7) >= ac.first[media] && inRange(p)) setArt(o, ac.byKey[media + '|' + block + '|' + p] || zero); });
  });
  Object.entries(ac.byKey).forEach(([k, c]) => {
    const [media, block, p] = k.split('|');
    if (!allowedMedia(user, media) || !inRange(p)) return;
    const id = mediaId(media, block), o = ((out[id] = out[id] || {})[p] = out[id][p] || (p.length === 7 ? { ch: {} } : {}));
    setArt(o, c);
  });
}

/** 進行管理で「完了」の記事の検索KW（メディアごと）。Ahrefs の Rank Tracker に入れる */
const BLANK_DONE_DOCS = { '水まわりお助け': { '洗面台': ['outline_url', 'writing_url'] }, 'ガラスお助け': { '進行中': ['outline_url', 'writing_url'] } };
const STOPPED_SUBS_SRV = { 'BEST365': ['外壁屋根', '電気設備'] };
async function doneKeywords() {
  const rows = await query("SELECT media, IFNULL(sub, '') sub, `no`, row_no, kw, status, url, outline_url, writing_url FROM " + T('article_items')).catch(() => []);
  const ex = await articleExtras();
  const ov = Object.fromEntries(ex.overrides.map(o => [o.key, o]));
  const items = rows.map(r => { const o = Object.assign({}, r), x = ov[keyOfItem(r)]; if (x) Object.keys(x).filter(k => k.startsWith('f_')).forEach(k => { o[k.slice(2)] = x[k]; }); return o; })
    .concat(ex.entries.map(e => Object.assign({ sub: e.sub || '' }, e)));
  const has = (o, k) => !!String(o[k] || '').trim();
  const done = o => { const st = String(o.status || '').trim(); if (st) return st === '完了' || st === '最終化'; return has(o, 'url') && ((BLANK_DONE_DOCS[o.media] || {})[o.sub] || []).every(k => has(o, k)); };
  const out = {};
  items.forEach(o => { if (o.deleted || !has(o, 'kw') || (STOPPED_SUBS_SRV[o.media] || []).includes(o.sub) || !done(o)) return; (out[o.media] = out[o.media] || []).push({ kw: o.kw, sub: o.sub, url: o.url || null }); });
  return out;
}

/** KW追従用：メディアのKWごとの記事（新規の公開記事を優先）・最新のアクション（アップロード日）・リライト候補 */
const looseKwSrv = s => String(s || '').normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, '').toLowerCase();
async function kwArticles(media) {
  const rows = await query("SELECT media, IFNULL(sub, '') sub, `no`, row_no, kw, type, status, url, post_id, CAST(upload_date AS STRING) upload_date FROM " + T('article_items') + " WHERE media = @m", { m: media }).catch(() => []);
  const ex = await articleExtras();
  const ov = Object.fromEntries(ex.overrides.map(o => [o.key, o]));
  const items = rows.map(r => { const o = Object.assign({}, r), x = ov[keyOfItem(r)]; if (x) Object.keys(x).filter(k => k.startsWith('f_')).forEach(k => { o[k.slice(2)] = x[k]; }); return o; })
    .concat(ex.entries.filter(e => e.media === media).map(e => Object.assign({ sub: e.sub || '' }, e)));
  const t = await wp.titlesFor(media).catch(() => null);
  const norm = u => String(u || '').replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const today = todayJst(), byKw = {};
  items.forEach(o => {
    if (o.deleted || !String(o.kw || '').trim()) return;
    const k = looseKwSrv(o.kw), b = byKw[k] = byKw[k] || { kw: k, url: null, title: null, action: null, candidate: null, subs: [] };
    if (o.sub && !b.subs.includes(o.sub)) b.subs.push(o.sub);   // ディレクトリ（KW追従の絞り込み用）
    const kind = artKind(o.type, o.media, o.sub), url = String(o.url || '').trim(), d = String(o.upload_date || '').slice(0, 10);
    if (url && (!b.url || kind === 'new')) { b.url = url; b.title = t ? (t.byId[String(o.post_id || '').trim()] || t.byUrl[norm(url)] || null) : null; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today && kind && (!b.action || d > b.action.date)) b.action = { kind, date: d };
    if ((kind === 'rewrite' || kind === 'lite') && !/^\d{4}-\d{2}-\d{2}$/.test(d) && !/^(完了|最終化)$/.test(String(o.status || '').trim())) b.candidate = kind;   // これからリライトする予定
  });
  return Object.values(byKw);
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** 日次：期間内の全メディア（最大400日） */
api.get('/daily', needMedia, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: '期間（from / to）を YYYY-MM-DD で指定してください' });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 400) return res.status(400).json({ error: '日次は400日以内で指定してください' });
    const data = await cached('daily|' + from + '|' + to, TEN_MIN, async () => {
      const ga4 = await query(`SELECT CAST(date AS STRING) d, media, block, pageviews, sessions, total_users, active_users, new_users, engagement_sec, key_events
        FROM ${T('ga4_daily')} WHERE channel = '(all)' AND date BETWEEN @from AND @to`, { from, to });
      const sc = await query(`SELECT CAST(date AS STRING) d, media, IFNULL(block, '') block, impressions, clicks, position FROM ${T('sc_daily')} WHERE date BETWEEN @from AND @to`, { from, to });
      return { ga4, sc };
    });
    const out = {};
    const slot = (id, d) => ((out[id] = out[id] || {})[d] = out[id][d] || {});
    data.ga4.forEach(r => {
      if (!allowedMedia(req.user, r.media)) return;
      Object.assign(slot(mediaId(r.media, r.block), r.d), { pv: r.pageviews, sessions: r.sessions, users: r.total_users, active: r.active_users, newUsers: r.new_users, engSec: r.engagement_sec, keyEvents: r.key_events });
    });
    data.sc.forEach(r => {
      if (!allowedMedia(req.user, r.media)) return;
      Object.assign(slot(mediaId(r.media, r.block), r.d), { imp: r.impressions, clicks: r.clicks, posW: r.position * r.impressions });
    });
    const kAll = (await kinRows()).filter(r => r.date && r.date.slice(0, 7) >= KINTONE_FROM), kMedia = new Set(kAll.map(r => r.media));
    kAll.filter(r => allowedMedia(req.user, r.media) && r.date >= from && r.date <= to).forEach(r => addKin(r, id => slot(id, r.date)));
    const months = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7) && months.length < 14; m = nextYm(m)) months.push(m);
    // WordPress：日別の新規公開・リライト（公開記事の一覧から数える）
    for (const ym of months) {
      let list = []; try { list = await wp.listAll(ym); } catch (e) { console.warn('listAll ' + ym + ': ' + e.message); }
      list.forEach(p => { if (p.date < from || p.date > to || !allowedMedia(req.user, p.media)) return; const o = slot(mediaId(p.media, ''), p.date); if (p.kind === 'new') o.posts = (o.posts || 0) + 1; else o.rewrites = (o.rewrites || 0) + 1; });
    }
    // 新規・リライト・簡易リライト：進行管理の本数（日別）
    try { applyArtCounts(out, await articleCounts(), req.user, p => p.length === 10 && p >= from && p <= to); } catch (e) { console.warn('articleCounts: ' + e.message); }
    // 支出・アフィリエイトは月の値を日割りにする（期間比較で合計できるように）
    // kintone を使う前の月（KINTONE_FROM より前）と kintone がないメディアは、スプレッドシートのコール数・訪問確定・成約・加盟店収益も日割りにする
    const sheetM = await cached('sheet-daily', TEN_MIN, () => query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, block, item, SUM(value) value FROM ${T('sheet_monthly')} WHERE (STARTS_WITH(item, 'cost_') AND item != 'cost_other') OR item IN ('rev_affiliate', 'k_calls', 'k_visits', 'k_contracts', 'rev_partner') GROUP BY ym, media, block, item`).catch(() => []));
    // もしものCSVを取り込んだ月・メディアは、シートのアフィリエイトの代わりにCSVの値を日割りにする
    let msmRows = []; try { msmRows = await msm.affiliateRevenue(); } catch (e) { console.warn('moshimo: ' + e.message); }
    const msmKeys = new Set(msmRows.map(r => r.media + '|' + r.ym));
    let staffRows = []; if (isFullAdmin(req.user)) { try { staffRows = (await staffMod.staffCosts()).map(r => ({ ym: r.ym, media: r.media, block: '', item: 'cost_staff', value: r.value })); } catch (e) { console.warn('staff: ' + e.message); } }   // BEST人件費は管理者の画面だけ
    const cc = await ecMod.rows().catch(() => null);
    let expRows = []; try { expRows = (await expenseMod.rows()).concat(cc ? [] : await invoiceMod.costRows(), await subRows()); if (cc) expRows = expRows.filter(r => !ecMod.DROP.includes(r.item)).concat(cc.filter(r => !r.block || out[mediaId(r.media, r.block)])); } catch (e) { console.warn('expense: ' + e.message); }   // 取り込んで確定した請求書と、11月分からの業務委託費
    sheetM.filter(r => !(cc && ecMod.DROP.includes(r.item)) && !((r.item === 'cost_article' || r.item === 'cost_direction') && r.ym >= invoiceMod.INVOICE_START) && !(r.item === 'cost_press' && r.ym >= pressMod.PRESS_FROM)).concat(msmRows.map(r => ({ ym: r.ym, media: r.media, block: '', item: 'rev_affiliate', value: r.value, csv: true })), staffRows, expRows).forEach(r => {
      if (!months.includes(r.ym) || !allowedMedia(req.user, r.media)) return;
      if (r.item === 'rev_affiliate' && !r.block && !r.csv && msmKeys.has(r.media + '|' + r.ym)) return;
      const kk = KIN_SHEET_KEY[r.item];
      if (kk && r.ym >= KINTONE_FROM && kMedia.has(r.media)) return;   // kintone の値がある月・メディア
      const [y, m] = r.ym.split('-').map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), v = (r.item === 'rev_affiliate' && !r.csv ? affExTax(r.value) : Number(r.value)) / dim;
      for (let d = 1; d <= dim; d++) {
        const ds = r.ym + '-' + String(d).padStart(2, '0');
        if (ds < from || ds > to) continue;
        const o = slot(mediaId(r.media, r.block), ds);
        if (kk) o[kk] = (o[kk] || 0) + v;
        else if (r.item === 'rev_affiliate') o.revAffiliate = (o.revAffiliate || 0) + v; else { o.cost = (o.cost || 0) + v; o.costs = o.costs || {}; o.costs[r.item] = (o.costs[r.item] || 0) + v; }
      }
    });
    if (req.user.roleEff === 'resta') Object.values(out).forEach(byK => Object.values(byK).forEach(o => { ['revPartner', 'revAffiliate', 'cost', 'costs'].forEach(k => { delete o[k]; }); }));   // REsta社員には収益と支出を返さない（2026-10-30 ユーザー指定）
    rollupGroups(out);   /* 害虫・害獣（まとめのディレクトリ）に、下のディレクトリの記事数・支出・kintone などを合計して入れる（2026-11-06 ユーザー指摘：害虫・害獣で単価が出ない） */
    res.json(out);
  } catch (e) { next(e); }
});

/** エリア：期間内の全メディア×都道府県 */
api.get('/regions', needMedia, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: '期間（from / to）を YYYY-MM-DD で指定してください' });
    const rows = await cached('regions|' + from + '|' + to, TEN_MIN, () => query(
      `SELECT media, block, region, SUM(pageviews) pv, SUM(sessions) sessions, SUM(key_events) key_events
       FROM ${T('ga4_region_daily')} WHERE date BETWEEN @from AND @to GROUP BY media, block, region`, { from, to }));
    const out = {};
    rows.forEach(r => {
      if (!allowedMedia(req.user, r.media)) return;
      (out[mediaId(r.media, r.block)] = out[mediaId(r.media, r.block)] || {})[r.region] = { pv: Number(r.pv), sessions: Number(r.sessions), keyEvents: Number(r.key_events) };
    });
    res.json(out);
  } catch (e) { next(e); }
});

/** エリア：kintone（SEO回線）の都道府県別 コール数・成約数・収益 */
api.get('/kintone-area', needMedia, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: '期間（from / to）を YYYY-MM-DD で指定してください' });
    const out = {};
    (await kinRows()).filter(r => allowedMedia(req.user, r.media) && r.date >= from && r.date <= to)
      .forEach(r => addKin(r, id => { const o = out[id] = out[id] || {}, p = r.pref || '（不明）'; return o[p] = o[p] || {}; }));
    if (req.user.roleEff === 'resta') Object.values(out).forEach(byP => Object.values(byP).forEach(o => { delete o.revPartner; }));   // REsta社員には収益を返さない（2026-10-30）
    res.json(out);
  } catch (e) { next(e); }
});

// ---------- システム構造（だれでも見られる。メモの変更は管理者だけ） ----------
const SYSTEM_MAP = require('./system-map.json');
api.get('/system', async (req, res, next) => {
  try {
    if (!capOk(req.user, 'admin_system', x => x.roleEff !== 'finance')) return res.status(403).json({ error: '見る権限がありません' });   // 権限管理の admin_system（初期値：BEST経理部以外。2026-10-30・2026-11-06 ユーザー指定）
    const snap = await db.collection('settings').doc('system_notes').get();
    const map = req.user.roleEff === 'resta' ? Object.assign({}, SYSTEM_MAP, { changelog: [] }) : SYSTEM_MAP;   // REsta社員には更新履歴を返さない（2026-10-30 ユーザー指定）
    res.json({ map, notes: (snap.exists && snap.data().notes) || {}, canEdit: isFullAdmin(req.user) });
  } catch (e) { next(e); }
});

// ---------- 管理者 ----------
const adminApi = express.Router();
// 「差異ありでOK」：その人のその月はスプレッドシートの金額を使う（進行管理は直さない）（2026-10-31 ユーザー指定）
/* 操作マニュアル（2026-11-05 ユーザー指定）：writer（ライター・月次進行管理）・director（ディレクション担当・コンテンツ進行管理）・contractor（業務委託・報酬）・staff（BEST社員・目標・稼働工数設定）。
   元は webapp/manuals/<key>.md。毎月初のタスクスケジューラー（claude -p）が更新したものは Firestore manuals/<key> に入り、「最終更新」の日付が新しいほうを返す。ログインしている人なら読める（操作の説明だけ） */
const MANUAL_KEYS = ['writer', 'director', 'contractor', 'staff', 'outline'];   /* outline＝構成シート（2026-11-13 ユーザー指定） */
api.get('/manuals/:key', async (req, res, next) => {
  try {
    const k = req.params.key; if (!MANUAL_KEYS.includes(k)) return res.status(404).json({ error: 'マニュアルがありません' });
    const dateOf = md => (String(md || '').match(/最終更新[：:]\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    let file = ''; try { file = require('fs').readFileSync(path.join(__dirname, 'manuals', k + '.md'), 'utf8'); } catch (e) { /* まだない */ }
    const snap = await db.collection('manuals').doc(k).get(), fsMd = snap.exists ? String(snap.data().md || '') : '';
    const md = fsMd && dateOf(fsMd) >= dateOf(file) ? fsMd : file;
    if (!md) return res.status(404).json({ error: 'マニュアルはまだありません' });
    res.set('Cache-Control', 'no-store'); res.json({ key: k, md, updatedAt: dateOf(md) });
  } catch (e) { next(e); }
});
api.get('/sheet-accepts', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ accepts: (await db.collection('sheet_accepts').get()).docs.map(d => Object.assign({ id: d.id }, d.data())) }); } catch (e) { next(e); }
});
api.put('/sheet-accepts', async (req, res, next) => {
  try {
    if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけができます' });
    const b = req.body || {}, cid = String(b.cid || ''), ym = String(b.ym || '');
    if (!cid || !/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: '指定が正しくありません' });
    const ref = db.collection('sheet_accepts').doc(cid + '_' + ym);
    if (b.on) await ref.set(Object.assign({ cid, ym, by: req.user.name || req.user.email, at: new Date().toISOString() }, b.waive ? { waive: true, note: String(b.note || '').slice(0, 300) } : {})); else await ref.delete();   /* waive：特例で請求なし（2026-11-05 ユーザー指定） */
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// シートに合わせて進行管理の数字を直したときの記録（直す前の値）（2026-10-31 ユーザー指定）
api.post('/sheet-fix-log', async (req, res, next) => {
  try {
    if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけができます' });
    const changes = (Array.isArray((req.body || {}).changes) ? req.body.changes : []).slice(0, 2000);
    await db.collection('sheet_fix_logs').add({ by: req.user.email, at: admin.firestore.FieldValue.serverTimestamp(), changes });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
adminApi.use(auth, isAdmin);

adminApi.get('/users', async (req, res, next) => {
  try {
    const snap = await db.collection('users').get();
    const docs = await Promise.all(snap.docs.map(async d => ({ id: d.id, u: await applyRole(Object.assign({}, d.data())) })));
    const restaSet = await restaEmails();   // REsta社員（役割は「REsta社員」から変えられない。2026-10-30）
    const users = docs.map(({ id, u }) => {
      return { resta: restaSet.has(String(u.email || '').toLowerCase()), uid: id, email: u.email, name: u.name, status: u.status, perms: u.perms, scope: u.scope, role: u.role || '', roleEff: u.roleEff || '', personNames: u.personNames || [],
        createdAt: u.createdAt && u.createdAt.toDate ? u.createdAt.toDate().toISOString() : null,
        lastLoginAt: u.lastLoginAt && u.lastLoginAt.toDate ? u.lastLoginAt.toDate().toISOString() : null };
    });
    // まだログインしていない、追加済みの人（user_invites）
    (await db.collection('user_invites').get()).docs.forEach(d => { const v = d.data(); users.push({ resta: restaSet.has(d.id.toLowerCase()), uid: '', invite: true, email: d.id, name: v.name || d.id, status: 'invited', role: v.role || '', roleEff: v.role === 'auto' ? '' : (v.role || ''), scope: v.scope || 'all', perms: {}, createdAt: tsIso(v.createdAt), lastLoginAt: null, createdBy: v.createdBy || '', mailedAt: tsIso(v.mailedAt), mailError: v.mailError || '' }); });
    users.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || String(a.email).localeCompare(String(b.email)));
    res.json(users);
  } catch (e) { next(e); }
});
/** ユーザー追加で選べる人：契約中の契約と BEST社員（メールアドレスがあり、まだユーザー管理にいない人）（2026-10-28 ユーザー指定） */
adminApi.get('/users/candidates', async (req, res, next) => {
  try {
    const [us, iv, cs, st] = await Promise.all([db.collection('users').get(), db.collection('user_invites').get(), activeContracts(), staffMod.userCandidates()]);
    const have = new Set(us.docs.map(d => String(d.data().email || '').toLowerCase()).concat(iv.docs.map(d => d.id.toLowerCase())));
    const contracts = cs.filter(c => c.email && !have.has(c.email)).map(c => ({ name: c.name, email: c.email, position: c.position || '', medias: c.medias || [] }));
    const resta = (await db.collection('resta_staff').get()).docs.map(d => d.data()).filter(r => r.email && !have.has(String(r.email).toLowerCase())).map(r => ({ name: r.name, email: String(r.email).toLowerCase(), empType: 'REsta社員', role: 'resta' }));
    const staff = st.filter(s => !have.has(s.email)).concat(resta);
    res.json({ contracts, staff });
  } catch (e) { next(e); }
});
/** REsta社員管理に登録されているメールアドレス（役割「REsta社員」の判定。5分キャッシュ）（2026-10-30） */
let restaCache = null;
async function restaEmails() { if (restaCache && restaCache.until > Date.now()) return restaCache.v; const v = new Set((await db.collection('resta_staff').get()).docs.map(d => String(d.data().email || '').toLowerCase()).filter(Boolean)); restaCache = { v, until: Date.now() + 5 * 60 * 1000 }; return v; }
/** REsta社員は役割「REsta社員」だけ。「REsta社員」は REsta社員管理に登録された人だけ */
async function restaRoleErr(role, email) {
  const isResta = (await restaEmails()).has(String(email || '').toLowerCase());
  if (isResta && role !== 'resta') return 'この人は REsta社員管理に登録されているため、役割は「REsta社員」だけです（変更できません）';
  if (!isResta && role === 'resta') return '役割「REsta社員」にするには、先に REsta社員管理にこのメールアドレス（' + email + '）を登録してください';
  return '';
}
/** ユーザーを追加（ログインする前に登録しておく。追加された人だけがログインできる）（2026-10-14 ユーザー指定） */
const CONTRACT_ROLES = ['auto', 'out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'];
adminApi.post('/users', async (req, res, next) => {
  try {
    const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 60);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスが正しくありません' });
    if (!name) return res.status(400).json({ error: '名前を入力してください' });
    const role = String(b.role || '');
    if (!(role === 'auto' || ROLES.some(r => r[0] === role))) return res.status(400).json({ error: '役割を選んでください' });
    if (role === 'admin' && !isFullAdmin(req.user)) return res.status(403).json({ error: '管理者の役割は、管理者だけが付けられます' });
    const scope = b.scope === 'all' ? 'all' : Array.isArray(b.scope) ? b.scope.filter(s => typeof s === 'string') : 'all';
    if (CONTRACT_ROLES.includes(role) && !(await activeContracts()).some(c => c.email === email)) return res.status(400).json({ error: '業務委託の役割にするには、契約管理でこのメールアドレス（' + email + '）を入れた契約中の契約が必要です。先に契約を登録してください' });
    // 正社員・契約社員・アルバイトの役割は、BEST社員管理に同じ名前・メールアドレス・区分の登録が必要（2026-10-27 ユーザー指定）
    const staffErr = await staffMod.checkUserInvite(role, email, name); if (staffErr) return res.status(400).json({ error: staffErr });
    const rErr = await restaRoleErr(role, email); if (rErr) return res.status(400).json({ error: rErr });
    const exists = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!exists.empty) return res.status(400).json({ error: 'このメールアドレスのユーザーは、すでに登録されています（一覧の「役割を編集」から変更してください）' });
    await db.collection('user_invites').doc(email).set({ email, name, role, scope, createdBy: req.user.email, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'ユーザーを追加：' + email + '（' + role + '）', at: admin.firestore.FieldValue.serverTimestamp() });
    const mail = b.sendMail ? await sendInviteMail(req, email, name) : null;
    res.json({ ok: true, mail });
  } catch (e) { next(e); }
});
/** ユーザー追加の案内メール（marketing@ から。2026-10-28 ユーザー指定） */
async function sendInviteMail(req, email, name) {
  const url = 'https://' + req.get('host') + '/';
  const body = [name + ' 様', '',
    'BEST MEDIA のダッシュボードを使えるように登録しました。',
    '下のURLを開き、「Googleアカウントでログイン」から、このメールの宛先（' + email + '）の Googleアカウントでログインしてください。', '',
    url, '',
    '■ ログインについて',
    '・ログインは Googleアカウントだけです（パスワードの登録はいりません）。',
    '・別の Googleアカウントでログインすると「このアカウントは登録されていません」と表示されます。その場合はログアウトして、' + email + ' でログインし直してください。',
    '・' + email + ' が Googleアカウントでない場合は、このアドレスで Googleアカウントを作れます（https://accounts.google.com/signup の「既存のメールアドレスを使用」）。', '',
    '――――――――――', 'BEST MEDIA', 'marketing@best-24.jp'].join('\n');
  const ref = db.collection('user_invites').doc(email);
  try {
    await gmail.send({ to: email, subject: '【BEST MEDIA】ダッシュボードへのログインのご案内', body });
    await ref.set({ mailedAt: admin.firestore.FieldValue.serverTimestamp(), mailError: '' }, { merge: true });
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '案内メールを送信：' + email, at: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };
  } catch (e) { await ref.set({ mailError: e.message }, { merge: true }).catch(() => {}); return { ok: false, error: e.message }; }
}
adminApi.post('/users/invite/:email/mail', async (req, res, next) => {
  try {
    const email = String(req.params.email || '').toLowerCase(), snap = await db.collection('user_invites').doc(email).get();
    if (!snap.exists) return res.status(404).json({ error: '見つかりません（ログイン済みの人には送れません）' });
    const r = await sendInviteMail(req, email, snap.data().name || email);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
adminApi.delete('/users/invite/:email', async (req, res, next) => {
  try {
    const email = String(req.params.email || '').toLowerCase(), ref = db.collection('user_invites').doc(email), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
    if (snap.data().role === 'admin' && !isFullAdmin(req.user)) return res.status(403).json({ error: '管理者の追加は、管理者だけが取り消せます' });
    await ref.delete();
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'ユーザーの追加を取り消し：' + email, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const PERM_VALUES = ['admin', 'viewer', 'none'];
const ARTICLE_PERM_VALUES = ['admin', 'editor', 'viewer', 'none'];
adminApi.patch('/users/:uid', async (req, res, next) => {
  try {
    const { status, perms, scope, role } = req.body || {};
    const patch = {};
    if (!isFullAdmin(req.user)) {
      const target = (await db.collection('users').doc(req.params.uid).get()).data() || {};
      if (role === 'admin' || perms !== undefined || target.role === 'admin' || (!target.role && target.perms && target.perms.media === 'admin')) return res.status(403).json({ error: '管理者の役割の付与・変更は、管理者だけができます' });
    }
    if (role !== undefined) {
      if (!(role === 'auto' || ROLES.some(r => r[0] === role))) return res.status(400).json({ error: '役割の値が正しくありません' });
      { const t = (await db.collection('users').doc(req.params.uid).get()).data() || {}, rErr = await restaRoleErr(role, t.email); if (rErr) return res.status(400).json({ error: rErr }); }
      // 業務委託・監修者・「契約から自動」にするときは、同じメールアドレスの契約中の契約が必須（2026-10-14 ユーザー指定）
      if (['auto', 'out_director', 'out_ad', 'out_aw', 'out_writer', 'supervisor'].includes(role)) {
        const target = (await db.collection('users').doc(req.params.uid).get()).data() || {}, email = String(target.email || '').toLowerCase();
        if (!email || !(await activeContracts()).some(c => c.email === email)) return res.status(400).json({ error: '業務委託の役割にするには、契約管理でこの人のメールアドレス（' + (email || '未登録') + '）を入れた契約中の契約が必要です。先に契約を登録してください' });
      }
      // 正社員・契約社員・アルバイトにするときは、BEST社員管理の登録が必須（2026-10-27 ユーザー指定）
      if (['employee', 'contract', 'parttime'].includes(role)) {
        const target = (await db.collection('users').doc(req.params.uid).get()).data() || {};
        const err = await staffMod.checkUserInvite(role, String(target.email || '').toLowerCase(), null); if (err) return res.status(400).json({ error: err });
      }
      patch.role = role;
    }
    if (status !== undefined) {
      if (!['active', 'pending', 'disabled'].includes(status)) return res.status(400).json({ error: '状態の値が正しくありません' });
      patch.status = status;
    }
    if (perms !== undefined) {
      if (!perms || !PERM_VALUES.includes(perms.media) || !PERM_VALUES.includes(perms.revenue)) return res.status(400).json({ error: '権限の値が正しくありません' });
      if (perms.articles !== undefined && !ARTICLE_PERM_VALUES.includes(perms.articles)) return res.status(400).json({ error: '記事管理の権限の値が正しくありません' });
      patch.perms = { media: perms.media, revenue: perms.revenue, articles: perms.articles || 'viewer' };
    }
    if (scope !== undefined) {
      if (!(scope === 'all' || (Array.isArray(scope) && scope.every(s => typeof s === 'string')))) return res.status(400).json({ error: '見られるメディアの値が正しくありません' });
      patch.scope = scope;
    }
    if (req.params.uid === req.user.uid && (patch.status && patch.status !== 'active' || patch.perms && patch.perms.media !== 'admin' || patch.role && patch.role !== 'admin')) {
      return res.status(400).json({ error: '自分自身の管理者権限は外せません' });
    }
    await db.collection('users').doc(req.params.uid).update(patch);
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '権限を変更：' + req.params.uid + ' ' + JSON.stringify(patch), at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 権限管理：役割ごとの操作権限
adminApi.get('/roles', async (req, res, next) => {
  try { res.json({ roles: ROLES, caps: CAPS, matrix: await roleCaps(), positionRole: POSITION_ROLE }); } catch (e) { next(e); }
});
adminApi.put('/roles', async (req, res, next) => {
  try {
    const m = (req.body || {}).matrix || {}, ids = CAPS.map(c => c[0]), caps = {};
    ROLES.filter(([id]) => id !== 'admin').forEach(([id]) => { caps[id] = Array.isArray(m[id]) ? m[id].filter(k => ids.includes(k)) : (DEFAULT_ROLE_CAPS[id] || []); });
    await db.collection('settings').doc('roles').set({ caps, known: ids, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    roleCapsCache = null;
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '権限管理を変更', at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminApi.put('/system-notes', async (req, res, next) => {
  try {
    const { id, text } = req.body || {};
    if (!SYSTEM_MAP.schedule.some(s => s.id === id)) return res.status(400).json({ error: '項目が正しくありません' });
    await db.collection('settings').doc('system_notes').set({ notes: { [id]: { text: String(text || '').slice(0, 1000), by: req.user.email, at: new Date().toISOString() } } }, { merge: true });
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'システム構造のメモを変更：' + id, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminApi.get('/logs', async (req, res, next) => {
  try {
    let q = db.collection('access_logs').orderBy('at', 'desc').limit(300);
    if (req.query.uid) q = db.collection('access_logs').where('uid', '==', String(req.query.uid)).orderBy('at', 'desc').limit(300);
    const snap = await q.get();
    res.json(snap.docs.map(d => { const x = d.data(); return { at: x.at && x.at.toDate ? x.at.toDate().toISOString() : null, email: x.email, name: x.name, view: x.view, ip: x.ip || '' }; }));
  } catch (e) { next(e); }
});

adminApi.get('/jobs', async (req, res, next) => {
  try {
    const rows = await query(`SELECT FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', run_at, 'Asia/Tokyo') run_at, job, media, CAST(date_from AS STRING) date_from, CAST(date_to AS STRING) date_to, status, message
      FROM ${T('job_log')} WHERE run_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY) ORDER BY run_at DESC LIMIT 500`);
    res.json(rows.map(r => Object.assign({}, r, { run_at: tsStr(r.run_at) })));
  } catch (e) { next(e); }
});


// ---------- 記事の追加・修正（ダッシュボードで入力した内容。スプレッドシートには書き込まない） ----------
// article_overrides/{key}：取り込んだ記事への修正（key = メディア|記事No.）
// article_entries/{id}  ：ダッシュボードで新しく追加した記事
const ARTICLE_FIELDS = {
  no: 'str', kw: 'str', related_kw: 'str', target: 'str', query_type: 'str', position: 'str', urgency: 'str', director: 'str', seo_difficulty: 'str',
  status: 'str', type: 'str', url: 'str', post_id: 'str', genre: 'str', cta: 'str', appeal_block: 'str', price_note: 'str', market_note: 'str', tags: 'str',
  planned_chars: 'num', request_date: 'date', outline_url: 'str', upload_date: 'date', writer: 'str', writing_status: 'str', chars: 'num', copy_rate: 'str', writing_url: 'str',
  image_owner: 'str', image_status: 'str', image_count: 'num', upload_owner: 'str', upload_status: 'str', memo: 'str', bill_ym: 'str', bill_skip: 'str',
  supervision: 'str', supervisor: 'str', expertise: 'str', sub: 'str', deleted: 'str',
  target_ym: 'str',   /* アップロード目標月（YYYY-MM）。執筆担当を入れたら必須（2026-11-04 ユーザー指定） */
};
/** ライター（業務委託ライター・契約外ライター）が月次進行管理で直せる項目（2026-11-04 ユーザー指定） */
const CHARS_AUTO_STATUSES = ['記事執筆完了', '記事チェック中', '記事監修者確認', 'アップロードチェック中', '完了'];   /* この進行状況にしたら文字数を自動で入れる（2026-11-13 ユーザー指定） */
const WRITER_ROLES = ['out_writer', 'free_writer'], WRITER_FIELDS = ['writing_url', 'chars', 'image_count', 'status', 'url', 'upload_date', 'copy_rate'];   /* copy_rate＝コピペ率（CCD）（2026-11-05 ユーザー指定） */
const canArticleSettings = u => u.status === 'active' && (u.perms.media === 'admin' || u.perms.articles === 'admin');
const canEditArticles = u => u.status === 'active' && (u.perms.media === 'admin' || ['admin', 'editor'].includes(u.perms.articles));
const keyOfItem = r => r.media + '|' + (r.no ? 'no' + r.no : 'row' + r.row_no);
/** 「自分が担当の記事だけ」の人：その記事が自分のものか（担当者に自分の名前がある、または自分が追加した記事） */
async function ownsItem(user, key) {
  const names = user.personNames || [];
  const mine = o => ['writer', 'director', 'upload_owner', 'supervisor'].some(k => o[k] && names.includes(o[k]));
  if (key.startsWith('entry:')) { const snap = await db.collection('article_entries').doc(key.slice(6)).get(); return snap.exists && (snap.data().createdBy === user.email || mine(snap.data())); }
  const media = key.split('|')[0];
  const rows = await query('SELECT media, `no`, row_no, writer, director, upload_owner, supervisor FROM ' + T('article_items') + ' WHERE media = @m', { m: media });
  const r = rows.find(x => keyOfItem(x) === key);
  if (!r) return false;
  const ov = await db.collection('article_overrides').doc(docIdOf(key)).get();
  if (ov.exists) ['writer', 'director', 'upload_owner', 'supervisor'].forEach(k => { if (ov.data()['f_' + k] !== undefined) r[k] = ov.data()['f_' + k]; });
  return mine(r);
}
const docIdOf = key => require('crypto').createHash('sha1').update(key).digest('hex');
const OUTLINE_URL = /^https:\/\/[a-z0-9.-]+(:\d+)?\/app\/[^/?#\s]+\/outline\/[^/?#\s]+$/i;
/** 文字数は原稿（Google ドキュメント）の文字数を1文字でも超えたら保存しない（2026-11-12 ユーザー指定）。
 *  writingUrl がドキュメントでないとき（スプレッドシート・空欄）は確かめない */
async function checkCharsLimit(chars, writingUrl) {
  if (chars == null || !/^https:\/\/docs\.google\.com\/document\//.test(String(writingUrl || '').trim())) return;
  let n;
  try { n = await ccheck.docChars(String(writingUrl).trim()); } catch (e) { throw Object.assign(new Error('原稿の文字数を確認できないため、文字数を保存できません（' + e.message + '）'), { status: 400 }); }
  if (Number(chars) > n) throw Object.assign(new Error('文字数がライティングURLのドキュメントの文字数（' + n.toLocaleString() + '文字）を超えています。' + n.toLocaleString() + '文字以下にしてください'), { status: 400, docChars: n });
}
/** いまのライティングURL（シートの値に、ダッシュボードでの修正を重ねる） */
async function currentWritingUrl(key) {
  if (key.startsWith('entry:')) { const s = await db.collection('article_entries').doc(key.slice(6)).get(); return s.exists ? s.data().writing_url : null; }
  const ov = await db.collection('article_overrides').doc(docIdOf(key)).get();
  if (ov.exists && ov.data().f_writing_url !== undefined) return ov.data().f_writing_url;
  const media = key.split('|')[0];
  const rows = await query('SELECT media, `no`, row_no, writing_url FROM ' + T('article_items') + ' WHERE media = @m', { m: media });
  const r = rows.find(x => keyOfItem(x) === key); return r ? r.writing_url : null;
}
function cleanArticle(body) {
  const out = {};
  Object.keys(ARTICLE_FIELDS).forEach(k => {
    if (!(k in body)) return;
    const v = body[k], t = ARTICLE_FIELDS[k];
    if (v === '' || v == null) { out[k] = null; return; }
    if (t === 'num') { const n = Number(String(v).replace(/[,\s]/g, '')); out[k] = isFinite(n) ? n : null; }
    else if (k === 'outline_url' || k === 'writing_url') { if (!/^https:\/\/docs\.google\.com\/(spreadsheets|document)\/d\//.test(String(v).trim()) && !(k === 'outline_url' && OUTLINE_URL.test(String(v).trim()))) throw new Error('URLはGoogleスプレッドシートかGoogleドキュメントのURLを入力してください'); out[k] = String(v).trim().slice(0, 2000); }   /* 構成URLは構成シートのURL（/app/メディア/outline/記事No）も可（2026-11-12 ユーザー指定） */
    else if (k === 'url' && !/^https?:\/\//i.test(String(v).trim())) throw new Error('記事URLは http:// か https:// で始まるURLを入力してください');
    else if (t === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error('日付は YYYY-MM-DD で入力してください'); out[k] = String(v); }
    else if (k === 'target_ym') { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v))) throw new Error('アップロード目標月（日付）は YYYY-MM で入力してください'); out[k] = String(v); }
    else out[k] = String(v).slice(0, 2000);
  });
  return out;
}
async function articleExtras() {
  const [ov, en] = await Promise.all([db.collection('article_overrides').get(), db.collection('article_entries').get()]);
  return { overrides: ov.docs.map(d => d.data()), entries: en.docs.map(d => Object.assign({ id: d.id }, d.data())) };
}
const tsIso = v => v && v.toDate ? v.toDate().toISOString() : null;
/** シートから取り込んだ記事と、進行管理で追加した記事が同じ（メディア・検索KW・新規／リライトが同じ）なら、進行管理の記事を残してシートの行は外す（上書きしない。2026-11-02 ユーザー指定）。
 *  ただし、シートの記事のアップロード日が進行管理で追加した日より前（前からある記事。リライト候補の元の記事など）は別の記事として残す */
function dropDupSheetRows(list, entries, isSheet) {
  const nk = v => String(v || '').normalize('NFKC').replace(/[\s　]+/g, ' ').trim().toLowerCase(), fam = t => /リライト/.test(String(t || '')) ? 'rw' : 'new';
  const ents = {}; entries.forEach(e => { if (!e.kw || e.deleted) return; const k = e.media + '|' + nk(e.kw) + '|' + fam(e.type), d = tsIso(e.createdAt) ? tsIso(e.createdAt).slice(0, 10) : ''; if (!(k in ents) || d < ents[k]) ents[k] = d; });
  for (let i = list.length - 1; i >= 0; i--) { const o = list[i]; if (!isSheet(o) || !o.kw) continue; const d = ents[o.media + '|' + nk(o.kw) + '|' + fam(o.type)]; if (d === undefined) continue; if (o.upload_date && d && String(o.upload_date).slice(0, 10) < d) continue; list.splice(i, 1); }
  return list;
}
api.post('/article-items', async (req, res, next) => {
  try {
    if (!canEditArticles(req.user)) return res.status(403).json({ error: '記事を編集する権限がありません' });
    const body = req.body || {};
    if (!body.media || !allowedMedia(req.user, body.media)) return res.status(400).json({ error: 'メディアを選んでください' });
    const data = Object.assign(cleanArticle(body), { media: String(body.media), createdBy: req.user.email, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    if (!data.kw && !data.url) return res.status(400).json({ error: '検索KWか記事URLのどちらかを入力してください' });
    if (data.writer && !data.target_ym) return res.status(400).json({ error: '執筆担当を入れたら、アップロード目標月も入れてください' });   /* 2026-11-04 ユーザー指定 */
    if (req.user.perms.own && !data.writer && !data.director && !data.upload_owner && !data.supervisor) data.writer = (req.user.personNames || [])[0] || req.user.name || null;   // 担当だけの人が追加したKWは自分の担当
    try { await checkCharsLimit(data.chars, data.writing_url); } catch (e) { return res.status(400).json({ error: e.message, docChars: e.docChars }); }
    const ref = await db.collection('article_entries').add(data);
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '記事を追加：' + data.media + ' ' + (data.kw || data.url), at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, key: 'entry:' + ref.id });
  } catch (e) { if (/日付|URL/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
});
api.patch('/article-items', async (req, res, next) => {
  try {
    if (!canEditArticles(req.user)) return res.status(403).json({ error: '記事を編集する権限がありません' });
    const body = req.body || {}, key = String(body.key || '');
    const fields = cleanArticle(body.fields || {});
    if ('deleted' in fields && !(req.user.perms.media === 'admin' || req.user.perms.bulk)) return res.status(403).json({ error: 'KWを削除する権限がありません' });
    if (req.user.perms.own && !(await ownsItem(req.user, key))) return res.status(403).json({ error: '自分が担当の記事だけ修正できます' });
    if (WRITER_ROLES.includes(req.user.roleEff) && !isFullAdmin(req.user)) { const ng = Object.keys(fields).filter(k => !WRITER_FIELDS.includes(k)); if (ng.length) return res.status(403).json({ error: 'ライターが直せるのは、ライティングURL・文字数・コピペ率（CCD）・画像枚数・進行状況・アップロードURL・アップロード日だけです' }); }   /* 2026-11-04 ユーザー指定 */
    /* 執筆担当を入れたら、アップロード目標月も必須（ディレクション担当でも。2026-11-04 ユーザー指定） */
    if (('writer' in fields && fields.writer && !fields.target_ym) || ('target_ym' in fields && !fields.target_ym)) {
      let cur = {}; if (key.startsWith('entry:')) { const sn = await db.collection('article_entries').doc(key.slice(6)).get(); if (sn.exists) cur = { writer: sn.data().writer, target_ym: sn.data().target_ym }; } else { const sn = await db.collection('article_overrides').doc(docIdOf(key)).get(); if (sn.exists) cur = { writer: sn.data().f_writer, target_ym: sn.data().f_target_ym }; }
      const w = 'writer' in fields ? fields.writer : cur.writer, t = 'target_ym' in fields ? fields.target_ym : cur.target_ym;
      if (w && !t) return res.status(400).json({ error: '執筆担当を入れたら、アップロード目標月も入れてください' });
    }
    /* 文字数は原稿のドキュメントの文字数を超えたら保存しない（2026-11-12 ユーザー指定） */
    if ('chars' in fields && fields.chars != null) {
      try { await checkCharsLimit(fields.chars, 'writing_url' in fields ? fields.writing_url : await currentWritingUrl(key)); } catch (e) { return res.status(400).json({ error: e.message, docChars: e.docChars }); }
    }
    /* 進行状況を「記事執筆完了」以降にしたら、ライティングURLのドキュメントの文字数を自動で入れる（読めなければそのまま）（2026-11-13 ユーザー指定） */
    let autoChars = null, autoCharsErr = '';
    if (fields.status && CHARS_AUTO_STATUSES.includes(fields.status) && !('chars' in fields)) {
      try { const wu = 'writing_url' in fields ? fields.writing_url : await currentWritingUrl(key); if (wu) { autoChars = await ccheck.docChars(String(wu).trim()); if (autoChars > 0) fields.chars = autoChars; else autoChars = null; } }
      catch (e) { autoChars = null; autoCharsErr = e.message; }
    }
    const meta = { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (key.startsWith('entry:')) {
      const ref = db.collection('article_entries').doc(key.slice(6));
      const snap = await ref.get();
      if (!snap.exists || !allowedMedia(req.user, snap.data().media)) return res.status(404).json({ error: '記事が見つかりません' });
      await ref.update(Object.assign(fields, meta));
    } else {
      const media = key.split('|')[0];
      if (!media || !allowedMedia(req.user, media)) return res.status(400).json({ error: '記事の指定が正しくありません' });
      const upd = { key, media };
      Object.keys(fields).forEach(k => { upd['f_' + k] = fields[k]; });
      await db.collection('article_overrides').doc(docIdOf(key)).set(Object.assign(upd, meta), { merge: true });
    }
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '記事を修正：' + key, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json(Object.assign({ ok: true }, autoChars ? { chars: autoChars } : {}, autoCharsErr ? { charsError: autoCharsErr } : {}));
  } catch (e) { if (/日付|URL/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
});
// ---------- 契約管理（Firestore contracts。変更前の内容は contracts/{id}/history に残す）（2026-10-14 ユーザー指定で作り直し） ----------
// 1つの契約に複数のメディア・ディレクトリ。報酬は記事単価／文字単価（＋オプションの記事監修・時間単価。2026-10-14 ユーザー指定で時間単価もオプションに）。
// 書面（契約内容）を見られるのは：管理者・契約管理の権限がある人・BEST役員・BEST正社員・本人（2026-10-14 ユーザー指定）
const CONTRACT_POSITIONS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター', 'ライター', '監修者', 'サイト作成・修正'];   // サイト作成・修正を追加。単発発注はポジションではなく契約内容（2026-10-14 ユーザー指定）
const WRITER_SOURCE_POSITIONS = ['PM', 'ディレクター', 'アシスタントディレクター', 'アシスタント兼ライター'];   // ライターを「自社ライター／BEST契約ライター」から選べる
const WRITER_SOURCES = ['自らライティング', '自社ライター', 'BEST契約ライター'];   // ライティング担当（2026-10-14 ユーザー指定で「自らライティング」を追加）
const CONTRACT_ROUTES = ['クラウドワークス', 'ランサーズ', 'Wantedly', '紹介', '自社募集', 'その他'];   // Wantedly を追加（2026-10-14 ユーザー指定）
const PAY_TYPES = ['記事単価', '文字単価', '単発発注'];   // 単発発注＝継続契約なし（2026-10-14 ユーザー指定）
const PAY_FIELDS = { 記事単価: ['articleNew', 'articleRewrite', 'articleLite', 'upload'],   // 記事単価は新規・リライト・簡易リライトに分ける（2026-10-14 ユーザー指定）
  文字単価: ['char', 'image', 'upload'], 単発発注: [] };
const catOfPosition = p => p === 'サイト作成・修正' ? 'site' : p === '監修者' ? 'supervision' : p === 'ライター' ? 'writing' : 'direction';
const isContractAdmin = u => hasAdminCap(u, 'admin_contracts');   // 管理者か、契約管理の権限がある人
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
/** 古い形（1契約1メディア）の契約も、新しい形に読み替える */
function normContract(id, d) {
  const medias = Array.isArray(d.medias) ? d.medias : d.media ? [d.media] : [];
  const pay = d.pay || (d.payType ? { type: d.payType === '文字単価' ? '文字単価' : '記事単価', [d.payType === '文字単価' ? 'char' : 'article']: d.payAmount } : {});
  if (pay.type === '時間単価') Object.assign(pay, { type: '記事単価', hourOn: true });
  // 以前の「記事単価」は新規記事の単価として読む。シートから取り込んだ契約は、メモの契約内容からリライト・簡易リライトも読む
  if (pay.type === '記事単価' && pay.articleNew == null && pay.article != null) pay.articleNew = pay.article;
  if (pay.type === '記事単価' && d.source === '契約管理シート' && pay.articleRewrite == null && pay.articleLite == null && d.memo) { const rl = require('./contract_import').parseRewriteLite(d.memo); if (rl.rewrite != null) pay.articleRewrite = rl.rewrite; if (rl.lite != null) pay.articleLite = rl.lite; }
  // 「その他（Wantedly）」のように取り込んだ採用経路は、選択肢にあればそちらに読み替える
  if (d.route === 'その他' && CONTRACT_ROUTES.includes(d.routeNote)) d = Object.assign({}, d, { route: d.routeNote, routeNote: '' });   // 時間単価はオプションになった（2026-10-14）
  /* 担当メディアの変更（2026-11-13 ユーザー指定：どの月からどのメディアに担当変更するか）：その月になったら、担当メディアは変更後のメディア */
  const changes = (Array.isArray(d.mediaChanges) ? d.mediaChanges : []).filter(x => x && /^\d{4}-\d{2}$/.test(x.from) && Array.isArray(x.medias) && x.medias.length).sort((a, b) => a.from.localeCompare(b.from));
  const now = todayJst().slice(0, 7), done = changes.filter(x => x.from <= now).pop();
  const eff = done ? done.medias.slice() : medias;
  return Object.assign({ id }, d, { medias: eff, baseMedias: medias, mediaChanges: changes, futureMedias: [...new Set(changes.filter(x => x.from > now).flatMap(x => x.medias))], media: eff[0] || '', subs: d.subs || {}, pay, category: catOfPosition(d.position), status: d.status === '終了' ? '契約解除' : (d.status || '契約中') });
}
const isActiveContract = c => (c.status !== '契約解除' || (!!c.endDate && c.endDate >= todayJst())) &&   /* 解除日が先の日付なら、その日までは契約中 */ (!c.startMonth || c.startMonth <= todayJst().slice(0, 7)) && (!c.endDate || c.endDate >= todayJst()) && (!c.end || c.end >= todayJst());
let contractsCache = null;
async function allContracts() {
  if (!contractsCache || contractsCache.until < Date.now()) contractsCache = { list: (await db.collection('contracts').get()).docs.map(d => normContract(d.id, d.data())), until: Date.now() + 60 * 1000 };
  return contractsCache.list;
}
async function activeContracts() { return (await allContracts()).filter(isActiveContract); }
const contractVisible = (u, c) => c.medias.some(m => allowedMedia(u, m)) || (!c.medias.length && isContractAdmin(u));
/** 書面を見られる人 */
const canViewContractDoc = (u, c) => isContractAdmin(u) || ['exec', 'employee'].includes(u.roleEff) || (!!c.email && c.email === String(u.email || '').toLowerCase());
const yenNum = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,\s円¥]/g, '')); if (!isFinite(n) || n < 0) throw new Error('金額は0以上の数字で入力してください'); return n; };
/** 契約内容（今・以前で共通） */
function cleanPay(pv) {
  const p = pv || {}, type = PAY_TYPES.includes(p.type) ? p.type : null;
  if (!type) throw new Error('契約内容（記事単価・文字単価・単発発注）を選んでください');
  const o = { type };
  PAY_FIELDS[type].forEach(k => { o[k] = yenNum(p[k]); });
  o.superviseOn = !!p.superviseOn; o.supervise = p.superviseOn ? yenNum(p.supervise) : null;   // 記事監修（オプション）
  o.hourOn = !!p.hourOn; o.hour = p.hourOn ? yenNum(p.hour) : null;   // 時間単価（オプション）
  o.press = yenNum(p.press);   // プレスリリース単価（円/本。2026-10-31 ユーザー指定）
  o.uploadNewOnly = !!p.uploadNewOnly;   // アップロード費は新規記事だけ。リライト・簡易リライトはアップロード込み（2026-10-29 ユーザー指定：幸谷さん）
  if (p.pressSameMonth) o.pressSameMonth = true;   // プレスリリースはリリース日の月の報酬（種石さん。2026-11-02）
  // ディレクション費：条件と金額（条件1・条件2…）
  o.direction = (Array.isArray(p.direction) ? p.direction : []).map(x => ({ cond: String((x || {}).cond || '').trim().slice(0, 200), amount: yenNum((x || {}).amount) })).filter(x => x.cond || x.amount != null).slice(0, 10);
  o.otherOn = !!p.otherOn; o.otherNote = p.otherOn ? String(p.otherNote || '').trim().slice(0, 500) : '';   // その他報酬（メモで入力）
  return o;
}
function cleanContract(b) {
  const o = {};
  if (b.name !== undefined) { o.name = String(b.name).trim().slice(0, 60); if (!o.name) throw new Error('契約者名を入力してください'); }
  if (b.medias !== undefined) { if (!Array.isArray(b.medias) || !b.medias.every(m => MEDIA_ORDER.some(([k]) => k === m))) throw new Error('担当メディアを選んでください'); o.medias = [...new Set(b.medias)]; if (!o.medias.length) throw new Error('担当メディアを1つ以上選んでください'); }
  if (b.subs !== undefined) { const s = {}; Object.entries(b.subs || {}).forEach(([m, list]) => { if (Array.isArray(list) && list.length) s[String(m)] = [...new Set(list.map(String))].slice(0, 30); }); o.subs = s; }
  if (b.route !== undefined) o.route = CONTRACT_ROUTES.includes(b.route) ? b.route : 'その他';
  if (b.routeNote !== undefined) o.routeNote = String(b.routeNote || '').trim().slice(0, 100);
  if (b.entity !== undefined) { if (!['企業', '個人'].includes(b.entity)) throw new Error('契約形態（企業・個人）を選んでください'); o.entity = b.entity; }
  if (b.company !== undefined) o.company = String(b.company || '').trim().slice(0, 100);
  if (b.position !== undefined) { if (!CONTRACT_POSITIONS.includes(b.position)) throw new Error('契約ポジションを選んでください'); o.position = b.position; }
  if (b.title !== undefined) o.title = String(b.title || '').slice(0, 200);
  if (b.startMonth !== undefined) { const v = String(b.startMonth || ''); if (!/^\d{4}-\d{2}$/.test(v)) throw new Error('契約月を選んでください'); o.startMonth = v; }
  if (b.pay !== undefined) o.pay = cleanPay(b.pay);
  // 以前の契約内容（ある場合だけ）：期間（開始月〜終了月）と、今の契約内容と同じ項目（2026-10-14 ユーザー指定）
  if (b.pastPays !== undefined) {
    o.pastPays = (Array.isArray(b.pastPays) ? b.pastPays : []).slice(0, 20).map(x => {
      const from = String((x || {}).from || ''), to = String((x || {}).to || '');
      if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) throw new Error('以前の契約内容の期間（開始月・終了月）を選んでください');
      if (from > to) throw new Error('以前の契約内容の期間は、開始月を終了月より前にしてください');
      const medias = [...new Set((Array.isArray((x || {}).medias) ? x.medias : []).map(m => String(m).slice(0, 60)).filter(Boolean))].slice(0, 20);   // その期間の担当メディア（2026-10-26 ユーザー指定）
      return { from, to, medias, pay: cleanPay((x || {}).pay), note: String((x || {}).note || '').trim().slice(0, 500) };
    }).sort((a, b) => a.from.localeCompare(b.from));
  }
  /* 担当メディアの変更（開始月・変更後のメディア・変更前のメディア）（2026-11-13 ユーザー指定） */
  if (b.mediaChanges !== undefined) {
    o.mediaChanges = (Array.isArray(b.mediaChanges) ? b.mediaChanges : []).slice(0, 10).map(x => {
      const from = String((x || {}).from || ''), ms = [...new Set((Array.isArray((x || {}).medias) ? x.medias : []).map(String))];
      if (!/^\d{4}-\d{2}$/.test(from)) throw new Error('担当変更の開始月を選んでください');
      if (!ms.length || !ms.every(m => MEDIA_ORDER.some(([k]) => k === m))) throw new Error('担当変更の変更後のメディアを1つ以上選んでください');
      const prev = [...new Set((Array.isArray((x || {}).prevMedias) ? x.prevMedias : []).map(String))].filter(m => MEDIA_ORDER.some(([k]) => k === m));
      return { from, medias: ms, prevMedias: prev, note: String((x || {}).note || '').trim().slice(0, 200) };
    }).sort((a, c) => a.from.localeCompare(c.from));
    if (new Set(o.mediaChanges.map(x => x.from)).size !== o.mediaChanges.length) throw new Error('担当変更の開始月が重なっています（同じ月は1つにまとめてください）');
  }
  if (b.writerSources !== undefined) o.writerSources = (Array.isArray(b.writerSources) ? b.writerSources : []).filter(x => WRITER_SOURCES.includes(x));
  if (b.email !== undefined) { const e = String(b.email || '').trim().toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('メールアドレスが正しくありません'); o.email = e; }
  if (b.billingStaffId !== undefined) o.billingStaffId = String(b.billingStaffId || '').slice(0, 60);
  if (b.billingSubStaffId !== undefined) o.billingSubStaffId = String(b.billingSubStaffId || '').slice(0, 60);   // 請求担当（サブ）   // 請求担当（BEST社員の ID）（2026-10-28 ユーザー指定）
  if (b.invoice !== undefined) { const v = String(b.invoice || '').trim().toUpperCase().replace(/[-\s]/g, ''); if (v && !/^T\d{13}$/.test(v)) throw new Error('インボイス番号は「T」と13桁の数字です（例：T1234567890123）'); o.invoice = v; }
  if (b.memo !== undefined) o.memo = String(b.memo || '').slice(0, 2000);
  // 契約解除日・休職開始日・復職日（解除・休職のあとでも入力・変更できる）（2026-10-14 ユーザー指定）
  ['endDate', 'leaveStart', 'leaveEnd'].forEach(k => { if (b[k] !== undefined) { const v = String(b[k] || ''); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('日付は YYYY-MM-DD で入力してください'); o[k] = v || null; } });
  if (b.changeNote !== undefined) o.changeNote = String(b.changeNote || '').trim().slice(0, 300);
  return o;
}
const CONTRACT_ERR = /入力|選んで|正しく|数字|桁|期間|重な/;
const contractOut = c => Object.assign({}, c, { createdAt: tsIso(c.createdAt), updatedAt: tsIso(c.updatedAt), active: isActiveContract(c) });
async function contractLog(req, view) { await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view, at: admin.firestore.FieldValue.serverTimestamp() }); }
/** 請求担当に選べる BEST社員（名前だけ。退職済みは除く）。契約管理の権限がある人と、報酬を見られる人 */
api.get('/staff-names', async (req, res, next) => {
  try {
    if (req.user.roleEff === 'finance' || (!isContractAdmin(req.user) && !(req.user.perms && req.user.perms.rewards === 'viewer'))) return res.status(403).json({ error: '見る権限がありません' });
    const today = todayJst();
    const list = (await db.collection('staff').get()).docs.map(d => ({ id: d.id, name: d.data().name || '', retired: !!(d.data().retireDate && d.data().retireDate < today && d.data().retireType !== '昇格'), joinDate: d.data().joinDate || '', assignMedia: Object.fromEntries(Object.entries(d.data().assign || {}).map(([ym, a]) => [ym, (Array.isArray(a) ? a : []).map(x => x.media).filter(Boolean)])), retireDate: d.data().retireType === '昇格' ? (d.data().execRetireDate || '') : (d.data().retireDate || '') }));   /* 入社日・退職日（プレスリリースの担当を、その時期に在籍していた人だけにする。2026-11-02） */
    res.json({ staff: list.sort((a, b) => a.retired - b.retired || String(a.name).localeCompare(b.name, 'ja')) });
  } catch (e) { next(e); }
});
/** 稼働表：contracts/{id}/timesheet/{YYYY-MM}＝{ days: { '01': { plan, planNote, w: {writing, image, upload, rewrite}, d: {meeting, strategy, production, operation, team, knowledge}, note } } }
 *  見られる・入力できるのは本人と契約管理の権限がある人（見るだけなら BEST役員・正社員も）。時間は 0.25（15分）単位（2026-10-28 ユーザー指定） */
const TS_W = ['writing', 'image', 'upload', 'rewrite'], TS_D = ['meeting', 'strategy', 'production', 'operation', 'team', 'knowledge'];
const tsHours = v => { if (v === '' || v == null) return null; const n = Number(v); if (!isFinite(n) || n < 0 || n > 24) throw new Error('時間は0〜24の数字で入力してください'); if (Math.round(n * 4) !== n * 4) throw new Error('時間は15分（0.25）単位で入力してください'); return n; };
async function tsContract(req, res) {
  const s = await db.collection('contracts').doc(req.params.id).get(); if (!s.exists) { res.status(404).json({ error: '契約が見つかりません' }); return null; }
  const c = normContract(s.id, s.data()); if (!canViewContractDoc(req.user, c) && !expView(req)) { res.status(404).json({ error: '契約が見つかりません' }); return null; }
  return c;
}
api.get('/contracts/:id/timesheets', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const months = String(req.query.months || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m)).slice(0, 60);
    const c = await tsContract(req, res); if (!c) return;
    const self = !!c.email && c.email === String(req.user.email || '').toLowerCase(), canEdit = self || isContractAdmin(req.user), col = db.collection('contracts').doc(c.id).collection('timesheet');
    const docs = months.length ? await db.getAll(...months.map(m => col.doc(m))) : [], out = {};
    docs.forEach((s, i) => { const d = s.data() || {}; out[months[i]] = { ym: months[i], days: d.days || {}, canEdit, updatedAt: tsIso(d.updatedAt), updatedBy: d.updatedBy || '' }; });
    res.json({ months: out });
  } catch (e) { next(e); }
});
api.get('/contracts/:id/timesheet/:ym', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!/^\d{4}-\d{2}$/.test(req.params.ym)) return res.status(400).json({ error: '月の指定が正しくありません' });
    const c = await tsContract(req, res); if (!c) return;
    const d = (await db.collection('contracts').doc(c.id).collection('timesheet').doc(req.params.ym).get()).data() || {};
    const self = !!c.email && c.email === String(req.user.email || '').toLowerCase();
    res.json({ ym: req.params.ym, days: d.days || {}, canEdit: self || isContractAdmin(req.user), updatedAt: tsIso(d.updatedAt), updatedBy: d.updatedBy || '' });
  } catch (e) { next(e); }
});
api.put('/contracts/:id/timesheet/:ym', async (req, res, next) => {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.ym)) return res.status(400).json({ error: '月の指定が正しくありません' });
    const c = await tsContract(req, res); if (!c) return;
    const self = !!c.email && c.email === String(req.user.email || '').toLowerCase();
    if (!self && !isContractAdmin(req.user)) return res.status(403).json({ error: '入力できるのは本人と契約管理の権限がある人だけです' });
    const days = {}, src = (req.body || {}).days || {};
    Object.keys(src).filter(k => /^\d{2}$/.test(k) && Number(k) >= 1 && Number(k) <= 31).forEach(k => {
      const x = src[k] || {}, o = { plan: tsHours(x.plan), planNote: String(x.planNote || '').slice(0, 300), note: String(x.note || '').slice(0, 1000), w: {}, d: {} };
      TS_W.forEach(f => { o.w[f] = tsHours((x.w || {})[f]); }); TS_D.forEach(f => { o.d[f] = tsHours((x.d || {})[f]); });
      if (o.plan != null || o.planNote || o.note || TS_W.some(f => o.w[f] != null) || TS_D.some(f => o.d[f] != null)) days[k] = o;
    });
    await db.collection('contracts').doc(c.id).collection('timesheet').doc(req.params.ym).set({ days, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await contractLog(req, '稼働表を保存：' + c.name + '（' + req.params.ym + '）');
    res.json({ ok: true });
  } catch (e) { if (/時間は/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
});
/** 自分の契約（ログインしたメールアドレスの契約中の契約）だけ。業務委託の「報酬」の画面用（2026-10-28 ユーザー指定）。画面右上の「契約内容」用の /my-contracts とは別 */
api.get('/my-reward-contracts', async (req, res, next) => {
  try {
    const email = String(req.user.email || '').toLowerCase();
    const list = (await allContracts()).filter(c => c.email && String(c.email).toLowerCase() === email).map(contractOut).filter(c => c.active);
    res.json({ contracts: list });
  } catch (e) { next(e); }
});
api.get('/contracts', async (req, res, next) => {
  try {
    const ev = expView(req) && !isContractAdmin(req.user);   /* 支出情報の業務委託費を見る BEST社員：連絡先・請求先・メモは外す */
    if (!ev && (req.user.roleEff === 'finance' || (!isContractAdmin(req.user) && !(req.user.perms && req.user.perms.rewards === 'viewer')))) return res.status(403).json({ error: '契約管理を見る権限がありません' });
    contractsCache = null;
    const list = (await allContracts()).filter(c => ev || contractVisible(req.user, c)).map(contractOut).map(c => { if (!ev) return c; const o = Object.assign({}, c); ['email', 'invoice', 'memo', 'changeNote', 'history', 'files'].forEach(k => delete o[k]); return o; });
    res.json({ contracts: list, positions: CONTRACT_POSITIONS, payTypes: PAY_TYPES, routes: CONTRACT_ROUTES, writerSources: WRITER_SOURCES, writerSourcePositions: WRITER_SOURCE_POSITIONS, canEdit: isContractAdmin(req.user) });
  } catch (e) { next(e); }
});
/** 状態（契約中・休職・契約解除）と日付を o に入れる。入力の誤りはメッセージを返す */
function applyContractStatus(b, o) {
  if (b.status === undefined) return '';
  if (b.status === '契約解除') { const d = String(b.endDate || todayJst()); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '契約解除日を入力してください'; o.status = '契約解除'; o.endDate = d; }
  else if (b.status === '休職') { const d = String(b.leaveStart || todayJst()); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '休職開始日を入力してください'; o.status = '休職'; o.leaveStart = d; if (o.endDate === undefined) o.endDate = null; }
  else if (b.status === '契約中') { o.status = '契約中'; if (b.endDate === undefined) o.endDate = null; }
  return '';
}
api.post('/contracts', async (req, res, next) => {
  try {
    if (!isContractAdmin(req.user)) return res.status(403).json({ error: '契約を登録する権限がありません' });
    const o = cleanContract(req.body || {});
    for (const k of ['name', 'medias', 'entity', 'position', 'startMonth', 'pay']) if (o[k] === undefined) return res.status(400).json({ error: '契約者名・担当メディア・契約形態・契約ポジション・契約月・契約内容を入力してください' });
    if (!o.medias.every(m => allowedMedia(req.user, m))) return res.status(403).json({ error: '担当できないメディアが含まれています' });
    if (!WRITER_SOURCE_POSITIONS.includes(o.position)) o.writerSources = [];
    // 追加のときも、選んだ状態（契約解除・休職）をそのまま保存する（2026-10-26：過去に契約していた人を登録すると契約中になっていたため）
    const stErr = applyContractStatus(req.body || {}, o); if (stErr) return res.status(400).json({ error: stErr });
    delete o.changeNote;
    contractsCache = null;
    const ref = await db.collection('contracts').add(Object.assign({ status: '契約中', version: 1 }, o, { createdBy: req.user.email, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
    await contractLog(req, '契約を追加：' + o.name + '（' + o.position + '）');
    res.json({ ok: true, id: ref.id });
  } catch (e) { if (CONTRACT_ERR.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
});
/** 変更・契約解除：変更前の内容を history に残してから更新する */
api.patch('/contracts/:id', async (req, res, next) => {
  try {
    if (!isContractAdmin(req.user)) return res.status(403).json({ error: '契約を変更する権限がありません' });
    const ref = db.collection('contracts').doc(req.params.id), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: '契約が見つかりません' });
    const cur = normContract(snap.id, snap.data());
    if (!contractVisible(req.user, cur)) return res.status(404).json({ error: '契約が見つかりません' });
    const b = req.body || {}, o = cleanContract(b);
    if (o.medias && !o.medias.every(m => allowedMedia(req.user, m))) return res.status(403).json({ error: '担当できないメディアが含まれています' });
    if (o.mediaChanges && !o.mediaChanges.every(x => x.medias.every(m => allowedMedia(req.user, m)))) return res.status(403).json({ error: '担当変更に、担当できないメディアが含まれています' });
    const stErr = applyContractStatus(b, o); if (stErr) return res.status(400).json({ error: stErr });
    const pos = o.position || cur.position;
    if (!WRITER_SOURCE_POSITIONS.includes(pos)) o.writerSources = [];
    const note = o.changeNote || (o.status === '契約解除' ? '契約解除' : o.status === '契約中' && cur.status === '契約解除' ? '再契約' : '契約内容の変更'); delete o.changeNote;
    // 変更前の内容を残す（いつ・誰が・どう変えたかを、あとから書面で確認できるように）
    const prev = snap.data();
    await ref.collection('history').add(Object.assign({}, prev, { savedAt: admin.firestore.FieldValue.serverTimestamp(), replacedBy: req.user.email, replaceNote: note }));
    contractsCache = null;
    await ref.update(Object.assign(o, { version: (prev.version || 1) + 1, lastChangeNote: note, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
    try { await staffMod.syncUnitsFromContract(snap.id, prev, Object.assign({}, prev, o)); } catch (e) { console.warn('メディア担当への反映: ' + e.message); }   // 担当メディアを変えたら、メディア担当管理にも反映（2026-10-27 ユーザー指定）
    await contractLog(req, '契約を変更：' + (o.name || cur.name) + '（' + note + '）');
    res.json({ ok: true });
  } catch (e) { if (CONTRACT_ERR.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
});
api.delete('/contracts/:id', async (req, res, next) => {
  try {
    if (!isFullAdmin(req.user)) return res.status(403).json({ error: '契約の削除は管理者だけができます（ふだんは「契約解除」を使ってください）' });
    const ref = db.collection('contracts').doc(req.params.id), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: '契約が見つかりません' });
    contractsCache = null;
    const hist = await ref.collection('history').get();
    for (const h of hist.docs) await h.ref.delete();
    await ref.delete();
    await contractLog(req, '契約を削除：' + snap.data().name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
/** 書面（契約内容と、これまでの変更）。本人・管理者・BEST役員・BEST正社員だけ。キャッシュさせない */
api.get('/contracts/:id/doc', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const ref = db.collection('contracts').doc(req.params.id), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: '契約が見つかりません' });
    const c = normContract(snap.id, snap.data());
    if (!canViewContractDoc(req.user, c)) return res.status(404).json({ error: '契約が見つかりません' });   // 見られない人には、あることも知らせない
    const hist = (await ref.collection('history').get()).docs.map(d => normContract(snap.id, d.data())).map(h => Object.assign(contractOut(h), { savedAt: tsIso(h.savedAt) }))
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    await contractLog(req, '契約の書面を表示：' + c.name);
    res.json({ contract: contractOut(c), history: hist, mediaNames: Object.fromEntries(MEDIA_ORDER) });
  } catch (e) { next(e); }
});
// ---------- 契約書類（PDF。公開できない専用の保管場所。見られるのは書面と同じ人だけ）・契約管理シートの取り込み（2026-10-14 ユーザー指定） ----------
const contractFiles = require('./contract_import')({ db, query, T, admin, MEDIA_ORDER, onChanged: () => { contractsCache = null; cache.clear(); } });
// 単発発注などの請求書の取り込み（確定した分を支出に入れ、経理部宛ての請求メールに入れる。2026-10-29 ユーザー指定）
const expenseMod = require('./expense_invoices')({ db, admin, isFullAdmin, hasAdminCap, isBestStaff, files: contractFiles, MEDIA_ORDER, onChanged: () => { cache.clear(); if (typeof pressMod !== 'undefined') pressMod.clear(); } });
expenseMod.routes(api, express);
// 定額のサービス（ツール・AI費）を毎月自動で支出に（2026-10-29 ユーザー指定）
/* 支出の計算値（支出一覧と同じ計算。管理者の画面が12時間ごとに保存）（2026-11-05 ユーザー指定） */
const ecMod = require('./expense_computed')({ db, admin, isFullAdmin, onChanged: () => cache.clear() });
ecMod.routes(api);
const subMod = require('./subscriptions')({ db, admin, query, T, isFullAdmin, hasAdminCap, isBestStaff, todayJst, onChanged: () => cache.clear() });
subMod.routes(api);
/** ツール利用費：サービスごと・月ごとの金額（円・ドル）。定額のサービス＋AI の API の費用（2026-11-02 ユーザー指定） */
api.get('/subscriptions/monthly', async (req, res, next) => {
  try {
    if (!(isBestStaff(req.user) || hasAdminCap(req.user, 'admin_expenses'))) return res.status(403).json({ error: '支出管理の権限がありません' });
    res.set('Cache-Control', 'no-store');
    const by = {}; (await subRows()).filter(r => (r.item === 'cost_tool' || r.item === 'cost_ai') && r.sub).forEach(r => { const k = r.sub + '|' + r.ym, o = by[k] = by[k] || { sub: r.sub, ym: r.ym, value: 0, usd: 0 }; o.value += r.value; o.usd += r.usd || 0; });
    res.json({ rows: Object.values(by) });
  } catch (e) { next(e); }
});
// AI の API の費用（Claude・OpenAI。Admin キーで読む。2026-10-29 ユーザー指定）
const aiCostMod = require('./ai_costs')({ PROJECT, db, admin, isFullAdmin, todayJst, subMod, onChanged: () => cache.clear() });
aiCostMod.routes(adminApi);
// プレスリリース（2026-10-31 ユーザー指定）：シートから読み、支出のプレスリリース費（配信したメディアに本数で分ける）
const pressMod = require('./press')({ db, query, T, todayJst, docChars: url => ccheck.docChars(url) });
pressMod.setExpenses(() => expenseMod.pressExpenses());   /* プレスリリース費の PR TIMES・freaaasy をリリースの配信費・調査費に（2026-11-02 ユーザー指定） */
pressMod.routes(api, { canEdit: u => canEditArticles(u) && (isFullAdmin(u) || ['exec', 'employee', 'contract', 'parttime'].includes(u.roleEff)), noMoney: u => u.roleEff === 'resta', allowedMedia: (u, m) => allowedMedia(u, m), isStaff: u => isFullAdmin(u) || ['exec', 'employee', 'contract', 'parttime'].includes(u.roleEff) });   // 入力はプレスリリース進行管理（管理者・BEST役員・BEST社員）だけ。見るのは見られるメディアの分（2026-10-31 ユーザー指定）
const subRows = () => cached('sub-rows', TEN_MIN, async () => (await subMod.rows()).concat(await aiCostMod.rows().catch(e => { console.warn('ai cost: ' + e.message); return []; }), await pressMod.costRows().catch(e => { console.warn('press: ' + e.message); return []; }), await comp.costRows(subMod.usdJpy).catch(e => { console.warn('competitor cost: ' + e.message); return []; })));   /* 競合調査の Brave の費用もツール利用費に（2026-11-13 ユーザー指定） */
api.get('/contracts/:id/file/:n', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const snap = await db.collection('contracts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: '見つかりません' });
    const c = normContract(snap.id, snap.data()), f = (c.files || [])[Number(req.params.n)];
    if (!canViewContractDoc(req.user, c) || !f) return res.status(404).json({ error: '見つかりません' });
    const o = await contractFiles.getObject(f.object);
    await contractLog(req, '契約書類を表示：' + c.name + '（' + (f.label || f.name) + '）');
    res.set({ 'Content-Type': o.type, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' }).send(o.body);
  } catch (e) { next(e); }
});
/** 契約書類を追加（PDF。管理者・契約管理の権限がある人だけ）。変更前の内容は履歴に残す */
api.post('/contracts/:id/files', express.raw({ type: 'application/pdf', limit: '20mb' }), async (req, res, next) => {
  try {
    if (!isContractAdmin(req.user)) return res.status(403).json({ error: '契約書類を追加する権限がありません' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'PDFファイルを選んでください' });
    const ref = db.collection('contracts').doc(req.params.id), snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: '契約が見つかりません' });
    const label = String(req.query.label || '契約書類').slice(0, 60), name = String(req.query.name || 'contract.pdf').slice(0, 120);
    const object = 'contracts/' + snap.id + '/' + Date.now() + '.pdf';
    await contractFiles.putObject(object, req.body, 'application/pdf');
    await ref.collection('history').add(Object.assign({}, snap.data(), { savedAt: admin.firestore.FieldValue.serverTimestamp(), replacedBy: req.user.email, replaceNote: '契約書類を追加：' + label }));
    contractsCache = null;
    await ref.update({ files: admin.firestore.FieldValue.arrayUnion({ label, name, object, type: 'application/pdf', from: req.user.email, at: new Date().toISOString() }), version: (snap.data().version || 1) + 1, lastChangeNote: '契約書類を追加：' + label, updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await contractLog(req, '契約書類を追加：' + snap.data().name + '（' + label + '）');
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// 契約管理シートからの取り込みは終了（2026-10-26 ユーザー指定）。契約・契約書類は契約管理の画面で追加する
adminApi.post('/contract-import', (req, res) => res.status(410).json({ error: '契約管理シートからの取り込みは終了しました。契約は「契約を追加」から登録してください。' }));
/** 過去の請求の確認者（契約管理シートの各月の「(名前)」＝確認した人。contractor_invoices の by）（2026-10-30 ユーザー指定）
 *  フル管理者は全員、ほかの社員は自分が請求担当（メイン・サブ）の契約の人だけ */
api.get('/invoices-past', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const full = isFullAdmin(req.user) || expView(req);
    let mine = null;
    if (!full) {
      const q = await db.collection('staff').where('email', '==', String(req.user.email || '').toLowerCase()).limit(1).get(); if (q.empty) return res.json({ rows: [] });
      const sid = q.docs[0].id; mine = new Set((await allContracts()).filter(c => c.billingStaffId === sid || c.billingSubStaffId === sid).map(c => String(c.name || '').replace(/[（(].*?[）)]/g, '').replace(/[\s　]/g, '')));
    }
    // ディレクション・監修者のタブ（contractor_invoices）と、ライターのタブ（writer_invoices_raw。2026-10-30 取り込み）。確認者（先頭の「(名前)」）と小計（税抜き）
    let rows = []; try { rows = await query("SELECT FORMAT_DATE('%Y-%m', month) ym, media, name, `by`, subtotal, text FROM " + T('contractor_invoices') + " WHERE (`by` IS NOT NULL AND `by` != '') OR subtotal IS NOT NULL"); } catch (e) { /* まだ取り込んでいない */ }
    try {
      rows = rows.concat(await query("SELECT ym, media, name, `by`, subtotal, text FROM (SELECT ym, media, name, text, REGEXP_EXTRACT(text, r'^[（(]([^）)]+)[）)]') `by`, SAFE_CAST(REPLACE(REGEXP_EXTRACT(text, r'小計\\s*[￥¥]?\\s*([0-9,]+)'), ',', '') AS INT64) subtotal FROM " + T('writer_invoices_raw') + ") WHERE `by` IS NOT NULL OR subtotal IS NOT NULL"));
    } catch (e) { /* ライターのタブはまだ取り込んでいない */ }
    res.json({ rows: rows.filter(r => !mine || mine.has(String(r.name || '').replace(/[（(].*?[）)]/g, '').replace(/[\s　]/g, ''))) });
  } catch (e) { next(e); }
});
/** 支出管理：取り込んだ請求（人ごと）と、SEO数値管理シートの支出の照合用 */
/** 支出管理：BEST人件費（社員ごと・メディアごと・月ごと）。フル管理者だけ（2026-11-02 ユーザー指定） */
api.get('/expenses/staff-costs', async (req, res, next) => {
  try { if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが見られます' }); res.set('Cache-Control', 'no-store'); res.json({ rows: await staffMod.staffCosts(), persons: await staffMod.staffPersonCosts() }); } catch (e) { next(e); }
});
api.get('/expenses/invoices', async (req, res, next) => {
  try {
    if (!hasAdminCap(req.user, 'admin_expenses') && !isContractAdmin(req.user)) return res.status(403).json({ error: '支出管理を見る権限がありません' });
    let invoices = [], sheet = [];
    try { invoices = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, name, subtotal, tax, withholding, billed, \`by\`, lines FROM ${T('contractor_invoices')} ORDER BY month DESC, media, name`); } catch (e) { /* まだ取り込んでいない */ }
    try { sheet = await query(`SELECT FORMAT_DATE('%Y-%m', month) ym, media, item, SUM(value) value FROM ${T('sheet_monthly')} WHERE item IN ('cost_direction', 'cost_article', 'cost_press', 'cost_site') AND month >= '2024-08-01' AND month <= CURRENT_DATE('Asia/Tokyo') AND (block IS NULL OR block = '') GROUP BY ym, media, item`); } catch (e) { /* 表がない */ }
    res.json({ invoices: invoices.filter(r => !r.media || allowedMedia(req.user, r.media)).map(r => Object.assign(r, { lines: JSON.parse(r.lines || '[]') })), sheet: sheet.filter(r => allowedMedia(req.user, r.media)) });
  } catch (e) { next(e); }
});
// ---------- BEST正社員管理（半期の目標・給料。2026-10-14 ユーザー指定） ----------
const staffMod = require('./staff')({ db, admin, isFullAdmin, hasAdminCap, allowedMedia, MEDIA_ORDER, onTargetsChanged: () => cache.clear(), onContractsChanged: () => { contractsCache = null; }, files: contractFiles });
/* BEST人件費の PM の分を均等に分けるメディア：そのメディアのデータが最初にある月から（2026-11-02 ユーザー指定） */
staffMod.setActiveMedia(() => cached('media-first', TEN_MIN, async () => Object.fromEntries((await query(`SELECT media, FORMAT_DATE('%Y-%m', MIN(month)) ym FROM ${T('sheet_monthly')} WHERE value > 0 AND NOT STARTS_WITH(item, 'cost_') GROUP BY media`)).filter(r => MEDIA_ORDER.some(m => m[0] === r.media)).map(r => [r.media, r.ym]))));
staffMod.routes(api);
// REsta社員管理（2026-10-30 ユーザー指定）
require('./resta')({ db, admin, isFullAdmin, hasAdminCap, todayJst }).routes(api);
// 担当者の紐づけ（記事管理の名前 → BEST社員・業務委託）（2026-10-27 ユーザー指定）
/* シミュレーション（2026-11-05 ユーザー指定）：計算の前提（BigQuery から）と、毎月の予測の保存・答え合わせ（BigQuery sim_predictions） */
/* Supabase（AIの作業机）（2026-11-05 ユーザー指定：設計図どおり BigQuery＝原本、Supabase＝AIの作業机） */
const supa = require('./supabase')({ PROJECT, query, T });
adminApi.get('/supabase', async (req, res, next) => {
  try { if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが見られます' }); res.set('Cache-Control', 'no-store');
    const st = await supa.status(); delete st.url; let last = null; if (st.ready) { try { const r = await supa.rest('GET', 'sim_copy_actuals?select=copied_at&order=copied_at.desc&limit=1'); last = r && r[0] ? r[0].copied_at : null; } catch (e) { /* なし */ } }
    res.json(Object.assign(st, { sql: supa.SQL, lastCopy: last })); } catch (e) { next(e); }
});
adminApi.put('/supabase', async (req, res, next) => {
  try {
    if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが設定できます' });
    /* URL はいろいろな形で入れられても、プロジェクトのID（ref）を取り出して https://<ref>.supabase.co にそろえる（2026-11-05 ユーザー指摘：「URLが正しくない」と出た）
       受け付ける形：https://<ref>.supabase.co（/rest/v1/ などが後ろについていても可）、管理画面のURL（supabase.com/dashboard/project/<ref>/…）、ID だけ */
    const b = req.body || {}, raw = String(b.url || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, ''), key = String(b.key || '').trim();
    const ref = ((raw.match(/^(?:https?:\/\/)?([a-z0-9]{15,40})\.supabase\.(?:co|in)\b/i) || raw.match(/supabase\.com\/dashboard\/project\/([a-z0-9]{15,40})/i) || raw.match(/^([a-z0-9]{15,40})$/i) || [])[1] || '').toLowerCase();
    if (!ref) return res.status(400).json({ error: 'プロジェクトのURLが読み取れませんでした。Project Settings →「Data API」の Project URL（https://xxxx.supabase.co）をそのまま貼ってください' });
    const url = 'https://' + ref + '.supabase.co';
    if (key.length < 30) return res.status(400).json({ error: 'secret キー（sb_secret_…）または service_role のキーを入れてください' });
    const st = await supa.status({ url, key });   /* 保存する前に、つながるか確かめる */
    if (!st.connected) return res.status(400).json({ error: 'このURLとキーではつながりませんでした（' + (st.error || '') + '）' });
    await supa.setCfg(url, key);
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'Supabase の接続先を保存', at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, ready: st.ready });
  } catch (e) { next(e); }
});
adminApi.post('/supabase/copy', async (req, res, next) => {
  try { if (!isFullAdmin(req.user)) return res.status(403).json({ error: '管理者だけが実行できます' }); res.json(await supa.copyDaily()); } catch (e) { next(e); }
});
const simMod = require('./sim')({ db, query, T, todayJst, allowedMedia, isFullAdmin, supa, capOk, usdJpy: subMod.usdJpy });   /* usdJpy：AIチームの費用を円に（2026-11-06） */
const errMod = require('./errcheck')({ supa, isFullAdmin, capOk, usdJpy: subMod.usdJpy });   /* AIエラーチェッカー（2026-11-13 ユーザー指定：Supabase） */
errMod.routes(api);
simMod.routes(api);
const personLinks = require('./person_links')({ db, admin, query, T, isFullAdmin, hasAdminCap, allowedMedia,   /* /person-names は見られるメディアの名前だけ（2026-11-04 ユーザー指定） */
  pressNames: async () => { const out = []; ((await pressMod.items()).items || []).forEach(x => ['sheetOwner', 'manager', 'outlineOwner', 'owner', 'imageOwner', 'uploadOwner'].forEach(k => { if (x[k]) out.push({ media: x.media, name: x[k] }); })); return out; } });
personLinks.routes(api);
/** 自分の契約（画面右上の「契約内容」用） */
api.get('/my-contracts', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const email = String(req.user.email || '').toLowerCase();
    const list = email ? (await allContracts()).filter(c => c.email === email).map(c => ({ id: c.id, name: c.name, position: c.position, status: c.status, active: isActiveContract(c) })) : [];
    res.json({ contracts: list });
  } catch (e) { next(e); }
});

// ---------- 記事管理：各種設定（カテゴリ・タグは WordPress から読むだけ。CTA・訴求ブロックはコードを保存） ----------
api.get('/wp-terms', async (req, res, next) => {
  try {
    const media = String(req.query.media || '');
    if (!media || !allowedMedia(req.user, media)) return res.status(400).json({ error: 'メディアの指定が正しくありません' });
    res.json(await wp.termsFor(media));
  } catch (e) { next(e); }
});
const BLOCK_KINDS = { cta: 'CTA', appeal: '訴求ブロック' };
const blocksRef = media => db.collection('article_blocks').doc(require('crypto').createHash('sha1').update(media).digest('hex').slice(0, 20));
api.get('/article-blocks', async (req, res, next) => {
  try {
    const media = String(req.query.media || '');
    if (!media || !allowedMedia(req.user, media)) return res.status(400).json({ error: 'メディアの指定が正しくありません' });
    // CTA・訴求ブロック・記事用コンテンツは WordPress の「マイブロック」から（ダッシュボードでは編集しない。2026-10-26 ユーザー指定）
    let mb = { cta: [], appeal: [], content: [], available: false };
    try { mb = await wp.myBlocksFor(media); } catch (e) { console.warn('myBlocks ' + media + ': ' + e.message); }
    res.json(mb);
  } catch (e) { next(e); }
});
/* 構成シート：リライトする既存記事の構成（H2〜H4・ブロック）を WordPress から読む（2026-11-13 ユーザー指定） */
api.get('/outline/existing', async (req, res) => {
  try {
    const media = String(req.query.media || '');
    if (!media || !allowedMedia(req.user, media) || !req.user.perms || req.user.perms.articles === 'none') return res.status(400).json({ error: 'メディアの指定が正しくありません' });
    res.json(await wp.postStructure(media, { id: req.query.id, url: req.query.url }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
/* 構成シート：記事用コンテンツ（マイブロック）の中の見出し（2026-11-13 ユーザー指定） */
api.get('/outline/block-heads', async (req, res) => {
  try {
    const media = String(req.query.media || '');
    if (!media || !allowedMedia(req.user, media) || !req.user.perms || req.user.perms.articles === 'none') return res.status(400).json({ error: 'メディアの指定が正しくありません' });
    const heads = await wp.myBlockHeads(media, String(req.query.id || ''));
    if (heads == null) return res.status(404).json({ error: 'ブロックが見つかりません' });
    res.json({ heads });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
api.put('/article-blocks', async (req, res, next) => {
  try {
    if (!canArticleSettings(req.user)) return res.status(403).json({ error: '各種設定を編集する権限がありません' });
    const { media, kind } = req.body || {}, name = String((req.body || {}).name || '').trim(), code = String((req.body || {}).code || '');
    if (!media || !allowedMedia(req.user, media) || !BLOCK_KINDS[kind]) return res.status(400).json({ error: '指定が正しくありません' });
    if (!name || name.length > 100) return res.status(400).json({ error: BLOCK_KINDS[kind] + 'の名前を入力してください（100文字まで）' });
    if (!code.trim()) return res.status(400).json({ error: 'ブロックのコードは入力必須です' });
    if (code.length > 50000) return res.status(400).json({ error: 'コードが長すぎます（5万文字まで）' });
    const ref = blocksRef(media), snap = await ref.get(), d = snap.exists ? snap.data() : {};
    const map = d[kind] || {}, key = require('crypto').createHash('sha1').update(name).digest('hex').slice(0, 16);
    map[key] = { name, code, updatedBy: req.user.email, updatedAt: admin.firestore.Timestamp.now() };
    await ref.set({ media, [kind]: map }, { merge: true });
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: BLOCK_KINDS[kind] + 'のコードを保存：' + media + ' ' + name, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
api.delete('/article-blocks', async (req, res, next) => {
  try {
    if (!canArticleSettings(req.user)) return res.status(403).json({ error: '各種設定を編集する権限がありません' });
    const { media, kind, name } = req.body || {};
    if (!media || !allowedMedia(req.user, media) || !BLOCK_KINDS[kind]) return res.status(400).json({ error: '指定が正しくありません' });
    const ref = blocksRef(media), snap = await ref.get(), d = snap.exists ? snap.data() : {};
    const map = d[kind] || {}, key = require('crypto').createHash('sha1').update(String(name)).digest('hex').slice(0, 16);
    delete map[key];
    await ref.set(Object.assign({ media, cta: d.cta || {}, appeal: d.appeal || {} }, { [kind]: map }));   // 消した名前を残さないよう、文書ごと書き直す
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 監修者ありのメディア（記事管理の管理者・メディア数値の管理者が切り替える）
api.put('/article-settings', async (req, res, next) => {
  try {
    const u = req.user;
    if (!(u.status === 'active' && (u.perms.media === 'admin' || u.perms.articles === 'admin'))) return res.status(403).json({ error: '記事管理の管理者だけが変更できます' });
    const { media, supervised, relatedKw } = req.body || {};
    if (!media || !allowedMedia(u, media)) return res.status(400).json({ error: 'メディアの指定が正しくありません' });
    if (relatedKw !== undefined) {   // 関連KWの表示（2026-10-28 ユーザー指定）
      await db.collection('settings').doc('article_media').set({ relatedKw: relatedKw ? admin.firestore.FieldValue.arrayUnion(String(media)) : admin.firestore.FieldValue.arrayRemove(String(media)) }, { merge: true });
      await db.collection('access_logs').add({ uid: u.uid, email: u.email, name: u.name, view: '関連KWの表示設定：' + media + ' → ' + (relatedKw ? '表示' : '非表示'), at: admin.firestore.FieldValue.serverTimestamp() });
      return res.json({ ok: true });
    }
    await db.collection('settings').doc('article_media').set({ supervised: supervised ? admin.firestore.FieldValue.arrayUnion(String(media)) : admin.firestore.FieldValue.arrayRemove(String(media)) }, { merge: true });
    await db.collection('access_logs').add({ uid: u.uid, email: u.email, name: u.name, view: '監修者あり設定：' + media + ' → ' + (supervised ? 'あり' : 'なし'), at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
api.delete('/article-items', async (req, res, next) => {
  try {
    if (!canEditArticles(req.user)) return res.status(403).json({ error: '記事を編集する権限がありません' });
    const key = String((req.body || {}).key || '');
    if (!key.startsWith('entry:')) return res.status(400).json({ error: 'スプレッドシートから取り込んだ記事は削除できません（スプレッドシート側で削除してください）' });
    if (req.user.perms.own && !(await ownsItem(req.user, key))) return res.status(403).json({ error: '自分が担当の記事だけ削除できます' });
    const ref = db.collection('article_entries').doc(key.slice(6));
    const snap = await ref.get();
    if (!snap.exists || !allowedMedia(req.user, snap.data().media)) return res.status(404).json({ error: '記事が見つかりません' });
    await ref.delete();
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '追加した記事を削除：' + key, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 記事管理（各メディアの記事管理シートを取り込んだもの） ----------
// 進行管理のアラート：WordPressで公開された新規記事が、進行管理（アップロード日）より多い月（今月・前月）
api.get('/article-gaps', async (req, res, next) => {
  try {
    if (!req.user.perms || req.user.perms.articles === 'none') return res.status(403).json({ error: '記事管理を見る権限がありません' });
    const ac = await articleCounts();
    const wpm = await cached('wp-monthly-new', TEN_MIN, () => query("SELECT FORMAT_DATE('%Y-%m', month) ym, media, posts_new FROM " + T('wp_monthly') + " QUALIFY ROW_NUMBER() OVER (PARTITION BY media, month ORDER BY collected_at DESC) = 1").catch(() => []));
    const cur = todayJst().slice(0, 7), d = new Date(cur + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); const prev = d.toISOString().slice(0, 7);
    const base = wpm.filter(r => (r.ym === cur || r.ym === prev) && allowedMedia(req.user, r.media) && ac.first[r.media] && r.ym >= ac.first[r.media]);
    // ディレクトリがあるメディアは、ディレクトリごとに比べる（2026-10-28 ユーザー指定）。
    // WordPress の新規記事は、進行管理に同じ記事URLがあればそのディレクトリ、なければURLの最初の階層（例 /washroom/）で多い方のディレクトリ
    const items = await cached('gap-items', TEN_MIN, async () => (await query("SELECT media, IFNULL(sub, '') sub, url FROM " + T('article_items') + " WHERE url IS NOT NULL AND TRIM(url) != ''").catch(() => []))
      .concat((await articleExtras()).entries.filter(e => e.url && !e.deleted).map(e => ({ media: e.media, sub: e.sub || '', url: e.url }))));
    const pathOf = u => { try { return decodeURIComponent(new URL(u).pathname).replace(/\/+$/, '').toLowerCase(); } catch (e) { return ''; } };
    const segOf = p => (p.split('/').filter(Boolean)[0] || '');
    const GAP_SKIP_SUBS = ['過去制作', 'BEST365移管'];   // 以前の記事の置き場（URLの階層の判定には使わない）
    const out = [];
    for (const r of base) {
      const its = items.filter(x => x.media === r.media && x.sub);
      if (!its.length || r.media === 'ガラスお助け') { const x = { media: r.media, ym: r.ym, wp: Number(r.posts_new) || 0, posts: (ac.byKey[r.media + '||' + r.ym] || { new: 0 }).new }; if (x.wp > x.posts) out.push(x); continue; }   // ガラスはタブ＝進行状況の区分なので、メディア全体で
      const byPath = new Map(its.map(x => [pathOf(x.url), x.sub])), seg = {};
      its.filter(x => !GAP_SKIP_SUBS.includes(x.sub)).forEach(x => { const s = segOf(pathOf(x.url)); if (!s) return; const m = seg[s] = seg[s] || {}; m[x.sub] = (m[x.sub] || 0) + 1; });
      const subOfSeg = s => { const m = seg[s]; return m ? Object.entries(m).sort((a, b) => b[1] - a[1])[0][0] : ''; };
      let list = []; try { list = (await wp.listAll(r.ym)).filter(p => p.media === r.media && p.kind === 'new'); } catch (e) { console.warn('article-gaps listAll: ' + e.message); }
      const wpBy = {};
      list.forEach(p => { const pp = pathOf(p.link), sub = byPath.get(pp) || subOfSeg(segOf(pp)) || '（ディレクトリ不明）'; wpBy[sub] = (wpBy[sub] || 0) + 1; });
      Object.entries(wpBy).forEach(([sub, n]) => { const posts = (ac.byKey[r.media + '|' + sub + '|' + r.ym] || { new: 0 }).new; if (n > posts) out.push({ media: r.media, sub, ym: r.ym, wp: n, posts }); });
    }
    res.json(out);
  } catch (e) { next(e); }
});
api.get('/article-items', async (req, res, next) => {
  try {
    if (!req.user.perms || req.user.perms.articles === 'none') return res.status(403).json({ error: '記事管理を見る権限がありません' });
    let rows = [];
    try {
      rows = await cached('article-items', TEN_MIN, () => query(`SELECT * EXCEPT(imported_at),
          CAST(request_date AS STRING) request_date_s, CAST(upload_date AS STRING) upload_date_s, CAST(wp_published AS STRING) wp_published_s, CAST(wp_modified AS STRING) wp_modified_s,
          FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', imported_at, 'Asia/Tokyo') imported
        FROM ${T('article_items')} ORDER BY media, row_no`));
    } catch (e) { console.warn('article_items: ' + e.message); }
    const ex = await articleExtras();
    const ov = Object.fromEntries(ex.overrides.map(o => [o.key, o]));
    const out = rows.filter(r => allowedMedia(req.user, r.media)).map(r => {
      const o = { source: 'sheet' };
      Object.keys(r).forEach(k => {
        if (/^(request_date|upload_date|wp_published|wp_modified)$/.test(k)) return;
        o[k.replace(/_s$/, '')] = r[k];
      });
      o.key = keyOfItem(o);
      const v = ov[o.key];
      if (v) {
        Object.keys(v).filter(k => k.startsWith('f_')).forEach(k => { o[k.slice(2)] = v[k]; });
        o.edited = true; o.editedBy = v.updatedBy; o.editedAt = tsIso(v.updatedAt);
      }
      return o;
    }).filter(o => !o.deleted)   // 進行管理で削除した記事（取り込んだ記事は非表示にするだけ）
      // 何も入っていない行（記事No.だけの空き枠：KW・URL・担当・日付がなく、進行状況が空か未着手）は出さない。進行管理で何か入れた行は出す（2026-10-27 ユーザー指定）
      .filter(o => o.edited || ['kw', 'url', 'outline_url', 'writing_url', 'writer', 'director', 'upload_owner', 'supervisor', 'request_date', 'upload_date', 'memo'].some(k => String(o[k] == null ? '' : o[k]).trim()) || (o.status && o.status !== '未着手'));
    dropDupSheetRows(out, ex.entries, o => o.source === 'sheet');
    ex.entries.filter(e => allowedMedia(req.user, e.media)).forEach(e => {
      const o = { source: 'dashboard', key: 'entry:' + e.id, media: e.media, editedBy: e.updatedBy, editedAt: tsIso(e.updatedAt), createdBy: e.createdBy };
      Object.keys(ARTICLE_FIELDS).forEach(k => { if (e[k] !== undefined) o[k] = e[k]; });
      out.push(o);
    });
    // 自分が担当の記事だけ（ライターなど）：契約管理の氏名か、ユーザー名と一致する担当者の記事
    if (req.user.perms.own) { const names = req.user.personNames || []; for (let i = out.length - 1; i >= 0; i--) { const o = out[i]; if (![o.writer, o.director, o.upload_owner, o.supervisor].some(n => n && names.includes(n)) && !(o.source === 'dashboard' && o.createdBy === req.user.email)) out.splice(i, 1); } }
    // 担当ディレクトリだけ（契約で担当ディレクトリを選んだメディアは、そのディレクトリの記事だけ）（2026-10-14 ユーザー指定）
    if (req.user.subScope) { for (let i = out.length - 1; i >= 0; i--) { const o = out[i], s = req.user.subScope[o.media]; if (Array.isArray(s) && !s.includes(o.sub)) out.splice(i, 1); } }
    // 検索Vol：Ahrefs の直近12か月平均（2026-10-13 ユーザー指定）。まだ取得していないKWはシートの値
    const vols = await kwv.volumes();
    out.forEach(o => { const v = vols.get(kwv.normKw(o.kw)); if (v) { o.vol_avg = v.vol; o.vol_src = 'ahrefs'; o.vol_ym = v.ym; } else if (o.vol_avg != null) o.vol_src = 'sheet'; });
    // ダッシュボードで追加した記事（リライトKWなど）で検索Volがないときは、同じメディア・同じKWの記事の値を使う
    const volByKw = {};
    out.forEach(o => { const k = o.media + '|' + kwv.normKw(o.kw); if (o.kw && o.vol_avg != null && !volByKw[k]) volByKw[k] = o; });
    out.forEach(o => { const x = o.kw && o.vol_avg == null && volByKw[o.media + '|' + kwv.normKw(o.kw)]; if (x) { o.vol_avg = x.vol_avg; o.vol_src = x.vol_src; o.vol_ym = x.vol_ym; } });
    // 記事タイトル（WordPressの公開記事。記事IDかURLで照合）
    const medias = [...new Set(out.map(o => o.media))];
    const titles = Object.fromEntries(await Promise.all(medias.map(m => wp.titlesFor(m).then(t => [m, t]).catch(() => [m, null]))));
    // 公開済みの記事のタグ・カテゴリ（WordPress の値）
    const termNames = Object.fromEntries(await Promise.all(medias.map(m => wp.termsFor(m).then(t => [m, { tags: Object.fromEntries(t.tags.map(x => [x.id, x.name])), cats: Object.fromEntries(t.categories.map(x => [x.id, x.name])) }]).catch(() => [m, null]))));
    const norm = u => String(u || '').replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    out.forEach(o => {
      const t = titles[o.media]; if (!t) return;
      // 記事IDはWordPressから（URLで照合。URLがないときはシートの記事IDが実在すればそれ）
      const sid = String(o.post_id || '').trim();
      o.wp_id = (t.idByUrl || {})[norm(o.url)] || (t.byId[sid] !== undefined ? sid : null);
      o.title = (o.wp_id && t.byId[o.wp_id]) || t.byUrl[norm(o.url)] || null;
      const tn = termNames[o.media];
      if (o.wp_id && tn && t.tagsById) { o.wp_tags = (t.tagsById[o.wp_id] || []).map(id => tn.tags[id]).filter(Boolean); o.wp_categories = (t.catsById[o.wp_id] || []).map(id => tn.cats[id]).filter(Boolean); }
    });
    const ms = await db.collection('settings').doc('article_media').get();
    // 担当者の候補：契約中の人（メディアごと）。自社ライターを使う人は「〇〇（自社ライター）」を執筆担当の候補に足す（2026-10-14 ユーザー指定）
    const people = [];
    /* 担当変更の予定があるメディアも、前もって担当に選べる（2026-11-13 ユーザー指定：12月から担当する人を今のうちに割り当てる） */
    (await activeContracts()).forEach(c => [...new Set(c.medias.concat(c.futureMedias || []))].filter(m => allowedMedia(req.user, m)).forEach(m => {
      people.push({ media: m, name: c.name, position: c.position, category: c.category, writerType: c.position === 'ライター' ? 'BEST契約ライター' : '' });
      if ((c.writerSources || []).includes('自社ライター')) people.push({ media: m, name: c.name + '（自社ライター）', position: 'ライター', category: 'writing', writerType: '自社ライター' });
    }));
    // BEST社員：今月担当しているメディアでは、どの担当（構成・執筆・アップロード・監修）にも選べる（2026-10-28 ユーザー指定）
    let known = (await allContracts()).map(c => c.name).filter(Boolean);
    try { const ms2 = await staffMod.mediaStaff(); known = known.concat(ms2.all); ms2.list.forEach(st => st.medias.filter(m => allowedMedia(req.user, m)).forEach(m => people.push({ media: m, name: st.name, position: 'BEST社員', category: 'staff', staff: true }))); } catch (e) { console.warn('mediaStaff: ' + e.message); }
    res.json({ items: out, canEdit: canEditArticles(req.user), supervised: (ms.exists && ms.data().supervised) || [], relatedKw: (ms.exists && ms.data().relatedKw) || [], people, known: [...new Set(known)] });
  } catch (e) { next(e); }
});

// ---------- 記事目標（月ごと × メディア／ディレクトリ） ----------
// Firestore: article_targets/{YYYY-MM} = { targets: { '<mediaId>': { new: n, rewrite: n } } }
const isYm = s => /^\d{4}-\d{2}$/.test(String(s || ''));
api.get('/targets', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!isYm(from) || !isYm(to)) return res.status(400).json({ error: '期間（from / to）を YYYY-MM で指定してください' });
    const snap = await db.collection('article_targets').where(admin.firestore.FieldPath.documentId(), '>=', from).where(admin.firestore.FieldPath.documentId(), '<=', to).get();
    const out = {};
    snap.docs.forEach(d => {
      const t = d.data().targets || {};
      out[d.id] = Object.fromEntries(Object.entries(t).filter(([id]) => allowedMedia(req.user, id.split('|')[0])));
    });
    res.json(out);
  } catch (e) { next(e); }
});
adminApi.put('/targets', async (req, res, next) => {
  try {
    const months = (req.body || {}).months || {};
    const keys = Object.keys(months);
    if (!keys.length || keys.length > 24 || !keys.every(isYm)) return res.status(400).json({ error: '保存する月の指定が正しくありません' });
    const num = v => v === '' || v == null ? null : Math.max(0, Math.min(9999, Math.floor(Number(v)) || 0));
    const batch = db.batch();
    keys.forEach(ym => {
      const targets = {};
      Object.entries(months[ym] || {}).forEach(([id, v]) => {
        if (typeof id !== 'string' || id.length > 100) return;
        const n = num(v && v.new), r = num(v && v.rewrite);
        if (n != null || r != null) targets[id] = { new: n, rewrite: r };
      });
      batch.set(db.collection('article_targets').doc(ym), { targets, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.email });
    });
    await batch.commit();
    await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '記事目標を保存：' + keys[0] + '〜' + keys[keys.length - 1], at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const wp = require('./wordpress')({ PROJECT, db, query, T, admin, allowedMedia, onDataChanged: () => cache.clear() });
wp.routes(adminApi, api);
const kwv = require('./keywords')({ PROJECT, db, query, T, admin, SA_EMAIL: process.env.ADS_SA_EMAIL || 'dashboard-app@' + PROJECT + '.iam.gserviceaccount.com' });
kwv.routes(adminApi);
const idx = require('./index_check')({ db, admin, query, T, allowedMedia });
idx.routes(api);
const ahr = require('./ahrefs')({ PROJECT, db, query, T, admin, doneKeywords, kwArticles, allowedMedia, kwVolumes: () => kwv.volumes(), kwNorm: k => kwv.normKw(k), mediaName: key => (MEDIA_ORDER.find(([k]) => k === key) || [])[1] || key });
ahr.routes(adminApi, api);
// コピペチェック（Brave Search API の無料分の中で。自社メディアは除く）（2026-10-28 ユーザー指定）
const ccheck = require('./copycheck')({ PROJECT, db, admin, ownUrls: () => Object.values(require('./ahrefs').SITE_URLS || {}), canEdit: canEditArticles,
  urlAllowed: (u, url) => { if (u.scope === 'all' || /docs\.google\.com/.test(String(url || ''))) return true; const S = require('./ahrefs').SITE_URLS || {}; const h = x => { try { return new URL(x).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }; return Object.entries(S).some(([m, s]) => allowedMedia(u, m) && h(s) && h(s) === h(url)); } });   /* 見られるメディアの結果だけ（2026-11-02） */
ccheck.routes(api, adminApi);
// 構成シート（2026-11-12 ユーザー指定）
const comp = require('./competitor')({ db, admin, braveWeb: (q, n) => ccheck.braveWeb(q, n), ownHosts: () => ccheck.ownHosts(), ahrefsKey: () => ahr.loadKey(), onChanged: () => cache.clear() });   /* 競合調査（2026-11-13 ユーザー指定） */
comp.adminRoutes(adminApi, () => MEDIA_ORDER.map(([k]) => k));
require('./outline')({ db, admin, query, T, allowedMedia, capOk, docIdOf, keyOfItem, WRITER_ROLES, comp }).routes(api);
// Gmail からのメール送信（marketing@ だけ。連携はフル管理者だけ。2026-10-28 ユーザー指定）
const gmail = require('./gmail')({ PROJECT, db, admin, isFullAdmin });
gmail.routes(app, adminApi);
// 機能改善依頼とタスク通知（2026-10-29 ユーザー指定）
require('./feedback')({ db, admin, isFullAdmin, capOk, gmail, pendingWork: () => staffMod.pendingWork(), errPending: () => errMod.pending(), appUrl: req => 'https://' + req.get('host') + '/' }).routes(api, adminApi);
// 請求書（2026-10-29 ユーザー指定）
/** その月に完了した（アップロード日が入った）記事の担当（構成・執筆・アップロード・監修）になっている契約のID（未請求のアラート用。2026-10-29） */
async function contractsWithArticles(ym) {
  const rows = await cached('article-items', TEN_MIN, () => query("SELECT * EXCEPT(imported_at), CAST(request_date AS STRING) request_date_s, CAST(upload_date AS STRING) upload_date_s, CAST(wp_published AS STRING) wp_published_s, CAST(wp_modified AS STRING) wp_modified_s, FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', imported_at, 'Asia/Tokyo') imported FROM " + T('article_items') + ' ORDER BY media, row_no')).catch(() => []);
  const ex = await articleExtras(), ov = Object.fromEntries(ex.overrides.map(o => [o.key, o]));
  const items = rows.map(r => { const o = {}; Object.keys(r).forEach(k => { if (!/^(request_date|upload_date|wp_published|wp_modified)$/.test(k)) o[k.replace(/_s$/, '')] = r[k]; }); const v = ov[keyOfItem(o)]; if (v) Object.keys(v).filter(k => k.startsWith('f_')).forEach(k => { o[k.slice(2)] = v[k]; }); return o; }).filter(o => !o.deleted)
    .concat(ex.entries.filter(e => !e.deleted).map(e => Object.assign({ media: e.media }, e)));
  const today = todayJst(), cs = await activeContracts(), norm = s => String(s || '').replace(/[\s　]/g, ''), ids = new Set();
  for (const o of items.filter(o => o.upload_date && String(o.upload_date).startsWith(ym) && String(o.upload_date) <= today)) {
    for (const f of ['director', 'writer', 'upload_owner', 'supervisor']) {
      const n = String(o[f] || '').trim(); if (!n) continue;
      const c = cs.find(x => norm(x.name) === norm(n)); if (c) { ids.add(c.id); continue; }
      const r = await personLinks.resolve(n, o.media, o.upload_date).catch(() => null); if (r && r.kind === 'contract') ids.add(r.id);
    }
  }
  return ids;
}
const invoiceMod = require('./invoices')({ db, admin, isFullAdmin, expView, gmail, allContracts, activeContracts, contractsWithArticles, extraForBatch: (ym, opt) => expenseMod.forBatch(ym, opt), mediaLabel: m => (MEDIA_ORDER.find(x => x[0] === m) || [])[1] || m, todayJst, appUrl: req => 'https://' + req.get('host') + '/' });
invoiceMod.routes(api);
const msm = require('./moshimo')({ PROJECT, db, query, T, admin, mediaKeys: MEDIA_ORDER.map(([k]) => k), mediaName: key => (MEDIA_ORDER.find(([k]) => k === key) || [])[1] || key });
msm.routes(api, adminApi, {
  canRevenue: u => u.status === 'active' && (u.perms.media === 'admin' || ['admin', 'viewer'].includes(u.perms.revenue)), allowedMedia,
  onDataChanged: () => cache.clear(),
});
const kin = require('./kintone')({ PROJECT, db, query, T, admin });
kin.routes(adminApi, api, {
  canRevenue: u => u.status === 'active' && (u.perms.media === 'admin' || ['admin', 'viewer'].includes(u.perms.revenue)), allowedMedia,
  // 回線名（例：ガラスお助け本舗(SEO)回線）の先頭がメディア名ならそのメディア
  mediaName: key => (MEDIA_ORDER.find(([k]) => k === key) || [])[1] || key,
  mediaOfLine: line => (MEDIA_ORDER.find(([, name]) => String(line || '').startsWith(name)) || [])[0] || '',
});

// 定期実行（Cloud Scheduler → OIDCトークン付きで呼ばれる）
const oidc = new OAuth2Client();
async function taskAuth(req, res, next) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    const ticket = await oidc.verifyIdToken({ idToken: m && m[1], audience: SERVICE_URL + req.path });
    if (ticket.getPayload().email !== TASK_SA_EMAIL) throw new Error('invalid caller');
    next();
  } catch (e) { res.status(401).json({ error: 'unauthorized' }); }
}
app.post('/tasks/wp-collect', taskAuth, async (req, res) => {
  const results = await wp.collectAll();
  const failed = results.filter(r => !r.ok);
  res.status(failed.length ? 500 : 200).json({ results });
});

app.post('/tasks/kintone-collect', taskAuth, async (req, res) => {
  const r = await kin.collect();
  res.status(r.ok ? 200 : 500).json(r);
});
app.post('/tasks/ahrefs-sync', taskAuth, async (req, res) => {
  const r = await ahr.sync();
  res.status(r.ok ? 200 : 500).json(r);
});
app.post('/tasks/ahrefs-fetch', taskAuth, async (req, res) => {
  const r = await ahr.fetchMonthly();
  res.status(r.ok ? 200 : 500).json(r);
});
app.post('/tasks/moshimo', taskAuth, async (req, res) => {   // 毎月2日・15日 5:30（2026-10-14 ユーザー指定）
  const r = await msm.collect('自動取得');
  if (r.ok) cache.clear();
  res.status(r.ok ? 200 : 500).json(r);
});
app.post('/tasks/index-check', taskAuth, async (req, res) => {   // 毎日：Search Console のインデックス状況（2026-10-28 ユーザー指定）
  const r = await idx.collect();
  try { r.supabase = await supa.copyDaily(); } catch (e) { console.error('supabase copy', e.message); r.supabase = { ok: false, error: e.message }; }   /* ついでに BigQuery → Supabase の毎日の写し（2026-11-05） */
  res.status(r.ok ? 200 : 500).json(r);
});
app.post('/tasks/invoice-alerts', taskAuth, async (req, res) => {   // 請求のアラート：mode=stale 毎朝9時（請求担当が平日2日間確認していない）／mode=unrequested 毎月3日0:00（担当記事があるのに未請求）（2026-10-29 ユーザー指定）
  try { res.json(await invoiceMod.alerts(String(req.query.mode || ''), 'https://' + req.get('host') + '/')); } catch (e) { console.error('invoice-alerts', e); res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/tasks/kw-volume', taskAuth, async (req, res) => {
  const r = await kwv.collect({ scheduled: true });   // 「毎月の自動取得」を有効にしたときだけ取る
  res.status(r.ok ? 200 : 500).json(r);
});

aiG.routes(api, adminApi);
app.use('/api/admin', adminApi);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: '見つかりません' }));

// index.html は毎回取り直させる（更新がすぐ反映されるように）。CSS・JS は ?v= 付きで読み込むので5分キャッシュ
// デプロイしたファイルの日付が固定（1980年）なので、ETag・Last-Modified だと ?v= の数字だけ変えた index.html が「同じ」と判定されて古いままになる（2026-10-27）。index.html は no-store で毎回送る
const sendIndex = async (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', (await hasSession(req)) ? 'index.html' : 'login.html'), { etag: false, lastModified: false }); };
// 画面のプログラムは通行証がある人だけ（ログイン画面に要るものは誰でも）
const PUBLIC_FILES = ['/gate.js', '/login.html', '/index.html', '/robots.txt', '/favicon.ico'];   // /index.html は sendIndex がログイン画面に切り替える
app.use(async (req, res, next) => { if (PUBLIC_FILES.includes(req.path) || !/\.(js|css|html|json|map)$/.test(req.path)) return next(); if (await hasSession(req)) return next(); res.status(403).type('text/plain').send('ログインしてください'); });
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
}));
app.get('*', sendIndex);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'サーバーでエラーが起きました。時間をおいてもう一度試してください' });
});

app.listen(PORT, () => console.log('listening on ' + PORT));
