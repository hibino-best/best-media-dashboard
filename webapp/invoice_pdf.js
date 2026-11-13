// 請求書の PDF（サーバーで作る。経理部へのメールの添付と、ダウンロード用。2026-10-29 ユーザー指定）
// 日本語の書体は IPAexゴシック（fonts/ipaexg.ttf、IPA フォントライセンス）
const path = require('path');
const PDFDocument = require('pdfkit');
const FONT = path.join(__dirname, 'fonts', 'ipaexg.ttf');
const INV_TO = 'BEST株式会社 御中';
const INV_TO_ADDR = ['〒220-0004', '神奈川県横浜市西区北幸2-15-10', '横浜ウエストサイドビル8F'];
const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString('ja-JP');
const ymJp = ym => ym.slice(0, 4) + '年' + Number(ym.slice(5)) + '月';
const dJp = d => d ? d.slice(0, 4) + '年' + Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日' : '';

/** 請求書1通の PDF（Buffer） */
function invoicePdf(v) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: '請求書_' + (v.name || '') + '_' + v.ym } });
    const bufs = []; doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    doc.font(FONT);
    const W = doc.page.width - 96, L = 48;
    doc.fontSize(22).text('請　求　書', L, 48, { width: W, align: 'center' });
    // 左：宛先・件名・金額
    let y = 100;
    doc.fontSize(14).text(INV_TO, L, y); doc.moveTo(L, y + 20).lineTo(L + 250, y + 20).stroke();
    doc.fontSize(9).text(INV_TO_ADDR[0] + '　' + INV_TO_ADDR[1], L, y + 25, { width: 270, lineBreak: false }).text(INV_TO_ADDR[2], L, y + 37, { width: 270, lineBreak: false });
    // BEST の登録番号（インボイス番号）の枠（2026-10-30 ユーザー指定。経理部確認で設定した番号を全員の請求書に）
    doc.rect(L, y + 52, 250, 20).stroke('#999999'); doc.fontSize(9).text('登録番号：' + (v.bestNo || ''), L + 8, y + 58, { width: 234, lineBreak: false });
    doc.fontSize(11).text('件名：' + ymJp(v.ym) + '分 業務委託費' + (v.subject ? '（' + v.subject + '）' : ''), L, y + 82);
    doc.fontSize(12).text('ご請求金額', L, y + 108); doc.fontSize(18).text(yen(v.total) + '（税込み）', L + 80, y + 104);
    // 右：日付・請求者
    const rx = L + 280, rw = W - 280;
    const right = [ '請求日：' + dJp(v.issueDate) ].concat(v.invoiceNumber ? ['請求書番号：' + v.invoiceNumber] : []).concat(v.entity === '企業' && v.company ? [v.company, v.name] : [v.name]).concat(v.address ? String(v.address).split(/\r?\n/) : [], v.invoiceNo ? ['登録番号：' + v.invoiceNo] : []);
    doc.fontSize(10); let ry = y; right.forEach(t => { doc.text(t, rx, ry, { width: rw, align: 'right' }); ry += 15; });
    // 明細
    y = Math.max(y + 138, ry + 14);
    const cols = [W * 0.5, W * 0.15, W * 0.15, W * 0.2], hdr = ['内容', '数量', '単価', '金額'];
    const row = (cells, opt = {}) => {
      let x = L; const h = 22;
      if (opt.fill) doc.save().rect(L, y, W, h).fill('#eeeeee').restore();
      cells.forEach((c, i) => { doc.rect(x, y, cols[i], h).stroke('#999999'); doc.fillColor('#000').fontSize(opt.big ? 11 : 10).text(String(c), x + 6, y + 6, { width: cols[i] - 12, align: i === 0 ? 'left' : 'right', lineBreak: false, ellipsis: true }); x += cols[i]; });
      y += h;
    };
    row(hdr, { fill: true });
    (v.items || []).forEach(it => row([it.label + (it.kind === 'other' ? '（その他）' : ''), Number(it.qty).toLocaleString('ja-JP') + (it.unitLabel || ''), yen(it.unit), yen(it.amount)]));
    const sum = (label, val, opt) => { const lw = cols[0] + cols[1] + cols[2]; doc.rect(L, y, lw, 22).stroke('#999999'); doc.rect(L + lw, y, cols[3], 22).stroke('#999999'); doc.fontSize(opt && opt.big ? 11 : 10).text(label, L + 6, y + 6, { width: lw - 12, align: 'right' }); doc.text(val, L + lw + 6, y + 6, { width: cols[3] - 12, align: 'right' }); y += 22; };
    sum('小計（税抜き）', yen(v.subtotal)); sum('消費税（10%）', yen(v.tax));
    if (v.entity === '個人') sum('源泉所得税（' + (v.subtotal > 1000000 ? '100万円まで10.21%・超える分20.42%' : '10.21%') + '）', '−' + yen(v.withholding));
    sum('ご請求金額', yen(v.total), { big: true });
    // 振込先
    y += 18; const b = v.bank || {};
    doc.rect(L, y, 280, 96).stroke('#999999');
    doc.fontSize(10).text('お支払期日：' + dJp(v.dueDate), L + 8, y + 74).text('お振込先', L + 8, y + 6).text((b.bankName || '') + '　' + (b.branch || ''), L + 8, y + 22).text((b.type || '普通') + '　' + (b.number || ''), L + 8, y + 38).text('口座名義：' + (b.holder || ''), L + 8, y + 54);
    // 備考：対象の記事（メディア・種類ごとに No.と KW）
    if (v.remarks) { y += 110; if (y > doc.page.height - 120) { doc.addPage(); y = 48; } doc.fontSize(10).text('備考', L, y); doc.fontSize(9).text(String(v.remarks), L + 8, y + 16, { width: W - 16 }); }
    doc.end();
  });
}
module.exports = { invoicePdf };
