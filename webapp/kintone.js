/**
 * kintone 連携（収益管理・SEO回線）
 *
 * お客様情報を入れないための決まり（2026-10-09 決定）
 * - kintone からは下の FIELDS に書いた項目だけを fields 指定で取得する。
 *   お客様名・カナ名・電話番号・メールアドレス・郵便番号・町名・番地・建物名は取得しない（通信にも乗らない）
 * - 住所は kintone の「都道府県」と「市・区・都」（市区町村）だけ
 * - 対象は 回線種別＝SEO の案件だけ（kintone 側の検索条件で絞るので、SEO 以外の案件は受け取らない）
 * - APIトークンは Secret Manager（kintone-token）。「レコード閲覧」だけのトークンを使う
 * 収益は BigQuery の条件表（revenue_rules／worker_alias。Apps Script の importRevenueTables で毎日取り込み）で計算する
 */
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const SECRET_ID = 'kintone-token';
const LINE_TYPE = 'SEO';
// 回線種別が空欄でも SEO として取り込む回線（2026-10-26 ユーザー確認：BEST365回線は kintone の回線種別が空欄）
const EXTRA_LINES = ['BEST365回線'];
// 2025/09 以前の案件は回線種別が空欄。回線名に「(SEO)」がある案件は SEO として取り込む（2026-10-26 確認：これで訪問確定がスプレッドシートと一致）
const isSeoName = name => /[（(]SEO[)）]/.test(String(name || ''));
// kintone の項目コード（案件管理アプリ）
const FIELDS = {
  received: '受付日時', lineType: '回線種別', lineName: '回線名', inquiry: '作業内容・問い合わせ内容', pref: '都道府県', city: '市・区・都',
  workerKt: '作業員KT有効', workerNg: '作業員KT無効', companyKt: 'KT有効担当会社経理用', companyNg: 'KT無効担当会社経理用',
  fCall: '有効コールフラグ数値', fOpCall: 'OP有効コールフラグ数値', fVisit: '訪問確定フラグ数値', fLost: '失注フラグ数値',
  result: '結果', status: 'ステータス', receipt: '受付結果', sales: '売上合計金額税込み', deductParts: '部材費控除額', deductCost: '経費控除額', visitDate: '訪問日k',
};
// 念のため：お客様情報らしいコードが FIELDS に入っていないか（入っていたら起動時に止める）
const PERSONAL = /お客様|氏名|名前|カナ|電話|連絡先|メール|郵便|番地|建物|町名|住所|立会者|支払者|紹介者/;
Object.values(FIELDS).forEach(code => { if (PERSONAL.test(code)) throw new Error('kintone.js: お客様情報の可能性がある項目を取得しようとしています：' + code); });

