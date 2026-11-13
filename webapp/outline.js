/**
 * 構成シート（2026-11-12 ユーザー指定）
 *
 * 進行管理の1記事に1つの構成（タイトル・H2〜H4・自由記入・CTA・訴求ブロック）。AI でも作りやすいよう「ブロックの並び」で保存する。
 * - 保存先：Firestore article_outlines/{sha1(記事のキー)}。変更の履歴は article_outlines/{id}/history（直す前の内容も残す）
 * - 色は「赤太字」「黄マーカー太字」の2つだけ（文字の一部にも、ブロック全体にも付けられる。2026-11-12 ユーザー指定）
 * - 編集できるのは構成シートの権限（outline_edit）がある人。記事ごとに「ライターにも編集を渡す」をオンにすると、執筆担当のライターも編集できる
 * - Google ドキュメント・スプレッドシートからの読み込み：dashboard-app@ に「閲覧者」で共有されたものを読む
 */
const MARKS = ['赤太字', '黄マーカー太字'];
const TYPES = ['h2', 'h3', 'h4', 'free', 'reco', 'image', 'cta', 'appeal', 'content'];   /* reco＝このような方にオススメ・image＝画像イメージ（2026-11-13 ユーザー指定） */   /* content＝記事用コンテンツ（マイブロック。中の見出しも残す。2026-11-13 ユーザー指定） */
const isBlkT = t => t === 'cta' || t === 'appeal' || t === 'content';
const TYPE_LABEL = { h2: 'H2', h3: 'H3', h4: 'H4', free: '自由記入', reco: 'このような方にオススメ', image: '画像イメージ', cta: 'CTA', appeal: '訴求ブロック', content: '記事用コンテンツ' };
const SA_EMAIL = 'dashboard-app@bestmedia-510909.iam.gserviceaccount.com';
/** 記事の設計の項目（構成シートで入力。2026-11-12 ユーザー指定）。想定文字数・緊急性は進行管理の値を使う */
const META_KEYS = { persona_station: 'ペルソナ：駅徒歩', persona_family_adult: 'ペルソナ：大人の人数', persona_family_child: 'ペルソナ：子供の人数', persona_family_elder: 'ペルソナ：祖父母の人数', persona_family_total: 'ペルソナ：家族の合計人数', persona_home_own: 'ペルソナ：持ち家・賃貸', persona_home_type: 'ペルソナ：建物', persona_home_room: 'ペルソナ：間取り', persona_home_note: 'ペルソナ：居住環境の補足', persona_gender: 'ペルソナ：性別', persona_age: 'ペルソナ：年齢', persona_income: 'ペルソナ：年収', persona_family: 'ペルソナ：家族構成', persona_home: 'ペルソナ：居住環境', persona_area: 'ペルソナ：居住地', persona_move: 'ペルソナ：移動手段', persona_hobby: 'ペルソナ：趣味', persona_thought: 'ペルソナ：考え', persona_worry: 'ペルソナ：悩み', image_need_reason: 'オリジナル画像作成の理由', urgency_reason: '緊急性の理由', image_need: 'オリジナル画像作成の必要性',existing_url: '既存記事URL', reader_before: 'A.記事を読む前の読者の状態', reader_action: 'B.記事を読んだ後に読者にとって欲しい行動', reader_info: 'C.AからBの状態にするために必要な情報', google_kw: 'Google関連キーワード', questions: '関連する質問', persona: 'ペルソナ' };
/** ブロックの右側の項目（2026-11-12 ユーザー指定） */
const NOTE_KEYS = { memo: 'メモ', figure: '図解の指示', link: '内部リンク' };
const txt = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n || 3000);
const newId = () => require('crypto').randomBytes(5).toString('hex');

