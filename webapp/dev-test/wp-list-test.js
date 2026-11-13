const wp = require('../wordpress')({ PROJECT: 'x', db: { collection: () => ({ doc: () => ({}) }) }, query: async () => [], T: n => n, admin: {}, allowedMedia: () => true, onDataChanged: () => {} });
(async () => {
  for (const [u, ym] of [['https://hachi.otasuke-honpo.com', '2026-09'], ['https://gaichugaiju.best24.co.jp', '2026-10']]) {
    const rows = await wp._test.listMonth({ url: u }, ym);
    const c = await wp._test.countMonth({ url: u }, ym);
    console.log(u, ym, 'list new=' + rows.filter(r => r.kind === 'new').length, 'rewrite=' + rows.filter(r => r.kind === 'rewrite').length, '| count new=' + c.posts_new, 'rewrite=' + c.rewrites);
    console.log('  e.g.', JSON.stringify(rows[0]));
  }
})();
