// Where an admin's own account reads its figures from: their Xero
// organisation, or the Demo Company's sample data this app generates (the
// same data a demo account shows). An admin may switch between the two and
// back; everyone else sees what their account is set to and has no choice.
// The server keeps the choice (PUT /api/setup/data-source) and refuses it to
// anyone else, so these only decide what the screen offers.
//
// Plain functions with no imports, so main/scripts/data-source-ui.test.js
// can load and run them; the switch itself (setup/useDataSource.js), the
// Setup card and the Dashboard only wire them in.

// Whether the signed-in user is offered the choice at all.
export function canChooseDataSource(user) {
  return user?.role === 'admin';
}

// Which source the account is on now: 'demo' only for a strict true, as
// connect.js#connectionView reads the same flag, and 'xero' otherwise.
export function currentSource(user) {
  return user && user.demo === true ? 'demo' : 'xero';
}

// The two choices, in the order the Setup card shows them.
export function sourceOptions() {
  return [
    { key: 'xero', label: 'Xero' },
    { key: 'demo', label: 'Sample data' },
  ];
}

// What is asked before a switch. It says where posting goes from then on,
// since that is the part with consequences: a bill approved after the switch
// to sample data lands in the Demo Company, not in Xero. And that the Xero
// connection is kept, which is what an admin trying the demo worries about.
export function switchConfirm(to) {
  if (to === 'demo') {
    return {
      title: 'Use sample data?',
      message: 'The dashboard will show Demo Company Pte Ltd. Anything posted from now on goes to the Demo Company, not Xero. '
             + 'Your Xero connection is kept for when you switch back.',
      confirmLabel: 'Use sample data',
    };
  }
  return {
    title: 'Switch to Xero?',
    message: 'The dashboard will show your own Xero data. Anything posted from now on goes to Xero.',
    confirmLabel: 'Switch to Xero',
  };
}
