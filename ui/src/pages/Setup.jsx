import { useState, useEffect } from 'react';
import { api } from '../api/client';
import HelpTooltip from '../components/HelpTooltip';

const HELP = {
  XERO_CLIENT_ID:        'Your Xero Custom Connection client ID. Found in developer.xero.com → My Apps → your app.',
  XERO_CLIENT_SECRET:    'Your Xero Custom Connection client secret. Treat this like a password — never share it.',
  IMAP_HOST:             'IMAP server hostname. For Gmail: imap.gmail.com',
  IMAP_PORT:             'IMAP port. Usually 993 (TLS) or 143 (STARTTLS).',
  IMAP_USER:             'Email address used to log in to the mailbox.',
  IMAP_PASS:             'App password for the mailbox. For Gmail, generate one under Google Account → Security → App passwords.',
  IMAP_FILTER_FROM:      'Optional — only process emails from this sender address. Leave blank to process all.',
  IMAP_POLL_INTERVAL_MS: 'How often to check for new emails in milliseconds. Default: 60000 (60 seconds).',
  Gemini_API_KEY:        'Google Gemini API key for LLM parsing and the chat assistant. Get it at aistudio.google.com',
  DEFAULT_ACCOUNT_CODE:  'Xero account code for line items when no code is detected (e.g. 200).',
  DEFAULT_CURRENCY:      'Default invoice currency code (e.g. SGD, USD, AUD).',
  ZERO_TAX_RATE:         'Tax rate name in Xero for zero-rated items (e.g. NONE, TAX001).',
  SLACK_WEBHOOK_URL:     'Optional Slack incoming webhook URL for error notifications.',
  REDIS_URL:             'Optional Redis URL for the job queue. Leave blank to use in-memory queue.',
};

const SECTION_META = {
  xero:     { label: 'Xero Connection',  desc: 'Custom Connection credentials from developer.xero.com', icon: '🔗', testKey: 'xero', testLabel: 'Test Xero' },
  imap:     { label: 'Email / IMAP',     desc: 'Mailbox credentials for watching invoice emails',       icon: '✉',  testKey: 'imap', testLabel: 'Test IMAP' },
  llm:      { label: 'LLM / AI Parsing', desc: 'Gemini API key for extracting invoice data from PDFs and powering the chat assistant', icon: '🤖', testKey: 'llm', testLabel: 'Test LLM' },
  defaults: { label: 'Invoice Defaults', desc: 'Fallback values when fields cannot be detected automatically', icon: '⚙', testKey: null },
  optional: { label: 'Optional',         desc: 'Slack error notifications, Redis queue', icon: '◎', testKey: null },
};

function isSecretKey(key) {
  return /pass|secret|key|url/i.test(key);
}

function Field({ name, meta, value, onChange }) {
  const [show, setShow] = useState(false);
  const isSecret  = isSecretKey(name);
  const isReadOnly = !!meta.readOnly;

  return (
    <div className="form-group">
      <label className="form-label">
        {name}
        {HELP[name] && <HelpTooltip text={HELP[name]} />}
        {isReadOnly && <span className="badge badge-gray" style={{ marginLeft: 4 }}>Read-only</span>}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={isSecret && !show ? 'password' : 'text'}
          className="form-input"
          placeholder={`Enter ${name}`}
          value={value}
          onChange={e => onChange(name, e.target.value)}
          readOnly={isReadOnly}
          autoComplete="new-password"
          style={{
            paddingRight: isSecret ? 38 : undefined,
            opacity:      isReadOnly ? 0.55 : 1,
            cursor:       isReadOnly ? 'not-allowed' : undefined,
          }}
        />
        {isSecret && !isReadOnly && (
          <button
            type="button"
            onClick={() => setShow(v => !v)}
            title={show ? 'Hide' : 'Show'}
            style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 14,
              transition: 'color 0.15s',
              lineHeight: 1,
            }}
          >
            {show ? '🙈' : '👁'}
          </button>
        )}
      </div>
    </div>
  );
}

