import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import ChartOfAccounts from '../components/ChartOfAccounts';
import HelpTooltip from '../components/HelpTooltip';
import AccountCodeSelect from '../components/AccountCodeSelect';
import RetryAlert from '../components/RetryAlert';
import TestResult from '../components/ResultNote';
import SetupChecklist from '../components/SetupChecklist';
import { setupAnchor } from '../components/setup-checklist';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { TIMEZONE_OPTIONS, DEFAULT_TIMEZONE } from '../utils/formatDate';
import { useUnsavedChanges } from '../utils/useUnsavedChanges';
import { boxState, defaultBoxes, extrasParam, optionalBoxes, connectionView, demoCard } from './setup/connect';
import { canChooseDataSource, sourceOptions } from './setup/data-source';
import { useDataSource } from './setup/useDataSource';
import { companiesView, companyBadge } from './setup/company-status';
import { secretView, secretNote, changeNote, CHANGE_PLACEHOLDER, keyListEmptyText, legacyKeyText, legacyKeyTitle } from './setup/secrets';

const HELP = {
  XERO_CLIENT_ID:        'Your Xero Custom Connection client ID. Found in developer.xero.com → My Apps → your app.',
  XERO_CLIENT_SECRET:    'Your Xero Custom Connection client secret. Treat this like a password — never share it.',
  IMAP_HOST:             'IMAP server hostname. For Gmail: imap.gmail.com',
  IMAP_PORT:             'IMAP port. Usually 993 (TLS) or 143 (STARTTLS).',
  IMAP_USER:             'Email address used to log in to the mailbox.',
  IMAP_PASS:             'App password for the mailbox. For Gmail, generate one under Google Account → Security → App passwords.',
  IMAP_FILTER_FROM:      'Optional — only process emails from this sender address. Leave blank to process all.',
  IMAP_POLL_INTERVAL_MS: 'How often to check for new emails in milliseconds. Default: 60000 (60 seconds).',
  IMAP_LOOKBACK_DAYS:    'How many days back to search for unread invoice emails. Default: 100. Max: 365.',
  DEFAULT_ACCOUNT_CODE:  'Xero account used for line items when the parser detects no account. Picked from your connected organisation\'s chart of accounts — or type any code your org uses.',
  DEFAULT_CURRENCY:      'Default invoice currency code (e.g. SGD, USD, AUD).',
  ZERO_TAX_RATE:         'Tax rate name in Xero for zero-rated items (e.g. NONE, TAX001).',
  CLAIM_PAYEE_NAME:      'Your name as the payee on expense claims sent to Xero, exactly as your contact appears there. The shop goes into each line\'s description. Leave blank to keep sending claims to the shop as the contact.',
  MILEAGE_RATE:          'What a km driven for work is paid at, in your default currency, up to 4 decimal places (e.g. 0.60). Blank turns mileage claims off. A claim keeps the rate it was made at.',
  MILEAGE_ACCOUNT_CODE:  'The Xero account mileage claims are coded to. Blank uses your claim account.',
  PER_DIEM_RATE:         'The daily travel allowance, in your default currency (e.g. 80.00). Half days are paid at half. Blank turns per diem claims off. A claim keeps the rate it was made at.',
  PER_DIEM_ACCOUNT_CODE: 'The Xero account per diem claims are coded to. Blank uses your claim account.',
  SLACK_WEBHOOK_URL:     'Optional Slack incoming webhook URL for error notifications.',
  XERO_OAUTH_CLIENT_ID:     'Client ID from your own Xero "Web app" (not Custom Connection). Each user brings their own — not shared with other accounts.',
  XERO_OAUTH_CLIENT_SECRET: 'Client secret for the same Xero Web app.',
  XERO_OAUTH_REDIRECT_URI:  'Set once for this whole server — register this exact value as a redirect URI on every user\'s Xero Web app. Must be HTTPS in production (http://localhost is fine for local dev).',
  TIMEZONE:                 'Controls what timezone dates/times are DISPLAYED in throughout the app — everything is still stored and processed the same way regardless of this setting.',
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
    desc: 'The mailbox to watch. Most settings are worked out from your email address — fill in what is asked below.',
    testKey: 'imap', testLabel: 'Test IMAP',
    helpUrl: 'https://myaccount.google.com/apppasswords', helpLabel: 'Generate a Gmail App Password ↗',
  },
  defaults:    { label: 'Invoice Defaults', desc: 'Fallback values when fields cannot be detected automatically', icon: '⚙', testKey: null },
  allowances:  {
    label: 'Mileage and allowances', icon: '🚗', testKey: null,
    desc: 'Expense claims with no receipt: a rate per km driven, and a daily allowance for travel. Set a rate to offer that claim on the claims tab; leave it blank to keep it off.',
  },
  preferences: { label: 'Preferences',      desc: 'Personal display settings — do not affect processing', icon: '🕒', testKey: null },
  optional:    { label: 'Optional',         desc: 'Slack error notifications', icon: '◎', testKey: null },
  xeroOAuth: {
    label: 'Xero OAuth Redirect URI (admin)', icon: '🔐',
    desc: 'Set once for the whole server — every user registers this same value on their own Xero Web app',
    testKey: null,
  },
  // For the whole server: what invites and password-reset links are emailed
  // with. Left empty, the admin is shown each link to send themselves.
  email: {
    label: 'Email sending (admin)', icon: '📨',
    desc: 'Sends invites and password-reset links. Not set up: you copy links and send them yourself.',
    testKey: 'email', testLabel: 'Send test email',
    helpUrl: 'https://myaccount.google.com/apppasswords', helpLabel: 'Gmail App Password ↗',
  },
  // For the whole server: who the privacy notice every account reads names
  // as the person to ask about their data.
  privacy: {
    label: 'Privacy contact (admin)', icon: '🛡',
    desc: 'Named in the privacy notice as who to ask about personal data. Blank: the admin who signed in most recently.',
    testKey: null,
  },
  // For the whole server: whether people may create their own accounts from
  // the sign-in page (ALLOW_REGISTRATION), drawn as an on/off box (Field).
  signup: {
    label: 'Sign-up (admin)', icon: '✍',
    desc: 'Whether people can create their own account from the sign-in page.',
    testKey: null,
  },
};

