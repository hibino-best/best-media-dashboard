// 実サイトに対して、公開記事の件数取得と認証の判定を試す（読み取りのみ・保存しない）
const wpModule = require('../wordpress');
const dummy = { PROJECT: 'x', db: { collection: () => ({ doc: () => ({}) }) }, query: async () => [], T: n => n, admin: {}, allowedMedia: () => true, onDataChanged: () => {} };
const { _test } = wpModule(dummy);
(async () => {
  for (const url of ['https://otasuke-honpo.com/', 'https://hachi.otasuke-honpo.com/', 'https://gaijyu.otasuke-honpo.com/']) {
    try {
      const st = await _test.countStatus({ url, user: 'test', pass: 'aaaa bbbb cccc dddd eeee ffff' });
      const m = await _test.countMonth({ url, user: '', pass: '' }, '2026-09');
      console.log(url, JSON.stringify({ published: st.published, auth: st.auth, sep: m }));
    } catch (e) { console.log(url, 'ERROR', e.message); }
  }
})();
