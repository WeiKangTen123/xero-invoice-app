import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useConfirm } from '../context/ConfirmContext';

// Asks before throwing away edits nobody has saved.
//
// Two ways to lose them, and each needs its own guard. Moving within the app —
// a sidebar link, Back, the arrow keys between receipts — goes through the
// router, which can hold the navigation while the question is asked (this is
// why the app runs on a data router; useBlocker exists only there). Closing the
// tab, reloading, or following a link off the site never reaches the router, and
// the only thing the browser allows then is its own generic "Leave site?" box.
//
// Only a change of page counts. A filter or tab written into the address of the
// same page is not leaving it.
export function useUnsavedChanges(dirty, {
  title   = 'Discard your changes?',
  message = 'You have edits that have not been saved. Leaving this page throws them away.',
  confirmLabel = 'Discard changes',
} = {}) {
  const confirm = useConfirm();
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && currentLocation.pathname !== nextLocation.pathname);

  // One question per blocked navigation. The blocker object can be handed back
  // more than once while it stays blocked, and a second dialog stacked under
  // the first would answer a navigation that had already been settled.
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return;
    asking.current = true;
    confirm({ title, message, confirmLabel, cancelLabel: 'Keep editing', danger: true })
      .then(ok => { if (ok) blocker.proceed(); else blocker.reset(); })
      .finally(() => { asking.current = false; });
  }, [blocker, confirm, title, message, confirmLabel]);

  useEffect(() => {
    if (!dirty) return undefined;
    function onBeforeUnload(e) {
      e.preventDefault();
      // Older browsers show the prompt only when returnValue is set; the text
      // itself is ignored everywhere now.
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
