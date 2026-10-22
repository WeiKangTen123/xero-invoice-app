// The "Get set up" checklist: four steps in the setup guide's order, each
// done when it works rather than when its boxes are filled in. The server
// judges each step (GET /api/onboarding → checklist, main/utils/onboarding.js)
// as { done, detail }; these put them in order, count them and say where to
// go for each one that is not done yet.
//
// Plain functions and values with no imports, so
// main/scripts/onboarding-ui.test.js can load and run them;
// SetupChecklist.jsx only draws what checklistView returns.

// Each step's action: the Setup card that sets it up (the ids on Setup.jsx's
// cards), or the Automation page, where the watcher is started.
export const CHECKLIST_STEPS = [
  { key: 'llm',     label: 'AI reading', to: '/setup#setup-llm',  action: 'Set up' },
  { key: 'mailbox', label: 'Mailbox',    to: '/setup#setup-imap', action: 'Set up' },
  { key: 'xero',    label: 'Xero',       to: '/setup#setup-xero', action: 'Connect' },
  { key: 'watcher', label: 'Watcher',    to: '/automation',       action: 'Start watcher' },
];

export const CHECKLIST_TITLE = 'Get set up';

// A Test reads what is saved, not what is typed in the box.
export const CHECKLIST_HINT = 'Save in Setup before pressing Test.';

// The checklist as drawn: { rows, doneCount, total, percent, complete }, each
// row { key, label, done, detail, to, action }. A step the server left out
// counts as not done. null when there is no checklist to draw (not loaded,
// or the server could not read it).
export function checklistView(checklist) {
  if (!checklist || typeof checklist !== 'object') return null;
  const rows = CHECKLIST_STEPS.map(step => {
    const s = checklist[step.key] || {};
    return { ...step, done: s.done === true, detail: typeof s.detail === 'string' ? s.detail : '' };
  });
  const doneCount = rows.filter(r => r.done).length;
  const total     = rows.length;
  return { rows, doneCount, total, percent: Math.round((doneCount / total) * 100), complete: doneCount === total };
}

// Whether the checklist is shown: once all four are done it has nothing
// left to say, and it goes.
export function showChecklist(view) {
  return !!view && !view.complete;
}

// "2 of 4".
export function progressText(view) {
  return view ? `${view.doneCount} of ${view.total}` : '';
}

// The id of the Setup card an address points at ('/setup#setup-llm' →
// 'setup-llm'), for Setup.jsx to bring it into view; '' for anything else.
export function setupAnchor(hash) {
  const id = String(hash || '').replace(/^#/, '');
  return /^setup-[a-z]+$/.test(id) ? id : '';
}
