// Every timestamp in this app is stored in UTC. These helpers only control the
// timezone timestamps are FORMATTED in for display — never how they're stored,
// compared, or sent to the backend.

export const DEFAULT_TIMEZONE = 'Asia/Singapore';

export const TIMEZONE_OPTIONS = [
  { value: 'UTC',                label: 'UTC' },
  { value: 'Asia/Singapore',     label: 'Singapore (UTC+8)' },
  { value: 'Asia/Kuala_Lumpur',  label: 'Malaysia (UTC+8)' },
  { value: 'Asia/Bangkok',       label: 'Bangkok (UTC+7)' },
  { value: 'Asia/Jakarta',       label: 'Jakarta (UTC+7)' },
  { value: 'Asia/Manila',        label: 'Manila (UTC+8)' },
  { value: 'Asia/Hong_Kong',     label: 'Hong Kong (UTC+8)' },
  { value: 'Asia/Shanghai',      label: 'China (UTC+8)' },
  { value: 'Asia/Tokyo',         label: 'Tokyo (UTC+9)' },
  { value: 'Asia/Kolkata',       label: 'India (UTC+5:30)' },
  { value: 'Asia/Dubai',         label: 'Dubai (UTC+4)' },
  { value: 'Australia/Sydney',   label: 'Sydney (UTC+10/11)' },
  { value: 'Europe/London',      label: 'London (UTC+0/1)' },
  { value: 'America/New_York',   label: 'New York (UTC-5/4)' },
  { value: 'America/Los_Angeles',label: 'Los Angeles (UTC-8/7)' },
];

// "9 Aug 2026, 14:32" in the given timezone.
export function formatDateTime(iso, timezone = DEFAULT_TIMEZONE) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

// "3m ago" / "2h ago" / "5d ago" — for recent-activity columns where the relative
// distance matters more than the exact clock time.
export function formatRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}
