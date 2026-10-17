// Xero's `where` filter, for the forms this app sends. Not Xero's whole
// expression language: a small parser for what report-fetch.js, bank.js,
// summary.js, ageing.js, cash-manager.js, cash-monthly.js, cash-flow-report.js,
// performance.js, invoices.js and main/scripts/cash-live-check.js actually
// write —
//
//   Date >= DateTime(2026,1,1) && Date < DateTime(2026,2,1)
//   Status=="AUTHORISED"            Type=="ACCREC"           AmountDue>0
//   Contact.ContactID==Guid("…")    Account.AccountID==Guid("…")
//   BankAccount.AccountID==Guid("…") && Date >= DateTime(…)
//   (Type=="SPEND-TRANSFER" || Type=="RECEIVE-TRANSFER")
//   Code=="200"   Type=="BANK"   Name=="Acme"   EmailAddress=="a@b.c"
//   Name.Contains("Acme")   Name.StartsWith("Ac")
//
// — and nothing else. A field the caller's endpoint does not offer, an
// operator or a function this does not know, is an error thrown at compile
// time, so a new clause somewhere in the app fails loudly in its test rather
// than quietly filtering nothing.

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'];

function tokenize(text) {
  const out = [];
  let i = 0;
  const s = String(text);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c }); i++; continue; }
    if (s.startsWith('&&', i)) { out.push({ t: '&&' }); i += 2; continue; }
    if (s.startsWith('||', i)) { out.push({ t: '||' }); i += 2; continue; }
    const op = OPERATORS.find(o => s.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op }); i += op.length; continue; }
    if (c === '"') {
      let j = i + 1, v = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { v += s[j + 1]; j += 2; continue; }
        v += s[j]; j++;
      }
      if (j >= s.length) throw new Error(`Demo Xero: unterminated string in where clause: ${s}`);
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: 'num', v: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (word === 'true' || word === 'false') out.push({ t: 'bool', v: word === 'true' });
      else if (word === 'null') out.push({ t: 'null' });
      else out.push({ t: 'id', v: word });
      i = j;
      continue;
    }
    throw new Error(`Demo Xero: cannot read where clause at "${s.slice(i, i + 12)}" in: ${s}`);
  }
  return out;
}

// expr := term ('||' term)* ; term := factor ('&&' factor)* ;
// factor := '(' expr ')' | comparison ;
// comparison := path op value | path '.' Method '(' value ')'
function parseWhere(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t, v) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`Demo Xero: expected ${v || t} at token ${pos} of where clause: ${text}`);
    }
    pos++;
    return tok;
  };

  function value() {
    const tok = peek();
    if (!tok) throw new Error(`Demo Xero: where clause ends early: ${text}`);
    if (tok.t === 'str') { pos++; return { kind: 'string', v: tok.v }; }
    if (tok.t === 'num') { pos++; return { kind: 'number', v: tok.v }; }
    if (tok.t === 'bool') { pos++; return { kind: 'bool', v: tok.v }; }
    if (tok.t === 'null') { pos++; return { kind: 'null', v: null }; }
    if (tok.t === 'id' && tok.v === 'DateTime') {
      pos++; take('(');
      const y = take('num').v; take(','); const m = take('num').v; take(','); const d = take('num').v;
      take(')');
      return { kind: 'date', v: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
    }
    if (tok.t === 'id' && tok.v === 'Guid') {
      pos++; take('('); const s = take('str').v; take(')');
      return { kind: 'guid', v: String(s).toLowerCase() };
    }
    throw new Error(`Demo Xero: unknown value "${tok.v ?? tok.t}" in where clause: ${text}`);
  }

  function comparison() {
    const id = take('id').v;
    // Name.Contains("x") — the method is the last dotted part.
    const parts = id.split('.');
    const last = parts[parts.length - 1];
    if ((last === 'Contains' || last === 'StartsWith' || last === 'EndsWith') && peek() && peek().t === '(') {
      take('('); const arg = value(); take(')');
      if (arg.kind !== 'string') throw new Error(`Demo Xero: ${last} takes a string in where clause: ${text}`);
      return { type: 'method', field: parts.slice(0, -1).join('.'), method: last, value: arg };
    }
    const op = take('op').v;
    return { type: 'cmp', field: id, op, value: value() };
  }

  function factor() {
    if (peek() && peek().t === '(') { take('('); const e = expr(); take(')'); return e; }
    return comparison();
  }
  function term() {
    let left = factor();
    while (peek() && peek().t === '&&') { pos++; left = { type: 'and', left, right: factor() }; }
    return left;
  }
  function expr() {
    let left = term();
    while (peek() && peek().t === '||') { pos++; left = { type: 'or', left, right: term() }; }
    return left;
  }

  const ast = expr();
  if (pos < tokens.length) throw new Error(`Demo Xero: unexpected "${tokens[pos].v ?? tokens[pos].t}" in where clause: ${text}`);
  return ast;
}