module.exports = function kintone({ PROJECT, db, query, T, admin }) {
  const sm = new SecretManagerServiceClient();
  const ref = db.collection('settings').doc('kintone');
  const secretName = `projects/${PROJECT}/secrets/${SECRET_ID}`;
  const getSettings = async () => { const s = await ref.get(); return s.exists ? s.data() : {}; };
  async function saveToken(token) {
    try { await sm.getSecret({ name: secretName }); } catch (e) {
      if (e.code !== 5) throw e;
      await sm.createSecret({ parent: `projects/${PROJECT}`, secretId: SECRET_ID, secret: { replication: { automatic: {} } } });
    }
    await sm.addSecretVersion({ parent: secretName, payload: { data: Buffer.from(token, 'utf8') } });
  }
  async function loadToken() { const [v] = await sm.accessSecretVersion({ name: secretName + '/versions/latest' }); return v.payload.data.toString('utf8').trim(); }
  async function kfetch(s, path, opt = {}) {
    if (!/^[a-z0-9-]+$/i.test(s.subdomain || '')) throw new Error('kintoneのサブドメインが未登録です');
    const res = await fetch('https://' + s.subdomain + '.cybozu.com' + path, Object.assign({ signal: AbortSignal.timeout(60000) }, opt, { headers: Object.assign({ 'X-Cybozu-API-Token': await loadToken() }, opt.headers || {}) }));
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch (e) { /* HTML */ }
    if (!res.ok) {
      if (res.status === 401 || /GAIA_IA0[12]|CB_WA01|GAIA_NO01/.test(j.code || '')) throw new Error('APIトークンが正しくないか、このアプリのトークンではありません');
      if (/CB_NO02|GAIA_AP01/.test(j.code || '')) throw new Error('トークンに「レコード閲覧」の権限がないか、アプリIDが違います');
      if (/CB_VA01|GAIA_IQ/.test(j.code || '')) throw new Error('kintoneの項目が見つかりません（項目コードが変わった可能性があります）：' + (j.message || ''));
      throw new Error('kintoneのエラー（' + res.status + (j.message ? '：' + j.message : '') + '）');
    }
    return j;
  }

  let tableReady = false;
  async function ensureTable() {
    if (tableReady) return;
    await query(`CREATE TABLE IF NOT EXISTS ${T('kintone_seo')} (record_id INT64, received_at TIMESTAMP, date DATE, hour INT64, line_type STRING, line_name STRING, inquiry STRING, pref STRING, city STRING,
      worker STRING, company STRING, f_call INT64, f_opcall INT64, f_visit INT64, f_lost INT64, result STRING, status STRING, receipt STRING, sales FLOAT64, deduct_parts FLOAT64, deduct_cost FLOAT64, visit_date DATE, fetched_at TIMESTAMP)`);
    tableReady = true;
  }
  const valOf = f => !f || f.value == null ? '' : Array.isArray(f.value) ? f.value.map(x => typeof x === 'object' ? (x.name || x.code || '') : x).join('・') : typeof f.value === 'object' ? (f.value.name || '') : String(f.value);
  const num = v => { const n = Number(String(v).replace(/[,円\s]/g, '')); return v === '' || !isFinite(n) ? null : n; };

  /** SEO回線の案件を全件取り直して保存 */
  async function collect() {
    const s = await getSettings();
    if (!s.hasToken || !s.subdomain || !s.appId) return { ok: true, skipped: true, message: 'kintoneは未設定のため取得していません' };   // 接続前の定期実行はエラーにしない
    try {
      await ensureTable();
      const cur = await kfetch(s, '/k/v1/records/cursor.json', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: s.appId, fields: ['$id'].concat(Object.values(FIELDS)), query: '(' + FIELDS.lineType + ' = "' + LINE_TYPE + '"' + EXTRA_LINES.map(l => ' or ' + FIELDS.lineName + ' = "' + l + '"').join('') + ' or (' + FIELDS.lineType + ' = "" and ' + FIELDS.lineName + ' like "SEO")) order by $id asc', size: 500 }) });
      const rows = [], lines = {};
      for (let next = true, guard = 0; next && guard < 400; guard++) {
        const page = await kfetch(s, '/k/v1/records/cursor.json?id=' + encodeURIComponent(cur.id));
        (page.records || []).forEach(r => {
          const g = k => valOf(r[FIELDS[k]]);
          if (g('lineType') !== LINE_TYPE && !EXTRA_LINES.includes(g('lineName')) && !(g('lineType') === '' && isSeoName(g('lineName')))) return;   // 念のため
          const recv = g('received'), t = recv ? new Date(Date.parse(recv) + 9 * 3600000) : null;
          const lineName = g('lineName').slice(0, 100);
          lines[lineName] = (lines[lineName] || 0) + 1;
          rows.push({
            record_id: Number(valOf(r.$id)), received_at: recv || null, date: t ? t.toISOString().slice(0, 10) : null, hour: t ? t.getUTCHours() : null,
            line_type: LINE_TYPE, line_name: lineName, inquiry: g('inquiry').slice(0, 60), pref: g('pref').slice(0, 10), city: g('city').slice(0, 20),
            worker: (g('workerKt') || g('workerNg')).slice(0, 100), company: (g('companyKt') || g('companyNg')).slice(0, 100),
            f_call: num(g('fCall')), f_opcall: num(g('fOpCall')), f_visit: num(g('fVisit')), f_lost: num(g('fLost')),
            result: g('result').slice(0, 40), status: g('status').slice(0, 40), receipt: g('receipt').slice(0, 40),
            sales: num(g('sales')), deduct_parts: num(g('deductParts')), deduct_cost: num(g('deductCost')), visit_date: g('visitDate') || null,
          });
        });
        next = page.next;
      }
      await query(`DELETE FROM ${T('kintone_seo')} WHERE TRUE`);
      const types = { record_id: 'INT64', received_at: 'STRING', date: 'STRING', hour: 'INT64', line_type: 'STRING', line_name: 'STRING', inquiry: 'STRING', pref: 'STRING', city: 'STRING', worker: 'STRING', company: 'STRING',
        f_call: 'FLOAT64', f_opcall: 'FLOAT64', f_visit: 'FLOAT64', f_lost: 'FLOAT64', result: 'STRING', status: 'STRING', receipt: 'STRING', sales: 'FLOAT64', deduct_parts: 'FLOAT64', deduct_cost: 'FLOAT64', visit_date: 'STRING' };
      for (let i = 0; i < rows.length; i += 3000) {
        await query(`INSERT INTO ${T('kintone_seo')} SELECT r.record_id, SAFE_CAST(r.received_at AS TIMESTAMP), SAFE.PARSE_DATE('%Y-%m-%d', r.date), r.hour, r.line_type, r.line_name, r.inquiry, r.pref, r.city, r.worker, r.company,
          CAST(r.f_call AS INT64), CAST(r.f_opcall AS INT64), CAST(r.f_visit AS INT64), CAST(r.f_lost AS INT64), r.result, r.status, r.receipt, r.sales, r.deduct_parts, r.deduct_cost, SAFE.PARSE_DATE('%Y-%m-%d', r.visit_date), CURRENT_TIMESTAMP() FROM UNNEST(@rows) r`,
          { rows: rows.slice(i, i + 3000) }, { rows: [types] });
      }
      const msg = 'SEO回線の案件 ' + rows.length + '件を取得';
      await ref.set({ lineValues: Object.entries(lines).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 200), lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastResult: 'OK ' + msg, lastError: null }, { merge: true });
      await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), 'kintone', 'SEO回線', NULL, NULL, 'OK', @m)`, { m: msg }).catch(() => {});
      return { ok: true, message: msg };
    } catch (e) {
      await ref.set({ lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastError: e.message }, { merge: true });
      await query(`INSERT INTO ${T('job_log')} (run_at, job, media, date_from, date_to, status, message) VALUES (CURRENT_TIMESTAMP(), 'kintone', 'SEO回線', NULL, NULL, 'ERROR', @m)`, { m: String(e.message).slice(0, 1000) }).catch(() => {});
      return { ok: false, error: e.message };
    }
  }

  /**
   * SEO回線の案件に収益を当てはめて、日付×回線名×問合せ内容×都道府県×市区町村×外注先ごとに集計する
   * - 売上(控除後・税抜) ＝（売上合計金額(税込) − 部材費控除額）÷ 1.1
   * - 成約 ＝ 結果が「03.完了報告」、訪問確定は kintone のフラグ
   * - コール ＝ 有効コールフラグが1、または受付結果が「失注」「重複…」の案件（2026-10-26 ユーザー指定。社内の集計表と合わせる）
   * - 収益：収益テーブルから KT商材×外注先×都道府県（×回線名）×適用期間（×報酬条件金額）で1行を選び、
   *   訪問買取＝訪問確定1件ごとに買取単価、成果買取・買取＝成約1件ごとに買取単価、売上シェア・料率＝売上×売上割合（WEB）、併用＝訪問確定1件ごとに買取単価＋成約時に売上×割合（2026/09 で既存の集計と一致）
   */
  async function seoRows() {
    // 条件表（Apps Script で取り込み）がまだない間も、売上・件数は出せるようにする
    const tables = new Set((await query(`SELECT table_name FROM ${T('INFORMATION_SCHEMA.TABLES')}`)).map(r => r.table_name));
    const hasAlias = tables.has('worker_alias'), hasRules = tables.has('revenue_rules'), hasLines = tables.has('line_master');
    const aliasSrc = hasAlias ? `(SELECT kt_name, ANY_VALUE(db_name) db_name FROM ${T('worker_alias')} GROUP BY kt_name)` : '(SELECT CAST(NULL AS STRING) kt_name, CAST(NULL AS STRING) db_name)';
    const lineJoin = hasLines ? `LEFT JOIN (SELECT line_name, ANY_VALUE(line_class) line_class FROM ${T('line_master')} GROUP BY line_name) lm ON lm.line_name = k.line_name` : '';
    const rec = `rec AS (
        SELECT k.*, IF(REGEXP_CONTAINS(k.inquiry, r'カギ|金庫'), 'カギ', k.inquiry) inquiry2,
          ${hasLines ? "COALESCE(NULLIF(lm.line_class, ''), '（未設定）')" : "'（未設定）'"} line_class,
          COALESCE(NULLIF(k.company, ''), a.db_name, NULLIF(k.worker, '')) partner, a.db_name p_alias,
          (IFNULL(k.sales, 0) - IFNULL(k.deduct_parts, 0)) / 1.1 sales_ex, k.result = '03.完了報告' is_contract
        FROM ${T('kintone_seo')} k LEFT JOIN ${aliasSrc} a ON a.kt_name = k.worker ${lineJoin})`;
    const m = !hasRules ? '' : `, m AS (
        SELECT rec.record_id, t.method, t.unit_price, COALESCE(t.rate_web, t.rate_phone) rate,
          ROW_NUMBER() OVER (PARTITION BY rec.record_id ORDER BY IF(IFNULL(t.line_name, '') = '', 1, 0), t.start_date DESC) rn
        FROM rec JOIN ${T('revenue_rules')} t ON t.item = rec.inquiry AND t.company IN (IFNULL(rec.p_alias, '-'), IFNULL(rec.worker, '-'), IFNULL(rec.company, '-')) AND t.pref = rec.pref
          AND (IFNULL(t.line_name, '') = '' OR t.line_name = rec.line_name)
          AND rec.date >= t.start_date AND (t.end_date IS NULL OR rec.date <= t.end_date)
          AND (t.cond_amount IS NULL OR (t.cond = '未満' AND rec.sales_ex < t.cond_amount) OR (t.cond = '以上' AND rec.sales_ex >= t.cond_amount)))`;
    const revenue = !hasRules ? 'CAST(NULL AS FLOAT64) revenue, 0 unmatched' : `SUM(CASE WHEN m.method IS NULL THEN 0
          WHEN REGEXP_CONTAINS(m.method, '訪問') THEN IF(rec.f_visit = 1, IFNULL(m.unit_price, 0), 0)
          WHEN REGEXP_CONTAINS(m.method, '併用') THEN IF(rec.f_visit = 1, IFNULL(m.unit_price, 0), 0) + IF(rec.is_contract, rec.sales_ex * IFNULL(m.rate, 0), 0)
          WHEN REGEXP_CONTAINS(m.method, 'シェア|料率') THEN IF(rec.is_contract, rec.sales_ex * IFNULL(m.rate, 0), 0)
          WHEN REGEXP_CONTAINS(m.method, '買取') THEN IF(rec.is_contract, IFNULL(m.unit_price, 0), 0) ELSE 0 END) revenue,
        COUNTIF(m.method IS NULL AND (rec.is_contract OR rec.f_visit = 1)) unmatched`;
    const rows = await query(`WITH ${rec}${m}
      SELECT FORMAT_DATE('%Y-%m-%d', rec.date) date, rec.line_name, rec.line_class, rec.inquiry, rec.inquiry2, rec.pref, rec.city, IFNULL(rec.partner, '（不明）') partner,
        COUNTIF(rec.f_call = 1 OR rec.receipt = '失注' OR STARTS_WITH(IFNULL(rec.receipt, ''), '重複')) calls, SUM(IFNULL(rec.f_visit, 0)) visits, COUNTIF(rec.is_contract) contracts, SUM(IF(rec.is_contract, rec.sales_ex, 0)) sales, SUM(IFNULL(rec.deduct_parts, 0)) deduct,
        ${revenue}
      FROM rec ${hasRules ? 'LEFT JOIN m ON m.record_id = rec.record_id AND m.rn = 1' : ''}
      WHERE rec.date IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`);
    return { rows, rules: hasRules };
  }

  function routes(adminApi, api, opts) {
    // 収益管理の画面用（回線名からメディアを判定。メディア管理の対応づけがあればそちらを優先）
    api.get('/revenue/seo', async (req, res, next) => {
      try {
        if (!opts.canRevenue(req.user)) return res.status(403).json({ error: '収益管理を見る権限がありません' });
        const s = await getSettings(), map = s.mediaMap || {};
        const { rows, rules } = await seoRows();
        const out = rows.map(r => Object.assign(r, { media: map[r.line_name] || opts.mediaOfLine(r.line_name) || '' }))
          // 回線分類が未設定の回線は、メディア名を回線分類として扱う
          .map(r => Object.assign(r, { line_class: r.line_class && r.line_class !== '（未設定）' ? r.line_class : (r.media && opts.mediaName(r.media)) || '（未設定）' }))
          .filter(r => r.media ? opts.allowedMedia(req.user, r.media) : req.user.perms.media === 'admin');
        res.json({ rows: out, rules, lastRunAt: s.lastRunAt && s.lastRunAt.toDate ? s.lastRunAt.toDate().toISOString() : null, lastError: s.lastError || '' });
      } catch (e) { next(e); }
    });
    adminApi.get('/kintone', async (req, res, next) => {
      try {
        const s = await getSettings();
        res.json({ subdomain: s.subdomain || '', appId: s.appId || '', hasToken: !!s.hasToken, mediaMap: s.mediaMap || {}, lineValues: s.lineValues || [], fields: FIELDS, lineType: LINE_TYPE,
          lastRunAt: s.lastRunAt && s.lastRunAt.toDate ? s.lastRunAt.toDate().toISOString() : null, lastResult: s.lastResult || '', lastError: s.lastError || '' });
      } catch (e) { next(e); }
    });
    adminApi.put('/kintone', async (req, res, next) => {
      try {
        const b = req.body || {}, patch = { updatedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (b.subdomain !== undefined) { const sd = String(b.subdomain).trim().replace(/^https?:\/\//, '').replace(/\.cybozu\.com.*$/, ''); if (!/^[a-z0-9-]{1,63}$/i.test(sd)) return res.status(400).json({ error: 'サブドメインの形式が正しくありません（〇〇〇.cybozu.com の〇〇〇）' }); patch.subdomain = sd; }
        if (b.appId !== undefined) { if (!/^\d{1,9}$/.test(String(b.appId))) return res.status(400).json({ error: 'アプリIDは数字で入力してください' }); patch.appId = String(b.appId); }
        if (b.token) { if (!/^[A-Za-z0-9]{20,60}$/.test(String(b.token).trim())) return res.status(400).json({ error: 'APIトークンの形式が正しくありません' }); await saveToken(String(b.token).trim()); patch.hasToken = true; }
        if (b.mediaMap !== undefined) patch.mediaMap = Object.fromEntries(Object.entries(b.mediaMap || {}).filter(([, v]) => v).map(([k, v]) => [String(k).slice(0, 100), String(v)]));
        await ref.set(patch, { merge: true });
        await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: 'kintone設定を保存' + (b.token ? '（APIトークンを更新）' : ''), at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    adminApi.post('/kintone/collect', async (req, res) => { res.json(await collect()); });
  }
  return { routes, collect, getSettings, seoRows };
};
