// ログイン画面（ログインしていない人に配るのはこれだけ）。ログインできたら /auth/session で通行証（クッキー）をもらい、ダッシュボードの本体を読み込み直す（2026-10-28 ユーザー指定）
(async () => {
  const $ = id => document.getElementById(id);
  const err = m => { $('err').textContent = m || ''; $('err').hidden = !m; };
  const MSG = { 'auth/invalid-credential': 'メールアドレスかパスワードが違います', 'auth/wrong-password': 'メールアドレスかパスワードが違います', 'auth/user-not-found': 'このメールアドレスは登録されていません', 'auth/email-already-in-use': 'このメールアドレスは登録済みです。ログインしてください', 'auth/weak-password': 'パスワードは8文字以上にしてください', 'auth/invalid-email': 'メールアドレスの形式が正しくありません', 'auth/too-many-requests': '試行回数が多すぎます。しばらくしてから試してください', 'auth/popup-closed-by-user': '' };
  const msg = e => MSG[e.code] !== undefined ? MSG[e.code] : (e.message || 'ログインできませんでした');
  let busy = false;
  const cfg = await fetch('/api/config').then(r => r.json());
  firebase.initializeApp(cfg.firebase);
  const auth = firebase.auth();
  auth.onAuthStateChanged(async user => {
    if (!user || busy) return;
    busy = true;
    try {
      const r = await fetch('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: await user.getIdToken(true) }), credentials: 'same-origin' });
      const b = await r.json().catch(() => ({}));
      if (r.ok) { location.reload(); return; }
      err(b.error || 'ログインできませんでした'); $('logout').hidden = false;
    } catch (e) { err('ログインできませんでした。もう一度試してください'); }
    busy = false;
  });
  $('form').onsubmit = ev => ev.preventDefault();   // ログインは Googleアカウントだけ（2026-10-28 ユーザー指定）
  $('google').onclick = async () => { err(''); try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch (e) { err(msg(e)); } };
  $('logout').onclick = () => auth.signOut().then(() => { err(''); $('logout').hidden = true; });
})();