function _compare(op, a, b) {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>':  return a > b;
    case '<':  return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: throw new Error(`Demo Xero: unknown operator ${op}`);
  }
}

// The calendar day of a record's date, however it is held: 'YYYY-MM-DD…',
// or a Date (read in UTC, as the app reads Xero's).
function dayOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// `fields` names what the endpoint can be filtered by, each as a function of
// the record. A clause on anything else throws here, before any record is
// looked at.
function compileWhere(text, fields) {
  if (text === undefined || text === null || String(text).trim() === '') return () => true;
  const ast = parseWhere(text);
  const accessor = field => {
    const fn = fields[field];
    if (typeof fn !== 'function') {
      throw new Error(`Demo Xero: where clause filters on "${field}", which this endpoint does not support: ${text}`);
    }
    return fn;
  };
  function build(node) {
    if (node.type === 'and') { const l = build(node.left), r = build(node.right); return rec => l(rec) && r(rec); }
    if (node.type === 'or')  { const l = build(node.left), r = build(node.right); return rec => l(rec) || r(rec); }
    if (node.type === 'method') {
      const get = accessor(node.field);
      const want = node.value.v.toLowerCase();
      return rec => {
        const v = String(get(rec) ?? '').toLowerCase();
        if (node.method === 'Contains') return v.includes(want);
        if (node.method === 'StartsWith') return v.startsWith(want);
        return v.endsWith(want);
      };
    }
    const get = accessor(node.field);
    const { kind, v } = node.value;
    if (kind === 'date') return rec => { const d = dayOf(get(rec)); return d !== null && _compare(node.op, d, v); };
    if (kind === 'guid') return rec => _compare(node.op, String(get(rec) ?? '').toLowerCase(), v);
    if (kind === 'number') return rec => _compare(node.op, Number(get(rec) ?? 0), v);
    if (kind === 'bool') return rec => _compare(node.op, !!get(rec), v);
    if (kind === 'null') return rec => _compare(node.op, get(rec) ?? null, null);
    return rec => _compare(node.op, String(get(rec) ?? ''), v);
  }
  return build(ast);
}

// Xero's `order`: "Field ASC|DESC" (or just the field). Only fields the
// endpoint names are accepted, as for `where`. Strings compare as a person
// reads them (case aside); a tie keeps the list's own order, which is the
// order the records were made in, so paging is stable.
function compileOrder(text, fields) {
  if (text === undefined || text === null || String(text).trim() === '') return null;
  const m = /^\s*([A-Za-z_.]+)\s*(ASC|DESC)?\s*$/i.exec(String(text));
  if (!m) throw new Error(`Demo Xero: cannot read order "${text}"`);
  const get = fields[m[1]];
  if (typeof get !== 'function') throw new Error(`Demo Xero: order by "${m[1]}" is not supported on this endpoint`);
  const dir = (m[2] || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  const key = rec => {
    const v = get(rec);
    if (v instanceof Date) return v.toISOString();
    return v ?? '';
  };
  return (a, b) => {
    const ka = key(a), kb = key(b);
    if (typeof ka === 'string' && typeof kb === 'string') return dir * ka.localeCompare(kb, 'en', { sensitivity: 'base' });
    if (ka < kb) return -dir;
    if (ka > kb) return dir;
    return 0;
  };
}

module.exports = { tokenize, parseWhere, compileWhere, compileOrder, dayOf };
