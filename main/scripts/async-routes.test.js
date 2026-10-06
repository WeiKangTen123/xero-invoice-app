const fs     = require('fs');
const path   = require('path');
// ESLint's own parser — present because eslint is a devDependency, and it
// reads the files the way node does, so a parenthesis inside a string or a
// comment cannot throw the scan off the way a regex would.
const espree = require('espree');

// Express 4 does not catch a rejected async route handler. The rejection goes
// unhandled, index.js treats every unhandled rejection as fatal, and the
// server restarts for every user because one request threw. At one point 23
// of 25 async handlers were exposed this way.
//
// So every async handler in main/routes must go through asyncHandler, which
// passes a rejection to next() like any synchronous error. This fails on any
// that does not, including ones built by a factory (xero-reports' report()) —
// any async function whose first parameter is req has to be wrapped where it
// is written.

const ROUTES_DIR = path.join(__dirname, '../routes');
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'options', 'head']);

const isAsyncFn = n => !!n && n.async === true
  && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(n.type);
const isWrapped = parent => !!parent && parent.type === 'CallExpression'
  && parent.callee.type === 'Identifier' && parent.callee.name === 'asyncHandler';
const takesReq = n => n.params[0] && n.params[0].type === 'Identifier' && /^_?req$/.test(n.params[0].name);

function walk(node, parent, visit) {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === 'string') walk(child, node, visit);
    }
  }
}

// Returns one line per unwrapped async handler, e.g. "line 43: POST handler ...".
function unwrappedAsyncHandlers(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', loc: true });

  // Handlers passed by name: `async function x(req, res)` or `const x = async (req, res) =>`.
  const asyncByName = new Map();
  walk(ast, null, n => {
    if (n.type === 'FunctionDeclaration' && n.async && n.id) asyncByName.set(n.id.name, n.loc.start.line);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isAsyncFn(n.init)) {
      asyncByName.set(n.id.name, n.loc.start.line);
    }
  });

  const problems = new Map(); // keyed by line so one handler is reported once
  walk(ast, null, (n, parent) => {
    const isRouteCall = n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
      && !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'router'
      && VERBS.has(n.callee.property.name);
    if (isRouteCall) {
      const verb = n.callee.property.name.toUpperCase();
      for (const arg of n.arguments) {
        if (isAsyncFn(arg)) {
          problems.set(arg.loc.start.line, `line ${arg.loc.start.line}: ${verb} handler is async but not wrapped in asyncHandler`);
        } else if (arg.type === 'Identifier' && asyncByName.has(arg.name)) {
          const line = asyncByName.get(arg.name);
          problems.set(line, `line ${line}: ${verb} handler ${arg.name} is async but not wrapped in asyncHandler`);
        }
      }
    }
    if (isAsyncFn(n) && takesReq(n) && !isWrapped(parent) && !problems.has(n.loc.start.line)) {
      problems.set(n.loc.start.line, `line ${n.loc.start.line}: async (req, ...) handler is not wrapped in asyncHandler`);
    }
  });
  return [...problems.keys()].sort((a, b) => a - b).map(line => problems.get(line));
}

const routeFiles = fs.readdirSync(ROUTES_DIR)
  .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

describe('async route handlers are wrapped in asyncHandler', () => {
  test('there are route files to check', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  test.each(routeFiles)('main/routes/%s', file => {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    expect(unwrappedAsyncHandlers(source)).toEqual([]);
  });
});

// The scan is only worth anything if it actually catches the shapes that
// matter, so it is checked against each of them.
describe('the scan itself', () => {
  const lines = src => unwrappedAsyncHandlers(src).map(p => p.split(':')[0]);

  test('flags an inline async handler', () => {
    expect(lines(`router.post('/x', requireAuth, async (req, res) => {\n  res.json({ a: '(' });\n});`))
      .toEqual(['line 1']);
  });

  test('flags an async handler passed by name', () => {
    expect(lines(`async function create(req, res) {}\nrouter.post('/x', create);`)).toEqual(['line 1']);
    expect(lines(`const create = async function (req, res) {};\nrouter.post('/x', create);`)).toEqual(['line 1']);
  });

  test('flags an async handler returned by a factory', () => {
    expect(lines(`function report(label) {\n  return async (req, res) => {};\n}\nrouter.get('/x', report('X'));`))
      .toEqual(['line 2']);
  });

  test('accepts wrapped handlers, sync handlers and async helpers that are not handlers', () => {
    const src = [
      `router.post('/a', asyncHandler(async (req, res) => {}));`,
      `const b = asyncHandler(async (req, res) => {});`,
      `router.post('/b', b);`,
      `function report() { return asyncHandler(async (req, res) => {}); }`,
      `router.get('/c', report());`,
      `router.get('/d', (req, res) => res.json({}));`,
      `async function loadRecord(userId) { return userId; }`,
      `// router.get('/e', async (req, res) => {}) — a comment is not code`,
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });
});
