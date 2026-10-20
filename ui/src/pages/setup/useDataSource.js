import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import { switchConfirm } from './data-source';

// An admin switching their own account between Xero and the Demo Company's
// sample data (setup/data-source.js), shared by the Setup card and the
// Dashboard. Asks first, tells the server, then re-reads the signed-in user,
// whose `demo` the Setup card, the Dashboard's pill and its own reload all go
// by. True once switched; false when the person cancels or the server
// refuses, and a refusal is shown as the server words it: a 409 says the
// email watcher is running or documents are still being processed, which is
// the person's to sort out before switching.
export function useDataSource() {
  const confirm = useConfirm();
  const toast   = useToast();
  const { refreshUser } = useAuth();
  const [switching, setSwitching] = useState(false);

  async function switchTo(source) {
    if (!(await confirm(switchConfirm(source)))) return false;
    setSwitching(true);
    try {
      await api.put('/setup/data-source', { source });
      await refreshUser();
      // The app-wide "reconnect Xero" banner reads the connection, which is
      // now the other source's: it looks again rather than in ten minutes.
      window.dispatchEvent(new CustomEvent('xero-connection-changed'));
      return true;
    } catch (err) {
      toast.error(err.message || 'Could not switch the data source');
      return false;
    } finally {
      setSwitching(false);
    }
  }

  return { switching, switchTo };
}
