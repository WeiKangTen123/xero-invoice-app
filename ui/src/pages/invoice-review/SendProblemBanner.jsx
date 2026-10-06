import { Link } from 'react-router-dom';

// The send problems sendProblem() recognises, each with the way out that
// actually applies. The generic failure banner says to correct the fields and
// try again, which is wrong for all of them: for 'choose' and 'gone' nothing in
// this record is at fault, and for 'interrupted' trying again is the risk.
// Red rather than the amber of an ordinary review note, because each one means
// the document is not where the person expects it to be.
const COPY = {
  choose: {
    heading: 'Not sent — no default Xero company chosen',
    detail:  'More than one Xero company is connected, and documents go only to the one chosen as the default. Nothing in this record needs changing: choose the company, then send this again.',
    link:    { to: '/setup#default-xero-company', label: 'Choose the company in Setup →' },
  },
  gone: {
    heading: 'Not sent — that Xero company is no longer connected',
    detail:  'A correction goes only to the company that holds the original, never to another one.',
    link:    { to: '/setup', label: 'Reconnect it in Setup →' },
  },
  interrupted: {
    heading: 'Xero may already have this',
    detail:  null,
    link:    null,
  },
};

export default function SendProblemBanner({ kind, message }) {
  const copy = COPY[kind];
  if (!copy) return null;
  return (
    <div className="alert alert-error" role="alert" style={{ marginBottom: 12 }}>
      <span className="alert-icon">⚠</span>
      <div>
        <strong>{copy.heading}</strong>
        <div style={{ marginTop: 4 }}>{message}</div>
        {copy.detail && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{copy.detail}</div>}
        {copy.link && (
          <Link to={copy.link.to} className="btn btn-sm btn-outline" style={{ marginTop: 8, display: 'inline-flex' }}>
            {copy.link.label}
          </Link>
        )}
      </div>
    </div>
  );
}