// A key that reads like a secret but is not one: this site's own address,
// which every link it emails shows anyway.
const PLAIN_KEYS = new Set(['APP_BASE_URL']);

function isSecretKey(key) {
  return /pass|secret|key|url/i.test(key) && !PLAIN_KEYS.has(key);
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

// The allowance rates: a number, not free text, and blank means off.
const RATE_FIELDS = {
  MILEAGE_RATE:  { unit: 'per km',  example: '0.60' },
  PER_DIEM_RATE: { unit: 'per day', example: '80.00' },
};
const ALLOWANCE_ACCOUNT_FIELDS = new Set(['MILEAGE_ACCOUNT_CODE', 'PER_DIEM_ACCOUNT_CODE']);

function Field({ name, meta, value, onChange }) {
  const [show, setShow] = useState(false);
  // Changing a stored secret: the box opens empty to type a new one.
  const [editing, setEditing] = useState(false);
  const isSecret  = isSecretKey(name);
  const isReadOnly = !!meta.readOnly;
  // The server sends a plain label for a key that does not explain itself.
  const label = meta.label || name;
  // Back to the saved view once a new secret has been saved (its last four
  // characters change).
  useEffect(() => { setEditing(false); }, [meta.masked]);

  // A stored secret, shown as stored: the server's dots and last four
  // characters, Saved, and Change (pages/setup/secrets.js). The value itself
  // never reaches the browser.
  if (isSecret && meta.masked !== undefined && secretView(meta, value, editing).mode === 'saved') {
    const note = secretNote(name, meta);
    return (
      <div className="form-group">
        <label className="form-label">
          {label}
          {HELP[name] && <HelpTooltip text={HELP[name]} />}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="form-input" role="status" aria-label={`${label}: saved, ending ${String(meta.masked).slice(-4)}`}
            style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', cursor: 'default', userSelect: 'none', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {secretView(meta, value, editing).masked}
          </div>
          <span className="badge badge-green" style={{ flexShrink: 0 }}>✓ Saved</span>
          {!isReadOnly && (
            <button type="button" className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={() => setEditing(true)}>Change</button>
          )}
        </div>
        {note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{note}</div>}
        {meta.hint && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{meta.hint}</div>}
      </div>
    );
  }

  // An on/off switch, kept as the words 'true' / 'false' the server reads
  // (routes/auth.js registrationOpen): a box to tick, not a word to type.
  if (name === 'ALLOW_REGISTRATION') {
    const on = String(value || '').trim().toLowerCase() === 'true';
    return (
      <div className="form-group">
        <label htmlFor={`setting-${name}`} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: isReadOnly ? 'default' : 'pointer', fontSize: 13.5, fontWeight: 600 }}>
          <input
            id={`setting-${name}`} type="checkbox" checked={on} disabled={isReadOnly}
            onChange={e => onChange(name, e.target.checked ? 'true' : 'false')}
            style={{ width: 17, height: 17, accentColor: 'var(--accent)', cursor: isReadOnly ? 'default' : 'pointer' }}
          />
          {label}
        </label>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
          {on ? 'On: the sign-in page offers "Create an account". Save to apply.' : 'Off: accounts come only from your invites.'}
        </div>
        {meta.hint && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{meta.hint}</div>}
      </div>
    );
  }

  if (RATE_FIELDS[name]) {
    const rate = RATE_FIELDS[name];
    return (
      <div className="form-group">
        <label htmlFor={`setting-${name}`} className="form-label">
          {label}
          {HELP[name] && <HelpTooltip text={HELP[name]} />}
        </label>
        <input
          id={`setting-${name}`} className="form-input" inputMode="decimal" autoComplete="off"
          placeholder={`Off — enter a rate ${rate.unit}, e.g. ${rate.example}`}
          value={value} onChange={e => onChange(name, e.target.value)} readOnly={isReadOnly}
        />
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
          {String(value || '').trim() ? `On: claims are priced at this rate ${rate.unit}.` : 'Off: not offered on the claims tab.'}
        </div>
      </div>
    );
  }

  if (ALLOWANCE_ACCOUNT_FIELDS.has(name)) {
    return (
      <div className="form-group">
        <label className="form-label">
          {label}
          {HELP[name] && <HelpTooltip text={HELP[name]} />}
        </label>
        <AccountCodeSelect value={value} onChange={v => onChange(name, v)} invoiceType="EXPENSE" disabled={isReadOnly} />
        {meta.hint && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{meta.hint}</div>}
      </div>
    );
  }

  // Same picker the invoice editor uses, so the default is chosen from the real
  // chart of accounts rather than typed from memory. No invoiceType here — this
  // one default covers both bills and sales invoices.
  if (name === 'DEFAULT_ACCOUNT_CODE') {
    return (
      <div className="form-group">
        <label className="form-label">
          {name}
          {HELP[name] && <HelpTooltip text={HELP[name]} />}
        </label>
        <AccountCodeSelect value={value} onChange={v => onChange(name, v)} disabled={isReadOnly} />
      </div>
    );
  }

  if (name === 'TIMEZONE') {
    return (
      <div className="form-group">
        <label htmlFor={`setting-${name}`} className="form-label">
          {name}
          {HELP[name] && <HelpTooltip text={HELP[name]} />}
        </label>
        <select
          id={`setting-${name}`}
          className="form-input"
          value={value || DEFAULT_TIMEZONE}
          onChange={e => onChange(name, e.target.value)}
        >
          {TIMEZONE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="form-group">
      <label htmlFor={`setting-${name}`} className="form-label">
        {label}
        {HELP[name] && <HelpTooltip text={HELP[name]} />}
        {isReadOnly && <span className="badge badge-gray" style={{ marginLeft: 4 }}>Read-only</span>}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id={`setting-${name}`}
          type={isSecret && !show ? 'password' : 'text'}
          className="form-input"
          // A stored secret never comes back from the server; while it is
          // being changed the box is blank and a blank save keeps it (the
          // saved view above shows it otherwise). Three states: a stored
          // secret being changed, a value that will be worked out if this is
          // left blank, and a plain empty box.
          placeholder={
            isSecret && meta.isSet ? CHANGE_PLACEHOLDER
              : meta.auto           ? `${meta.auto} — used automatically`
              : `Enter ${name}`
          }
          value={value}
          onChange={e => onChange(name, e.target.value)}
          readOnly={isReadOnly}
          autoComplete="new-password"
          autoFocus={editing}
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
            aria-label={show ? `Hide ${name}` : `Show ${name}`}
            aria-pressed={show}
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
      {isSecret && meta.isSet && !isReadOnly && (editing || String(value || '') !== '') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span>{changeNote(name, meta)}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { onChange(name, ''); setEditing(false); }}>
            Cancel, keep the saved one
          </button>
        </div>
      )}
      {/* A line of help the server sends with a field (the email sending
          settings), under it rather than behind a tooltip. */}
      {meta.hint && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{meta.hint}</div>}
    </div>
  );
}

