const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');
const { documentKind, imageMime } = require('../intake/document');

const BASE_DIR    = require('../utils/paths').usersDir();
const MAX_ATTEMPTS = 3;

// The largest attachment taken into the queue. The worker reads the whole file
// into memory and sends it to the model base64-encoded (a third larger again),
// and the model refuses an inline file much past 20 MB anyway. A bigger one
// cost a memory spike and a guaranteed failure, three times over. Real bills
// are a few hundred KB; anything this large is a scan or a brochure.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// How long a failed job waits before its next attempt: a minute after the
// first failure, five after the second (the third is the last). Most failures
// are a model rate limit or a Xero hiccup that clears in minutes, and an
// immediate retry spent all three attempts on the same outage within seconds.
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS  = 30 * 60 * 1000;

function retryDelayMs(attempts) {
  return Math.min(RETRY_BASE_MS * Math.pow(5, Math.max(0, attempts - 1)), RETRY_MAX_MS);
}

function _jobDir(userId)         { return path.join(BASE_DIR, userId, 'email-queue'); }
// Use .que extension (not .json) so nodemon never watches these files,
// regardless of ignore patterns or extension filters in the dev config.
function _jobFile(userId, jobId) { return path.join(_jobDir(userId), `${jobId}.que`); }
function _pdfPath(userId, ref)   { return path.join(_jobDir(userId), ref); }

// ── The status summary ────────────────────────────────────────────────────────
// The dashboard asks for the queue's state every few seconds per open tab, and
// that used to read and parse every job file on each ask. The summary is now
// built from disk once per user and then kept in step by the functions below,
// which are the only writers of job files. Built lazily, so a process that
// never shows the status never reads for it; one process serves the app
// (ecosystem.config.js runs a single fork), so nothing else writes behind it.
const _summaries = new Map();   // userId → Map(jobId → summary)

function _summary(job) {
  return {
    id:        job.id,
    status:    job.status,
    attempts:  job.attempts,
    subject:   job.email?.subject || '',
    from:      job.email?.from    || '',
    pdfs:      (job.email?.attachments || []).map(a => a.filename),
    createdAt: job.createdAt,
    lastError: job.lastError || null,
  };
}

function _remember(userId, job) {
  const known = _summaries.get(userId);
  if (known && job?.id) known.set(job.id, _summary(job));
}

function _forget(userId, jobId) {
  const known = _summaries.get(userId);
  if (known) known.delete(jobId);
}

// Every job file is written whole or not at all: into a temporary file, then
// renamed over the real one, which replaces it in one step. A crash in the
// middle of a plain writeFileSync left a job file cut short, and that job was
// lost. The temporary name does not end in .que, so nothing reads it as a job.
function _writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Writes a job and keeps the status summary in step with what is on disk.
function _writeJob(userId, job) {
  _writeJson(_jobFile(userId, job.id), job);
  _remember(userId, job);
}

// A file that exists but is not a job (cut short by a crash from before writes
// were atomic, or damaged on disk) is moved aside as <name>.corrupt-<time> and
// logged. It used to be skipped in silence on every read, and since the mail
// was already marked read in the mailbox it vanished with nothing to show it
// had ever arrived. Kept rather than deleted, so it can be read by hand.
function _setAside(userId, file, err) {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    _forget(userId, path.basename(file, '.que'));
    logger.error('Email queue: unreadable job file set aside', { file: aside, error: err.message });
  } catch (renameErr) {
    logger.error('Email queue: unreadable job file could not be set aside', { file, error: err.message, renameError: renameErr.message });
  }
}

// One job, or null. A file that cannot be read at all is not set aside: it was
// finished and deleted between the directory listing and the read, or is
// briefly locked, and the next read will see it as it is.
function _readJobFile(userId, file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const job = JSON.parse(raw);
    if (!job || typeof job !== 'object' || !job.id) throw new Error('not a queue job');
    return job;
  } catch (err) {
    _setAside(userId, file, err);
    return null;
  }
}

function _readAll(userId) {
  const dir = _jobDir(userId);
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.que')); } catch { return []; }
  return names.map(f => _readJobFile(userId, path.join(dir, f))).filter(Boolean);
}

function _attachmentBytes(a) {
  if (Buffer.isBuffer(a.content)) return a.content.length;
  if (typeof a.content === 'string') return Buffer.byteLength(a.content);
  return Number(a.size) || 0;
}

// mailparser hands over an Invalid Date for a malformed header, and
// toISOString() on one throws — which used to drop the whole mail.
const _isoDate = d => (d && !Number.isNaN(+d) ? new Date(d).toISOString() : null);

// Where a document came from when it was not the email itself: an email
// forwarded inside this one as an attachment. The forwarder is a colleague,
// not the supplier, so the parser reads the contact and the description from
// the inner message's sender and subject.
function _forwardedOrigin(inner) {
  const sender = inner.from?.value?.[0] || {};
  return {
    from:        inner.from?.text || '',
    fromAddress: sender.address || '',
    fromName:    sender.name || '',
    subject:     inner.subject || '',
    date:        _isoDate(inner.date),
    messageId:   inner.messageId || null,
  };
}

