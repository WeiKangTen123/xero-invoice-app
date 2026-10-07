import { useEffect, useRef } from 'react';

// What a bulk action did, row by row, until it is dismissed. Successes are a
// count in the headline; every row that was not done, or was skipped, is
// listed by name with the reason, and can be opened from here. The rows not
// done also stay selected (see Invoices.jsx), so fixing them and pressing the
// same button again acts on just those.
//
// Focus moves to the heading when a new report arrives: the button that was
// pressed may have gone with the selection, and a keyboard or screen-reader
// user should land on the answer rather than at the top of the page.
export default function BulkResultsPanel({ report, onDismiss, openRecord }) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, [report]);

  const tone = report.failed ? 'var(--warning)' : 'var(--success, #16a34a)';
  return (
    <section
      aria-labelledby="bulk-results-heading"
      style={{
        border: '1px solid var(--border)', borderLeft: `3px solid ${tone}`, borderRadius: 10,
        background: 'var(--bg-secondary)', padding: '10px 12px', marginBottom: 14,
        animation: 'fadeUp 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="bulk-results-heading" ref={headingRef} tabIndex={-1}
              style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', outlineOffset: 2 }}>
            {report.headline}
          </h2>
          {report.note && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{report.note}</div>}
          {report.failed > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              The {report.failed === 1 ? 'row' : `${report.failed} rows`} not done {report.failed === 1 ? 'is' : 'are'} still selected, so you can fix them and try again.
            </div>
          )}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}
                aria-label="Dismiss these results" title="Dismiss" style={{ flexShrink: 0, padding: '2px 8px' }}>
          ✕
        </button>
      </div>

      {report.items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, maxHeight: 260, overflowY: 'auto',
                     display: 'flex', flexDirection: 'column', gap: 4 }}>
          {report.items.map(it => (
            <li key={it.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
              <span aria-hidden="true" style={{ color: it.ok ? 'var(--text-muted)' : 'var(--warning)', width: 12, flexShrink: 0 }}>
                {it.ok ? '–' : '!'}
              </span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{it.name}</span>
              <span style={{ color: it.ok ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                {it.ok ? 'Skipped: ' : 'Not done: '}{it.outcome}{it.message ? `. ${it.message}` : ''}
              </span>
              {/* A deleted row cannot be opened; any other can, to fix it. */}
              {!(report.action === 'delete' && it.ok) && it.outcome !== 'Not found' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openRecord(it.id)}
                        style={{ padding: '0 6px', fontSize: 12, color: 'var(--accent)' }}
                        aria-label={`Open ${it.name}`}>
                  Open →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