// Settings that are a choice rather than a requirement: blank is a real answer,
// so they belong with the automatic ones rather than in a user's face.
const OPTIONAL_KEYS = new Set(['IMAP_FILTER_FROM']);

// ── One generic Xero/IMAP/defaults/optional card ────────────────────────────────
function SectionCard({ sectionKey, meta, sectionData, values, onChange, idx, testing, msgs, onTest }) {
  const entries = Object.entries(sectionData);
  // A section where the server can work values out (today: the mailbox) shows
  // only what it genuinely needs, and folds the rest away. A field keeps its
  // place at the front when there is nothing to offer for it — an app password
  // always, and the server name for a provider we do not know.
  const hasAutomatic = entries.some(([, m]) => m.auto);
  // A server-wide section is read-only to anyone but an admin, and so is its
  // Test button: the server refuses it (Send test email is admin-only).
  const readOnly = entries.length > 0 && entries.every(([, m]) => m.readOnly);
  const needed   = hasAutomatic ? entries.filter(([k, m]) => !m.auto && !OPTIONAL_KEYS.has(k)) : entries;
  const decided  = hasAutomatic ? entries.filter(([k, m]) => m.auto || OPTIONAL_KEYS.has(k)) : [];

  return (
    <div id={`setup-${sectionKey}`} className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
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

        {meta.testKey && !readOnly && (
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
        {needed.map(([name, fieldMeta]) => (
          <Field key={name} name={name} meta={fieldMeta} value={values[name] || ''} onChange={onChange} />
        ))}
      </div>

      {decided.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', userSelect: 'none' }}>
            Advanced — {decided.length} settings you do not need to fill in
          </summary>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '8px 0 14px', lineHeight: 1.55 }}>
            Each box shows the value that will be used while it is empty. Fill one in only to
            watch a different mailbox, to reach a company mail server, or to change how often
            and how far back the inbox is searched.
          </div>
          <div className="grid-2">
            {decided.map(([name, fieldMeta]) => (
              <Field key={name} name={name} meta={fieldMeta} value={values[name] || ''} onChange={onChange} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Which Xero company documents are sent to ─────────────────────────────────────
// Shown only with two or more companies connected; with one there is nothing to
// choose. With several, the server does not guess: until a default is chosen it
// sends nothing and marks each document "Choose a default Xero company in Setup
// before sending." (the review page links back here). Saved the moment it
// changes, through the processing settings rather than the Save button below,
// because it is not one of the credential fields that form sends.
function DefaultTenantPicker({ tenants }) {
  const [value,  setValue]  = useState(null);   // null = loading; '' = none chosen
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    let active = true;
    api.get('/process/settings')
      .then(d => { if (active) setValue(d.defaultTenantId || ''); })
      .catch(() => { if (active) setValue(''); });
    return () => { active = false; };
  }, []);

  // The review page links to #default-xero-company. This only renders after
  // the connection check, long after the browser looked for the anchor, so it
  // brings itself into view.
  useEffect(() => {
    if (window.location.hash === '#default-xero-company') ref.current?.scrollIntoView({ block: 'center' });
  }, []);

  async function choose(next) {
    const before = value;
    setValue(next);
    setSaving(true);
    setMsg(null);
    try {
      const d = await api.patch('/process/settings', { defaultTenantId: next || null });
      setValue(d.defaultTenantId || '');
      setMsg({ ok: true, text: next ? 'Saved' : 'Cleared' });
    } catch (err) {
      setValue(before);
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  // A default saved before that company was disconnected matches no option;
  // the select would silently show the first company as if it were chosen.
  const stale = !!value && !tenants.some(t => t.tenantId === value);

  return (
    <div id="default-xero-company" ref={ref} className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
      <label htmlFor="default-tenant" className="form-label">Default Xero company for sending</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <select
          id="default-tenant" className="form-input" style={{ maxWidth: 360 }}
          value={stale ? '' : (value ?? '')}
          disabled={value === null || saving}
          onChange={e => choose(e.target.value)}
        >
          <option value="">{value === null ? 'Loading…' : '— Choose a company —'}</option>
          {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
        </select>
        <TestResult msg={msg} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.55 }}>
        Invoices, bills and expense claims are sent only to this company — never to the others connected here.
        {value === '' && ' Until one is chosen, nothing is sent to Xero.'}
      </div>
      {stale && (
        <div className="alert alert-warning" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="alert-icon">⚠</span>
          The company chosen before is no longer connected — choose one of these.
        </div>
      )}
    </div>
  );
}

// ── Data source, for an admin ────────────────────────────────────────────────────
// An admin may show their own Xero data or the Demo Company's sample data
// (setup/data-source.js), so for them this stands in for the Xero card's
// subtitle in either state: the first thing said about the card is which data
// it is about. Two pills, as the Dashboard's receivables/payables switch; the
// one not chosen asks before it switches (setup/useDataSource.js).
function DataSourceChooser({ value, onChoose, disabled }) {
  return (
    <>
      <div className="card-subtitle" style={{ marginBottom: 0 }}>
        Show your own Xero data, or the Demo Company’s sample data.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Data source</span>
        <div role="group" aria-label="Data source"
             style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          {sourceOptions().map(o => (
            <button key={o.key} type="button" aria-pressed={value === o.key} className="tab-pill" disabled={disabled}
                    onClick={() => { if (o.key !== value) onChoose(o.key); }} style={{
              padding: '5px 12px', borderRadius: 7, border: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: 12, fontWeight: 600,
              background: value === o.key ? 'var(--accent-gradient)' : 'transparent',
              color: value === o.key ? '#fff' : 'var(--text-muted)', whiteSpace: 'nowrap',
            }}>{o.label}</button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Xero Connection — two coexisting connection methods, not a flat field list ──
// Custom Connection (existing Client ID/Secret fields + Test button, unchanged)
// and OAuth2 "Web app" (new — connect via Xero's consent screen) are both shown at
// once; whichever the user successfully completes becomes the active method
// (config.xero.connectionType, decided server-side by which one actually succeeds).
function XeroConnectionCard({ idx, user, values, onChange, sectionData, testing, msgs, onTest, onConnectionChange }) {
  const confirm = useConfirm();
  // An admin chooses between Xero and the Demo Company's sample data for
  // their own account; anyone else's card is whatever their account is.
  const chooser = canChooseDataSource(user);
  const { switching, switchTo } = useDataSource();
  const [tenants, setTenants]       = useState(null); // null = loading
  // Whether the last read of the companies, or of the connection's state,
  // failed: the rows then say "Couldn't check" rather than pass a failed
  // read off as no companies, or as a live connection.
  const [tenantsFailed, setTenantsFailed]       = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [connectionType, setConnectionType] = useState('custom');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [banner, setBanner]         = useState(null);
  // What became of each optional permission, as /xero/connection reports it
  // under `optional` — null until the server has answered — and the boxes
  // beside Connect, keyed by group (setup/connect.js says what each means).
  const [connection, setConnection] = useState(null);
  const [boxes, setBoxes]           = useState(() => defaultBoxes(null));
  const [checking, setChecking]     = useState(false);

  // The boxes are set afresh from every answer: a Connect that just finished
  // changes what is granted, and "Check again" may find a refusal, whose box
  // must untick. `force` makes the server probe Xero's sign-in page again
  // rather than read what it found last time.
  async function fetchConnection({ force = false } = {}) {
    try {
      const c = await api.get(`/xero/connection${force ? '?force=true' : ''}`);
      setConnection(c);
      setConnectionFailed(false);
      setBoxes(defaultBoxes(c.optional));
    } catch (_) {
      // A failed check is not news about Xero: the last answer stands, and
      // with none, Connect leaves the choice of permissions to the server.
      setConnectionFailed(true);
    }
  }

  async function checkAgain() {
    setChecking(true);
    try {
      await fetchConnection({ force: true });
    } finally {
      setChecking(false);
      // The banner reads the same answer, and a refusal found now changes
      // what it has to say.
      window.dispatchEvent(new CustomEvent('xero-connection-changed'));
    }
  }

  async function fetchTenants() {
    // Everything that changes the companies — a connect, a disconnect, a
    // Custom Connection test — changes the permissions too.
    fetchConnection();
    try {
      const d = await api.get('/xero/tenants');
      setConnectionType(d.connectionType || 'custom');
      setTenants(d.tenants || []);
      setTenantsFailed(false);
    } catch (_) {
      setTenants([]);
      setTenantsFailed(true);
    } finally {
      // Anything else on this page reading Xero data has to be told the
      // connection moved. Without this, disconnecting left the previous
      // organisation's chart of accounts sitting below, looking live.
      onConnectionChange?.();
      // And the app-wide "reconnect Xero" banner, which otherwise would not
      // look again for up to ten minutes after the reconnect it asked for.
      window.dispatchEvent(new CustomEvent('xero-connection-changed'));
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('xero_oauth');

    async function settle() {
      if (flag === 'pending') {
        // The unauthenticated /oauth/callback route never completes the connection
        // itself — it only forwards code+state here. This authenticated call is
        // what actually finishes it, and the server re-checks that whoever is
        // logged in right now is the same account that started the flow (closes
        // an account-hijack path where an attacker's connect link, if completed by
        // someone else's browser, would otherwise link the victim's Xero org to
        // the attacker's account instead of the victim's).
        const code  = params.get('code');
        const state = params.get('state');
        try {
          await api.post('/xero/oauth/complete', { code, state });
          setBanner({ ok: true, text: 'Xero connected via OAuth.' });
        } catch (err) {
          setBanner({ ok: false, text: err.message || 'Xero OAuth connection failed — try again.' });
        }
      } else if (flag) {
        setBanner(flag === 'success'
          ? { ok: true, text: 'Xero connected via OAuth.' }
          : { ok: false, text: 'Xero OAuth connection failed — try again.' });
      }

      if (flag) {
        ['xero_oauth', 'code', 'state'].forEach(k => params.delete(k));
        const qs = params.toString();
        // The router keeps its own bookkeeping in history.state (which entry
        // this is, for Back and for asking before leaving unsaved edits), so it
        // is carried over rather than wiped with {}.
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
      }
      fetchTenants();
    }
    settle();
  }, []);

  // A successful Custom Connection test also connects tenants server-side —
  // refresh this card's view of the connection once that happens.
  useEffect(() => {
    if (msgs.xero?.ok) fetchTenants();
  }, [msgs.xero]);

  async function handleConnect() {
    setConnecting(true);
    try {
      // Only the ticked permissions are asked for, so Xero's sign-in page is
      // never asked for a scope it answers with "invalid_scope" (the page
      // never comes back from that, and Connect looked broken). The value is
      // built from the boxes' fixed keys, so it needs no encoding. With no
      // answer from the server about the permissions yet, the parameter is
      // left out and the server asks for whatever its own probe allows.
      const extras = connection ? `?extras=${extrasParam(boxes)}` : '';
      const { url } = await api.get(`/xero/oauth/connect${extras}`);
      window.location.href = url;
    } catch (err) {
      setBanner({ ok: false, text: err.message });
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    // Said here because the fear that stops people is of being left with
    // nothing: a Connect that fails at Xero leaves this connection as it is.
    if (!(await confirm({
      title: 'Disconnect Xero?',
      message: 'You can reconnect afterwards; a failed Connect never removes the current connection.',
      confirmLabel: 'Disconnect', danger: true,
    }))) return;
    setDisconnecting(true);
    try {
      await api.delete('/xero/oauth/disconnect');
      await fetchTenants();
    } catch (err) {
      setBanner({ ok: false, text: err.message });
    } finally {
      setDisconnecting(false);
    }
  }

  // An admin's switch of data source. The card is then drawn afresh for the
  // other source: the last answers are dropped, so neither the demo row nor
  // the Xero companies stand in for the new source while it is read, and
  // fetchTenants reads it, which also tells the chart of accounts below.
  async function chooseSource(source) {
    if (!(await switchTo(source))) return;
    setConnection(null);
    setConnectionFailed(false);
    setTenants(null);
    setTenantsFailed(false);
    fetchTenants();
  }

  // A demo account has sample data this app generates in place of a Xero
  // connection (setup/connect.js): nothing to connect, test or disconnect,
  // and no credentials to enter, so the card says what the dashboard shows
  // and leaves it there. Known from the account before any request answers,
  // or from the connection answer's own `demo`. An admin on sample data sees
  // the same row, under the choice that put it there and can take it back.
  if (connectionView(connection, user) === 'demo') {
    const card = demoCard(connection);
    return (
      <div id="setup-xero" className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
            🔗
          </div>
          <div>
            <div className="card-title">Xero Connection</div>
            {chooser
              ? <DataSourceChooser value="demo" onChoose={chooseSource} disabled={switching} />
              : <div className="card-subtitle" style={{ marginBottom: 0 }}>{card.note}</div>}
          </div>
        </div>
        <div style={{ height: 1, background: 'var(--border)', margin: '12px 0 16px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', fontSize: 13 }}>
          <span className="badge badge-green" title="Sample data: documents are not sent to Xero">{card.status}</span>
          {card.company}
        </div>
        {chooser && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.55 }}>
            Your Xero connection is kept; switch back any time.
          </div>
        )}
      </div>
    );
  }

  return (
    <div id="setup-xero" className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
            🔗
          </div>
          <div>
            <div className="card-title">Xero Connection</div>
            {chooser ? (
              <DataSourceChooser value="xero" onChoose={chooseSource} disabled={switching} />
            ) : (
              <div className="card-subtitle" style={{ marginBottom: 0 }}>
                Connect via Custom Connection credentials, or via Xero login (OAuth) — either works
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <HelpLink url="https://developer.xero.com/app/manage" label="Manage your Xero apps ↗" />
      </div>

      {banner && (
        <div className={`alert ${banner.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 14 }}>
          <span className="alert-icon">{banner.ok ? '✓' : '✕'}</span>{banner.text}
        </div>
      )}

      <div style={{ height: 1, background: 'var(--border)', marginBottom: 20 }} />

      {/* Each company is "● Live" only while /xero/connection says the
          connection works; it said Live whatever the connection's state
          (setup/company-status.js). */}
      {companiesView(tenants, tenantsFailed) === 'loading' ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>Checking connection…</div>
      ) : companiesView(tenants, tenantsFailed) === 'failed' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, marginBottom: 16, flexWrap: 'wrap' }}>
          <span className="badge badge-gray">Couldn’t check</span>
          <span style={{ color: 'var(--text-muted)' }}>Could not read which Xero companies are connected.</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={fetchTenants}>Try again</button>
        </div>
      ) : companiesView(tenants, tenantsFailed) === 'none' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, marginBottom: 16 }}>
          <span className="badge badge-gray">Not connected</span>
          <span style={{ color: 'var(--text-muted)' }}>No Xero company is connected yet.</span>
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Connected {connectionType === 'oauth' ? 'via OAuth' : 'via Custom Connection'}
            </span>
            {connectionType === 'oauth' && (
              <button type="button" className="btn btn-sm" disabled={disconnecting} onClick={handleDisconnect}
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}>
                {disconnecting ? '...' : 'Disconnect'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tenants.map(t => {
              const badge = companyBadge(connection, connectionFailed);
              return (
                <div key={t.tenantId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', fontSize: 13 }}>
                  <span className={badge.className} title={badge.title}>{badge.text}</span>
                  {t.tenantName}
                </div>
              );
            })}
          </div>
          {tenants.length >= 2 && <DefaultTenantPicker tenants={tenants} />}
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>
        Option A — Custom Connection
      </div>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        {Object.entries(sectionData)
          .filter(([name]) => !name.startsWith('XERO_OAUTH_'))
          .map(([name, fieldMeta]) => (
            <Field key={name} name={name} meta={fieldMeta} value={values[name] || ''} onChange={onChange} />
          ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <TestResult msg={msgs.xero} />
        <button type="button" className="btn btn-outline btn-sm" disabled={testing.xero} onClick={() => onTest('xero')}>
          {testing.xero ? <><span className="btn-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'var(--accent)' }} /> Testing...</> : '⚡ Test Custom Connection'}
        </button>
      </div>

      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 20px' }} />

      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
        Option B — OAuth (your own Xero Web app)
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        Bring your own Xero Web app's Client ID/Secret — this keeps your Xero API rate limit separate from every other account on this deployment.
      </div>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        {Object.entries(sectionData)
          .filter(([name]) => name.startsWith('XERO_OAUTH_'))
          .map(([name, fieldMeta]) => (
            <Field key={name} name={name} meta={fieldMeta} value={values[name] || ''} onChange={onChange} />
          ))}
      </div>

      {/* The permissions Connect may ask for beyond what the app needs. Each
          box is set from the server's answer (setup/connect.js#boxState): one
          Xero refuses this app is unticked and locked, with the reason, since
          asking for it sends the person to Xero's "invalid_scope" page and
          never back; one already granted says so, so an unticked box is seen
          for what it is — giving the permission up on the next connect. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>Also ask Xero for</div>
          {optionalBoxes().map(({ key, label }) => {
            const box = boxState(connection?.optional, key);
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, marginBottom: 6 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: box.disabled ? 0.6 : 1 }}>
                  <input
                    type="checkbox" checked={!box.disabled && !!boxes[key]} disabled={box.disabled}
                    onChange={e => setBoxes(prev => ({ ...prev, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
                {box.status === 'granted' && <span className="badge badge-green">granted</span>}
                {(box.status === 'refused' || box.status === 'unknown') && (
                  <span style={{ fontSize: 12, color: box.status === 'refused' ? 'var(--warning)' : 'var(--text-muted)' }}>
                    {box.note} —{' '}
                    <button
                      type="button" onClick={checkAgain} disabled={checking}
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}
                    >
                      {checking ? 'Checking…' : 'Check again'}
                    </button>
                  </span>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.55 }}>
            If Xero answers 'Invalid scope', untick the permission it refused and connect again.
            Your existing connection is not affected by a failed attempt.
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={connecting} onClick={handleConnect} style={{ whiteSpace: 'nowrap' }}>
          {connecting ? '...' : '🔗 Connect to Xero'}
        </button>
      </div>
    </div>
  );
}

// ── LLM / AI Studio — multiple API keys, not a single flat field ────────────────
// A separate resource (its own add/remove endpoints) rather than part of the
// generic Setup form, since "a list the user can add to" doesn't fit the
// one-value-per-field pattern the rest of this page uses.
// The Gemini keys. Every key the account can be using is listed, in the
// order invoice reading tries them (routes/setup.js GET /llm-keys): the added
// ones, a key saved in the old single-key field, and, for an account with
// none, whether the server's shared key stands in.
//
// The add box is NOT a <form>: this card sits inside the settings form, and a
// form inside a form is not allowed. Chrome's answer to one was to run
// neither form's handler and submit the page the old way, so "Add key"
// reloaded Setup as /setup? and the key was never sent (seen in the server
// log, and reproduced in headless Chrome with this app's React). Its button
// is a plain button and Enter is caught on the inputs, which also keeps Enter
// from submitting the settings form around it.
function LlmKeysCard({ idx, testing, msgs, onTest, onKeysChange }) {
  const [keys,    setKeys]    = useState(null);
  const [serverKey, setServerKey] = useState(false);
  const [newKey,  setNewKey]  = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [adding,  setAdding]  = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error,   setError]   = useState('');
  const [loadErr, setLoadErr] = useState('');

  // A failed load is not an empty list: "No API keys added yet" over keys
  // that are there would invite adding them all again.
  async function fetchKeys() {
    try { const d = await api.get('/setup/llm-keys'); setKeys(d.keys); setServerKey(!!d.serverKey); setLoadErr(''); }
    catch (err) { setLoadErr(err.message || 'Could not load the keys'); }
  }

  useEffect(() => { fetchKeys(); }, []);

  async function handleAdd() {
    if (!newKey.trim() || adding) return;
    setAdding(true); setError('');
    try {
      await api.post('/setup/llm-keys', { apiKey: newKey.trim(), label: newLabel.trim() || undefined });
      setNewKey(''); setNewLabel(''); setShowNew(false);
      await fetchKeys();
      onKeysChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  // Enter adds the key, and goes no further: left alone it would submit the
  // settings form this card sits in.
  function addOnEnter(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleAdd();
  }

  function cancelAdd() { setShowNew(false); setNewKey(''); setNewLabel(''); }

  async function handleRemove(id) {
    setRemoving(id);
    try { await api.delete(`/setup/llm-keys/${id}`); await fetchKeys(); onKeysChange?.(); }
    catch (err) { setError(err.message); }
    finally { setRemoving(null); }
  }

  return (
    <div id="setup-llm" className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
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

      {loadErr && (
        <RetryAlert message={`Could not load your API keys. ${loadErr}`} onRetry={fetchKeys} style={{ marginBottom: 12 }} />
      )}
      {keys === null ? (
        !loadErr && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading keys…</div>
      ) : keys.length === 0 && !showNew ? (
        <div className="empty-state" style={{ padding: '20px 0' }}>
          <div className="empty-state-icon">🔑</div>
          <div>{keyListEmptyText(serverKey)}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {keys.map((k, i) => (
            <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', opacity: k.inUse === false ? 0.7 : 1 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', width: 18 }}>{i + 1}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 13, flex: 1 }}>{k.keyMasked}</span>
              {k.label && <span className="badge badge-gray">{k.label}</span>}
              {k.legacy && (
                <span className="badge badge-gray" title={legacyKeyTitle(k)}>{legacyKeyText(k)}</span>
              )}
              <button
                type="button" className="btn btn-sm"
                disabled={removing === k.id}
                onClick={() => handleRemove(k.id)}
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}
                title="Remove key"
                aria-label={`Remove key ${i + 1}${k.label ? ` (${k.label})` : ''}`}
              >
                {removing === k.id ? '...' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showNew ? (
        <div role="group" aria-label="Add a Gemini API key" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 8, border: '1px dashed var(--border)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 2 }}>
              <input
                type="password" className="form-input" placeholder="AIza…" aria-label="Gemini API key"
                value={newKey} onChange={e => setNewKey(e.target.value)} onKeyDown={addOnEnter} autoFocus
                autoComplete="off" style={{ fontFamily: 'monospace' }}
              />
            </div>
            <input
              type="text" className="form-input" placeholder="Label (optional)" aria-label="Label (optional)"
              value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={addOnEnter} style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={cancelAdd}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={adding || !newKey.trim()} onClick={handleAdd}>
              {adding ? '...' : '✓ Add key'}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowNew(true)}>
          + Add another API key
        </button>
      )}
    </div>
  );
}

// The form's values, one per setting, from the server's sectioned answer.
// TIMEZONE that has never been saved defaults to the account's current
// effective timezone rather than showing blank.
function flatten(data, timezone) {
  const flat = {};
  for (const section of Object.values(data))
    for (const [k, fieldMeta] of Object.entries(section)) flat[k] = fieldMeta.value || '';
  if (!flat.TIMEZONE) flat.TIMEZONE = timezone || DEFAULT_TIMEZONE;
  return flat;
}

export default function Setup() {
  const { user, refreshUser } = useAuth();
  const [config,  setConfig]  = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [values,  setValues]  = useState({});
  // The values as last loaded or saved, which is what "unsaved changes" means.
  const [savedValues, setSavedValues] = useState({});
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState({});
  const [msgs,    setMsgs]    = useState({});
  // Bumped whenever the Xero connection changes, so anything below reading Xero
  // data refetches instead of showing a disconnected organisation's figures.
  const [xeroVersion, setXeroVersion] = useState(0);
  // Bumped after anything that can tick a step of the "Get set up" checklist
  // at the top (a save, a Test, a key added or removed, a Xero change), so it
  // reads the server's verdict again (components/SetupChecklist.jsx).
  const [checklistVersion, setChecklistVersion] = useState(0);
  const refreshChecklist = useCallback(() => setChecklistVersion(v => v + 1), []);
  const [saved,   setSaved]   = useState(false);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  // Where the Save box goes: the header's slot on the web layout
  // (components/layout/Header.jsx), found once this page is mounted below it;
  // on a phone the header has no room, so the box sits at the bottom instead.
  const { isMobile } = useViewMode();
  const [headerSlot, setHeaderSlot] = useState(null);
  useEffect(() => { setHeaderSlot(document.getElementById('header-page-actions')); }, [isMobile]);

  // Read through a ref so loading does not depend on `user`. It used to: every
  // save calls refreshUser(), which hands back a new user object, which
  // refetched the settings and overwrote the form — including anything typed
  // in the moment after pressing Save.
  const timezoneRef = useRef(user?.timezone);
  timezoneRef.current = user?.timezone;

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const data = await api.get('/setup');
      const flat = flatten(data, timezoneRef.current);
      setConfig(data);
      setValues(flat);
      setSavedValues(flat);
    } catch (err) {
      setLoadErr(err.message || 'Could not load your settings');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The checklist's links point at a card here (/setup#setup-llm and the
  // like). The cards are drawn only once the settings have loaded, after the
  // browser looked for the anchor, and a link followed from this page itself
  // changes only the hash, so the card is brought into view here.
  const { hash } = useLocation();
  const loaded = !!config;
  useEffect(() => {
    const id = setupAnchor(hash);
    if (loaded && id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash, loaded]);

  const dirty = !!config && Object.keys({ ...values, ...savedValues })
    .some(k => (values[k] ?? '') !== (savedValues[k] ?? ''));
  useUnsavedChanges(dirty, {
    message: 'Some settings on this page have not been saved. Leaving now throws them away.',
  });

  function handleChange(key, val) {
    setValues(prev => ({ ...prev, [key]: val }));
  }

  // Back to what was last loaded or saved, without a reload: the form's
  // values only, so a test result or a save error already on screen stays.
  function handleDiscard() {
    setValues(savedValues);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    // The last attempt's error goes as soon as there is a new attempt. It used
    // to stay up for good, above a success banner once the next save worked.
    setMsgs(prev => ({ ...prev, _save: null }));
    const sent = values;
    try {
      const answer = await api.post('/setup', sent);
      // The mailbox's server or address changed with no new app password, so
      // the server dropped the saved one rather than send it to the new place
      // (routes/setup.js mailboxMovedWithoutPassword). Said on the mailbox card.
      if (answer?.cleared?.includes('IMAP_PASS')) {
        setMsgs(prev => ({ ...prev, imap: { ok: false, text: 'The mailbox server or address changed, so the saved app password was removed. Enter the app password for this mailbox and save again.' } }));
      }
    } catch (err) {
      setMsgs(prev => ({ ...prev, _save: { ok: false, text: err.message } }));
      setSaving(false);
      return;
    }
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 3500);
    // A changed mailbox or Custom Connection undoes its last Test.
    refreshChecklist();
    // Picks up a changed TIMEZONE (or any other /auth/me-visible field) so every
    // already-mounted component reading it (Admin.jsx's timestamps, etc.)
    // reflects the change immediately instead of needing a full reload.
    refreshUser();
    try {
      // The server's view after the save: a secret comes back blank and
      // "saved", a value worked out from the email address appears. Fields
      // edited since Save was pressed keep what was typed.
      const fresh = await api.get('/setup');
      const flat  = flatten(fresh, timezoneRef.current);
      setConfig(fresh);
      setSavedValues(flat);
      setValues(prev => {
        const next = { ...flat };
        for (const k of Object.keys(prev)) if (prev[k] !== sent[k]) next[k] = prev[k];
        return next;
      });
    } catch (_) {
      // Saved, but the page could not reread it. What was sent is what is
      // saved, as far as this page knows.
      setSavedValues(sent);
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
      // The server kept this Test's outcome for the checklist.
      refreshChecklist();
    }
  }

  if (!config && loadErr) {
    return (
      <div>
        <div className="page-header"><h1>Setup</h1></div>
        <RetryAlert message={`Could not load your settings. ${loadErr}`} onRetry={load} />
      </div>
    );
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

      {/* What is left to set up, in the setup guide's order; gone once all
          four steps work. */}
      <SetupChecklist refreshKey={checklistVersion} />

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

      {/* Named, so the Save bar can sit after the Chart of Accounts at the
          page's end and still submit this form (the button's `form`
          attribute): nothing after the bar, so Save is where a page ends. */}
      <form id="setup-form" onSubmit={handleSave}>
        {config.xero && (
          <XeroConnectionCard
            idx={0} user={user} sectionData={config.xero}
            values={values} onChange={handleChange} testing={testing} msgs={msgs} onTest={runTest}
            onConnectionChange={() => { setXeroVersion(v => v + 1); refreshChecklist(); }}
          />
        )}

        {['imap'].map((key, idx) => {
          const sectionData = config[key];
          if (!sectionData) return null;
          return (
            <SectionCard
              key={key} sectionKey={key} meta={SECTION_META[key]} sectionData={sectionData}
              values={values} onChange={handleChange} idx={idx + 1} testing={testing} msgs={msgs} onTest={runTest}
            />
          );
        })}

        <LlmKeysCard idx={2} testing={testing} msgs={msgs} onTest={runTest} onKeysChange={refreshChecklist} />

        {/* The server's own settings (admin) come last: Slack, the OAuth
            redirect, email sending and the privacy contact. Anyone but an
            admin sees them read-only, with no Test button. */}
        {['defaults', 'allowances', 'preferences', 'optional', 'xeroOAuth', 'email'].map((key, i) => {
          const sectionData = config[key];
          if (!sectionData) return null;
          return (
            <SectionCard
              key={key} sectionKey={key} meta={SECTION_META[key]} sectionData={sectionData}
              values={values} onChange={handleChange} idx={i + 3} testing={testing} msgs={msgs} onTest={runTest}
            />
          );
        })}
        {config.privacy && (
          <SectionCard
            sectionKey="privacy" meta={SECTION_META.privacy} sectionData={config.privacy}
            values={values} onChange={handleChange} idx={9} testing={testing} msgs={msgs} onTest={runTest}
          />
        )}
        {config.signup && (
          <SectionCard
            sectionKey="signup" meta={SECTION_META.signup} sectionData={config.signup}
            values={values} onChange={handleChange} idx={10} testing={testing} msgs={msgs} onTest={runTest}
          />
        )}

      </form>

      {/* Reference, not a setting: nothing here is saved. It lives in Settings
          because "are my account codes right?" is a setup question, and a list
          of codes is not something you would act on from a dashboard. The
          account's own password is on the Account page (pages/Account.jsx),
          with the rest of what belongs to the person rather than the app. */}
      <div style={{ marginTop: 24 }}>
        <ChartOfAccounts refreshKey={xeroVersion} />
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'right', marginTop: 16 }}>
        Secrets are hidden by default — click 👁 to reveal
      </div>

      {/* The Save box, always in view. On the web layout it is in the
          header's slot, pinned at the top with the header: its own band, so
          it never floats over a card, and the bottom-right corner is the
          chat launcher's alone. On a phone the header has no room, so it is
          pinned to the window's bottom instead, above the nav bar
          (globals.css .mobile-mode .setup-save-bar), as a small box and not
          the full-width band it once was, which hid whatever field scrolled
          behind it; the pinned strip lets clicks through everywhere but the
          box, and the right-hand room is the chat launcher's corner
          (--fab-clearance). Outside the form, and submits it by name. */}
      {!isMobile && headerSlot
        ? createPortal(<SaveControls dirty={dirty} saving={saving} saved={saved} error={msgs._save} onDiscard={handleDiscard} />, headerSlot)
        : (
          <div className="setup-save-bar" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            padding: '16px var(--fab-clearance) 16px 0',
            position: 'sticky', bottom: 0, zIndex: 10, pointerEvents: 'none',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10,
              pointerEvents: 'auto', padding: '8px 8px 8px 14px', maxWidth: '100%',
              background: 'var(--bg-card)', border: '1px solid var(--border-card)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)',
            }}>
              <SaveControls compact dirty={dirty} saving={saving} saved={saved} error={msgs._save} onDiscard={handleDiscard} />
            </div>
          </div>
        )}
    </div>
  );
}

// The Save box's contents: the one line that is true now, Discard while
// there is something to discard, and Save, which submits the settings form
// by name from wherever the box is. `compact` is the phone's: short words,
// Discard as an icon, no reason for a failed save (the banner at the top has
// it). A failed save names the reason on the web, where the banner is out of
// view from the header.
function SaveControls({ dirty, saving, saved, error, compact = false, onDiscard }) {
  const line = (text, color, weight = 500) => <span style={{ fontSize: 12, color, fontWeight: weight, whiteSpace: 'nowrap' }}>{text}</span>;
  let state;
  if (saving)     state = line('Saving…', 'var(--text-muted)');
  else if (dirty) state = line(compact ? '● Unsaved' : '● Unsaved changes', 'var(--warning)', 600);
  else if (error) state = line(compact ? '✕ Not saved' : `✕ Not saved: ${error.text}`, 'var(--danger)', 600);
  else if (saved) state = line('✓ Saved', 'var(--success)', 600);
  else            state = line(compact ? '✓ Saved' : '✓ All settings saved', 'var(--text-muted)');
  return (
    <>
      {state}
      {dirty && (
        <button type="button" className="btn btn-outline btn-sm" disabled={saving} onClick={onDiscard}
          title="Discard the unsaved changes" aria-label="Discard the unsaved changes">
          {compact ? '↶' : 'Discard'}
        </button>
      )}
      <button type="submit" form="setup-form" className="btn btn-primary btn-sm" disabled={saving} style={{ minWidth: compact ? 0 : 120 }}>
        {saving
          ? <><span className="btn-spinner" /> Saving...</>
          : compact ? '💾 Save' : '💾 Save settings'}
      </button>
    </>
  );
}