// What on an email is read as a document: its PDFs and attached photos
// (intake/document.js documentKind decides which), and those of any email
// forwarded inside it as an attachment. watcher-registry parses forwarded
// messages one level down and hands them over as `forwarded`; an email
// forwarded inside one of those is not opened.
function _documents(parsedEmail) {
  const docs = [];
  for (const a of parsedEmail.attachments || []) {
    const kind = documentKind(a);
    if (kind) docs.push({ a, kind, origin: null });
  }
  for (const inner of parsedEmail.forwarded || []) {
    const origin = _forwardedOrigin(inner);
    for (const a of inner.attachments || []) {
      const kind = documentKind(a);
      if (kind) docs.push({ a, kind, origin });
    }
  }
  return docs;
}

const _IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif' };

// Persist an email (mailparser result) as a queue job. Attachment buffers are
// written as separate binary files so the JSON stays small. Each one is marked
// with its kind: a PDF goes to the text reader, a photo to the vision reader
// (email/parser.js), so nothing downstream guesses again from a name.
function enqueue(userId, parsedEmail) {
  const id  = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const dir = _jobDir(userId);
  fs.mkdirSync(dir, { recursive: true });

  // Only store text body; HTML is large and we fall back to text anyway.
  // If text is empty, strip tags from HTML as a last resort.
  const textBody = parsedEmail.text ||
    (parsedEmail.html ? parsedEmail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

  const attachments = [];
  const skipped     = [];
  const written     = [];
  try {
    _documents(parsedEmail).forEach(({ a, kind, origin }, idx) => {
      const mime     = kind === 'pdf' ? 'application/pdf' : imageMime(a);
      const ext      = kind === 'pdf' ? 'pdf' : _IMAGE_EXT[mime] || 'img';
      const filename = a.filename || (kind === 'pdf' ? `attachment-${idx}.pdf` : `photo-${idx}.${ext}`);
      const bytes    = _attachmentBytes(a);
      if (bytes > MAX_ATTACHMENT_BYTES) {
        skipped.push({ filename, bytes, reason: `larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit` });
        return;
      }
      const ref = `${id}-${idx}.${ext}`;
      if (a.content) { fs.writeFileSync(_pdfPath(userId, ref), a.content); written.push(ref); }
      const entry = { filename, ref, kind, contentType: mime };
      if (origin) entry.forwarded = origin;
      attachments.push(entry);
    });

    const job = {
      id,
      userId,
      status:    'pending',
      attempts:  0,
      createdAt: new Date().toISOString(),
      email: {
        // What recognises this email if the mailbox delivers it again; the
        // worker checks it before anything is read (queue/email-worker.js).
        messageId: parsedEmail.messageId || null,
        from:    parsedEmail.from?.text || '',
        subject: parsedEmail.subject    || '',
        date:    _isoDate(parsedEmail.date),
        text:    textBody,
        attachments,
      },
    };
    // Recorded on the job as well as logged, so a job that later fails or
    // dies still says which attachment never reached it.
    if (skipped.length) job.email.skippedAttachments = skipped;

    _writeJob(userId, job);
    if (skipped.length) {
      logger.warn(`[email-queue:${userId}] Attachment(s) too large to process were left out of the job`, {
        jobId: id, subject: job.email.subject, skipped,
      });
    }
    return job;
  } catch (err) {
    // No job file means no job: the files written for it would be orphans.
    for (const ref of written) { try { fs.unlinkSync(_pdfPath(userId, ref)); } catch {} }
    throw err;
  }
}

// Return all actionable jobs for a user, ordered oldest-first.
// Includes 'processing' jobs — these were abandoned mid-flight by a server restart/crash
// and must be retried; each such retry still counts as an attempt (markProcessing).
// Also includes jobs waiting out a retry delay: the worker picks among them with isDue.
function getPending(userId) {
  return _readAll(userId)
    .filter(j => j.status === 'pending' || j.status === 'processing')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// Whether a pending job's retry delay has passed. An unreadable time counts as
// due, so a damaged field cannot park a job for ever.
function isDue(job, now = Date.now()) {
  if (!job.nextAttemptAt) return true;
  const t = Date.parse(job.nextAttemptAt);
  return !Number.isFinite(t) || t <= now;
}

// Return queue stats for the status endpoint (all statuses), from the summary
// kept in step with every write; the files are read only to build it.
function getStats(userId) {
  try {
    let known = _summaries.get(userId);
    if (!known) {
      known = new Map(_readAll(userId).map(j => [j.id, _summary(j)]));
      _summaries.set(userId, known);
    }
    const jobs = [...known.values()];
    return {
      pending:    jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      dead:       jobs.filter(j => j.status === 'dead').length,
      // Copies: a caller that edits what it was given must not edit the summary.
      jobs: jobs.map(j => ({ ...j, pdfs: [...j.pdfs] })),
    };
  } catch { return { pending: 0, processing: 0, dead: 0, jobs: [] }; }
}

// Delete all queued jobs and their attachments for a user.
function clearAll(userId) {
  _summaries.delete(userId);
  const dir = _jobDir(userId);
  if (!fs.existsSync(dir)) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

// Return all user IDs that have an email-queue directory (for startup recovery).
function getAllUserIds() {
  if (!fs.existsSync(BASE_DIR)) return [];
  try {
    return fs.readdirSync(BASE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(BASE_DIR, d.name, 'email-queue')))
      .map(d => d.name);
  } catch { return []; }
}

// Claims a job for one run and counts the attempt, on disk, before any work
// starts. Returns the claimed job, or null when it must not run: gone,
// unreadable, already dead, or out of attempts (it is marked dead here).
//
// Every claim counts, including the reclaim of a job left 'processing' by a
// process that died. Only the pending → processing move used to count, so a
// mail that crashed the server was rerun on every boot with its attempts stuck
// at 1, and once pm2 gave up restarting, the app was down for every account.
// Now such a job has the same three runs as any other, then is kept as dead.
//
// Throws if the claim cannot be written: a job whose attempt was not recorded
// must not run, or a crash during it would not count.
function markProcessing(userId, jobId) {
  const file = _jobFile(userId, jobId);
  const job  = _readJobFile(userId, file);
  if (!job || job.status === 'dead') return null;

  if ((job.attempts || 0) >= MAX_ATTEMPTS) {
    const interrupted = job.status === 'processing';
    job.status = 'dead';
    delete job.nextAttemptAt;
    if (interrupted || !job.lastError) {
      job.lastError = `Stopped after ${job.attempts} attempts that never finished: the server stopped or crashed while this email was being read`;
    }
    _writeJob(userId, job);
    logger.error(`[email-queue:${userId}] Job ${jobId} is out of attempts and kept as dead`, { subject: job.email?.subject, lastError: job.lastError });
    return null;
  }

  if (job.status === 'processing') {
    logger.warn(`[email-queue:${userId}] Job ${jobId} was interrupted mid-run (attempt ${job.attempts}); retrying, and counting it`, { subject: job.email?.subject });
  }
  job.attempts  = (job.attempts || 0) + 1;
  job.status    = 'processing';
  job.claimedAt = new Date().toISOString();
  delete job.nextAttemptAt;
  _writeJob(userId, job);
  return job;
}

// Delete the job file and its attachments.
function markDone(userId, jobId) {
  const file = _jobFile(userId, jobId);
  try {
    const job = _readJobFile(userId, file);
    (job?.email?.attachments || []).forEach(a => {
      try { fs.unlinkSync(_pdfPath(userId, a.ref)); } catch {}
    });
    fs.unlinkSync(file);
    _forget(userId, jobId);
  } catch {}
}

// On failure, back to pending with a retry delay (retryDelayMs); after
// MAX_ATTEMPTS the job is kept as 'dead' with its attachments. It used to be
// deleted, so a mail that failed three times — already marked read in the
// mailbox — vanished without a trace, and the queue's "dead" count was always
// zero.
function markFailed(userId, jobId, error) {
  const file = _jobFile(userId, jobId);
  const job  = _readJobFile(userId, file);
  if (!job) return;
  job.lastError = String(error);
  if ((job.attempts || 0) >= MAX_ATTEMPTS) {
    job.status = 'dead';
    delete job.nextAttemptAt;
  } else {
    job.status        = 'pending';
    job.nextAttemptAt = new Date(Date.now() + retryDelayMs(job.attempts || 1)).toISOString();
  }
  try { _writeJob(userId, job); } catch (err) {
    // Left as 'processing', which the next claim counts and retries.
    logger.error(`[email-queue:${userId}] Could not record failure of job ${jobId}`, { error: err.message });
  }
}

// Reconstruct a mailparser-compatible email object from a stored job.
// Called by the worker just before passing to parseInvoice. A job queued
// before attachments carried a kind held nothing but PDFs.
function reconstructEmail(userId, job) {
  const { email } = job;
  const attachments = (email.attachments || []).map(a => {
    let content = null;
    try {
      const p = _pdfPath(userId, a.ref);
      if (fs.existsSync(p)) content = fs.readFileSync(p);
    } catch {}
    if (!content) return null;
    const kind = a.kind || 'pdf';
    const out  = { filename: a.filename, contentType: a.contentType || (kind === 'pdf' ? 'application/pdf' : null), content, kind };
    if (a.forwarded) {
      const f = a.forwarded;
      out.forwarded = {
        from:      { text: f.from || '', value: f.fromAddress ? [{ address: f.fromAddress, name: f.fromName || '' }] : [] },
        subject:   f.subject || '',
        date:      f.date ? new Date(f.date) : null,
        messageId: f.messageId || null,
      };
    }
    return out;
  }).filter(Boolean);

  return {
    messageId:   email.messageId || null,
    from:        { text: email.from },
    subject:     email.subject,
    date:        email.date ? new Date(email.date) : null,
    text:        email.text,
    attachments,
  };
}

module.exports = {
  MAX_ATTEMPTS, MAX_ATTACHMENT_BYTES,
  enqueue, getPending, isDue, retryDelayMs, getStats, getAllUserIds,
  markProcessing, markDone, markFailed,
  reconstructEmail, clearAll,
};
