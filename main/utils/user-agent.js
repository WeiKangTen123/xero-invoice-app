// What browser and device a User-Agent header names, in the words an admin
// reads on an account's sign-ins and sessions: "Chrome · Windows",
// "Safari · iPhone".
//
// Built on ua-parser-js 1.x, which is MIT. Version 2 changed its licence to
// AGPL, so package.json pins ^1: moving to 2 is a licence decision, not an
// upgrade.
//
// No versions, of the browser or the system. Browsers now freeze the system
// version they send (every Mac says 10.15, every Windows says 10), so a
// version would be a guess dressed as a fact, and it is the browser and the
// device that tell one sign-in from another anyway.
const UAParser = require('ua-parser-js');

// ua-parser's names, in the words people use for them.
const BROWSER_NAMES = { 'Chrome Headless': 'Headless Chrome', 'Chrome WebView': 'Android WebView' };
const OS_NAMES      = { 'Mac OS': 'macOS', 'Chromium OS': 'ChromeOS' };

// An iPhone or an iPad is named as itself: "Safari · iPhone" says more than
// "Safari · iOS". (An iPad on iPadOS 13 or later says it is a Mac, and is
// shown as one; nothing in the header tells them apart.)
const NAMED_DEVICES = new Set(['iPhone', 'iPad', 'iPod']);

/**
 * { browser, os, device, label } for a User-Agent string. browser and os are
 * names or null; device is 'mobile', 'tablet', 'desktop' or null when nothing
 * says; label is one line for the screen, "Unknown device" for an empty
 * header, and for something that is not a browser (a script) the name it
 * gives itself, such as "curl".
 */
function describeUserAgent(ua) {
  const s = String(ua ?? '').trim();
  if (!s) return { browser: null, os: null, device: null, label: 'Unknown device' };

  let r;
  try { r = new UAParser(s).getResult(); } catch (_) { r = { browser: {}, os: {}, device: {} }; }
  const rawBrowser = r.browser && r.browser.name;
  const rawOs      = r.os && r.os.name;
  const browser = rawBrowser ? (BROWSER_NAMES[rawBrowser] || rawBrowser.replace(/^Mobile /, '')) : null;
  const os      = rawOs ? (OS_NAMES[rawOs] || rawOs) : null;
  const type    = r.device && r.device.type;
  const device  = type === 'mobile' || type === 'tablet' ? type : (browser || os ? 'desktop' : null);

  const model = r.device && r.device.model;
  const where = model && NAMED_DEVICES.has(model) ? model : os;
  let label = [browser, where].filter(Boolean).join(' · ');
  if (!label) {
    // Not a browser: the first product token, "curl/8.4.0" -> "curl".
    const product = /^([A-Za-z][\w.-]{0,39})/.exec(s);
    label = product ? product[1] : 'Unknown device';
  }
  return { browser, os, device, label };
}

module.exports = { describeUserAgent };