/** 入力された文字（HTML）を、決めた印（<br> と <span data-c="赤太字|黄マーカー太字">）だけに整える */
function cleanHtml(html) {
  const parts = String(html == null ? '' : html).slice(0, 20000).split(/(<[^>]*>)/);
  let out = '', open = 0;
  parts.forEach(p => {
    if (!p) return;
    if (p[0] !== '<') { out += p.replace(/>/g, '&gt;'); return; }
    const m = p.match(/^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>$/i); if (!m) return;
    const close = !!m[1], tag = m[2].toLowerCase();
    if (tag === 'br') { out += '<br>'; return; }
    if (tag === 'span') {
      if (close) { if (open) { out += '</span>'; open--; } return; }
      const c = (m[3].match(/data-c\s*=\s*"([^"]*)"/) || [])[1];
      out += MARKS.includes(c) ? '<span data-c="' + c + '">' : '<span>'; open++; return;
    }
  });
  while (open-- > 0) out += '</span>';
  return out.replace(/<span>([^<]*)<\/span>/g, '$1').replace(/<span data-c="[^"]*"><\/span>/g, '').slice(0, 5000);
}
const plainOf = html => String(html || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
/** 画面・AI から来たブロックを整える */
function cleanBlocks(list) {
  if (!Array.isArray(list)) throw new Error('構成の形が正しくありません');
  if (list.length > 300) throw new Error('ブロックが多すぎます（300個まで）');
  return list.map(b => {
    const type = TYPES.includes(b && b.type) ? b.type : 'free';
    const id = b && typeof b.id === 'string' && /^[a-z0-9]{6,16}$/.test(b.id) ? b.id : newId();
    const o = isBlkT(type) ? { id, type, block: String(b.block || '').slice(0, 200) } : { id, type, html: cleanHtml(b.html) };
    if (type === 'content' && Array.isArray(b.heads)) o.heads = b.heads.slice(0, 50).map(h => ({ type: ['h2', 'h3', 'h4'].includes(h && h.type) ? h.type : 'h3', text: String((h || {}).text || '').slice(0, 200) })).filter(h => h.text);
    Object.keys(NOTE_KEYS).forEach(k => { const v = txt(b && b[k], 2000).trim(); if (v) o[k] = v; });
    if (isBlkT(type)) return o;
    if (type === 'image' && typeof b.img === 'string' && /^[a-z0-9]{10}$/.test(b.img)) o.img = b.img;   /* 画像イメージ：画像は images サブコレクションに入れ、ここは番号だけ */
    if (MARKS.includes(b.box)) o.box = b.box;
    const n = Number(b.chars); if (isFinite(n) && n > 0) o.chars = Math.min(100000, Math.round(n));
    if (b.by) o.by = String(b.by).slice(0, 100); if (b.at) o.at = String(b.at).slice(0, 40); if (b.byWriter) o.byWriter = true;
    return o;
  });
}
const sig = b => b.type + '|' + (b.html || b.block || '') + '|' + (b.box || '') + '|' + (b.chars || '') + '|' + Object.keys(NOTE_KEYS).map(k => b[k] || '').join('|');
const label = b => TYPE_LABEL[b.type] + '「' + (isBlkT(b.type) ? b.block : plainOf(b.html)).replace(/\s+/g, ' ').slice(0, 16) + '」';
/** 直す前と後の違い（履歴に出す短い説明） */
function summarize(before, after) {
  const out = [];
  if ((before.title || '') !== (after.title || '')) out.push('タイトルを修正');
  if ((before.lead || '') !== (after.lead || '')) out.push('リード文を修正');
  if ((before.description || '') !== (after.description || '')) out.push('ディスクリプションを修正');
  Object.keys(META_KEYS).forEach(k => { if (((before.meta || {})[k] || '') !== ((after.meta || {})[k] || '')) out.push(META_KEYS[k] + 'を修正'); });
  const a = (before.blocks || []).map(sig), b = (after.blocks || []).map(sig);
  const rest = a.slice(), added = [];
  b.forEach((s, i) => { const j = rest.indexOf(s); if (j >= 0) rest.splice(j, 1); else added.push(after.blocks[i]); });
  const removed = rest.map(s => before.blocks[a.indexOf(s)]);
  // 同じ種類が1つずつ消えて増えた＝修正
  const fixed = [];
  added.slice().forEach(x => { const k = removed.findIndex(y => y.type === x.type); if (k >= 0) { fixed.push(x); removed.splice(k, 1); added.splice(added.indexOf(x), 1); } });
  fixed.forEach(x => out.push(label(x) + 'を修正'));
  added.forEach(x => out.push(label(x) + 'を追加'));
  removed.forEach(x => out.push(label(x) + 'を削除'));
  if (!out.length && a.join('\n') !== b.join('\n')) out.push('並べ替え');
  return out.length > 6 ? out.slice(0, 6).concat(['ほか' + (out.length - 6) + '件']) : out;
}

module.exports = function ({ db, admin, query, T, allowedMedia, capOk, docIdOf, keyOfItem, WRITER_ROLES, comp }) {
  const col = db.collection('article_outlines');
  const now = () => admin.firestore.FieldValue.serverTimestamp();
  const iso = v => v && v.toDate ? v.toDate().toISOString() : v || null;

  /** 記事の担当者など（シートの値に、ダッシュボードでの修正を重ねる） */
  async function itemOf(key) {
    if (key.startsWith('entry:')) { const s = await db.collection('article_entries').doc(key.slice(6)).get(); return s.exists && !s.data().deleted ? s.data() : null; }
    const media = key.split('|')[0];
    const rows = await query('SELECT media, `no`, row_no, kw, writer, director, upload_owner, supervisor, writing_url FROM ' + T('article_items') + ' WHERE media = @m', { m: media });
    const r = rows.find(x => keyOfItem(x) === key); if (!r) return null;
    const ov = await db.collection('article_overrides').doc(docIdOf(key)).get();
    if (ov.exists) Object.keys(ov.data()).filter(k => k.startsWith('f_')).forEach(k => { r[k.slice(2)] = ov.data()[k]; });
    return r;
  }
  /* 競合調査を使える人：業務委託のディレクション担当（アシスタント以上）とBEST役員・正社員（と管理者）。権限管理の「構成シートの競合調査」（2026-11-13 ユーザー指定） */
  const canCompete = u => capOk(u, 'outline_compete', x => ['exec', 'employee', 'out_director', 'out_ad', 'out_aw'].includes(x.roleEff));
  const mediaOfKey = (key, item) => key.startsWith('entry:') ? (item && item.media) : key.split('|')[0];
  const isDirector = u => capOk(u, 'outline_edit', x => !!x.perms && (x.perms.media === 'admin' || ['admin', 'editor'].includes(x.perms.articles)) && !x.perms.own && !WRITER_ROLES.includes(x.roleEff));
  const isWriterOf = (u, item) => !!item && !!item.writer && (u.personNames || []).includes(item.writer);
  const mine = (u, item) => ['writer', 'director', 'upload_owner', 'supervisor'].some(k => item[k] && (u.personNames || []).includes(item[k]));
  /** 見られるか・編集できるか */
  async function access(u, key) {
    if (!key || !(u.status === 'active')) return { err: [400, '記事の指定が正しくありません'] };
    const item = await itemOf(key);
    if (!item) return { err: [404, '記事が見つかりません'] };
    const media = mediaOfKey(key, item);
    if (!allowedMedia(u, media) || !u.perms || u.perms.articles === 'none') return { err: [403, 'この記事を見る権限がありません'] };
    if (u.perms.own && !mine(u, item) && !(key.startsWith('entry:') && item.createdBy === u.email)) return { err: [403, '自分が担当の記事だけ見られます'] };
    const snap = await col.doc(docIdOf(key)).get(), ol = snap.exists ? snap.data() : null;
    const dir = isDirector(u), viaWriter = !dir && !!ol && !!ol.writerCanEdit && isWriterOf(u, item);
    /* 確定した構成は、ディレクターが「追加修正」を押すまで直せない（2026-11-13 ユーザー指定） */
    const locked = !!(ol && ol.locked);
    /* 編集を渡されたライターも「追加修正」を押せる（確定は今までどおりディレクターだけ）（2026-11-13 ユーザー指定） */
    return { item, media, ref: col.doc(docIdOf(key)), ol, canEdit: !locked && (dir || viaWriter), canHand: dir, canReopen: dir || viaWriter, viaWriter: !locked && viaWriter, locked };
  }
  const pub = (ol, a) => ol ? { title: ol.title || '', lead: ol.lead || '', description: ol.description || '', meta: ol.meta || {}, blocks: (ol.blocks || []).map((b, i) => b.id ? b : Object.assign({ id: 'x' + i + 'abcde' }, b)), writerCanEdit: !!ol.writerCanEdit, sourceUrl: ol.sourceUrl || '', version: ol.version || 0, baseline: ol.baseline || null, locked: !!ol.locked, confirmedAt: iso(ol.confirmedAt), confirmedBy: ol.confirmedByName || '', reopenedAt: iso(ol.reopenedAt), reopenedBy: ol.reopenedByName || '',
    updatedBy: ol.updatedByName || ol.updatedBy || '', updatedAt: iso(ol.updatedAt), createdBy: ol.createdByName || '', createdAt: iso(ol.createdAt) } : null;

  // ---------- Google ドキュメント・スプレッドシートから読む ----------
  async function token() {
    const t = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=' + encodeURIComponent('https://www.googleapis.com/auth/documents.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/spreadsheets.readonly'), { headers: { 'Metadata-Flavor': 'Google' } });
    if (!t.ok) throw new Error('Google のファイルを読む準備ができませんでした（' + t.status + '）');
    return (await t.json()).access_token;
  }
  const notShared = () => new Error('ファイルを読めません。ファイル（またはフォルダ）を ' + SA_EMAIL + ' に「閲覧者」で共有してください');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /** 行（セルの並び）から見出しを見分ける：「H2」などの列＋次の列の文字、または「H2：文字」 */
  const LABEL = /^\s*(H[1-6]|Ｈ[１-６]|h[1-6]|タイトル|記事タイトル|title|見出し\s*[1-6１-６]|本文|内容|メモ|自由記入|導入|リード文?|まとめ|CTA|訴求ブロック|訴求)\s*$/i;
  const INLINE = /^\s*(H[1-6]|Ｈ[１-６]|h[1-6]|見出し\s*[1-6１-６])\s*[：:．.\s　]\s*(.+)$/i;
  const typeOfLabel = l => {
    const s = String(l).normalize('NFKC').replace(/\s/g, '').toLowerCase();
    const n = (s.match(/[1-6]/) || [])[0];
    if (/^(タイトル|記事タイトル|title|h1|見出し1)$/.test(s)) return 'title';
    if (n) return n === '2' ? 'h2' : n === '3' ? 'h3' : 'h4';
    if (s === 'cta') return 'cta'; if (/訴求/.test(s)) return 'appeal';
    return 'free';
  };
  /** 記事の設計の項目・リード文・ディスクリプションの見出し → 保存する名前 */
  const metaOfLabel = l => {
    const t = String(l || '').normalize('NFKC').replace(/\s/g, '');
    if (/^(メタ)?ディスクリプション$/.test(t)) return 'description';
    if (/^リード文?$/.test(t)) return 'lead';
    if (/^オリジナル画像/.test(t)) return 'image_need';
    if (/^既存記事URL/i.test(t)) return 'existing_url';
    if (/読む前/.test(t)) return 'reader_before';
    if (/欲しい行動|ほしい行動/.test(t)) return 'reader_action';
    if (/AからB/.test(t)) return 'reader_info';
    if (/^Google関連(キーワード|KW)/i.test(t)) return 'google_kw';
    if (/^関連する質問/.test(t)) return 'questions';
    if (/^ペルソナ$/.test(t)) return 'persona';
    return '';
  };
  /** スプレッドシートの行を構成に読む（2026-11-13 ユーザー指定：害獣お助け本舗などの構成シートの形に合わせる）
   *  ・「３．競合一覧」「４．競合調査」の欄は読まない（競合サイトの H2 が入らないように）
   *  ・ペルソナは横並びの「性別｜年齢｜…｜悩み」の行と、その下の値の行
   *  ・インサイト（A・B・C）、タイトル、ディスクリプション、リード文は、項目名の右の値
   *  ・「H2」「H3」「H4」の列＋文字、「本文」「内容」＝自由記入、項目名のない長い文章＝自由記入、「リンク」＝直前の行の内部リンク、「CTA…」の行の [st-myblock id] ＝CTA など */
  const PERSONA = { '性別': 'persona_gender', '年齢': 'persona_age', '年収': 'persona_income', '家族構成': 'persona_family', '居住環境': 'persona_home_note', '居住地': 'persona_area', '移動手段': 'persona_move', '趣味': 'persona_hobby', '考え': 'persona_thought', '悩み': 'persona_worry' };
  const nz = c => String(c == null ? '' : c).normalize('NFKC').replace(/\s/g, '');
  function fromRows(rows) {
    let title = '', lead = '', description = '', section = '', personaCols = null; const blocks = [], meta = {}, noteCol = {};
    const last = () => blocks[blocks.length - 1];
    const addNote = (k, v) => { const b = last(); if (!b || !v) return; b[k] = b[k] ? b[k] + '\n' + v : v; };
    rows.forEach(cells => {
      const cs = cells.map(c => String(c == null ? '' : c).trim()), ns = cs.map(nz), filled = cs.filter(Boolean);
      if (!filled.length) return;
      // 見出しの番号つきの行（例：３．競合一覧／５．記事設計）で欄を切り替える
      const sec = cs.find(c => /^[0-9]+[.．]/.test(c.normalize('NFKC')));
      if (sec) { const t = nz(sec); section = /競合/.test(t) ? 'comp' : /記事設計|構成/.test(t) ? 'design' : 'other'; return; }
      if (section === 'comp') return;
      // ペルソナ：横並びの見出しの行 → 次の行が値
      const pc = {}; ns.forEach((c, j) => { if (PERSONA[c]) pc[PERSONA[c]] = j; });
      if (Object.keys(pc).length >= 3) { personaCols = pc; return; }
      if (personaCols) { const p = personaCols; personaCols = null; let any = false; Object.entries(p).forEach(([k, j]) => { if (cs[j]) { meta[k] = cs[j]; any = true; } }); if (any) return; }
      // 「メモ」「図解の指示」「内部リンク」の見出しの行：列の場所だけ覚える
      const hd = {}; cs.forEach((c, j) => { const k = Object.keys(NOTE_KEYS).find(x => NOTE_KEYS[x] === nz(c)); if (k) hd[k] = j; });
      if (hd.figure != null || hd.link != null) { Object.assign(noteCol, hd); return; }
      const skip = new Set(Object.values(noteCol));
      const after = i => cs.slice(i + 1).find((c, j) => c && !skip.has(i + 1 + j)) || '';
      const rest = i => cs.slice(i + 1).filter(Boolean).join(' ');
      // CTA の行：[st-myblock id="7149"] → CTA（名前は画面でマイブロックから当てる）
      const ci = ns.findIndex(c => /^CTA/i.test(c));
      if (ci >= 0) { const code = cs.join(' ').match(/st-myblock\s+id=["'“”]?(\d+)/i); if (code) blocks.push({ type: 'cta', block: '#' + code[1] }); return; }
      // 内部リンク：直前の行に
      const li = ns.findIndex(c => c === 'リンク' || c === '内部リンク');
      if (li >= 0) { const v = rest(li).replace(/\s*記事ID\s*/, '（記事ID ') + (/記事ID/.test(rest(li)) ? '）' : ''); addNote('link', v); return; }
      const mi = cs.findIndex((c, j) => !skip.has(j) && metaOfLabel(c));
      if (mi >= 0) {
        const k = metaOfLabel(cs[mi]), v = after(mi); if (!v) return;
        if (k === 'lead') lead = lead || v; else if (k === 'description') description = description || v;
        else meta[k] = meta[k] ? meta[k] + '\n' + v : v;
        return;
      }
      const i = cs.findIndex((c, j) => !skip.has(j) && LABEL.test(c));
      let type = null, text = '';
      if (i >= 0) { type = typeOfLabel(cs[i]); text = after(i); if (type === 'free' && !/^(本文|内容|メモ|自由記入)$/.test(nz(cs[i])) && text) text = cs[i].trim() + '：' + text; }
      else if (section === 'design') {
        const c = cs.find((x, j) => !skip.has(j) && INLINE.test(x));
        if (c) { const m = c.match(INLINE); type = typeOfLabel(m[1]); text = m[2]; }
        else {
          // 参考URL は直前の行のメモに。項目名のない長い文章は自由記入
          const url = cs.find(x => /^https?:\/\//.test(x));
          if (url && filled.length === 1) { addNote('memo', '参考：' + url); return; }
          if (url && last()) addNote('memo', '参考：' + url);
          const t = filled.find(x => !/^https?:\/\//.test(x)) || '';
          if (filled.filter(x => !/^https?:\/\//.test(x)).length === 1 && (t.length > 25 || /\n/.test(t) || /^[・-]/.test(t))) { type = 'free'; text = t; }
        }
      }
      if (!type || !text) return;
      if (type === 'title') { if (!title) title = text; return; }
      const o = (type === 'cta' || type === 'appeal') ? { type, block: text } : { type, html: esc(text).replace(/\n/g, '<br>') };
      Object.keys(noteCol).forEach(k => { if (cs[noteCol[k]]) o[k] = cs[noteCol[k]]; });
      const ref = cs.find(x => /^https?:\/\//.test(x) && x !== text); if (ref && section === 'design') o.memo = (o.memo ? o.memo + '\n' : '') + '参考：' + ref;   // 参考URL
      blocks.push(o);
    });
    normPersona(meta);
    return { title, lead, description, meta, blocks };
  }
  /** 読み込んだペルソナの文字を、画面の選択肢に合わせる（例：45～54才→45～54、夫婦と子供2人の世帯→2世代・大人2・子供2、持ち家・戸建て 3LDK→持ち家・戸建て・3LDK） */
  function normPersona(m) {
    const t = s => String(s || '').normalize('NFKC');
    if (m.persona_age) { const a = t(m.persona_age).match(/(\d+)\D+(\d+)/); if (a) m.persona_age = a[1] + '～' + a[2]; else if (/65/.test(t(m.persona_age))) m.persona_age = '65以上'; }
    if (m.persona_family) { const f = t(m.persona_family), c = Number((f.match(/子供(\d+)/) || [])[1] || 0), g = /祖父|祖母|両親と同居|3世代/.test(f);
      if (/単身|一人暮らし|ひとり暮らし/.test(f)) m.persona_family = '単身';
      else if (/夫婦|子供|家族|世帯/.test(f)) { m.persona_family = g ? '3世代' : '2世代'; m.persona_family_adult = /夫婦/.test(f) ? '2' : '1'; if (c) m.persona_family_child = String(c); if (g) m.persona_family_elder = '2'; } }
    const h = t(m.persona_home_note);
    if (h) { if (/持ち家|持家/.test(h)) m.persona_home_own = '持ち家'; else if (/賃貸/.test(h)) m.persona_home_own = '賃貸';
      const ty = (h.match(/戸建て|戸建|マンション|アパート/) || [])[0]; if (ty) m.persona_home_type = ty === '戸建' ? '戸建て' : ty;
      const rm = (h.match(/([1-5])\s*(LDK|DK|K|R)/i) || []); if (rm[0]) m.persona_home_room = rm[1] + rm[2].toUpperCase();
      const rest = h.replace(/持ち家|持家|賃貸|戸建て|戸建|マンション|アパート|[1-5]\s*(LDK|DK|K|R)\s*[~～〜]?|集合住宅/gi, '').replace(/[・\s/／,、]+/g, ' ').trim(); if (rest) m.persona_home_note = rest; else delete m.persona_home_note; }
    if (m.persona_income && /[%％]/.test(m.persona_income)) delete m.persona_income;   /* 世帯年収は100万円ごとの選択肢だけ（％の値は読まない。2026-11-13 ユーザー指定） */
    /* 居住地：都市部／都市郊外／農村・山間部 と 駅徒歩（5分ごと）（2026-11-13 ユーザー指定） */
    if (m.persona_area) { const a = t(m.persona_area), w = a.match(/駅徒歩\s*(\d+)\s*分\s*(以上|以内)?/);
      if (w) { const n = Number(w[1]), lo = Math.min(30, Math.round(n / 5) * 5); m.persona_station = w[2] === '以内' ? (n <= 5 ? '駅徒歩5分以内' : '駅徒歩' + (lo - 5) + '～' + lo + '分') : lo >= 30 ? '駅徒歩30分以上' : lo < 5 ? '駅徒歩5分以内' : '駅徒歩' + lo + '～' + (lo + 5) + '分'; }
      const ar = /農村|山間|田舎/.test(a) ? '農村・山間部' : /郊外|地方/.test(a) ? '都市郊外' : /都市|都心|市街/.test(a) ? '都市部' : '';
      if (ar) m.persona_area = ar; else if (w) delete m.persona_area; }
    if (m.persona_family) { const n = k => Number(m[k]) || 0, tot = m.persona_family === '単身' ? 1 : n('persona_family_adult') + n('persona_family_child') + (m.persona_family === '3世代' ? n('persona_family_elder') : 0); if (tot) m.persona_family_total = String(tot); }
  }
  const col3 = c => c && c.rgbColor ? c.rgbColor : null;
  function markOf(st) {
    if (!st || !st.bold) return '';
    const fg = col3(st.foregroundColor && st.foregroundColor.color), bg = col3(st.backgroundColor && st.backgroundColor.color);
    if (bg && (bg.red || 0) > 0.8 && (bg.green || 0) > 0.7 && (bg.blue || 0) < 0.65) return '黄マーカー太字';
    if (fg && (fg.red || 0) > 0.55 && (fg.green || 0) < 0.4 && (fg.blue || 0) < 0.4) return '赤太字';
    return '';
  }
  async function readDoc(id, tok) {
    const r = await fetch('https://docs.googleapis.com/v1/documents/' + id + '?fields=title,body', { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(20000) });
    if (r.status === 403 || r.status === 404) throw notShared();
    if (!r.ok) throw new Error('ドキュメントを読めませんでした（' + r.status + '）');
    const d = await r.json();
    let title = ''; const blocks = [], tableRows = [];
    const runs = p => (p.elements || []).map(pe => { const tr = pe.textRun; if (!tr || !tr.content || (tr.suggestedInsertionIds && tr.suggestedInsertionIds.length)) return ''; const t = esc(tr.content.replace(/\n$/, '').replace(/\u000b/g, '\n')).replace(/\n/g, '<br>'); const mk = markOf(tr.textStyle); return mk && t.trim() ? '<span data-c="' + mk + '">' + t + '</span>' : t; }).join('');
    const textOf = cs => (cs || []).map(el => el.paragraph ? plainOf(runs(el.paragraph)) : '').join('\n').trim();
    (d.body && d.body.content || []).forEach(el => {
      if (el.table) { (el.table.tableRows || []).forEach(row => tableRows.push((row.tableCells || []).map(c => textOf(c.content)))); const t = fromRows(tableRows.splice(0)); if (!title && t.title) title = t.title; blocks.push(...t.blocks); return; }
      if (!el.paragraph) return;
      const html = runs(el.paragraph), plain = plainOf(html).trim(); if (!plain) return;
      const st = (el.paragraph.paragraphStyle || {}).namedStyleType || 'NORMAL_TEXT';
      let type = st === 'TITLE' || st === 'HEADING_1' ? 'title' : st === 'HEADING_2' ? 'h2' : st === 'HEADING_3' ? 'h3' : /^HEADING_[456]$/.test(st) ? 'h4' : 'free', h = html;
      if (type === 'free') { const m = plain.match(INLINE); if (m) { type = typeOfLabel(m[1]); h = esc(m[2]); } }
      if (type === 'title') { if (!title) title = plain; return; }
      const last = blocks[blocks.length - 1];
      if (type === 'free' && last && last.type === 'free' && last._doc) { last.html += '<br>' + h; return; }   // 続く本文は1つの自由記入にまとめる
      blocks.push({ type, html: h, _doc: type === 'free' });
    });
    blocks.forEach(b => delete b._doc);
    return { title: title || '', blocks, name: d.title || '' };
  }
  async function readSheet(id, gid, tok) {
    const h = { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(20000) };
    const m = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=properties.title,sheets.properties', h);
    if (m.status === 403 || m.status === 404) throw notShared();
    if (!m.ok) throw new Error('スプレッドシートを読めませんでした（' + m.status + '）');
    const meta = await m.json(), sheets = (meta.sheets || []).map(s => s.properties);
    const sh = sheets.find(s => String(s.sheetId) === String(gid)) || sheets[0];
    if (!sh) throw new Error('シートが見つかりません');
    const v = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + encodeURIComponent("'" + sh.title.replace(/'/g, "''") + "'!A1:Z600"), h);
    if (!v.ok) throw new Error('スプレッドシートを読めませんでした（' + v.status + '）');
    return Object.assign(fromRows((await v.json()).values || []), { name: (meta.properties || {}).title + '／' + sh.title });
  }
  async function importUrl(url) {
    const u = String(url || '').trim(), tok = await token();
    let m = u.match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/);
    let r;
    if (m) r = await readDoc(m[1], tok);
    else if ((m = u.match(/^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/))) r = await readSheet(m[1], (u.match(/[#&?]gid=(\d+)/) || [])[1], tok);
    else throw new Error('GoogleドキュメントかGoogleスプレッドシートのURLを入力してください');
    r.blocks = cleanBlocks(r.blocks);
    if (!r.blocks.length && !r.title && !r.lead && !Object.keys(r.meta || {}).length) throw new Error('見出し（H2・H3など）が見つかりませんでした。ドキュメントは見出しのスタイル（見出し2〜4）、スプレッドシートは「H2」「H3」などの列を使ってください');
    return r;
  }

  function routes(api) {
    // 構成を見る（なければ outline: null）
    /* 今のライティングURL（一覧で消したら構成シートでも出さない）と、いちばん新しい競合調査の文字数（平均・最大・最小）（2026-11-13 ユーザー指定） */
    async function freshOf(a) {
      let comp = null;
      if (a.ol) { const s = await a.ref.collection('competitors').orderBy('at', 'desc').limit(1).get(); const x = s.docs[0] && s.docs[0].data(), ch = x ? (x.sites || []).map(p => Number(p.chars)).filter(n => n > 0) : [];
        if (ch.length) comp = { avg: Math.round(ch.reduce((t, n) => t + n, 0) / ch.length), max: Math.max(...ch), min: Math.min(...ch), n: ch.length }; }
      return { writing_url: a.item.writing_url || null, comp };
    }
    /* 画像イメージ（2026-11-13 ユーザー指定）：画面で縮めた画像（data URL、約1MBまで）を article_outlines/{id}/images に入れる。見るのは構成シートを見られる人、入れるのは編集できる人 */
    api.post('/outline/image', async (req, res, next) => {
      try { const b = req.body || {}, a = await access(req.user, String(b.key || '')); if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        if (!a.canEdit) return res.status(403).json({ error: '画像を入れる権限がありません' });
        const data = String(b.data || '');
        if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: '画像の形が正しくありません（JPEG・PNG・WebP・GIF）' });
        if (data.length > 1000000) return res.status(400).json({ error: '画像が大きすぎます' });
        if (!a.ol) await a.ref.set({ key: String(b.key), media: a.media, version: 0 }, { merge: true });
        const id = newId();
        await a.ref.collection('images').doc(id).set({ data, by: req.user.email, name: req.user.name || req.user.email, at: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ id });
      } catch (e) { next(e); }
    });
    api.get('/outline/image', async (req, res, next) => {
      try { const a = await access(req.user, String(req.query.key || '')); if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const id = String(req.query.id || ''); if (!/^[a-z0-9]{10}$/.test(id)) return res.status(400).json({ error: '画像の指定が正しくありません' });
        const sn = await a.ref.collection('images').doc(id).get(); if (!sn.exists) return res.status(404).json({ error: '画像が見つかりません' });
        res.set('Cache-Control', 'private, max-age=86400'); res.json({ data: sn.data().data });
      } catch (e) { next(e); }
    });
    api.get('/outline/fresh', async (req, res, next) => {
      try { const a = await access(req.user, String(req.query.key || '')); if (a.err) return res.status(a.err[0]).json({ error: a.err[1] }); res.json(await freshOf(a)); } catch (e) { next(e); }
    });
    api.get('/outline', async (req, res, next) => {
      try {
        const a = await access(req.user, String(req.query.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const hs = a.ol ? await a.ref.collection('history').orderBy('at', 'desc').limit(50).get() : { docs: [] };
        /* 基準（構成を作ったとき）がまだない構成：いちばん古い履歴の「直す前」（＝作ったときの内容）を基準にして保存。なければ今の内容 */
        if (a.ol && (a.ol.blocks || []).length && !a.ol.baseline) {
          const old = await a.ref.collection('history').orderBy('at', 'asc').limit(10).get(), f = old.docs.map(d => d.data()).find(h => h.before && (h.before.blocks || []).length);
          a.ol.baseline = f ? { title: f.before.title || '', lead: f.before.lead || '', description: f.before.description || '', blocks: f.before.blocks || [] } : { title: a.ol.title || '', lead: a.ol.lead || '', description: a.ol.description || '', blocks: a.ol.blocks || [] };
          await a.ref.set({ baseline: a.ol.baseline }, { merge: true });
        }
        const cs = await a.ref.collection('comments').orderBy('at', 'asc').limit(1000).get();
        res.json({ outline: pub(a.ol), canEdit: a.canEdit, canHand: a.canHand, canReopen: a.canReopen, viaWriter: a.viaWriter, canCompete: canCompete(req.user), me: req.user.email, fresh: await freshOf(a),
          comments: cs.docs.map(d => { const c = d.data(); return { id: d.id, target: c.target, text: c.text, name: c.name || c.by, by: c.by, at: iso(c.at) }; }),
          history: hs.docs.map(d => { const h = d.data(); return { id: d.id, at: iso(h.at), name: h.name || h.by || '', action: h.action || '', summary: h.summary || [], canRevert: !!h.before }; }) });
      } catch (e) { next(e); }
    });
    // 保存（作成・読み込み・修正）。ほかの人が先に保存していたら止める
    api.put('/outline', async (req, res, next) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const handOnly = 'writerCanEdit' in b && b.blocks == null;
        if (a.locked && !handOnly) return res.status(409).json({ error: 'この構成は確定済みです。ディレクターが「追加修正」を押すと直せます' });
        if (!a.canEdit && !(handOnly && a.canHand)) return res.status(403).json({ error: a.ol && !a.ol.writerCanEdit && !a.canHand ? 'この構成を編集する権限がありません（ディレクターが「ライターにも編集を渡す」をオンにすると編集できます）' : 'この構成を編集する権限がありません' });
        const cur = a.ol || { title: '', blocks: [], version: 0 };
        if (a.ol && b.version != null && Number(b.version) !== (a.ol.version || 0)) return res.status(409).json({ error: (a.ol.updatedByName || 'ほかの人') + 'が先に保存しました。画面を読み込み直してから、もう一度直してください' });
        const title = String(b.title == null ? cur.title || '' : b.title).trim().slice(0, 300);
        const lead = b.lead == null ? cur.lead || '' : txt(b.lead, 5000).trim(), description = b.description == null ? cur.description || '' : txt(b.description, 1000).trim();
        const meta = b.meta == null ? cur.meta || {} : Object.fromEntries(Object.keys(META_KEYS).map(k => [k, txt(b.meta[k], 3000).trim()]).filter(x => x[1]));
        let blocks = cleanBlocks(b.blocks == null ? cur.blocks || [] : b.blocks);
        // 変わったブロックに「誰が・いつ」を付ける（ライターが直したものは印を付ける）
        const old = (cur.blocks || []).slice(), at = new Date().toISOString(), who = req.user.name || req.user.email;
        blocks = blocks.map(x => { const j = old.findIndex(y => sig(y) === sig(x)); if (j >= 0) { const y = old.splice(j, 1)[0]; return Object.assign(x, { by: y.by, at: y.at, byWriter: y.byWriter }); } return Object.assign(x, { by: who, at, byWriter: a.viaWriter || undefined }); })
          .map(x => { Object.keys(x).forEach(k => x[k] === undefined && delete x[k]); return x; });
        const upd = { key: String(b.key), media: a.media, title, lead, description, meta, blocks, version: (cur.version || 0) + 1, updatedBy: req.user.email, updatedByName: who, updatedAt: now() };
        if (b.sourceUrl) upd.sourceUrl = String(b.sourceUrl).slice(0, 2000);
        if ('writerCanEdit' in b) { if (!a.canHand) return res.status(403).json({ error: 'ライターへの受け渡しを変えられるのはディレクターだけです' }); upd.writerCanEdit = !!b.writerCanEdit; }
        if (!a.ol) Object.assign(upd, { createdBy: req.user.email, createdByName: who, createdAt: now(), writerCanEdit: !!upd.writerCanEdit });
        const action = String(b.action || (a.ol ? '保存' : '作成')).slice(0, 30);
        /* 変更の色分けの基準＝構成を作ったとき（読み込み直したときも、そのときの内容を基準に）（2026-11-13 ユーザー指定） */
        if (!a.ol || (!(a.ol.blocks || []).length && !a.ol.baseline) || action === '読み込み') upd.baseline = { title, lead, description, blocks };
        const summary = 'writerCanEdit' in b && b.blocks == null ? [upd.writerCanEdit ? 'ライターに編集を渡した' : 'ライターへの受け渡しを取り消した'] : a.ol ? summarize(cur, upd) : [(b.sourceUrl ? '読み込み元：' + String(b.sourceUrl).slice(0, 120) : 'ブロック ' + blocks.length + '個')];
        if (a.ol && !summary.length && !('writerCanEdit' in b)) return res.json({ ok: true, unchanged: true, outline: pub(a.ol) });
        await a.ref.set(upd, { merge: true });
        /* 自動保存（2026-11-12 ユーザー指定）で履歴が細かく増えないよう、同じ人が15分以内に続けて保存したときは1つの履歴にまとめる（直す前の内容は最初のまま） */
        const lastQ = a.ol && b.blocks != null && action === '保存' ? await a.ref.collection('history').orderBy('at', 'desc').limit(1).get() : null, last = lastQ && lastQ.docs[0], lh = last && last.data();
        if (lh && lh.by === req.user.email && lh.action === '保存' && lh.at && lh.at.toMillis && Date.now() - lh.at.toMillis() < 15 * 60 * 1000) {
          const all = [...new Set((lh.summary || []).concat(summary).filter(x => !/^ほか\d+件$/.test(x)))];
          await last.ref.update({ at: now(), summary: all.length > 8 ? all.slice(0, 8).concat(['ほか' + (all.length - 8) + '件']) : all });
        } else await a.ref.collection('history').add({ at: now(), by: req.user.email, name: who, action, summary, viaWriter: !!a.viaWriter, before: a.ol ?{ title: cur.title || '', lead: cur.lead || '', description: cur.description || '', meta: cur.meta || {}, blocks: cur.blocks || [] } : null });
        if (!lh || !(lh.by === req.user.email && lh.action === '保存')) await db.collection('access_logs').add({ uid: req.user.uid, email: req.user.email, name: req.user.name, view: '構成シートを' + action + '：' + b.key, at: now() });   /* 続けての自動保存は記録しない */
        const snap = await a.ref.get();
        res.json({ ok: true, outline: pub(snap.data()) });
      } catch (e) { if (/構成の形|ブロックが多すぎ/.test(e.message)) return res.status(400).json({ error: e.message }); next(e); }
    });
    // ペルソナのコピー元：同じメディアの構成シートのペルソナ（2026-11-13 ユーザー指定。進行状況での絞り込みは画面で）
    api.get('/outline/personas', async (req, res, next) => {
      try {
        const media = String(req.query.media || '');
        if (!media || !allowedMedia(req.user, media) || !req.user.perms || req.user.perms.articles === 'none') return res.status(400).json({ error: 'メディアの指定が正しくありません' });
        const s = await col.where('media', '==', media).get();
        res.json({ list: s.docs.map(d => { const o = d.data(), m = o.meta || {}, p = {}; Object.keys(m).filter(k => /^persona/.test(k)).forEach(k => { p[k] = m[k]; }); return { key: o.key, title: o.title || '', persona: p, locked: !!o.locked }; }).filter(x => x.key && Object.keys(x.persona).length) });
      } catch (e) { next(e); }
    });
    // この内容で確定する／追加修正（2026-11-13 ユーザー指定）：確定すると今の内容が色分けの基準になり、直せなくなる。追加修正を押すと直せて、確定したときとの違いが色で出る
    api.post('/outline/confirm', async (req, res, next) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const reopen = !!b.reopen;
        if (reopen ? !a.canReopen : !a.canHand) return res.status(403).json({ error: reopen ? '追加修正ができるのは、ディレクターと編集を渡されたライターだけです' : '確定できるのはディレクターだけです' });
        if (!a.ol || !(a.ol.blocks || []).length) return res.status(400).json({ error: 'まだ構成がありません' });
        const who = req.user.name || req.user.email, cur = a.ol;
        const upd = reopen ? { locked: false, reopenedAt: now(), reopenedBy: req.user.email, reopenedByName: who }
          : { locked: true, confirmedAt: now(), confirmedBy: req.user.email, confirmedByName: who, baseline: { title: cur.title || '', lead: cur.lead || '', description: cur.description || '', blocks: cur.blocks || [] } };
        upd.version = (cur.version || 0) + 1; upd.updatedBy = req.user.email; upd.updatedByName = who; upd.updatedAt = now();
        await a.ref.set(upd, { merge: true });
        await a.ref.collection('history').add({ at: now(), by: req.user.email, name: who, action: reopen ? '追加修正' : '確定', summary: [reopen ? '確定した構成の追加修正を始めた' : 'この内容で確定した'], before: null });
        res.json({ ok: true, outline: pub((await a.ref.get()).data()) });
      } catch (e) { next(e); }
    });
    // 履歴の「直す前」に戻す
    api.post('/outline/revert', async (req, res, next) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        if (!a.canHand) return res.status(403).json({ error: '元に戻せるのはディレクターだけです' });
        const h = await a.ref.collection('history').doc(String(b.id || '')).get();
        if (!h.exists || !h.data().before) return res.status(404).json({ error: '戻せる内容がありません' });
        const cur = a.ol || {}, bf = h.data().before, who = req.user.name || req.user.email;
        await a.ref.set({ title: bf.title || '', lead: bf.lead || '', description: bf.description || '', meta: bf.meta || {}, blocks: bf.blocks || [], version: (cur.version || 0) + 1, updatedBy: req.user.email, updatedByName: who, updatedAt: now() }, { merge: true });
        await a.ref.collection('history').add({ at: now(), by: req.user.email, name: who, action: '元に戻す', summary: [(h.data().name || '') + 'の変更の前に戻した'], before: { title: cur.title || '', lead: cur.lead || '', description: cur.description || '', meta: cur.meta || {}, blocks: cur.blocks || [] } });
        res.json({ ok: true, outline: pub((await a.ref.get()).data()) });
      } catch (e) { next(e); }
    });
    // コメント（見られる人ならだれでも。誰が書いたかを残す。2026-11-12 ユーザー指定）。target＝b:ブロックid／f:項目名
    api.post('/outline/comments', async (req, res, next) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const target = String(b.target || ''), text = txt(b.text, 2000).trim();
        if (!/^(b:[a-z0-9]{6,16}|f:[a-z_]{2,30})$/.test(target)) return res.status(400).json({ error: 'コメントする場所が正しくありません' });
        if (!text) return res.status(400).json({ error: 'コメントを入力してください' });
        const who = req.user.name || req.user.email;
        if (!a.ol) await a.ref.set({ key: String(b.key), media: a.media, version: 0 }, { merge: true });   // 構成を保存する前のコメントも残す
        const r = await a.ref.collection('comments').add({ target, text, by: req.user.email, name: who, at: now() });
        res.json({ ok: true, comment: { id: r.id, target, text, name: who, by: req.user.email, at: new Date().toISOString() } });
      } catch (e) { next(e); }
    });
    api.delete('/outline/comments', async (req, res, next) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        const ref = a.ref.collection('comments').doc(String(b.id || '')), c = await ref.get();
        if (!c.exists) return res.status(404).json({ error: 'コメントが見つかりません' });
        if (c.data().by !== req.user.email && !a.canHand) return res.status(403).json({ error: '自分のコメントだけ消せます' });
        await ref.delete(); res.json({ ok: true });
      } catch (e) { next(e); }
    });
    // 競合調査（2026-11-13 ユーザー指定）：見るのは構成シートを見られる人、取得するのは構成を編集できる人
    api.get('/outline/competitors', async (req, res, next) => {
      try { const a = await access(req.user, String(req.query.key || '')); if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        if (!canCompete(req.user)) return res.status(403).json({ error: '競合調査を使う権限がありません' });
        res.json({ list: await comp.latest(a.ref), usage: await comp.usage(a.media), canRun: a.canEdit, kw: a.item.kw || '' }); } catch (e) { next(e); }
    });
    api.post('/outline/competitors', async (req, res) => {
      try { const b = req.body || {}, a = await access(req.user, String(b.key || '')); if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        if (!a.canEdit || !canCompete(req.user)) return res.status(403).json({ error: '競合を取得する権限がありません' });
        const kw = String(a.item.kw || '').trim(); if (!kw) return res.status(400).json({ error: '進行管理に検索KWがないため、競合を取得できません' });
        if (!a.ol) await a.ref.set({ key: String(b.key), media: a.media, version: 0 }, { merge: true });
        const r = await comp.run({ media: a.media, kw, ref: a.ref, user: req.user });
        res.json({ result: r, usage: await comp.usage(a.media) });
      } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
    });
    // Google ドキュメント・スプレッドシートを読む（保存はしない。画面で確かめてから保存）
    api.post('/outline/import', async (req, res) => {
      try {
        const b = req.body || {}, a = await access(req.user, String(b.key || ''));
        if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
        if (!a.canEdit) return res.status(403).json({ error: '構成を作る権限がありません' });
        res.json(await importUrl(b.url));
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
  return { routes, cleanHtml, cleanBlocks, fromRows, _test: { summarize, typeOfLabel } };
};
