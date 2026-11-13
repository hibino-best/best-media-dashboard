// Gmail からのメール送信（2026-10-28 ユーザー指定）
// ドメイン全体の委任は使わない（全アドレスになりすませるため）。送信元のアドレス（marketing@）本人が一度だけ
// 「メールの送信だけ」を許可し、その許可（リフレッシュトークン）を Secret Manager に保存する。連携・解除・設定はフル管理者だけ。
const crypto = require('crypto');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const CLIENT_SECRET_ID = 'gmail-oauth-client';    // {client_id, client_secret}
const TOKEN_SECRET_ID = 'gmail-refresh-token';
const DEFAULT_SENDER = 'marketing@best-24.jp';
// marketing@ はグループ（ログインできない）なので、グループのメンバーのアカウント（account）で連携し、
// そのアカウントの Gmail に「送信元」として登録した marketing@ から送る（2026-10-28 ユーザー指定 B）
const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send';   // 送信だけ（読む・消すはできない）

module.exports = function gmail({ PROJECT, db, admin, isFullAdmin }) {
  const sm = new SecretManagerServiceClient();
  const settingsRef = db.collection('settings').doc('gmail');
  const cache = {};
  async function readSecret(id) {
    if (cache[id] && cache[id].until > Date.now()) return cache[id].v;
    try { const [v] = await sm.accessSecretVersion({ name: `projects/${PROJECT}/secrets/${id}/versions/latest` }); const s = v.payload.data.toString('utf8').trim(); cache[id] = { v: s, until: Date.now() + 10 * 60 * 1000 }; return s; } catch (e) { return ''; }
  }
  async function writeSecret(id, value) {
    const name = `projects/${PROJECT}/secrets/${id}`;
    try { await sm.getSecret({ name }); } catch (e) { if (e.code !== 5) throw e; await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: id, secret: { replication: { automatic: {} } } }); }
    await sm.addSecretVersion({ parent: name, payload: { data: Buffer.from(value, 'utf8') } });
    delete cache[id];
  }
  async function settings() { const s = await settingsRef.get(); return s.exists ? s.data() : {}; }
  async function client() { try { const c = JSON.parse(await readSecret(CLIENT_SECRET_ID) || '{}'); return c.client_id && c.client_secret ? c : null; } catch (e) { return null; } }
  const redirectOf = req => 'https://' + req.get('host') + '/oauth/gmail/callback';
  const enc = s => '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';

  let tokCache = null;
  async function accessToken() {
    if (tokCache && tokCache.until > Date.now()) return tokCache.v;
    const c = await client(), rt = await readSecret(TOKEN_SECRET_ID);
    if (!c || !rt) throw new Error('Gmail の連携ができていません（API・連携設定 →「メール送信（Gmail）」）');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: rt, grant_type: 'refresh_token' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { if (j.error === 'invalid_grant') await settingsRef.set({ connected: false, lastError: '許可が取り消されたか期限切れです。もう一度連携してください' }, { merge: true }); throw new Error('Gmail の許可を使えませんでした（' + (j.error || r.status) + '）'); }
    tokCache = { v: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
    return tokCache.v;
  }
  /** メールを送る（送信元は連携したアドレスだけ） */
  async function send({ to, cc, subject, body, attachments }) {
    const s = await settings(); if (!s.connected || !s.sender) throw new Error('Gmail の連携ができていません');
    const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
    const head = ['From: ' + enc('BEST MEDIA') + ' <' + s.sender + '>', 'To: ' + to].concat(cc ? ['Cc: ' + cc] : [], ['Subject: ' + enc(subject), 'MIME-Version: 1.0']);
    const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(String(body || ''), 'utf8'))];
    let msg;
    if (attachments && attachments.length) {   // 添付つき（請求書の PDF など。2026-10-29）
      const bd = 'bm_' + crypto.randomBytes(12).toString('hex');
      msg = head.concat(['Content-Type: multipart/mixed; boundary="' + bd + '"', '', '--' + bd], text, attachments.flatMap(a => ['--' + bd, 'Content-Type: ' + (a.type || 'application/octet-stream') + '; name="' + enc(a.filename) + '"', 'Content-Disposition: attachment; filename="' + enc(a.filename) + '"; filename*=UTF-8\'\'' + encodeURIComponent(a.filename), 'Content-Transfer-Encoding: base64', '', b64(a.content)]), ['--' + bd + '--', '']).join('\r\n');
    } else msg = head.concat(text).join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(msg).toString('base64url') }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('送信できませんでした（' + ((j.error && j.error.message) || r.status) + '）'); }
    return true;
  }
  /** 予約されたメール（mail_queue）を送る。連携していなければ何もしない */
  let flushing = false;
  async function flush() {
    if (flushing) return 0; flushing = true; let n = 0;
    try {
      const s = await settings(); if (!s.connected) return 0;
      const q = await db.collection('mail_queue').where('status', '==', 'queued').limit(20).get();
      for (const d of q.docs) {
        const m = d.data();
        try { await send(m); await d.ref.update({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp() }); n++; }
        catch (e) { await d.ref.update({ status: (m.tries || 0) >= 2 ? 'error' : 'queued', tries: (m.tries || 0) + 1, error: e.message }); }
      }
    } finally { flushing = false; }
    return n;
  }

  function routes(app, adminApi) {
    const fullOnly = (req, res, next) => isFullAdmin(req.realUser || req.user) && !req.realUser ? next() : res.status(403).json({ error: 'Gmail の連携はフル管理者だけが設定できます' });
    adminApi.get('/gmail', fullOnly, async (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        const s = await settings(), c = await client();
        const queued = (await db.collection('mail_queue').where('status', '==', 'queued').get()).size;
        res.json({ sender: s.sender || DEFAULT_SENDER, account: s.account || '', hasClient: !!c, connected: !!s.connected && !!(await readSecret(TOKEN_SECRET_ID)), connectedAt: s.connectedAt || null, connectedBy: s.connectedBy || '', lastError: s.lastError || '', redirectUri: redirectOf(req), queued });
      } catch (e) { next(e); }
    });
    // OAuth クライアント（ID・シークレット）と送信元のアドレス
    adminApi.put('/gmail', fullOnly, async (req, res, next) => {
      try {
        const b = req.body || {}, s = await settings();
        if (b.clientId || b.clientSecret) {
          const old = (await client()) || {};
          const c = { client_id: String(b.clientId || old.client_id || '').trim(), client_secret: String(b.clientSecret || old.client_secret || '').trim() };
          if (!/\.apps\.googleusercontent\.com$/.test(c.client_id) || !c.client_secret) return res.status(400).json({ error: 'クライアントID（…apps.googleusercontent.com）とクライアントシークレットを入れてください' });
          await writeSecret(CLIENT_SECRET_ID, JSON.stringify(c));
        }
        if (b.account !== undefined) {   // 連携するアカウント（送信元と同じドメインの人だけ）
          const account = String(b.account).trim().toLowerCase(), dom = (String(b.sender || s.sender || DEFAULT_SENDER).split('@')[1] || '').toLowerCase();
          if (!/^[^@\s]+@[^@\s]+$/.test(account) || account.split('@')[1] !== dom) return res.status(400).json({ error: '連携するアカウントは @' + dom + ' のアドレスにしてください' });
          if (account !== (s.account || '')) await settingsRef.set({ account, connected: false }, { merge: true });   // アカウントを変えたら連携し直し
        }
        if (b.sender !== undefined) {
          const sender = String(b.sender).trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+$/.test(sender)) return res.status(400).json({ error: '送信元のメールアドレスが正しくありません' });
          if (sender !== (s.sender || DEFAULT_SENDER)) await settingsRef.set({ sender, connected: false }, { merge: true });   // アドレスを変えたら連携し直し
          else await settingsRef.set({ sender }, { merge: true });
        }
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'Gmail 連携の設定を変更', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 連携の開始：Google の許可画面の URL を返す（10分だけ有効な合言葉 state を付ける）
    adminApi.post('/gmail/start', fullOnly, async (req, res, next) => {
      try {
        const c = await client(); if (!c) return res.status(400).json({ error: '先にクライアントIDとシークレットを保存してください' });
        const s = await settings(); if (!s.account) return res.status(400).json({ error: '先に「連携するアカウント」を保存してください' });
        const state = crypto.randomBytes(24).toString('hex');
        await db.collection('gmail_oauth_states').doc(state).set({ uid: req.user.uid, email: req.user.email, at: Date.now() });
        const u = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: c.client_id, redirect_uri: redirectOf(req), response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent select_account', login_hint: s.account, state });
        res.json({ url: u });
      } catch (e) { next(e); }
    });
    adminApi.post('/gmail/test', fullOnly, async (req, res) => {
      try { await send({ to: req.user.email, subject: '【BEST MEDIA】テスト送信', body: 'ダッシュボードからのテスト送信です。\nこのメールが届いていれば、Gmail の連携はできています。' }); res.json({ ok: true, to: req.user.email }); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    adminApi.post('/gmail/flush', fullOnly, async (req, res) => { try { res.json({ sent: await flush() }); } catch (e) { res.status(400).json({ error: e.message }); } });
    adminApi.post('/gmail/disconnect', fullOnly, async (req, res, next) => {
      try {
        const rt = await readSecret(TOKEN_SECRET_ID);
        if (rt) await fetch('https://oauth2.googleapis.com/revoke?' + new URLSearchParams({ token: rt }), { method: 'POST' }).catch(() => {});
        await writeSecret(TOKEN_SECRET_ID, '');
        tokCache = null;
        await settingsRef.set({ connected: false, connectedAt: null, connectedBy: '', lastError: '' }, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'Gmail 連携を解除', at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // Google の許可画面から戻ってくるところ。合言葉（フル管理者が10分以内に発行・1回だけ）と、許可したアカウントが送信元のアドレスかを確かめる
    app.get('/oauth/gmail/callback', async (req, res) => {
      const page = (ok, msg) => res.status(ok ? 200 : 400).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail 連携</title><body style="font-family:sans-serif;padding:32px;line-height:1.8"><h2>' + (ok ? 'Gmail の連携ができました' : 'Gmail の連携ができませんでした') + '</h2><p>' + msg.replace(/[<>&]/g, '') + '</p><p>このタブを閉じて、ダッシュボードの「API・連携設定」を開き直してください。</p></body>');
      try {
        const state = String(req.query.state || ''), code = String(req.query.code || '');
        if (req.query.error) return page(false, '許可されませんでした（' + String(req.query.error) + '）');
        if (!/^[0-9a-f]{48}$/.test(state) || !code) return page(false, '連携の情報が正しくありません');
        const ref = db.collection('gmail_oauth_states').doc(state), st = await ref.get();
        if (!st.exists || Date.now() - st.data().at > 10 * 60 * 1000) return page(false, '時間切れです。もう一度「連携する」から始めてください');
        await ref.delete();   // 合言葉はフル管理者だけが発行できる（/gmail/start）
        const c = await client(); if (!c) return page(false, 'クライアントIDが保存されていません');
        const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirectOf(req), grant_type: 'authorization_code' }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.refresh_token || !j.id_token) return page(false, '許可の受け取りに失敗しました（' + (j.error || r.status) + '）');
        const claims = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString());
        const s = await settings(), sender = s.sender || DEFAULT_SENDER, account = s.account || '', email = String(claims.email || '').toLowerCase();
        if (!account || email !== account || claims.email_verified === false) {   // 決めたアカウント以外で許可されたら、すぐに取り消して保存しない
          await fetch('https://oauth2.googleapis.com/revoke?' + new URLSearchParams({ token: j.refresh_token }), { method: 'POST' }).catch(() => {});
          return page(false, email + ' で許可されました。' + account + ' でログインして許可してください（今回の許可は取り消しました）');
        }
        await writeSecret(TOKEN_SECRET_ID, j.refresh_token);
        tokCache = null;
        await settingsRef.set({ sender, connected: true, connectedAt: new Date().toISOString(), connectedBy: st.data().email || '', connectedAccount: account, lastError: '' }, { merge: true });
        await db.collection('access_logs').add({ uid: st.data().uid, email: st.data().email, view: 'Gmail 連携（' + account + ' → 送信元 ' + sender + '）', at: admin.firestore.FieldValue.serverTimestamp() });
        page(true, account + ' で連携しました（送信だけの許可です）。送信元は ' + sender + ' です。ダッシュボードの「自分にテスト送信」で、届いたメールの送信元が ' + sender + ' になっているか確かめてください（' + account + ' の Gmail に送信元として登録されていないと、' + account + ' から送られます）。');
      } catch (e) { console.error('gmail callback', e); page(false, 'エラーが起きました'); }
    });
  }
  return { routes, send, flush };
};
