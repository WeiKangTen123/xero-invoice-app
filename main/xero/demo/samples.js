// Invented documents for a demo recording: the app is shown reading paperwork
// it has never seen. Everything here is made up (the merchants, the numbers,
// the dates), nothing is copied from real data, and every document is dated
// the day it is generated.
//
//   AR        two sales invoices written in the app's own email template, the
//             one email/parser.js#parseTemplateFormat reads.
//   AP        two supplier tax invoices as PDFs with a text layer, which is
//             what the bill reader is given (pdf-parse, then the model).
//   AP photo  one printed bill photographed on a desk, a JPEG for the vision
//             reader (email/parser.js#parseImageBill).
//   receipt   three thermal receipts for Add Claim, each with what the claim
//             reader is expected to find on it.
//
// Deterministic for a seed: the same seed gives the same bytes, a different
// seed gives different document numbers, times and codes. The suppliers
// themselves (names, GST numbers, bank accounts) never change, so a second
// run is the same supplier sending another bill, not one whose bank details
// changed, which the app would rightly hold as possible invoice fraud.
//
// The pictures are drawn as glyph outlines rather than SVG text. sharp asks
// the system for fonts when it meets <text>, so the same file would come out
// differently on a laptop and on a server that has none. The outlines come
// from Roboto, which pdfmake already ships, read by pdfkit's own fontkit.

const fs   = require('fs');
const path = require('path');

const SAMPLE_KINDS = ['ar', 'ap', 'ap-photo', 'receipt'];
const TIME_ZONE    = 'Asia/Singapore';
const GST_PCT      = 9;

// The Demo Company's own address, as its organisation record gives it (company.js).
const BILL_TO = { name: 'Demo Company Pte Ltd', street: '3 Westgate Tower, #03-12', city: 'Singapore 608532' };

// ── Seeded numbers ──────────────────────────────────────────────────────────
// FNV-1a over the text, then mulberry32: small, fast, and the same everywhere.
function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function randomFor(seed, label) {
  let a = hash32(`${seed}|${label}`);
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: list => list[Math.floor(next() * list.length)],
    digits: n => Array.from({ length: n }, () => int(0, 9)).join(''),
    // Booking-reference style: capitals and digits, no 0/O or 1/I to confuse.
    code: n => Array.from({ length: n }, () => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[int(0, 31)]).join(''),
  };
}

const pad = (n, width) => String(n).padStart(width, '0');

// ── Dates ───────────────────────────────────────────────────────────────────
const MONTHS      = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function singaporeToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function checkDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  const d = m && new Date(`${iso}T00:00:00Z`);
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== iso) {
    throw new Error(`buildSamples: today must be a date like 2026-10-20, not ${JSON.stringify(iso)}`);
  }
}

const dateParts = iso => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) });

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The day before the same date next month: a monthly plan's period.
function monthEnd(iso) {
  const { y, m, d } = dateParts(iso);
  const next = new Date(Date.UTC(y, m, d));
  if (next.getUTCMonth() !== m % 12) next.setUTCDate(0);   // 31 Jan → end of Feb
  return addDays(next.toISOString().slice(0, 10), -1);
}

const longDate  = iso => { const { y, m, d } = dateParts(iso); return `${d} ${MONTHS[m - 1]} ${y}`; };
const slashDate = iso => { const { y, m, d } = dateParts(iso); return `${pad(d, 2)}/${pad(m, 2)}/${y}`; };

