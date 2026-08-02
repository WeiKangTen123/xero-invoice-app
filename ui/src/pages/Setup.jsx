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
  DEFAULT_ACCOUNT_CODE:  'Xero account code for line items when no code is detected (e.g. 200).',
  DEFAULT_CURRENCY:      'Default invoice currency code (e.g. SGD, USD, AUD).',
  ZERO_TAX_RATE:         'Tax rate name in Xero for zero-rated items (e.g. NONE, TAX001).',
  SLACK_WEBHOOK_URL:     'Optional Slack incoming webhook URL for error notifications.',
  REDIS_URL:             'Optional Redis URL for the job queue. Leave blank to use in-memory queue.',
};

// helpUrl/helpLabel — where to actually go get the credentials this section asks
// for. Shown as a link in the section header, not just described in prose.
const SECTION_META = {
  xero: {
    label: 'Xero Connection', icon: '🔗',
    desc: 'Custom Connection credentials from developer.xero.com',
    testKey: 'xero', testLabel: 'Test Xero',
    helpUrl: 'https://developer.xero.com/app/manage', helpLabel: 'Get Client ID & Secret ↗',
  },
  imap: {
    label: 'Email / IMAP', icon: '✉',
    desc: 'Mailbox credentials for watching invoice emails',
    testKey: 'imap', testLabel: 'Test IMAP',
    helpUrl: 'https://myaccount.google.com/apppasswords', helpLabel: 'Generate a Gmail App Password ↗',
  },
  defaults: { label: 'Invoice Defaults', desc: 'Fallback values when fields cannot be detected automatically', icon: '⚙', testKey: null },
  optional: { label: 'Optional',         desc: 'Slack error notifications, Redis queue', icon: '◎', testKey: null },
};

function isSecretKey(key) {
  return /pass|secret|key|url/i.test(key);
}

function HelpLink({ url, label }) {
  if (!url) return null;
  return (
    <a
      href={url} target="_blank" rel="noopener noreferrer"
      style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}
      onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
      onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}
    >
      {label}
    </a>
  );
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

