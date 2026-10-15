import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import RetryAlert from '../../components/RetryAlert';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import { formatTime } from '../../utils/formatDate';
import { fmtCell } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { XeroCheckPanel } from './XeroCheckPanel';
import { SourceNote } from './bits';
import { cashManagerHowTo } from './xero-check';
import { CashCalendar, CashChart, CashTable, DayPanel } from './CashManagerChart';
import { CashList } from './CashManagerLists';
import { BankOptionsModal, EntryModal, OverrideModal } from './CashManagerModals';
import CashMonthly from './CashMonthly';
import { connectedTenant, daysOptions, exportQueryFor, modeOptions, readPrefs, tileFigures, viewOptions, windowOf } from './cash-manager';

// The Cash Flow Manager, after Xero Analytics' own: what the bank balance is
// today, what is expected in and out over the next 30, 60 or 90 days, and
// the means to plan with it — move an invoice to when it will really be
// paid, leave a bill out, add a loan drawdown Xero knows nothing of. All of
// that is kept in this app; Xero is read, never written.
//
// The page owns the forecast (XeroInsights.jsx#fetchCashManager), so a change
// seen in Xero, a Refresh or a switch of organisation reloads it like any
// other tab. This keeps what changes nothing the server is asked for: which
// sub-tab is open, the window, the view and the chart mode — the last three
// remembered between visits — and the open day and dialog. After a change
// made here the forecast is asked for again, quietly, so the figures stay up
// until the new ones land.

const PREFS_KEY = 'cashManagerPrefs';
const NOTE_KEY = 'cashManagerNoteDismissed';
// Monthly is the same forecast by the month, with the months before this one
// as they happened (CashMonthly.jsx); it asks for its own figures.
const SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'in',       label: 'Manage cash in' },
  { key: 'out',      label: 'Manage cash out' },
  { key: 'monthly',  label: 'Monthly' },
];

// Storage can be missing or refuse a write (a private window, a full quota);
// the tab works without it, starting from the defaults.
function loadPrefs() {
  try { return readPrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return readPrefs(null); }
}
function storePrefs(prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* kept for this visit only */ }
}
function noteDismissed() {
  try { return window.localStorage.getItem(NOTE_KEY) === '1'; } catch { return false; }
}

