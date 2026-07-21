# UI Prototype — Xero Invoice Automation Desktop App

Prototype link: https://claude.ai/design/p/578f9910-7128-425d-a210-8932a6fad8ce

---

## Overview

2 screens + 1 system tray icon. That's the entire UI.

| Screen | When shown |
|---|---|
| Setup | First launch, or when user clicks ⚙ |
| Status | After setup is saved, main running view |
| Tray icon | Always — app lives here when window is closed |

---

## Screen 1 — Setup

### Layout

```
┌─────────────────────────────────────────┐
│         Xero Invoice Automation         │
├─────────────────────────────────────────┤
│                                         │
│  XERO                  [Open Xero Dev →]│
│  Client ID     [                      ] │
│  Client Secret [                      ] │
│                                         │
│  EMAIL               [Get App Password →]│
│  Email Address [                      ] │
│  App Password  [                      ] │
│  IMAP Host     [ imap.gmail.com       ] │
│  IMAP Port     [ 993                  ] │
│                                         │
│  DEFAULTS                               │
│  Currency      [ SGD ▼                ] │
│  Account Code  [ 310                  ] │
│                                         │
│  FILTER (optional)                      │
│  Only from     [                      ] │
│                                         │
│     [Test Connection]   [Save & Start]  │
└─────────────────────────────────────────┘
```

### Fields

| Field | Type | Behaviour |
|---|---|---|
| Client ID | Text input | Plain text |
| Client Secret | Password input | Hidden by default, toggle to show |
| Email Address | Text input | Auto-fills IMAP Host when user stops typing |
| App Password | Password input | Hidden by default, toggle to show |
| IMAP Host | Text input | Auto-filled, but editable |
| IMAP Port | Number input | Auto-filled as 993, editable |
| Currency | Dropdown | SGD / USD / AUD / GBP / EUR |
| Account Code | Text input | Default: 310 |
| Only from (filter) | Text input | Optional — leave blank = all emails |

### IMAP Host Auto-fill Logic

| Email domain typed | IMAP Host auto-filled |
|---|---|
| @gmail.com | `imap.gmail.com` |
| @outlook.com / @hotmail.com | `outlook.office365.com` |
| @yahoo.com | `imap.mail.yahoo.com` |
| @icloud.com / @me.com | `imap.mail.me.com` |
| anything else | blank — user types manually |

### Buttons

| Button | Action |
|---|---|
| Open Xero Dev → | Opens `https://developer.xero.com/app/manage` in system browser |
| Get App Password → | Opens `https://myaccount.google.com/apppasswords` in system browser |
| Test Connection | Tries connecting to Xero API + Gmail IMAP — shows success or error inline |
| Save & Start | Saves all fields to `settings.json`, starts IMAP watcher, switches to Status screen |

### Validation (on Save & Start)

- Client ID — cannot be empty
- Client Secret — cannot be empty
- Email Address — must contain @
- App Password — cannot be empty
- IMAP Host — cannot be empty
- IMAP Port — must be a number

---

## Screen 2 — Status

### Layout

```
┌─────────────────────────────────────────┐
│  Xero Invoice Automation        [⚙ ] [—]│
├─────────────────────────────────────────┤
│                                         │
│  ● Running                              │
│  Org:   Your Company (Xero)             │
│  Email: you@gmail.com                   │
│                                         │
│  ──── Recent Invoices ────────────────  │
│                                         │
│  ✓ Acme Corp     INV-001   SGD 1,200    │
│  ✓ Supplier Co   INV-002   SGD 450      │
│  ✗ Unknown       INV-003   Failed       │
│                                         │
│  ──── Last checked: 2 mins ago ───────  │
│                                         │
│              [Stop]   [Open Xero →]     │
└─────────────────────────────────────────┘
```

### Status Indicator

| State | Colour | Label |
|---|---|---|
| Watcher running | Green dot | Running |
| Watcher stopped by user | Grey dot | Stopped |
| Error / disconnected | Red dot | Error — click ⚙ to check settings |

### Recent Invoices List

Each row shows:

```
[✓ or ✗]  Vendor Name     Invoice #     Amount     Type      Time
✓         Acme Corp        INV-001      SGD 1,200   Bill      5 min ago
✓         Supplier Co      INV-002      SGD 450     Sales     12 min ago
✗         Unknown          INV-003      SGD 3,200   Sales     Failed
```

- ✓ = successfully created in Xero
- ✗ = failed, will retry on next startup
- Type column shows **Bill** (ACCPAY) or **Sales** (ACCREC)
- Shows last 10 entries from `invoices.json` cache
- Entries older than 24 hours do not appear (auto-purged)

### Buttons

| Button | Action |
|---|---|
| ⚙ | Opens Setup screen (pre-filled with saved values) |
| — | Minimizes window to system tray, watcher keeps running |
| Stop | Stops IMAP watcher, dot turns grey, button changes to Start |
| Open Xero → | Opens Xero in system browser |

---

## System Tray

### Icon States

| State | Icon colour |
|---|---|
| Running | Blue / Green |
| Stopped | Grey |
| Error | Red |

### Right-click Menu

```
Xero Invoice Automation
─────────────────────
● Running
─────────────────────
Open
Quit
```

- Clicking the tray icon = opens the Status screen
- App does NOT appear in the Dock (Mac) / Taskbar (Windows) when minimized — lives in tray only

---

## Tech Stack for UI

| Layer | Choice | Reason |
|---|---|---|
| Framework | Electron | Desktop app, access to file system + Node.js |
| UI | Plain HTML + CSS + vanilla JS | 2 screens only — no need for React |
| Styling | Custom CSS | Simple enough to write from scratch |
| IPC | Electron `ipcMain` / `ipcRenderer` | Communication between UI and watcher |

---

## Files for the UI

```
src/
└── renderer/
    ├── setup.html      ← Setup screen
    ├── status.html     ← Status screen
    ├── styles.css      ← Shared styles
    └── app.js          ← Button logic, IPC calls, auto-fill logic
```

---

## What Is NOT in the UI

| Excluded | Reason |
|---|---|
| Invoice history beyond 1 day | Cache auto-purges, matches the plan |
| Dark / light mode | Internal tool, not needed |
| Multiple email accounts | Out of scope for now |
| App login / password screen | Internal use only |
| Notifications per invoice | Too noisy — check status screen instead |
