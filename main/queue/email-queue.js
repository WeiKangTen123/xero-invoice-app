const fs   = require('fs');
const path = require('path');

const BASE_DIR    = path.join(__dirname, '../data/users');
const MAX_ATTEMPTS = 3;

function _jobDir(userId)         { return path.join(BASE_DIR, userId, 'email-queue'); }
// Use .que extension (not .json) so nodemon never watches these files,
// regardless of ignore patterns or extension filters in the dev config.
function _jobFile(userId, jobId) { return path.join(_jobDir(userId), `${jobId}.que`); }
function _pdfPath(userId, ref)   { return path.join(_jobDir(userId), ref); }

// Persist an email (mailparser result) as a queue job.
// PDF attachment buffers are written as separate binary files so the JSON stays small.
function enqueue(userId, parsedEmail) {
  const id  = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const dir = _jobDir(userId);
  fs.mkdirSync(dir, { recursive: true });

  const pdfAtts = (parsedEmail.attachments || []).filter(a =>
    a.contentType === 'application/pdf' ||
    (a.filename || '').toLowerCase().endsWith('.pdf')
  );

  const attachments = pdfAtts.map((a, idx) => {
    const ref = `${id}-${idx}.pdf`;
    if (a.content) fs.writeFileSync(_pdfPath(userId, ref), a.content);
    return { filename: a.filename || `attachment-${idx}.pdf`, ref };
  });

  // Only store text body; HTML is large and we fall back to text anyway.
  // If text is empty, strip tags from HTML as a last resort.
  const textBody = parsedEmail.text ||
    (parsedEmail.html ? parsedEmail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

  const job = {
    id,
    userId,
    status:    'pending',
    attempts:  0,
    createdAt: new Date().toISOString(),
    email: {
      from:    parsedEmail.from?.text || '',
      subject: parsedEmail.subject    || '',
      date:    parsedEmail.date ? parsedEmail.date.toISOString() : null,
      text:    textBody,
      attachments,
    },
  };

  fs.writeFileSync(_jobFile(userId, id), JSON.stringify(job, null, 2));
  return job;
}

// Return all actionable jobs for a user, ordered oldest-first.
// Includes 'processing' jobs — these were abandoned mid-flight by a server restart/crash
// and must be retried. The worker's busy flag prevents double-processing within one process.
function getPending(userId) {
  const dir = _jobDir(userId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.que'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(j => j && (j.status === 'pending' || j.status === 'processing'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return []; }
}

// Return queue stats for the status endpoint (all statuses).
function getStats(userId) {
  const dir = _jobDir(userId);
  if (!fs.existsSync(dir)) return { pending: 0, processing: 0, dead: 0, jobs: [] };
  try {
    const jobs = fs.readdirSync(dir)
      .filter(f => f.endsWith('.que'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
    return {
      pending:    jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      dead:       jobs.filter(j => j.status === 'dead').length,
      jobs: jobs.map(j => ({
        id:       j.id,
        status:   j.status,
        attempts: j.attempts,
        subject:  j.email?.subject || '',
        from:     j.email?.from    || '',
        pdfs:     (j.email?.attachments || []).map(a => a.filename),
        createdAt: j.createdAt,
        lastError: j.lastError || null,
      })),
    };
  } catch { return { pending: 0, processing: 0, dead: 0, jobs: [] }; }
}

// Delete all queued jobs and their PDF attachments for a user.
function clearAll(userId) {
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

function markProcessing(userId, jobId) {
  const file = _jobFile(userId, jobId);
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Only increment attempts when transitioning from 'pending' → 'processing'.
    // If already 'processing' (recovered from a crash), don't double-count the attempt.
    if (job.status === 'pending') job.attempts++;
    job.status = 'processing';
    fs.writeFileSync(file, JSON.stringify(job, null, 2));
  } catch {}
}

// Delete the job file and its PDF attachments.
function markDone(userId, jobId) {
  const file = _jobFile(userId, jobId);
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    (job.email?.attachments || []).forEach(a => {
      try { fs.unlinkSync(_pdfPath(userId, a.ref)); } catch {}
    });
    fs.unlinkSync(file);
  } catch {}
}

// On failure, reset to pending for retry or delete after maxAttempts (dead jobs).
function markFailed(userId, jobId, error) {
  const file = _jobFile(userId, jobId);
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    job.lastError = String(error);
    if (job.attempts >= MAX_ATTEMPTS) {
      // Job is dead — delete it and its PDF attachments so it never accumulates
      (job.email?.attachments || []).forEach(a => {
        try { fs.unlinkSync(_pdfPath(userId, a.ref)); } catch {}
      });
      try { fs.unlinkSync(file); } catch {}
    } else {
      job.status = 'pending';
      fs.writeFileSync(file, JSON.stringify(job, null, 2));
    }
  } catch {}
}

// Reconstruct a mailparser-compatible email object from a stored job.
// Called by the worker just before passing to parseInvoice.
function reconstructEmail(userId, job) {
  const { email } = job;
  const attachments = (email.attachments || []).map(a => {
    let content = null;
    try {
      const p = _pdfPath(userId, a.ref);
      if (fs.existsSync(p)) content = fs.readFileSync(p);
    } catch {}
    return content ? { filename: a.filename, contentType: 'application/pdf', content } : null;
  }).filter(Boolean);

  return {
    from:        { text: email.from },
    subject:     email.subject,
    date:        email.date ? new Date(email.date) : null,
    text:        email.text,
    attachments,
  };
}

module.exports = {
  enqueue, getPending, getStats, getAllUserIds,
  markProcessing, markDone, markFailed,
  reconstructEmail, clearAll,
};
