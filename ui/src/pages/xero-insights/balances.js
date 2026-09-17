// The Bank Summary report identifies accounts by NAME only — it carries no
// account id — so balances can only be joined to the Accounts list by name.
// A miss returns null and the UI shows an em dash: a missing balance is honest,
// a balance attached to the wrong account is not.
export function balancesByName(cashAccounts = []) {
  const map = new Map();
  for (const a of cashAccounts) {
    const key = String(a.name || '').trim().toLowerCase();
    if (key) map.set(key, a);
  }
  return map;
}

export function balanceFor(map, account) {
  return map.get(String(account?.name || '').trim().toLowerCase()) || null;
}