// A row of pill buttons, as the chart's Bar/Line toggle elsewhere.
function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 2, background: 'var(--bg-secondary)', borderRadius: 7, padding: 2 }}>
      {options.map(o => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)} style={{
          padding: '4px 11px', fontSize: 11.5, fontWeight: 600, borderRadius: 5, cursor: 'pointer', border: 'none',
          background: value === o.key ? 'var(--accent-gradient)' : 'transparent',
          color: value === o.key ? '#fff' : 'var(--text-muted)',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

export default function CashManagerTab({ cash, fetchCashManager, tenantId, currency, orgName, timezone }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [section, setSection] = useState('overview');
  const [prefs, setPrefs] = useState(loadPrefs);
  const [checking, setChecking] = useState(false);
  const [noteOpen, setNoteOpen] = useState(() => !noteDismissed());
  const [selectedDay, setSelectedDay] = useState(null);
  // The open dialog: { kind: 'bank' }, { kind: 'entry', direction, entryId? }
  // or { kind: 'override', item }.
  const [modal, setModal] = useState(null);
  // The item whose exclude or delete is in flight, so its row's buttons wait.
  const [busyKey, setBusyKey] = useState(null);

  const d = cash.data;
  // The server answers connected:false once no organisation is connected (a
  // disconnect in Setup since the page loaded): there is no forecast to show.
  const connected = d?.connected !== false;
  const ready = !!d && !cash.error && connected;
  const cur = d?.organisation?.currency || currency;
  // The page's organisation only while it is still connected (cash-manager.js).
  const tid = connectedTenant(tenantId, d);
  const exportQuery = exportQueryFor({ tenantId: tid, days: prefs.days });

  function setPref(patch) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    storePrefs(next);
  }

  function dismissNote() {
    setNoteOpen(false);
    try { window.localStorage.setItem(NOTE_KEY, '1'); } catch { /* shown again next visit */ }
  }

  // A second click on the open day closes it.
  function selectDay(date) {
    setSelectedDay(s => (s === date ? null : date));
  }

  // The forecast asked for again after a change made here. The page's fetch
  // answers whether it landed; when it did not, the change was still saved,
  // and the toast says both.
  async function afterChange(message) {
    const ok = await fetchCashManager({ quiet: true });
    if (ok === false) toast.info(`${message} The forecast could not be reloaded; Refresh to see the change.`);
    else toast.success(message);
  }

  function edit(item) {
    if (item.source === 'manual') setModal({ kind: 'entry', direction: item.direction, entryId: item.entryId });
    else setModal({ kind: 'override', item });
  }

  async function toggleExclude(item) {
    setBusyKey(item.key);
    try {
      await api.put('/cash-manager/overrides', { ...(tid ? { tenantId: tid } : {}), key: item.key, excluded: !item.excluded });
      await afterChange(item.excluded ? 'Counted in the forecast again.' : 'Left out of the forecast. Xero is unchanged.');
    } catch (err) {
      toast.error(err.message || 'Could not change the item');
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteEntry(item) {
    const yes = await confirm({
      title: 'Delete this entry?',
      message: `${item.description || item.reference || 'This entry'} is removed from the forecast. If it repeats, every date in the series goes with it. Nothing in Xero is affected.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!yes) return;
    setBusyKey(item.key);
    try {
      await api.delete(`/cash-manager/entries/${encodeURIComponent(item.entryId)}${tid ? `?tenantId=${encodeURIComponent(tid)}` : ''}`);
      await afterChange('Entry deleted.');
    } catch (err) {
      toast.error(err.message || 'Could not delete the entry');
    } finally {
      setBusyKey(null);
    }
  }

  const fetched = d?.fetchedAt ? `Xero data as of ${formatTime(d.fetchedAt, timezone)}` : '';
  const subtitle = [d?.organisation?.name || orgName, fetched].filter(Boolean).join(' · ');
  const win = d ? windowOf(d, prefs.days) : null;
  const modeLabel = modeOptions().find(m => m.key === prefs.mode)?.label || '';
  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="card-title" style={{ marginBottom: 2 }}>Cash Flow Manager</div>
          <div className="card-subtitle" style={{ marginBottom: 2 }}>{subtitle || 'What is expected in and out of the bank, day by day'}</div>
          <SourceNote>Xero bank accounts, invoices, bills, repeating invoices, payments and bank transactions</SourceNote>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" disabled={cash.status === 'loading'} onClick={() => fetchCashManager({ force: true })}>
            {cash.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
          </button>
          <button className="btn btn-outline btn-sm" disabled={!ready} aria-expanded={checking} onClick={() => setChecking(c => !c)}>
            ✓ Check against Xero
          </button>
          <BudgetExport kind="cashmanager" query={exportQuery} disabled={!ready} />
        </div>
      </div>

      {checking && ready && (
        <XeroCheckPanel key={JSON.stringify(exportQuery)} query={exportQuery} endpoint="cash-manager-check" howTo={cashManagerHowTo}
                        onClose={() => setChecking(false)} />
      )}

      <div role="tablist" aria-label="Cash Flow Manager sections" className="mobile-scroll-x"
           style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', margin: '14px 0 0', overflowX: 'auto' }}>
        {SECTIONS.map(s => (
          <button key={s.key} type="button" role="tab" aria-selected={section === s.key} onClick={() => setSection(s.key)} style={{
            padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
            color: section === s.key ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: `2px solid ${section === s.key ? 'var(--accent)' : 'transparent'}`, marginBottom: -1,
          }}>{s.label}</button>
        ))}
      </div>

      {noteOpen && (
        <div className="alert alert-info" style={{ marginTop: 14, alignItems: 'center' }}>
          <span className="alert-icon">ℹ</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            Manage your cash flow without changing anything in Xero. Entries and changes you make here stay in this app.
          </span>
          <button type="button" aria-label="Dismiss" onClick={dismissNote}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 15, padding: '0 4px', flexShrink: 0 }}>✕</button>
        </div>
      )}

      {cash.status === 'loading' && !d && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading the cash flow forecast…</div>}

      {cash.error && (
        <RetryAlert message={cash.error} onRetry={() => fetchCashManager({ force: true })} busy={cash.status === 'loading'} style={{ marginTop: 14 }} />
      )}

      {/* The page's own "No Xero connection yet", in the tab: an organisation
          disconnected since the page loaded leaves nothing to forecast. */}
      {d && !cash.error && !connected && (
        <div style={{ textAlign: 'center', padding: '36px 16px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No Xero connection yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
            No Xero organisation is connected now. Connect one in Setup to see its cash flow forecast.
          </div>
          <Link to="/setup" className="btn btn-primary btn-sm">Go to Setup →</Link>
        </div>
      )}

      {ready && section === 'overview' && (
        <>
          {cur && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '16px 0 6px' }}>Figures in {cur}</div>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {tileFigures(d).map(t => (
              <div key={t.key} className="card figure-tile" style={{ flex: 1, minWidth: 170, background: 'var(--bg-secondary)', padding: '12px 14px' }}>
                <div className="figure-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                {/* A balance that could not be read says so, never "-" for
                    nil, and why under it in place of the limit and runway. */}
                <div className="figure-value" style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.tone }}>
                  {t.value === null ? <span style={{ fontSize: 16, color: 'var(--text-muted)' }}>{t.text}</span> : fmtCell(t.value)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                  {t.kind === 'balance'
                    ? t.note || [t.date, t.overdraft > 0 ? `overdraft limit ${fmtCell(t.overdraft)}` : '', t.runwayDays !== null ? `runway ${t.runwayDays} day${t.runwayDays === 1 ? '' : 's'}` : '']
                      .filter(Boolean).join(' · ')
                    : `In ${fmtCell(t.in)} · Out ${fmtCell(t.out)}`}
                </div>
              </div>
            ))}
          </div>

          {/* The view, what the chart shows and how far ahead on the left;
              what changes the forecast on the right. They wrap on a phone. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', margin: '18px 0 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Segmented label="View" options={viewOptions()} value={prefs.view} onChange={v => setPref({ view: v })} />
              {prefs.view === 'chart' && (
                <select className="form-input" style={sel} aria-label="Chart shows" value={prefs.mode} onChange={e => setPref({ mode: e.target.value })}>
                  {modeOptions().map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              )}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                Graph days
                <select className="form-input" style={sel} value={prefs.days} onChange={e => setPref({ days: Number(e.target.value) })}>
                  {daysOptions().map(o => <option key={o.key} value={o.key}>{o.key}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setModal({ kind: 'bank' })}>Bank options</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'entry', direction: 'in' })}>+ Add cash in/out</button>
            </div>
          </div>

          <div style={{ fontSize: 12.5, fontWeight: 600, margin: '4px 0 8px' }}>
            {prefs.view === 'chart' ? `${modeLabel} · ` : ''}{win.title}
          </div>

          {prefs.view === 'chart' && (
            <CashChart payload={d} days={prefs.days} mode={prefs.mode} currency={cur} selected={selectedDay} onSelect={selectDay} />
          )}
          {prefs.view === 'table' && <CashTable payload={d} days={prefs.days} selected={selectedDay} onSelect={selectDay} />}
          {prefs.view === 'calendar' && (
            <CashCalendar payload={d} days={prefs.days} currency={cur} selected={selectedDay} onSelect={selectDay} />
          )}

          {selectedDay && <DayPanel payload={d} date={selectedDay} onClose={() => setSelectedDay(null)} onEdit={edit} />}

          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
            Figures in {cur || 'the organisation\'s base currency'}; bank accounts in another currency are not counted.
            Each invoice and bill is placed on the date set here if there is one, else its expected (invoice) or planned
            (bill) payment date in Xero, else a date predicted from the contact&apos;s payment history, else its due date.
            Repeating invoices and bills are placed on their next dates, and Spend or Receive Money entered in Xero with a
            later date on that date. Overdue items &mdash; due before today and not yet paid, or with no date in Xero
            &mdash; stand apart, left of today. Credit notes not yet allocated are netted off the same contact&apos;s
            earliest items. Further left, behind a solid line, the days before today are what
            actually moved: the payments and bank transactions recorded in Xero. Graph days counts the days ahead only.
            {(d.notes || []).map((note, i) => <div key={i}>{note}</div>)}
          </div>
        </>
      )}

      {ready && (section === 'in' || section === 'out') && (
        <CashList payload={d} direction={section} busyKey={busyKey} onEdit={edit} onToggleExclude={toggleExclude}
                  onDelete={deleteEntry} onAdd={direction => setModal({ kind: 'entry', direction })} />
      )}

      {/* Its own request, so it is not held up by the day-by-day forecast;
          that forecast being read again from Xero (a Refresh, a live update)
          is what tells it to ask again. */}
      {section === 'monthly' && tid && (
        <CashMonthly tenantId={tid} refreshedAt={d?.fetchedAt} currency={cur} />
      )}

      {modal?.kind === 'bank' && d && (
        <BankOptionsModal bank={d.bank} tenantId={tid} currency={cur} onClose={() => setModal(null)} onSaved={afterChange} />
      )}
      {modal?.kind === 'entry' && (
        <EntryModal entryId={modal.entryId} direction={modal.direction} today={d?.today} tenantId={tid} currency={cur}
                    onClose={() => setModal(null)} onSaved={afterChange} />
      )}
      {modal?.kind === 'override' && (
        <OverrideModal item={modal.item} tenantId={tid} onClose={() => setModal(null)} onSaved={afterChange} />
      )}
    </div>
  );
}