// ── Money, in cents ─────────────────────────────────────────────────────────
function money(cents) {
  const [whole, frac] = (Math.abs(cents) / 100).toFixed(2).split('.');
  return `${cents < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
const dollars = cents => Math.round(cents) / 100;

// GST on one line, rounded to the cent. Per line because that is how the demo
// Xero (api.js) works it out once the bill is posted: the GST printed on the
// bill and the GST Xero computes are the same figure.
const lineGst = cents => Math.round(cents * GST_PCT / 100);
// The GST inside a GST-inclusive price (a shop receipt).
const gstInside = cents => Math.round(cents * GST_PCT / (100 + GST_PCT));

// A tax invoice's figures. `total` is what the document must come to; a line
// edited so that it no longer does fails here rather than in the recording.
function taxInvoice(lines, total) {
  const items    = lines.map(l => ({ ...l, amount: l.qty * l.unit }));
  const subTotal = items.reduce((s, l) => s + l.amount, 0);
  const gst      = items.reduce((s, l) => s + lineGst(l.amount), 0);
  if (subTotal + gst !== total) {
    throw new Error(`samples: lines come to ${money(subTotal + gst)} with GST, not ${money(total)}`);
  }
  return { items, subTotal, gst, total };
}

// ── Lettering ───────────────────────────────────────────────────────────────
let _faces = null;
function faces() {
  if (!_faces) {
    const fontkit = require('@foliojs-fork/fontkit');
    const vfs     = require('pdfmake/build/vfs_fonts.js');
    const load    = (file, key) => Object.assign(fontkit.create(Buffer.from(vfs[file], 'base64')), { cacheKey: key });
    _faces = { regular: load('Roboto-Regular.ttf', 'r'), bold: load('Roboto-Medium.ttf', 'b') };
  }
  return _faces;
}

const _outlines = new Map();
function glyphCommands(face, glyph) {
  const key = `${face.cacheKey}:${glyph.id}`;
  let cmds = _outlines.get(key);
  if (!cmds) {
    cmds = glyph.path.commands.map(c => [c.command, c.args.slice()]);
    _outlines.set(key, cmds);
  }
  return cmds;
}

const r2 = v => Math.round(v * 100) / 100;

function glyphPath(cmds, ox, oy, sx, sy) {
  const X = x => r2(ox + x * sx), Y = y => r2(oy - y * sy);
  let d = '';
  for (const [cmd, a] of cmds) {
    if (cmd === 'moveTo') d += `M${X(a[0])} ${Y(a[1])}`;
    else if (cmd === 'lineTo') d += `L${X(a[0])} ${Y(a[1])}`;
    else if (cmd === 'quadraticCurveTo') d += `Q${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`;
    else if (cmd === 'bezierCurveTo') d += `C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`;
    else if (cmd === 'closePath') d += 'Z';
  }
  return d;
}

// Roboto has no arrow, and a ride's route is printed with one.
const ARROW = '→';
function arrowPath(x, y, w, size) {
  const yc = y - size * 0.3, t = size * 0.09, h = size * 0.22;
  const x1 = x + w * 0.12, tip = x + w * 0.88, base = tip - size * 0.34;
  return `M${r2(x1)} ${r2(yc - t / 2)}L${r2(base)} ${r2(yc - t / 2)}L${r2(base)} ${r2(yc - h)}L${r2(tip)} ${r2(yc)}` +
         `L${r2(base)} ${r2(yc + h)}L${r2(base)} ${r2(yc + t / 2)}L${r2(x1)} ${r2(yc + t / 2)}Z`;
}

// Where each glyph goes. `mono` is a cell width in ems: every character gets
// one cell, as on a receipt printer, and a glyph too wide for its cell (M, W)
// is narrowed to fit rather than allowed to touch its neighbours.
function layoutText(str, { size = 16, bold = false, mono = 0, track = 0 } = {}) {
  const face  = faces()[bold ? 'bold' : 'regular'];
  const scale = size / face.unitsPerEm;
  const placed = [];
  let pen = 0;
  if (mono) {
    const cell = mono * size;
    for (const ch of String(str)) {
      if (ch !== ' ') {
        // An arrow spills into the spaces either side of it, or it is a dot.
        if (ch === ARROW) placed.push({ arrow: true, x: pen - cell * 0.45, w: cell * 1.9 });
        else {
          const glyph   = face.glyphForCodePoint(ch.codePointAt(0));
          const advance = glyph.advanceWidth * scale;
          const squeeze = advance > cell * 0.94 ? (cell * 0.94) / advance : 1;
          placed.push({ glyph, x: pen + (cell - advance * squeeze) / 2, sx: squeeze });
        }
      }
      pen += cell;
    }
    return { face, scale, placed, width: pen };
  }
  String(str).split(ARROW).forEach((part, i) => {
    if (i > 0) { placed.push({ arrow: true, x: pen, w: size * 1.1 }); pen += size * 1.1 + track * size; }
    if (!part) return;
    const run = face.layout(part);
    run.glyphs.forEach((glyph, j) => {
      const p = run.positions[j];
      placed.push({ glyph, x: pen + p.xOffset * scale, dy: p.yOffset * scale, sx: 1 });
      pen += p.xAdvance * scale + track * size;
    });
  });
  return { face, scale, placed, width: pen };
}

// One <path> for a string of text, baseline at y.
function text(str, x, y, { size = 16, bold = false, anchor = 'start', mono = 0, track = 0, fill = '#1f1f1f', opacity } = {}) {
  if (str === undefined || str === null || str === '') return '';
  const run = layoutText(str, { size, bold, mono, track });
  const x0  = anchor === 'end' ? x - run.width : anchor === 'middle' ? x - run.width / 2 : x;
  let d = '';
  for (const p of run.placed) {
    d += p.arrow
      ? arrowPath(x0 + p.x, y, p.w, size)
      : glyphPath(glyphCommands(run.face, p.glyph), x0 + p.x, y - (p.dy || 0), run.scale * p.sx, run.scale);
  }
  return d ? `<path fill="${fill}"${opacity ? ` fill-opacity="${opacity}"` : ''} d="${d}"/>` : '';
}

// ── Pictures ────────────────────────────────────────────────────────────────
async function svgToJpeg(svg, { quality = 86, blur = 0 } = {}) {
  const sharp = require('sharp');
  let img = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: '#ffffff' });
  if (blur) img = img.blur(blur);
  return img.jpeg({ quality, chromaSubsampling: '4:2:0' }).toBuffer();
}

// Paper grain: a small tile of seeded noise repeated across the paper. An SVG
// noise filter would do it too, but librsvg spends half a second on one the
// size of the bill, and this is the same bytes for the same seed.
async function grainTile(seed, name, size = 160) {
  const sharp = require('sharp');
  const rnd = randomFor(seed, `${name}-grain`);
  const px  = Buffer.alloc(size * size);
  for (let i = 0; i < px.length; i++) {
    px[i] = Math.max(0, Math.min(255, Math.round(128 + (rnd.next() + rnd.next() + rnd.next() - 1.5) * 90)));
  }
  const png = await sharp(px, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
  return { uri: `data:image/png;base64,${png.toString('base64')}`, size };
}

// A soft shadow without a blur filter, which librsvg is also slow at: the
// shape again under wide faint strokes, darkest where they all overlap.
function shadowOf(shape, dx, dy) {
  return [22, 16, 11, 7, 3].map(w =>
    `<g transform="translate(${dx} ${dy})" fill="#000" fill-opacity="0.05" stroke="#000" stroke-opacity="0.05" stroke-width="${w}" stroke-linejoin="round">${shape}</g>`).join('');
}

// The grain, the light falling across the paper and the desk under it.
function photoDefs(grain) {
  return `
  <pattern id="grain" width="${grain.size}" height="${grain.size}" patternUnits="userSpaceOnUse">
    <image width="${grain.size}" height="${grain.size}" xlink:href="${grain.uri}"/>
  </pattern>
  <radialGradient id="light" cx="38%" cy="30%" r="85%">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
    <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000000" stop-opacity="0.16"/>
  </radialGradient>
  <linearGradient id="desk" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b9b2a5"/>
    <stop offset="1" stop-color="#9d9586"/>
  </linearGradient>`;
}

// ── Receipts ────────────────────────────────────────────────────────────────
// A thermal receipt as rows:
//   { c: 'text' }                     centred
//   { l: 'left', r: 'right', m }      left and right ends, and a middle column
//   { rule: '-' }                     a printed rule across the paper
//   { gap: px }                       blank feed
//   { bars: 'value' }                 a barcode with its value beneath
// with `big` (a size multiple) and `bold` on any text row.
const RECEIPT = { width: 600, minHeight: 1400, cols: 38, size: 21, cell: 0.6, ink: '#262626' };
const MID_COL = 29;   // where the middle column (unit price, quantity) ends

// Looks like a barcode; encodes nothing. Narrowed to fit a long value.
function barcode(value, cx, y) {
  const height = 66;
  const widths = [];
  for (const ch of `*${value}*`) {
    const h = hash32(ch + value.length);
    for (let k = 0; k < 6; k++) widths.push(1 + ((h >>> (k * 3)) % 3));
  }
  widths.push(2, 3, 1, 1, 2);
  const modules = widths.reduce((s, w) => s + w, 0);
  const module  = Math.min(2.2, 400 / modules);
  const total   = modules * module;
  let x = cx - total / 2, d = '';
  widths.forEach((w, i) => {
    if (i % 2 === 0) d += `M${r2(x)} ${y}h${r2(w * module)}v${height}h${-r2(w * module)}Z`;
    x += w * module;
  });
  return { svg: `<path fill="${RECEIPT.ink}" d="${d}"/>`, height };
}

function receiptRows(rows) {
  const { cols, size, cell, ink } = RECEIPT;
  const pitch = size * cell;
  const left  = (RECEIPT.width - cols * pitch) / 2;
  const right = left + cols * pitch;
  let y = 0, svg = '';
  for (const row of rows) {
    if (row.gap) { y += row.gap; continue; }
    if (row.bars) {
      const b = barcode(row.bars, RECEIPT.width / 2, y + 10);
      svg += b.svg;
      y += b.height + 14;
      svg += text(row.bars, RECEIPT.width / 2, y + size * 0.9, { size: size * 0.85, mono: cell, anchor: 'middle', fill: ink });
      y += size * 1.4;
      continue;
    }
    const s    = size * (row.big || 1);
    const opts = { size: s, mono: cell, bold: !!row.bold, fill: ink };
    // A row wider than the paper would run off it, or into its own columns;
    // say so while editing rather than in the recording.
    const len  = v => String(v ?? '').length;
    const over = row.rule ? false
      : row.c !== undefined ? len(row.c) * (row.big || 1) > cols
      : row.m !== undefined ? len(row.l) + 1 + len(row.m) > MID_COL || len(row.r) + 1 > cols - MID_COL
      : (len(row.l) + 1 + len(row.r)) * (row.big || 1) > cols;
    if (over) throw new Error(`samples: receipt row too wide: ${JSON.stringify(row)}`);
    const base = y + s * 1.02;
    if (row.rule) {
      svg += text(row.rule.repeat(cols), left, base - s * 0.1, { ...opts, size, bold: false });
    } else if (row.c !== undefined) {
      svg += text(row.c, RECEIPT.width / 2, base, { ...opts, anchor: 'middle' });
    } else {
      svg += text(row.l, left, base, opts);
      if (row.m !== undefined) svg += text(row.m, left + MID_COL * pitch, base, { ...opts, anchor: 'end' });
      svg += text(row.r, right, base, { ...opts, anchor: 'end' });
    }
    y += s * 1.42;
  }
  return { svg, height: y };
}

// Torn thermal paper on a desk, photographed from above.
function receiptSvg(rows, seed, name, grain) {
  const rnd = randomFor(seed, `${name}-photo`);
  const top = 70;
  const { svg: body, height } = receiptRows(rows);
  const H = Math.max(RECEIPT.minHeight, Math.ceil(top + height + 90));
  const W = RECEIPT.width;
  const L = 24, R = W - 24, T = 16, B = H - 16;
  const tooth = 12, depth = 6;
  let edge = `M${L} ${T + depth}`;
  for (let x = L; x < R; x += tooth) edge += `L${Math.min(x + tooth / 2, R)} ${T}L${Math.min(x + tooth, R)} ${T + depth}`;
  edge += `L${R} ${B - depth}`;
  for (let x = R; x > L; x -= tooth) edge += `L${Math.max(x - tooth / 2, L)} ${B}L${Math.max(x - tooth, L)} ${B - depth}`;
  edge += 'Z';
  const tilt = ((rnd.int(0, 100) - 50) / 100).toFixed(2);   // within half a degree
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${photoDefs(grain)}
    <clipPath id="paper"><path d="${edge}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#desk)"/>
  <g transform="rotate(${tilt} ${W / 2} ${H / 2})">
    ${shadowOf(`<path d="${edge}"/>`, 4, 7)}
    <path d="${edge}" fill="#fefdf9"/>
    <g transform="translate(0 ${top})">${body}</g>
    <rect width="${W}" height="${H}" fill="url(#grain)" opacity="0.06" clip-path="url(#paper)"/>
  </g>
  <rect width="${W}" height="${H}" fill="url(#light)"/>
</svg>`;
}

// ── Suppliers (fixed: the same supplier on every run) ───────────────────────
const SUNBRIGHT = {
  name: 'Sunbright Office Supplies Pte Ltd',
  address: ['18 Kaki Bukit Road 3, #04-07', 'Entrepreneur Business Centre', 'Singapore 415978'],
  phone: '+65 6748 2190', email: 'billing@sunbright.example.sg',
  gst: 'M90471236K', uen: '199208713G',
  bank: { name: 'DBS Bank Ltd', account: '072-981346-5', swift: 'DBSSSGSG' },
};
const KESTREL = {
  name: 'Kestrel Cloud Services Pte Ltd',
  address: ['71 Ayer Rajah Crescent, #05-14', 'Singapore 139951'],
  phone: '+65 6631 2087', email: 'billing@kestrelcloud.example.sg',
  gst: '201734918W', uen: '201734918W',
  bank: { name: 'OCBC Bank', account: '601-384920-001', swift: 'OCBCSGSG' },
};
const ORCHID = {
  name: 'Orchid Catering Pte Ltd',
  address: ['Blk 3015 Bedok North Street 5, #02-18', 'Singapore 486350'],
  phone: '6245 8813', email: 'accounts@orchidcatering.example.sg',
  gst: 'M90638251D', uen: '199704512K',
  bank: { name: 'UOB', account: '451-302-887-6' },
};

// ── AR: the app's email template ────────────────────────────────────────────
// Labels and spacing exactly as email/parser.test.js has them. The customers
// are the Demo Company's own (company.js), with the emails it has on file, so
// the invoices land on contacts that already exist.
function templateEmail({ customer, email, address, items }) {
  const blocks = items.map((item, i) => [
    `${i + 1}. Description / Details :`,
    ...item.lines,
    '',
    `Amount : SGD${dollars(item.amount)}`,
    'Discount :',
    'Tax (If applicable) :',
  ].join('\n'));
  return [
    `Client / Customer : ${customer}`,
    `Email : ${email}`,
    `Address : ${address}`,
    'Currency : SGD, Standard',
    'Payment Terms / Payment Date : 30 days',
    'Tax inclusive / exclusive : Exclusive',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function harbourlineEmail(today) {
  const { y, m } = dateParts(today);
  const q = Math.ceil(m / 3);
  const first = MONTHS_LONG[(q - 1) * 3], last = MONTHS_LONG[q * 3 - 1];
  const items = [{
    amount: 480000,
    lines: [
      `Project: Fleet telematics subscription, Q${q} ${y}`,
      `Period: ${first} to ${last} ${y}`,
      'Scope: live GPS tracking, fuel and idling reports and driver scorecards for 40 vehicles',
    ],
  }];
  const customer = 'Harbourline Logistics Pte Ltd';
  const email    = 'accounts@harbourline.example.sg';
  return {
    kind: 'ar',
    id: 'ar-harbourline',
    subject: `Harbourline Logistics – invoice for Q${q} telematics`,
    text: templateEmail({ customer, email, address: '9 Pandan Crescent #04-11, Singapore 128465', items }),
    attachments: [],
    expected: {
      contact: customer, email, currency: 'SGD', dueDate: addDays(today, 30),
      lineItems: items.map(i => dollars(i.amount)), total: dollars(items.reduce((s, i) => s + i.amount, 0)),
    },
  };
}

function meridianEmail(today) {
  const items = [
    { amount: 185000, lines: ['Project: Site survey and measured drawings', 'Site: new office, Level 6, 30 Cecil Street', 'Laser measurement of the floor plate, services and existing fittings'] },
    { amount: 50000,  lines: ['Project: Layout plan', 'Two layout options for 48 workstations, a pantry and three meeting rooms'] },
  ];
  const customer = 'Meridian Fitouts Pte Ltd';
  const email    = 'ap@meridianfitouts.example.sg';
  return {
    kind: 'ar',
    id: 'ar-meridian',
    subject: 'Meridian Fitouts – invoice for site survey and layout plan',
    text: templateEmail({ customer, email, address: '21 Kallang Avenue #06-170, Singapore 339412', items }),
    attachments: [],
    expected: {
      contact: customer, email, currency: 'SGD', dueDate: addDays(today, 30),
      lineItems: items.map(i => dollars(i.amount)), total: dollars(items.reduce((s, i) => s + i.amount, 0)),
    },
  };
}

// ── AP: tax invoices as PDFs ────────────────────────────────────────────────
// pdfmake with the standard Helvetica, mapped as reports/budget-render.js maps
// it (FONTS there): nothing embedded, and a text layer pdf-parse reads plainly.
// Copied rather than required, because that module loads ExcelJS, half a
// second this does not need. Standard fonts draw only WinAnsi, so these
// documents keep to Latin-1 plus – · •.
const PDF_FONTS = {
  Helvetica: {
    normal:      'Helvetica',
    bold:        'Helvetica-Bold',
    italics:     'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

let _printer = null;
function printer() {
  if (!_printer) {
    const PdfPrinter = require('pdfmake');
    _printer = new PdfPrinter(PDF_FONTS);
  }
  return _printer;
}

function renderPdf(definition) {
  return new Promise((resolve, reject) => {
    const doc = printer().createPdfKitDocument(definition);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// pdfkit stamps the time it ran and derives the file ID from it; a fixed
// stamp on the document's own date keeps the bytes the same per seed.
const pdfInfo = (today, title, author) => ({
  title, author, subject: title, creator: `${author} billing`, producer: 'pdfmake',
  creationDate: new Date(`${today}T09:00:00+08:00`),
});

const GREY = '#6b7280';
const INK  = '#1f2937';

function itemsLayout(rule) {
  return {
    hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5),
    hLineColor: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? rule : '#d1d5db'),
    vLineWidth: () => 0,
    paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 6, paddingBottom: () => 6,
  };
}

// pdf-parse runs the cells of a table row together ("1980.00980.00" for one
// item at 980.00), which the model reading the text can take for 1,980.00.
// A trailing space keeps them apart; pdfmake leaves it out when it aligns.
const sp = t => `${t} `;

function itemsTable(bill, { rule, headFill, headColor }) {
  const head = ['No.', 'Description', 'Qty', 'Unit price (S$)', 'Amount (S$)'].map((t, i) => ({
    text: i < 4 ? sp(t) : t, bold: true, fontSize: 8.5, color: headColor, fillColor: headFill, alignment: i >= 2 ? 'right' : 'left',
  }));
  const rows = bill.items.map((l, i) => [
    { text: sp(i + 1), color: GREY },
    { stack: [{ text: sp(l.description) }, ...(l.detail ? [{ text: sp(l.detail), fontSize: 8, color: GREY, margin: [0, 2, 0, 0] }] : [])] },
    { text: sp(l.qty), alignment: 'right' },
    { text: sp(money(l.unit)), alignment: 'right' },
    { text: money(l.amount), alignment: 'right' },
  ]);
  return { table: { headerRows: 1, widths: [22, '*', 30, 72, 72], body: [head, ...rows] }, layout: itemsLayout(rule), margin: [0, 18, 0, 0] };
}

function totalsTable(bill, accent) {
  const row = (label, value, strong) => [
    { text: sp(label), alignment: 'right', bold: !!strong, fontSize: strong ? 11 : 9.5, color: strong ? INK : '#374151' },
    { text: value, alignment: 'right', bold: !!strong, fontSize: strong ? 11 : 9.5, color: strong ? accent : INK },
  ];
  return {
    table: {
      widths: ['*', 90],
      body: [
        row('Subtotal (excl. GST)', money(bill.subTotal)),
        row(`GST ${GST_PCT}%`, money(bill.gst)),
        row('Total (incl. GST) S$', money(bill.total), true),
      ],
    },
    layout: {
      hLineWidth: (i, node) => (i === node.table.body.length - 1 || i === node.table.body.length ? 1 : 0),
      hLineColor: () => accent, vLineWidth: () => 0,
      paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 4, paddingRight: () => 4,
    },
  };
}

const label = (t, color = GREY) => ({ text: t, fontSize: 8, bold: true, color, characterSpacing: 0.6, margin: [0, 0, 0, 3] });
const billToStack = (heading, color) => ({ stack: [label(heading, color), { text: BILL_TO.name, bold: true }, BILL_TO.street, BILL_TO.city] });
const metaTable = rows => ({
  table: { widths: ['*', 'auto'], body: rows.map(([k, v]) => [{ text: `${k}: `, color: GREY, alignment: 'right' }, { text: v, bold: k === 'Invoice No.', alignment: 'right' }]) },
  layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingTop: () => 1.5, paddingBottom: () => 1.5, paddingLeft: () => 2, paddingRight: () => 0 },
});

function sunMark() {
  const cx = 17, cy = 17, rays = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    rays.push({ type: 'line', x1: cx + Math.cos(a) * 11, y1: cy + Math.sin(a) * 11, x2: cx + Math.cos(a) * 16, y2: cy + Math.sin(a) * 16, lineWidth: 2, lineColor: '#f59e0b', lineCap: 'round' });
  }
  return [...rays, { type: 'ellipse', x: cx, y: cy, r1: 8, r2: 8, color: '#f59e0b' }];
}

function sunbrightDoc(today, seed) {
  const rnd    = randomFor(seed, 'sunbright');
  const number = `SB-${dateParts(today).y}-${pad(rnd.int(101, 1999), 4)}`;
  const due    = addDays(today, 30);
  const bill   = taxInvoice([
    { description: 'A4 copy paper, 80 gsm', detail: 'Box of 5 reams, 500 sheets each', qty: 6, unit: 2980 },
    { description: 'Laser toner cartridge, black, high yield', detail: 'Approx. 9,000 pages', qty: 1, unit: 9870 },
    { description: 'Lever arch files, A4, 75 mm spine', detail: 'Assorted colours', qty: 10, unit: 420 },
    { description: 'Whiteboard markers, assorted', detail: 'Pack of 12', qty: 2, unit: 1750 },
  ], 38640);
  const accent = '#b45309';
  const definition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    info: pdfInfo(today, `Tax Invoice ${number}`, SUNBRIGHT.name),
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, color: INK, lineHeight: 1.2 },
    footer: () => ({
      text: `${SUNBRIGHT.name} · UEN ${SUNBRIGHT.uen} · ${SUNBRIGHT.email} · Page 1 of 1`,
      alignment: 'center', fontSize: 7.5, color: GREY, margin: [40, 20, 40, 0],
    }),
    content: [
      {
        columns: [
          {
            width: '*',
            stack: [
              { columns: [{ width: 38, canvas: sunMark() }, { width: '*', stack: [
                { text: SUNBRIGHT.name, bold: true, fontSize: 15, color: accent },
                { text: 'Office stationery · Printing supplies · Pantry', fontSize: 8.5, color: GREY, margin: [0, 2, 0, 0] },
              ], margin: [0, 4, 0, 0] }], columnGap: 8 },
              { stack: [...SUNBRIGHT.address, `Tel ${SUNBRIGHT.phone} · ${SUNBRIGHT.email}`, `GST Reg No: ${SUNBRIGHT.gst}`], fontSize: 9, color: '#374151', margin: [46, 8, 0, 0] },
            ],
          },
          {
            width: 190,
            stack: [
              { text: 'TAX INVOICE', fontSize: 20, bold: true, color: accent, alignment: 'right' },
              { ...metaTable([
                ['Invoice No.', number],
                ['Invoice date', longDate(today)],
                ['Due date', longDate(due)],
                ['Terms', '30 days'],
                ['D/O No.', `DO-${pad(rnd.int(20001, 48999), 5)}`],
              ]), margin: [0, 10, 0, 0] },
            ],
          },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: '#f59e0b' }], margin: [0, 16, 0, 14] },
      {
        columns: [
          billToStack('BILL TO', accent),
          { stack: [label('DELIVER TO', accent), { text: BILL_TO.name, bold: true }, `${BILL_TO.street}, front desk`, BILL_TO.city, 'Attn: Office Manager'] },
          { width: 150, stack: [label('YOUR REFERENCE', accent), `PO-${pad(rnd.int(3000, 3999), 4)}`, { text: 'Sales: Jasmine Koh', color: GREY }] },
        ],
      },
      itemsTable(bill, { rule: accent, headFill: '#fef3c7', headColor: '#78350f' }),
      {
        columns: [
          {
            width: '*',
            stack: [
              label('PAYMENT DETAILS', accent),
              `Bank: ${SUNBRIGHT.bank.name}`,
              `Account name: ${SUNBRIGHT.name}`,
              `Account no: ${SUNBRIGHT.bank.account}`,
              `SWIFT: ${SUNBRIGHT.bank.swift}`,
              `PayNow UEN: ${SUNBRIGHT.uen}`,
              { text: `Please quote ${number} with your payment.`, color: GREY, margin: [0, 4, 0, 0] },
            ],
            margin: [0, 16, 0, 0],
          },
          { width: 230, ...totalsTable(bill, accent), margin: [0, 12, 0, 0] },
        ],
        columnGap: 20,
      },
      { text: 'Goods remain the property of Sunbright Office Supplies Pte Ltd until paid in full. Report shortages or damage within 7 days of delivery.', fontSize: 8, color: GREY, margin: [0, 28, 0, 0] },
      { text: 'Thank you for your business.', fontSize: 9, bold: true, color: accent, margin: [0, 8, 0, 0] },
    ],
  };
  return {
    number, due, bill, definition,
    email: {
      kind: 'ap',
      id: 'ap-sunbright',
      subject: `Tax invoice ${number} from Sunbright Office Supplies`,
      text: `Please find attached our tax invoice ${number} for S$ ${money(bill.total)}, due on ${longDate(due)}.`,
      filename: `Sunbright_Tax_Invoice_${number}.pdf`,
    },
  };
}

function kestrelMark() {
  return [
    { type: 'polyline', points: [{ x: 0, y: 22 }, { x: 14, y: 4 }, { x: 18, y: 12 }], closePath: true, color: '#0f766e' },
    { type: 'polyline', points: [{ x: 14, y: 4 }, { x: 30, y: 0 }, { x: 18, y: 12 }], closePath: true, color: '#14b8a6' },
    { type: 'polyline', points: [{ x: 18, y: 12 }, { x: 30, y: 0 }, { x: 26, y: 24 }], closePath: true, color: '#0d9488' },
  ];
}

function kestrelDoc(today, seed) {
  const rnd    = randomFor(seed, 'kestrel');
  const { y, m } = dateParts(today);
  const number = `KCS-${y}${pad(m, 2)}-${pad(rnd.int(101, 9899), 4)}`;
  const due    = addDays(today, 30);
  const period = `${longDate(today)} – ${longDate(monthEnd(today))}`;
  const egress = 15396;   // 153.96 GB at S$0.25
  const bill   = taxInvoice([
    { description: 'Managed hosting, Business plan', detail: `4 vCPU, 16 GB RAM, 400 GB SSD · ${period}`, qty: 1, unit: 98000 },
    { description: 'Daily off-site backups', detail: '2 TB retention, 30 restore points', qty: 1, unit: 12000 },
    { description: 'Managed DNS and TLS certificates', detail: 'Up to 10 domains', qty: 1, unit: 4500 },
    { description: 'Data transfer above plan allowance', detail: `${(egress / 100).toFixed(2)} GB at S$0.25 per GB, previous period`, qty: 1, unit: Math.round(egress * 25 / 100) },
  ], 129000);
  const accent  = '#0f766e';
  const account = 'KC-10482';
  const definition = {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 64],
    info: pdfInfo(today, `Tax Invoice ${number}`, KESTREL.name),
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, color: INK, lineHeight: 1.2 },
    background: () => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: 595.28, h: 10, color: accent }] }),
    footer: () => ({
      columns: [
        { text: sp(`Questions about this invoice? ${KESTREL.email}`), fontSize: 7.5, color: GREY },
        { text: 'Page 1 of 1', fontSize: 7.5, color: GREY, alignment: 'right' },
      ],
      margin: [40, 24, 40, 0],
    }),
    content: [
      {
        columns: [
          {
            width: '*',
            stack: [
              { columns: [{ width: 34, canvas: kestrelMark() }, { width: '*', text: KESTREL.name, bold: true, fontSize: 15, color: INK, margin: [0, 5, 0, 0] }], columnGap: 6 },
              { stack: [...KESTREL.address, `${KESTREL.phone} · ${KESTREL.email}`, `GST Reg No: ${KESTREL.gst}`], fontSize: 9, color: '#374151', margin: [0, 10, 0, 0] },
            ],
          },
          {
            width: 200,
            stack: [
              { text: 'TAX INVOICE', fontSize: 20, bold: true, color: accent, alignment: 'right' },
              { ...metaTable([
                ['Invoice No.', number],
                ['Invoice date', longDate(today)],
                ['Due date', longDate(due)],
                ['Account', account],
                ['Plan', 'Business, monthly'],
              ]), margin: [0, 10, 0, 0] },
            ],
          },
        ],
      },
      {
        margin: [0, 22, 0, 0],
        table: {
          widths: ['*', '*'],
          body: [[
            { ...billToStack('BILL TO', accent), margin: [8, 8, 8, 8] },
            { stack: [label('SERVICE PERIOD', accent), period, { text: `Amount due by ${longDate(due)}`, bold: true, margin: [0, 6, 0, 0] }, { text: 'S$ ' + money(bill.total), fontSize: 16, bold: true, color: accent }], margin: [8, 8, 8, 8] },
          ]],
        },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => '#f0fdfa' },
      },
      itemsTable(bill, { rule: accent, headFill: '#ccfbf1', headColor: '#134e4a' }),
      { columns: [{ width: '*', text: '' }, { width: 230, ...totalsTable(bill, accent) }], margin: [0, 12, 0, 0] },
      {
        margin: [0, 24, 0, 0],
        stack: [
          label('HOW TO PAY', accent),
          `Bank transfer to ${KESTREL.bank.name}, account name ${KESTREL.name}`,
          `Account no: ${KESTREL.bank.account} · SWIFT: ${KESTREL.bank.swift}`,
          `PayNow UEN: ${KESTREL.uen}`,
          { text: `Please use ${number} as the payment reference. Services continue uninterrupted while payment is in transit.`, color: GREY, margin: [0, 4, 0, 0] },
        ],
      },
    ],
  };
  return {
    number, due, bill, definition,
    email: {
      kind: 'ap',
      id: 'ap-kestrel',
      subject: `Kestrel Cloud Services – invoice ${number} for your hosting plan`,
      text: `Please find attached invoice ${number} for your Business hosting plan, ${period}.`,
      filename: `Kestrel-Invoice-${number}.pdf`,
    },
  };
}

