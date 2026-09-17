import { createContext, useContext, useState, useCallback } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

// `const confirm = useConfirm(); if (!(await confirm({ title, message }))) return;`
// — the same shape as the native call, minus the blocked tab.
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [pending, setPending] = useState(null);   // { title, message, confirmLabel, danger, resolve }

  const confirm = useCallback(opts => new Promise(resolve => setPending({ ...opts, resolve })), []);
  function answer(value) { pending.resolve(value); setPending(null); }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog title={pending.title} message={pending.message} confirmLabel={pending.confirmLabel}
                       cancelLabel={pending.cancelLabel} danger={pending.danger}
                       onConfirm={() => answer(true)} onCancel={() => answer(false)} />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}
