import { useState } from 'react';
import { api } from '../api/client';
import Modal from './Modal';
import {
  PRIVACY_NOTICE_VERSION, PRIVACY_NOTICE_TITLE, PRIVACY_NOTICE_BUTTON, noticeParagraphs, acknowledgeError,
} from './privacy-notice';

// The privacy notice, over the app, until the person presses "I understand"
// (components/privacy-notice.js has the words and says when; Layout.jsx shows
// it). There is no other way out of it: Escape and a click outside do nothing,
// since the point is that it was read. The server records which version was
// read, and when; onDone runs once it has.
export default function PrivacyNotice({ contact, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  async function acknowledge() {
    setSaving(true);
    setError('');
    try {
      await api.post('/onboarding/notice', { version: PRIVACY_NOTICE_VERSION });
      onDone?.();
    } catch (err) {
      setError(acknowledgeError(err));
      setSaving(false);
    }
  }

  return (
    <Modal busy={saving} maxWidth={480} zIndex={1100} label={PRIVACY_NOTICE_TITLE}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>
        {PRIVACY_NOTICE_TITLE}
      </div>
      {noticeParagraphs(contact).map((text, i) => (
        <p key={i} style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px' }}>{text}</p>
      ))}
      {error && (
        <div className="alert alert-error" role="alert" style={{ marginTop: 4, marginBottom: 12 }}>
          <span className="alert-icon">✕</span>{error}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" className="btn btn-primary" onClick={acknowledge} disabled={saving} autoFocus>
          {saving ? <><span className="btn-spinner" /> Saving...</> : PRIVACY_NOTICE_BUTTON}
        </button>
      </div>
    </Modal>
  );
}