// ── AP photo: a printed bill on a desk ──────────────────────────────────────
function orchidMark(x, y, s) {
  let petals = '';
  for (let k = 0; k < 5; k++) {
    petals += `<ellipse cx="0" cy="${-s * 0.42}" rx="${s * 0.2}" ry="${s * 0.4}" transform="rotate(${k * 72})" fill="${k % 2 ? '#9b59b6' : '#7d3c98'}"/>`;
  }
  return `<g transform="translate(${x} ${y})">${petals}<circle r="${s * 0.16}" fill="#f4d03f"/></g>`;
}

function orchidDoc(today, seed) {
  const rnd    = randomFor(seed, 'orchid');
  const { y, m } = dateParts(today);
  const number = `OC-${String(y).slice(2)}${pad(m, 2)}-${pad(rnd.int(11, 389), 3)}`;
  const due    = addDays(today, 30);
  const bill   = taxInvoice([
    { description: 'Corporate lunch buffet, Menu B', detail: '8 dishes, rice and dessert, 25 pax', qty: 25, unit: 1680 },
    { description: 'Assorted kueh platter', detail: 'Ang ku kueh, kueh salat, ondeh-ondeh', qty: 33, unit: 159 },
    { description: 'Coffee and tea station', detail: 'With disposable cups and stirrers', qty: 25, unit: 240 },
    { description: 'Delivery, set-up and collection', detail: 'Jurong East, weekday', qty: 1, unit: 2900 },
  ], 61200);
  const filename = `Orchid-Catering-Invoice-${number}.jpg`;
  return {
    number, due, bill,
    email: {
      kind: 'ap-photo',
      id: 'ap-orchid',
      subject: `Invoice ${number} – Orchid Catering`,
      text: `Please find attached a photo of our invoice ${number} for today's lunch catering.`,
      filename,
    },
  };
}