function TestResult({ msg }) {
  if (!msg) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 12, fontWeight: 500,
      color: msg.ok ? 'var(--success)' : 'var(--danger)',
      background: msg.ok ? 'var(--success-subtle)' : 'var(--danger-subtle)',
      padding: '4px 10px', borderRadius: 6,
      animation: 'fadeIn 0.2s ease',
    }}>
      {msg.ok ? '✓' : '✕'} {msg.text}
    </span>
  );
}

export default function Setup() {
  const [config,  setConfig]  = useState(null);
  const [values,  setValues]  = useState({});
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState({});
  const [msgs,    setMsgs]    = useState({});
  const [saved,   setSaved]   = useState(false);

  useEffect(() => {
    api.get('/setup').then(data => {
      setConfig(data);
      const flat = {};
      for (const section of Object.values(data))
        for (const [k, fieldMeta] of Object.entries(section)) flat[k] = fieldMeta.value || '';
      setValues(flat);
    }).catch(() => {});
  }, []);

  function handleChange(key, val) {
    setValues(prev => ({ ...prev, [key]: val }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await api.post('/setup', values);
      setSaved(true);
      const fresh = await api.get('/setup');
      setConfig(fresh);
      const flat = {};
      for (const section of Object.values(fresh))
        for (const [k, fieldMeta] of Object.entries(section)) flat[k] = fieldMeta.value || '';
      setValues(flat);
      setTimeout(() => setSaved(false), 3500);
    } catch (err) {
      setMsgs(prev => ({ ...prev, _save: { ok: false, text: err.message } }));
    } finally {
      setSaving(false);
    }
  }

  async function runTest(type) {
    setTesting(prev => ({ ...prev, [type]: true }));
    setMsgs(prev => ({ ...prev, [type]: null }));
    try {
      const d = await api.post(`/setup/test/${type}`);
      setMsgs(prev => ({ ...prev, [type]: { ok: true, text: d.message } }));
    } catch (err) {
      setMsgs(prev => ({ ...prev, [type]: { ok: false, text: err.message } }));
    } finally {
      setTesting(prev => ({ ...prev, [type]: false }));
    }
  }

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 16 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading configuration...
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Setup</h1>
        <p>Configure API credentials. Secrets are stored in <code style={{ fontSize: 12, background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: 4 }}>.env</code> and never exposed after saving.</p>
      </div>

      {saved && (
        <div className="alert alert-success">
          <span className="alert-icon">✓</span>
          Settings saved successfully. Changes take effect immediately.
        </div>
      )}
      {msgs._save && (
        <div className="alert alert-error">
          <span className="alert-icon">✕</span>
          {msgs._save.text}
        </div>
      )}

      <form onSubmit={handleSave}>
        {Object.entries(SECTION_META).map(([key, meta], idx) => {
          const sectionData = config[key];
          if (!sectionData) return null;
          return (
            <div
              key={key}
              className="card"
              style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}
            >
              {/* Section header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                    background: 'var(--accent-subtle)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18,
                  }}>
                    {meta.icon}
                  </div>
                  <div>
                    <div className="card-title">{meta.label}</div>
                    <div className="card-subtitle" style={{ marginBottom: 0 }}>{meta.desc}</div>
                  </div>
                </div>

                {/* Test button */}
                {meta.testKey && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <TestResult msg={msgs[meta.testKey]} />
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={testing[meta.testKey]}
                      onClick={() => runTest(meta.testKey)}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {testing[meta.testKey]
                        ? <><span className="btn-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'var(--accent)' }} /> Testing...</>
                        : `⚡ ${meta.testLabel}`}
                    </button>
                  </div>
                )}
              </div>

              <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

              <div className="grid-2">
                {Object.entries(sectionData).map(([name, fieldMeta]) => (
                  <Field
                    key={name}
                    name={name}
                    meta={fieldMeta}
                    value={values[name] || ''}
                    onChange={handleChange}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Save bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12,
          padding: '16px 0',
          position: 'sticky', bottom: 0,
          background: 'linear-gradient(to top, var(--bg-primary) 80%, transparent)',
          zIndex: 10,
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Secrets are hidden by default — click 👁 to reveal
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
            style={{ minWidth: 130 }}
          >
            {saving
              ? <><span className="btn-spinner" /> Saving...</>
              : '💾 Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
