const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const onboarding = require('../utils/onboarding');
const { isDemoUser } = require('../utils/users');
const logger = require('../utils/logger');

// The privacy notice and the "Get set up" checklist (utils/onboarding.js),
// for the signed-in account. Read by the app's frame (Layout.jsx), which
// shows the notice over whatever page comes first after signing in, and by
// the checklist on Setup and on the Dashboard.

// GET /api/onboarding →
//   { notice: { required, version, contact },
//     checklist: { llm, mailbox, xero, watcher }, each { done, detail },
//     demo }
// `contact` is who to ask about one's data (null when there is no admin to
// name). The checklist is null when it could not be read: the notice must
// still reach the person, whatever a connection helper made of their setup.
router.get('/', requireAuth, (req, res, next) => {
  try {
    const userId  = req.user.id;
    const version = onboarding.currentNoticeVersion();
    const notice  = onboarding.noticeState(userId, version);
    let checklist = null;
    try {
      checklist = onboarding.checklist(userId);
    } catch (err) {
      logger.warn('Could not read the setup checklist', { userId, error: err.message });
    }
    res.json({
      notice: { required: notice.required, version, contact: onboarding.privacyContact() },
      checklist,
      demo: isDemoUser(userId),
    });
  } catch (err) { next(err); }
});

// POST /api/onboarding/notice { version } → { success: true }
// Records that the account read this version of the privacy notice, and
// when, with an event in the audit log beside it. Only the current version
// is taken: a page loaded before the notice changed showed the old words, so
// it is told to reload (409, code NOTICE_CHANGED) rather than recorded as
// having read words it never showed. Pressing it again for a version already
// recorded keeps the first time, and adds no second event.
router.post('/notice', requireAuth, (req, res, next) => {
  try {
    const userId  = req.user.id;
    const version = onboarding.currentNoticeVersion();
    const sent    = Number(req.body?.version);
    if (!Number.isInteger(sent) || sent < 1 || sent > version) {
      return res.status(400).json({ error: `version must be ${version}` });
    }
    if (sent < version) {
      return res.status(409).json({
        error: 'The privacy notice has changed since this page loaded. Reload the page to read the new one.',
        code: 'NOTICE_CHANGED', version,
      });
    }
    if (!onboarding.noticeState(userId, version).required) return res.json({ success: true });

    onboarding.acknowledgeNotice(userId, version);
    const auditLog = require('../utils/audit-log');
    const self = { id: userId, email: req.user.email };
    auditLog.safely(() => auditLog.recordAdminEvent({
      actor: self, target: self, action: 'notice.acknowledged', details: { version },
    }), 'Privacy notice acknowledgement');
    logger.info('Privacy notice acknowledged', { userId, version });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
