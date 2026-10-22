import { useState, useEffect } from 'react';
import { setReauthHandler } from '../api/client';
import { useAuth } from './AuthContext';
import ReauthDialog from '../components/ReauthDialog';

// "Confirm it's you" for the whole app. A sensitive admin action the server
// answers with 403 reauth_required (inviting or promoting an admin; a reset
// link, password reset or deletion of an admin; resetting someone's 2-step
// sign-in) waits in the API client (api/client.js send) while this asks; it
// is sent again once the dialog has confirmed, and fails with its original
// error on Cancel. So the Admin page's calls need nothing of their own.
// Requests refused together share one dialog (client.js confirmIdentity).
export function ReauthProvider({ children }) {
  const { user } = useAuth();
  const [pending, setPending] = useState(null);   // { resolve }

  // Registered once; the returned function unregisters it.
  useEffect(() => setReauthHandler(() => new Promise(resolve => setPending({ resolve }))), []);

  function answer(ok) {
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <>
      {children}
      {pending && (
        <ReauthDialog
          hasCode={user?.mfaEnabled === true}
          onConfirmed={() => answer(true)}
          onCancel={() => answer(false)}
        />
      )}
    </>
  );
}
