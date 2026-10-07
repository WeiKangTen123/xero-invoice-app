// Mileage and per diem: expense claims with no receipt, priced from a rate set
// in Setup (main/routes/claims.js). The server works the amount out and keeps
// the rate the claim was made at; everything here is for showing a claim and
// previewing one while it is typed, never for deciding what it costs.

export const ALLOWANCE_KINDS = {
  mileage:  { label: 'Mileage',  long: 'Mileage claim',  icon: '🚗', unit: 'km',  per: 'per km'  },
  per_diem: { label: 'Per diem', long: 'Per diem claim', icon: '🗓', unit: 'day', per: 'per day' },
};

export function isAllowanceClaim(inv) {
  return !!inv && Object.prototype.hasOwnProperty.call(ALLOWANCE_KINDS, inv.claimKind);
}

// 'Mileage claim' / 'Per diem claim', or null for anything else. A claim of
// this kind has no merchant, so this is what stands where the merchant would.
export function claimKindLabel(inv) {
  return isAllowanceClaim(inv) ? ALLOWANCE_KINDS[inv.claimKind].long : null;
}

// The Source badge for the AR & AP list, which otherwise reads a record with
// no receipt and no PDF as "✉ Email". Null for every other record, so the
// list keeps its own badges for those.
export function claimSourceBadge(inv) {
  if (!isAllowanceClaim(inv)) return null;
  const k = ALLOWANCE_KINDS[inv.claimKind];
  return { className: 'badge badge-blue', text: `${k.icon} ${k.label}`, title: `${k.long}: no receipt, priced from the rate in Setup` };
}

// The same form as the server's users.formatRate: at least two places, up to four.
export function formatRate(rate) {
  const n = Number(rate);
  return Number.isFinite(n) ? n.toFixed(4).replace(/0{1,2}$/, '') : '';
}

export function formatQuantity(kind, quantity) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return '';
  return kind === 'mileage' ? `${q.toFixed(1)} km` : `${q} ${q === 1 ? 'day' : 'days'}`;
}

function money(amount, currency) {
  const v = Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency ? `${currency} ` : ''}${v}`;
}

// "42.0 km × 0.60 = SGD 25.20", from what the server stored.
export function allowanceSummary(inv) {
  if (!isAllowanceClaim(inv)) return '';
  return `${formatQuantity(inv.claimKind, inv.claimQuantity)} × ${formatRate(inv.claimRate)} = ${money(inv.totalAmount, inv.currency)}`;
}

const _dayNumber = s => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);

// Days from a start to an end date, both counted; null when either is missing
// or the end comes first.
export function daySpan(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return null;
  const span = _dayNumber(endDate) - _dayNumber(startDate) + 1;
  return span >= 1 ? span : null;
}

// The quantity the form describes, or null while it is incomplete: km
// (doubled for a return trip), or days (typed, else the dates' span).
export function formQuantity(kind, form) {
  if (kind === 'mileage') {
    const km = Number(form.distanceKm);
    if (!(km > 0)) return null;
    return km * (form.returnTrip ? 2 : 1);
  }
  if (form.days !== '' && form.days !== null && form.days !== undefined) {
    const d = Number(form.days);
    return d > 0 ? d : null;
  }
  return daySpan(form.startDate, form.endDate);
}

// What the claim will come to, for the preview under the form. The same
// whole-number sum the server does, so the preview agrees with what is saved.
export function previewAmount(quantity, rate) {
  if (!(quantity > 0) || !(Number(rate) > 0)) return null;
  const cents = Math.floor((Math.round(quantity * 10) * Math.round(Number(rate) * 10000) + 500) / 1000);
  return cents / 100;
}

export function emptyAllowanceForm(kind, today) {
  return kind === 'mileage'
    ? { date: today, from: '', to: '', purpose: '', distanceKm: '', returnTrip: false }
    : { startDate: today, endDate: today, days: '', destination: '', purpose: '' };
}

// The form an existing claim was made from, for editing it. Days are left
// blank when they are just the span of the dates, so changing a date moves
// them along; a typed number of days (a half day, say) is kept.
export function allowanceForm(inv) {
  const d = inv.claimDetails || {};
  if (inv.claimKind === 'mileage') {
    return {
      date: inv.invoiceDate || '', from: d.from || '', to: d.to || '', purpose: d.purpose || '',
      distanceKm: d.distanceKm != null ? String(d.distanceKm) : '', returnTrip: !!d.returnTrip,
    };
  }
  const span = daySpan(inv.invoiceDate, d.endDate);
  return {
    startDate: inv.invoiceDate || '', endDate: d.endDate || '',
    days: span !== null && Number(inv.claimQuantity) === span ? '' : String(inv.claimQuantity ?? ''),
    destination: d.destination || '', purpose: d.purpose || '',
  };
}

// What is still missing before the form is worth sending. The server checks
// everything again; this only keeps Save from answering with an error the
// person could see coming.
export function missingFields(kind, form) {
  const need = kind === 'mileage'
    ? [['date', 'date'], ['from', 'from'], ['to', 'to'], ['purpose', 'purpose'], ['distanceKm', 'distance']]
    : [['startDate', 'start date'], ['destination', 'destination'], ['purpose', 'purpose']];
  const missing = need.filter(([k]) => !String(form[k] ?? '').trim()).map(([, label]) => label);
  if (kind === 'per_diem' && !String(form.endDate || '').trim() && !String(form.days || '').trim()) missing.push('end date or days');
  return missing;
}
