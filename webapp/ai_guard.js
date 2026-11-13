// AI による情報の抜き取りを防ぐ・見つける（2026-10-28 ユーザー指定）
// ・B：名乗っている AI の収集ロボット（GPTBot・ClaudeBot など）は入口で断る
// ・C：検索・AI 学習の対象外にする宣言（robots.txt・X-Robots-Tag）
// ・ログインした人の画面が自動操作されている／短時間に大量に読んでいるときは、承認していないアカウントなら記録して、本人の画面に出し、日比野へメール（送信のしくみができるまではメールの予約として残す）
// ・承認したアカウント（Firestore settings/ai_access の emails）は対象外
const BOT_RE = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|cohere-training|Diffbot|YouBot|meta-externalagent|meta-externalfetcher|FacebookBot|Google-Extended|GoogleOther|Timpibot|ImagesiftBot|Omgili|PetalBot|AI2Bot|Kangaroo Bot|Scrapy|python-requests|HeadlessChrome|PhantomJS/i;
const ALERT_TO = 'yoshihiro.hibino@best-24.jp';   // アラートの宛先（日比野）
const RATE_WINDOW = 2 * 60 * 1000, RATE_LIMIT = 150;   // 2分で150回をこえる読み込み＝人の操作ではない可能性

module.exports = function aiGuard({ db, admin, onQueued }) {
  let approvedCache = null;
  async function approved() {
    if (approvedCache && approvedCache.until > Date.now()) return approvedCache.value;
    const d = (await db.collection('settings').doc('ai_access').get()).data() || {};
    approvedCache = { value: d.emails || {}, until: Date.now() + 60 * 1000 };
    return approvedCache.value;
  }
  const isApproved = async email => !!email && !!(await approved())[String(email).toLowerCase()];
  const last = new Map();   // 同じ内容のアラートは30分に1回
  async function alert(kind, info) {
    const key = kind + '|' + (info.email || info.ua || '') + '|' + (info.ip || '');
    if (last.get(key) > Date.now() - 30 * 60 * 1000) return;
    last.set(key, Date.now());
    const label = { bot: 'AI の収集ロボットからのアクセス（ブロック済み）', automation: '画面の自動操作（AI・ツールの可能性）', rate: '短時間に大量のデータの読み込み' }[kind] || kind;
    const doc = Object.assign({ kind, label, at: admin.firestore.FieldValue.serverTimestamp() }, info);
    await db.collection('ai_alerts').add(doc).catch(() => {});
    await db.collection('mail_queue').add({ to: ALERT_TO, subject: '【BEST MEDIA】AIによる情報取得の可能性を検知しました', body: [label, 'アカウント：' + (info.email || '（ログインなし）'), 'ブラウザ：' + (info.ua || ''), 'IP：' + (info.ip || ''), '場所：' + (info.path || ''), info.detail ? '内容：' + info.detail : ''].filter(Boolean).join('\n'), status: 'queued', kind: 'ai_alert', createdAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    if (onQueued) Promise.resolve().then(onQueued).catch(e => console.warn('mail flush: ' + e.message));   /* Gmail 連携済みならすぐ送る */
  }
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

  /** B：AI の収集ロボットは断る */
  function botBlock(req, res, next) {
    const ua = String(req.headers['user-agent'] || '');
    if (req.path.startsWith('/tasks/')) return next();   // 定期実行（Cloud Scheduler）は通す
    if (BOT_RE.test(ua)) { alert('bot', { ua: ua.slice(0, 300), ip: ipOf(req), path: req.path }); return res.status(403).type('text/plain').send('Forbidden'); }
    next();
  }
  /** C：検索・AI 学習の対象外 */
  function noIndex(req, res, next) { res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noai, noimageai'); next(); }
  const robots = (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n');

  /** ログインした人の読み込みの回数を見る（承認したアカウントは対象外） */
  const hits = new Map();
  async function rateWatch(req, res) {
    const u = req.user; if (!u || !u.email) return;
    const now = Date.now(), arr = (hits.get(u.email) || []).filter(t => t > now - RATE_WINDOW); arr.push(now); hits.set(u.email, arr);
    if (arr.length > RATE_LIMIT && !(await isApproved(u.email))) {
      res.set('X-AI-Warn', '1');
      alert('rate', { email: u.email, ua: String(req.headers['user-agent'] || '').slice(0, 300), ip: ipOf(req), path: req.path, detail: '2分間に' + arr.length + '回の読み込み' });
    }
  }

  function routes(api, adminApi) {
    // 画面が自動操作されている印（navigator.webdriver など）を本人の画面から知らせる
    api.post('/ai-signal', async (req, res, next) => {
      try {
        const u = req.user;
        if (await isApproved(u.email)) return res.json({ warn: false, approved: true });
        await alert('automation', { email: u.email, ua: String(req.headers['user-agent'] || '').slice(0, 300), ip: ipOf(req), path: String((req.body || {}).path || '').slice(0, 200), detail: String((req.body || {}).detail || '').slice(0, 300) });
        res.json({ warn: true });
      } catch (e) { next(e); }
    });
    // API・連携設定：承認したアカウントとアラートの一覧
    adminApi.get('/ai-access', async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const emails = await approved();
        const alerts = (await db.collection('ai_alerts').orderBy('at', 'desc').limit(100).get()).docs.map(d => { const v = d.data(); return Object.assign({ id: d.id }, v, { at: v.at && v.at.toDate ? v.at.toDate().toISOString() : null }); });
        const users = (await db.collection('users').get()).docs.map(d => ({ email: d.data().email || '', name: d.data().name || '', status: d.data().status || '' })).filter(x => x.email && x.status === 'active');
        const queued = (await db.collection('mail_queue').where('status', '==', 'queued').get()).size;
        res.json({ approved: Object.entries(emails).map(([email, v]) => Object.assign({ email }, v)), alerts, users, queued });
      } catch (e) { next(e); }
    });
    adminApi.put('/ai-access', async (req, res, next) => {
      try {
        const email = String((req.body || {}).email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスを入力してください' });
        await db.collection('settings').doc('ai_access').set({ emails: { [email]: { note: String((req.body || {}).note || '').slice(0, 200), by: req.user.email, at: new Date().toISOString() } } }, { merge: true });
        approvedCache = null; res.json({ ok: true });
      } catch (e) { next(e); }
    });
    adminApi.delete('/ai-access/:email', async (req, res, next) => {
      try {
        const email = String(req.params.email || '').toLowerCase();
        const ref = db.collection('settings').doc('ai_access'), d = (await ref.get()).data() || {}, em = d.emails || {}; delete em[email]; await ref.set({ emails: em });
        approvedCache = null; res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }
  return { botBlock, noIndex, robots, rateWatch, routes, isApproved };
};
