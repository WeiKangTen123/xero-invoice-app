// The privacy notice every account reads once (Singapore's PDPA notification
// obligation): what this app keeps about a person, why, where it goes, how
// long it is kept, and who to ask. The server records which version an
// account saw and when (POST /api/onboarding/notice, main/utils/onboarding.js)
// and says whether it must be shown (GET /api/onboarding, notice.required).
//
// Plain functions and values with no imports, so
// main/scripts/onboarding-ui.test.js can load and run them; PrivacyNotice.jsx
// draws them and Layout.jsx decides when.

// The version of the words below. It must match the server's
// NOTICE_VERSION (main/utils/onboarding.js): raise both together when the
// words change in a way people must be told about, and every account is
// asked again.
export const PRIVACY_NOTICE_VERSION = 1;

export const PRIVACY_NOTICE_TITLE = 'Before you start';

export const PRIVACY_NOTICE_BUTTON = 'I understand';

// Who to write to, as the notice says it: the address the server names
// (Setup's privacy contact, else an admin's), or, with none at all, the
// person's administrator.
export function contactText(contact) {
  const c = typeof contact === 'string' ? contact.trim() : '';
  return c || 'your administrator';
}

// The notice's three paragraphs, the last naming who to ask.
export function noticeParagraphs(contact) {
  return [
    'This app keeps your email address, and the times and places you sign in from (IP address, browser and approximate city), to keep accounts safe. Sign-in records are kept for 90 days and admin actions for 2 years.',
    'Documents you send in are stored on a Google Cloud server in the United States and read by Google Gemini. Documents you post go to your Xero.',
    `Questions or requests about your data: ${contactText(contact)}.`,
  ];
}

// Whether the server may be asked about the notice at all. Not while a
// password must be set or 2-step sign-in set up: the server refuses
// everything else then (403), and those screens come first.
export function canAskForNotice(user) {
  return !!user && !user.mustChangePassword && !user.mfaSetupRequired;
}

// Whether the notice is shown now: the server says this account has not
// read this version, and nothing comes before it.
export function shouldShowNotice(user, notice) {
  return canAskForNotice(user) && !!notice && notice.required === true;
}

// What to say when "I understand" could not be recorded. A notice that has
// changed since the page loaded (409 NOTICE_CHANGED) needs a reload to show
// the new words; anything else can simply be pressed again.
export function acknowledgeError(err) {
  if (err && (err.code === 'NOTICE_CHANGED' || err.status === 409)) {
    return 'This notice has changed since the page loaded. Reload the page to read the new one.';
  }
  return `Could not save that: ${(err && err.message) || 'the server did not answer'}. Try again.`;
}