// ── One generic Xero/IMAP/defaults/optional card ────────────────────────────────
function SectionCard({ sectionKey, meta, sectionData, values, onChange, idx, testing, msgs, onTest }) {
  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: 'var(--accent-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
          }}>
            {meta.icon}
          </div>
          <div>
            <div className="card-title">{meta.label}</div>
            <div className="card-subtitle" style={{ marginBottom: 0 }}>{meta.desc}</div>
          </div>
        </div>

        {meta.testKey && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <TestResult msg={msgs[meta.testKey]} />
            <button
              type="button" className="btn btn-outline btn-sm"
              disabled={testing[meta.testKey]}
              onClick={() => onTest(meta.testKey)}
              style={{ whiteSpace: 'nowrap' }}
            >
              {testing[meta.testKey]
                ? <><span className="btn-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'var(--accent)' }} /> Testing...</>
                : `⚡ ${meta.testLabel}`}
            </button>
          </div>
        )}
      </div>

      {meta.helpUrl && (
        <div style={{ marginBottom: 14 }}><HelpLink url={meta.helpUrl} label={meta.helpLabel} /></div>
      )}

      <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

      <div className="grid-2">
        {Object.entries(sectionData).map(([name, fieldMeta]) => (
          <Field key={name} name={name} meta={fieldMeta} value={values[name] || ''} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

// ── LLM / AI Studio — multiple API keys, not a single flat field ────────────────
// A separate resource (its own add/remove endpoints) rather than part of the
// generic Setup form, since "a list the user can add to" doesn't fit the
// one-value-per-field pattern the rest of this page uses.
function LlmKeysCard({ idx, testing, msgs, onTest }) {
  const [keys,    setKeys]    = useState(null);
  const [newKey,  setNewKey]  = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [adding,  setAdding]  = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error,   setError]   = useState('');

  async function fetchKeys() {
    try { const d = await api.get('/setup/llm-keys'); setKeys(d.keys); }
    catch (_) { setKeys([]); }
  }

  useEffect(() => { fetchKeys(); }, []);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newKey.trim()) return;
    setAdding(true); setError('');
    try {
      await api.post('/setup/llm-keys', { apiKey: newKey.trim(), label: newLabel.trim() || undefined });
      setNewKey(''); setNewLabel(''); setShowNew(false);
      await fetchKeys();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id) {
    setRemoving(id);
    try { await api.delete(`/setup/llm-keys/${id}`); await fetchKeys(); }
    catch (err) { setError(err.message); }
    finally { setRemoving(null); }
  }

  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
            🤖
          </div>
          <div>
            <div className="card-title">LLM / AI Parsing</div>
            <div className="card-subtitle" style={{ marginBottom: 0 }}>
              Gemini API keys for extracting invoice data from PDFs and powering the chat assistant
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <TestResult msg={msgs.llm} />
          <button type="button" className="btn btn-outline btn-sm" disabled={testing.llm} onClick={() => onTest('llm')} style={{ whiteSpace: 'nowrap' }}>
            {testing.llm ? <><span className="btn-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'var(--accent)' }} /> Testing...</> : '⚡ Test LLM'}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <HelpLink url="https://aistudio.google.com/apikey" label="Get a Gemini API key at Google AI Studio ↗" />
      </div>

      <div style={{ height: 1, background: 'var(--border)', marginBottom: 16 }} />

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
        Add more than one key for extra headroom — when a key's quota runs out across
        every model, the next key is used automatically. Nothing extra to configure.
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

      {keys === null ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading keys…</div>
      ) : keys.length === 0 && !showNew ? (
        <div className="empty-state" style={{ padding: '20px 0' }}>
          <div className="empty-state-icon">🔑</div>
          <div>No API keys added yet</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {keys.map((k, i) => (
            <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', width: 18 }}>{i + 1}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 13, flex: 1 }}>{k.keyMasked}</span>
              {k.label && <span className="badge badge-gray">{k.label}</span>}
              <button
                type="button" className="btn btn-sm"
                disabled={removing === k.id}
                onClick={() => handleRemove(k.id)}
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}
                title="Remove key"
              >
                {removing === k.id ? '...' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showNew ? (
        <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 8, border: '1px dashed var(--border)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 2 }}>
              <input
                type="password" className="form-input" placeholder="AIza…"
                value={newKey} onChange={e => setNewKey(e.target.value)} autoFocus
                style={{ fontFamily: 'monospace' }}
              />
            </div>
            <input
              type="text" className="form-input" placeholder="Label (optional)"
              value={newLabel} onChange={e => setNewLabel(e.target.value)} style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => { setShowNew(false); setNewKey(''); setNewLabel(''); }}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={adding || !newKey.trim()}>
              {adding ? '...' : '✓ Add key'}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowNew(true)}>
          + Add another API key
        </button>
      )}
    </div>
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
        {['xero', 'imap'].map((key, idx) => {
          const sectionData = config[key];
          if (!sectionData) return null;
          return (
            <SectionCard
              key={key} sectionKey={key} meta={SECTION_META[key]} sectionData={sectionData}
              values={values} onChange={handleChange} idx={idx} testing={testing} msgs={msgs} onTest={runTest}
            />
          );
        })}

        <LlmKeysCard idx={2} testing={testing} msgs={msgs} onTest={runTest} />

        {['defaults', 'optional'].map((key, i) => {
          const sectionData = config[key];
          if (!sectionData) return null;
          return (
            <SectionCard
              key={key} sectionKey={key} meta={SECTION_META[key]} sectionData={sectionData}
              values={values} onChange={handleChange} idx={i + 3} testing={testing} msgs={msgs} onTest={runTest}
            />
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