function orchidSvg(doc, today, seed, grain) {
  const { number, due, bill } = doc;
  const rnd = randomFor(seed, 'orchid-photo');
  const W = 1240, H = 1700;
  const PW = 1120, PH = 1584;            // A4 proportions
  const px = 60, py = 58;
  const ink = '#1c1c1c', grey = '#585858', accent = '#6c3483';
  const L = 80, R = PW - 80;
  let s = '';

  // Header: mark, supplier, document title.
  s += orchidMark(L + 34, 128, 70);
  s += text('ORCHID CATERING PTE LTD', L + 112, 118, { size: 36, bold: true, fill: accent });
  s += text('Corporate & event catering since 1997', L + 112, 152, { size: 19, fill: grey });
  s += text(ORCHID.address.join(', '), L, 222, { size: 20, fill: ink });
  s += text(`Tel ${ORCHID.phone}  ·  ${ORCHID.email}`, L, 252, { size: 20, fill: ink });
  s += text(`GST Reg No: ${ORCHID.gst}   UEN: ${ORCHID.uen}`, L, 282, { size: 20, fill: ink });
  s += text('TAX INVOICE', R, 118, { size: 44, bold: true, anchor: 'end', fill: ink, track: 0.02 });
  s += `<rect x="${L}" y="312" width="${R - L}" height="4" fill="${accent}"/>`;

  // Bill to, and the invoice's particulars.
  s += text('BILL TO', L, 368, { size: 17, bold: true, fill: accent, track: 0.08 });
  s += text(BILL_TO.name, L, 402, { size: 24, bold: true, fill: ink });
  s += text(BILL_TO.street, L, 434, { size: 21, fill: ink });
  s += text(BILL_TO.city, L, 464, { size: 21, fill: ink });
  s += text(`Event: Team lunch, ${longDate(today)}, 12:00 pm`, L, 504, { size: 20, fill: grey });
  const meta = [['Invoice No.', number], ['Date', longDate(today)], ['Terms', '30 days'], ['Due date', longDate(due)]];
  meta.forEach(([k, v], i) => {
    s += text(k, R - 250, 402 + i * 34, { size: 21, fill: grey, anchor: 'end' });
    s += text(v, R, 402 + i * 34, { size: 21, bold: i === 0, fill: ink, anchor: 'end' });
  });

  // The items.
  const cQty = 690, cUnit = 850, cAmt = R - 14;
  let yy = 560;
  s += `<rect x="${L}" y="${yy}" width="${R - L}" height="48" fill="#ece6f0"/>`;
  s += text('Description', L + 14, yy + 32, { size: 20, bold: true, fill: ink });
  s += text('Qty', cQty, yy + 32, { size: 20, bold: true, fill: ink, anchor: 'end' });
  s += text('Unit price', cUnit, yy + 32, { size: 20, bold: true, fill: ink, anchor: 'end' });
  s += text('Amount (S$)', cAmt, yy + 32, { size: 20, bold: true, fill: ink, anchor: 'end' });
  yy += 48;
  for (const l of bill.items) {
    s += text(l.description, L + 14, yy + 38, { size: 22, fill: ink });
    s += text(l.detail, L + 14, yy + 68, { size: 18, fill: grey });
    s += text(String(l.qty), cQty, yy + 38, { size: 22, fill: ink, anchor: 'end' });
    s += text(money(l.unit), cUnit, yy + 38, { size: 22, fill: ink, anchor: 'end' });
    s += text(money(l.amount), cAmt, yy + 38, { size: 22, fill: ink, anchor: 'end' });
    yy += 92;
    s += `<rect x="${L}" y="${yy - 1}" width="${R - L}" height="1.5" fill="#c8c2cc"/>`;
  }

  // Totals, right-aligned.
  yy += 18;
  const tLabel = R - 230;
  const totals = [['Subtotal', money(bill.subTotal)], [`GST ${GST_PCT}%`, money(bill.gst)]];
  totals.forEach(([k, v], i) => {
    s += text(k, tLabel, yy + 34 + i * 38, { size: 22, fill: grey, anchor: 'end' });
    s += text(v, cAmt, yy + 34 + i * 38, { size: 22, fill: ink, anchor: 'end' });
  });
  yy += 34 + totals.length * 38 - 8;
  s += `<rect x="${tLabel - 200}" y="${yy}" width="${R - tLabel + 200}" height="2.5" fill="${ink}"/>`;
  s += text('TOTAL (S$)', tLabel, yy + 46, { size: 28, bold: true, fill: ink, anchor: 'end' });
  s += text(money(bill.total), cAmt, yy + 46, { size: 30, bold: true, fill: accent, anchor: 'end' });
  s += `<rect x="${tLabel - 200}" y="${yy + 64}" width="${R - tLabel + 200}" height="2.5" fill="${ink}"/>`;

  // Payment and sign-off.
  yy += 140;
  s += text('PAYMENT', L, yy, { size: 17, bold: true, fill: accent, track: 0.08 });
  s += text(`Bank transfer: ${ORCHID.bank.name}, ${ORCHID.name}, A/C ${ORCHID.bank.account}`, L, yy + 34, { size: 20, fill: ink });
  s += text(`PayNow UEN: ${ORCHID.uen}   Please quote ${number} as your reference.`, L, yy + 64, { size: 20, fill: ink });
  s += text('Cheques payable to "Orchid Catering Pte Ltd".', L, yy + 94, { size: 20, fill: grey });
  const sigY = yy + 190;
  s += `<path d="M${R - 300} ${sigY - 18}c22-36 40-40 46-14s-10 30 10 6 28-34 44-12 8 22 30 2 40-26 70-8" fill="none" stroke="#24305e" stroke-width="2.6" stroke-linecap="round"/>`;
  s += `<rect x="${R - 330}" y="${sigY}" width="330" height="1.5" fill="${grey}"/>`;
  s += text('Authorised signature', R - 165, sigY + 30, { size: 18, fill: grey, anchor: 'middle' });
  s += text('Thank you for choosing Orchid Catering!', PW / 2, PH - 86, { size: 21, bold: true, fill: accent, anchor: 'middle' });
  s += text('Goods once delivered are not returnable. Please check the order on delivery.', PW / 2, PH - 56, { size: 17, fill: grey, anchor: 'middle' });

  const tilt = (-0.25 - rnd.int(0, 40) / 100).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${photoDefs(grain)}
    <linearGradient id="fold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.5" stop-color="#000" stop-opacity="0.07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#desk)"/>
  <g transform="translate(${px} ${py}) rotate(${tilt} ${PW / 2} ${PH / 2})">
    ${shadowOf(`<rect width="${PW}" height="${PH}"/>`, 6, 10)}
    <rect width="${PW}" height="${PH}" fill="#fbf9f3"/>
    ${s}
    <rect y="${Math.round(PH / 3) - 14}" width="${PW}" height="28" fill="url(#fold)"/>
    <rect y="${Math.round((2 * PH) / 3) - 14}" width="${PW}" height="28" fill="url(#fold)"/>
    <rect width="${PW}" height="${PH}" fill="url(#grain)" opacity="0.05"/>
  </g>
  <rect width="${W}" height="${H}" fill="url(#light)"/>
</svg>`;
}

// ── Receipts for Add Claim ──────────────────────────────────────────────────
function hhmm(h, m) { return `${pad(h, 2)}:${pad(m, 2)}`; }

function commonGroundsReceipt(today, seed) {
  const rnd   = randomFor(seed, 'common-grounds');
  const time  = hhmm(9, rnd.int(18, 49));
  const no    = `CG-T07-${rnd.digits(5)}`;
  const total = 1460;
  const rows = [
    { c: 'COMMON GROUNDS', big: 1.55, bold: true },
    { c: 'COFFEE', big: 1.55, bold: true },
    { c: 'Specialty coffee · All-day brunch' },
    { gap: 8 },
    { c: '100 Tras Street #01-09' },
    { c: 'Singapore 079027' },
    { c: 'Tel: 6221 4730' },
    { c: 'GST Reg No: 201955318E' },
    { gap: 10 },
    { c: 'TAX INVOICE', bold: true },
    { rule: '-' },
    { l: `Receipt: ${no}` },
    { l: `Date: ${slashDate(today)}`, r: `Time: ${time}` },
    { l: 'Table: 7', r: 'Pax: 2' },
    { l: 'Server: Aisyah', r: 'POS: 02' },
    { l: 'DINE IN', bold: true },
    { rule: '-' },
    { l: 'QTY ITEM', m: 'PRICE', r: 'AMOUNT', bold: true },
    { l: '2   Flat White', m: '7.30', r: money(total) },
    { l: '    Regular, whole milk' },
    { rule: '-' },
    { l: 'Subtotal', r: money(total) },
    { l: 'TOTAL', r: `S$ ${money(total)}`, big: 1.35, bold: true },
    { rule: '-' },
    { l: `GST ${GST_PCT}% included`, r: money(gstInside(total)) },
    { l: 'Total excl. GST', r: money(total - gstInside(total)) },
    { rule: '-' },
    { l: 'VISA CONTACTLESS', r: money(total) },
    { l: 'Card: ************4417' },
    { l: `Auth code: ${rnd.digits(6)}`, r: `Ref: ${rnd.digits(6)}` },
    { rule: '-' },
    { gap: 6 },
    { c: 'Thank you and see you again!' },
    { c: 'Wi-Fi: CommonGrounds_Guest' },
    { gap: 12 },
    { bars: no },
  ];
  return {
    id: 'receipt-common-grounds',
    filename: 'common-grounds-coffee-receipt.jpg',
    rows,
    expected: { merchant: 'Common Grounds Coffee', total: dollars(total), date: today, category: 'Entertainment/Meals', time, currency: 'SGD', tax: dollars(gstInside(total)) },
  };
}

function grabReceipt(today, seed) {
  const rnd     = randomFor(seed, 'grab');
  const time    = '08:52';
  const booking = `A-${rnd.code(12)}`;
  const fare = 1580, booking_fee = 200, platform = 60;
  const total = fare + booking_fee + platform;
  const rows = [
    { c: 'Grab', big: 2.3, bold: true },
    { c: 'Ride receipt' },
    { c: 'GrabCar · Standard' },
    { c: 'GST Reg No: 201417662R' },
    { gap: 10 },
    { c: 'TAX INVOICE', bold: true },
    { rule: '-' },
    { l: `Booking ID: ${booking}` },
    { l: `Date: ${longDate(today)}`, r: `Time: ${time}` },
    { l: 'Passenger: Demo Company' },
    { rule: '-' },
    { l: 'ROUTE', bold: true },
    { l: 'Robinson Road → Tanjong Pagar', bold: true },
    { l: 'Distance: 3.6 km', r: 'Duration: 17 min' },
    { l: `Vehicle: SKH ${rnd.int(1000, 9899)} ${rnd.pick(['A', 'C', 'D', 'G', 'J', 'L', 'T', 'X'])}` },
    { l: 'Driver: Rizal' },
    { rule: '-' },
    { l: 'Ride fare', r: money(fare) },
    { l: 'Booking fee', r: money(booking_fee) },
    { l: 'Platform fee', r: money(platform) },
    { rule: '-' },
    { l: 'TOTAL', r: `S$ ${money(total)}`, big: 1.35, bold: true },
    { l: `GST ${GST_PCT}% included`, r: money(gstInside(total)) },
    { rule: '-' },
    { l: 'Paid by Mastercard •••• 8832', r: money(total) },
    { l: `Payment ref: ${rnd.digits(10)}` },
    { rule: '-' },
    { gap: 6 },
    { c: 'Thanks for riding with Grab!' },
    { c: 'Help: see Help Centre in the app' },
    { gap: 12 },
    { bars: booking },
  ];
  return {
    id: 'receipt-grab',
    filename: 'grab-ride-receipt.jpg',
    rows,
    expected: { merchant: 'Grab', total: dollars(total), date: today, category: 'Local Travel', time, currency: 'SGD', tax: dollars(gstInside(total)) },
  };
}

function popularReceipt(today, seed) {
  const rnd  = randomFor(seed, 'popular');
  const time = hhmm(12, rnd.int(14, 52));
  const no   = `P0412-${rnd.digits(4)}-${rnd.digits(5)}`;
  const items = [
    { name: 'Spiral notebook A5', qty: 3, unit: 490 },
    { name: 'Gel pen 0.5mm blue 10s', qty: 1, unit: 1290 },
    { name: 'Sticky notes 3x3 5 pads', qty: 1, unit: 695 },
    { name: 'Correction tape 5mm', qty: 2, unit: 390 },
  ];
  const total = items.reduce((s, i) => s + i.qty * i.unit, 0);
  const rows = [
    { c: 'POPULAR', big: 1.9, bold: true },
    { c: 'BOOKSTORE', big: 1.25, bold: true },
    { gap: 6 },
    { c: 'Tanjong Pagar Centre #B1-12' },
    { c: '7 Wallich Street, Singapore 078884' },
    { c: 'Tel: 6222 5310' },
    { c: 'GST Reg No: M90284177B' },
    { gap: 10 },
    { c: 'TAX INVOICE / RECEIPT', bold: true },
    { rule: '-' },
    { l: `Rcpt No: ${no}` },
    { l: `Date: ${slashDate(today)}`, r: `Time: ${time}` },
    { l: `Cashier: ${rnd.digits(4)}`, r: 'Counter: 04' },
    { rule: '-' },
    { l: 'ITEM', m: 'QTY', r: 'AMOUNT', bold: true },
    ...items.flatMap(i => [
      { l: i.name, m: String(i.qty), r: money(i.qty * i.unit) },
      ...(i.qty > 1 ? [{ l: `  @ ${money(i.unit)}` }] : []),
    ]),
    { rule: '-' },
    { l: `Items: ${items.reduce((s, i) => s + i.qty, 0)}`, r: '' },
    { l: 'Subtotal', r: money(total) },
    { l: 'TOTAL', r: `S$ ${money(total)}`, big: 1.35, bold: true },
    { rule: '-' },
    { l: `GST ${GST_PCT}% included`, r: money(gstInside(total)) },
    { l: 'Total excl. GST', r: money(total - gstInside(total)) },
    { rule: '-' },
    { l: 'NETS', r: money(total) },
    { l: 'Card: XXXXXXXXXXXX5521' },
    { l: `Approval code: ${rnd.digits(6)}` },
    { rule: '-' },
    { gap: 6 },
    { c: 'Thank you for shopping at POPULAR!' },
    { c: 'Exchange within 7 days with receipt.' },
    { gap: 12 },
    { bars: no },
  ];
  return {
    id: 'receipt-popular',
    filename: 'popular-bookstore-receipt.jpg',
    rows,
    expected: { merchant: 'Popular Bookstore', total: dollars(total), date: today, category: 'Office Supplies', time, currency: 'SGD', tax: dollars(gstInside(total)) },
  };
}

// ── The set ─────────────────────────────────────────────────────────────────
function billExpected(supplier, doc, today) {
  return {
    supplier: supplier.name, gstRegNo: supplier.gst, invoiceNumber: doc.number, date: today, dueDate: doc.due,
    currency: 'SGD', subTotal: dollars(doc.bill.subTotal), gst: dollars(doc.bill.gst), total: dollars(doc.bill.total),
    lineItems: doc.bill.items.map(l => dollars(l.amount)),
  };
}

async function buildSamples({ today, seed } = {}) {
  today = today || singaporeToday();
  checkDate(today);
  seed = seed === undefined || seed === null || seed === '' ? today : String(seed);

  const sunbright = sunbrightDoc(today, seed);
  const kestrel   = kestrelDoc(today, seed);
  const orchid    = orchidDoc(today, seed);
  const slips     = [commonGroundsReceipt(today, seed), grabReceipt(today, seed), popularReceipt(today, seed)];

  // The PDFs one after the other: pdfkit's standard fonts keep state between
  // documents, and two rendering at once is not something it promises to do.
  const sunbrightPdf = await renderPdf(sunbright.definition);
  const kestrelPdf   = await renderPdf(kestrel.definition);
  const [orchidJpeg, ...receiptJpegs] = await Promise.all([
    grainTile(seed, orchid.email.id).then(g => svgToJpeg(orchidSvg(orchid, today, seed, g), { quality: 85, blur: 0.45 })),
    ...slips.map(r => grainTile(seed, r.id).then(g => svgToJpeg(receiptSvg(r.rows, seed, r.id, g), { quality: 86, blur: 0.35 }))),
  ]);

  const mail = ({ kind, id, subject, text: body, filename }, content, contentType, expected) => ({
    kind, id, subject, text: body, attachments: [{ filename, contentType, content }], expected,
  });

  const emails = [
    harbourlineEmail(today),
    meridianEmail(today),
    mail(sunbright.email, sunbrightPdf, 'application/pdf', billExpected(SUNBRIGHT, sunbright, today)),
    mail(kestrel.email, kestrelPdf, 'application/pdf', billExpected(KESTREL, kestrel, today)),
    mail(orchid.email, orchidJpeg, 'image/jpeg', billExpected(ORCHID, orchid, today)),
  ];
  const receipts = slips.map((r, i) => ({
    id: r.id, filename: r.filename, contentType: 'image/jpeg', content: receiptJpegs[i], expected: r.expected,
  }));
  return { emails, receipts };
}

// Every attachment and receipt as a file, and each AR body as <id>.txt, for
// uploading by hand or checking by eye. Returns the paths written.
async function writeSamples(dir, samples) {
  if (!dir) throw new Error('writeSamples: a directory is needed');
  samples = samples || await buildSamples();
  const emailsDir   = path.join(dir, 'emails');
  const receiptsDir = path.join(dir, 'receipts');
  await fs.promises.mkdir(emailsDir, { recursive: true });
  await fs.promises.mkdir(receiptsDir, { recursive: true });

  const safe = name => String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-');
  const written = [];
  const put = async (file, content) => {
    await fs.promises.writeFile(file, content);
    written.push(file);
  };
  for (const email of samples.emails || []) {
    if (email.kind === 'ar') await put(path.join(emailsDir, `${safe(email.id)}.txt`), `${email.text}\n`);
    for (const att of email.attachments || []) await put(path.join(emailsDir, safe(att.filename)), att.content);
  }
  for (const receipt of samples.receipts || []) await put(path.join(receiptsDir, safe(receipt.filename)), receipt.content);
  return written;
}

module.exports = { buildSamples, writeSamples, SAMPLE_KINDS, singaporeToday };
