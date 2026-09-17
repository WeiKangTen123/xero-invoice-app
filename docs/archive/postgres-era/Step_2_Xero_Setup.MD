# Step 2 — Xero API Setup

---

## What This Step Does

Creates a Xero Developer app that allows this system to connect to your Xero organisation and create invoices on your behalf via OAuth2.

---

## Part A — Create a Xero Developer App

**1. Go to the Xero Developer portal**

[developer.xero.com](https://developer.xero.com) → sign in with your Xero account

**2. Create a new app**

- Click **My Apps** → **New App**
- Fill in:
  - App name: `Invoice Automation` (or any name)
  - Integration type: **Web app**
  - Company URL: your website or any placeholder
  - Redirect URI:
    - If deploying to Railway: `https://yourapp.up.railway.app/xero/callback`
    - If running locally: `http://localhost:3000/xero/callback`
- Click **Create App**

**3. Get your credentials**

On the **Configuration** tab:
- Copy **Client ID** — you will need this
- Click **Generate a secret** → copy the secret immediately (shown once only)

---

## Part B — What Credentials You Get

| Credential | Where to get it | Where to put it |
|---|---|---|
| `XERO_CLIENT_ID` | Xero Developer → Configuration tab | `.env` file |
| `XERO_CLIENT_SECRET` | Xero Developer → Generate a secret | `.env` file |
| `XERO_REDIRECT_URI` | You decide (must match Xero portal exactly) | `.env` file |

---

## Part C — The Redirect URI Must Match Exactly

This is the most common setup mistake. The URI in your `.env` must be **character-for-character identical** to what you entered in the Xero Developer portal.

```
# .env
XERO_REDIRECT_URI=https://yourapp.up.railway.app/xero/callback

# Xero Developer Portal → Configuration → Redirect URIs
https://yourapp.up.railway.app/xero/callback    ← must be identical
```

Common mistakes that cause `redirect_uri_mismatch` error:

| Wrong | Right |
|---|---|
| `http://yourapp...` | `https://yourapp...` |
| `https://yourapp.../xero/callback/` (trailing slash) | `https://yourapp.../xero/callback` |
| `https://yourapp.railway.app/...` | `https://yourapp.up.railway.app/...` |

---

## Part D — OAuth Scopes (already configured in the code)

These scopes are hardcoded in `xero/client.js` and requested automatically when the user connects. You do not need to set these manually.

| Scope | Purpose |
|---|---|
| `openid` | Required for OAuth2 login |
| `profile` | Read user profile |
| `email` | Read user email |
| `offline_access` | Get refresh token (enables auto token renewal) |
| `accounting.transactions` | **Create invoices** |
| `accounting.contacts` | **Look up and create contacts (vendors)** |
| `accounting.settings` | Read org settings (currency, tax codes) |
| `accounting.reports.read` | Read reports |

---

## Part E — Token Lifecycle (how authentication stays alive)

You log in once via the browser. After that, the app handles tokens automatically.

```
Browser login (one time only)
        ↓
Access token issued (lasts 30 minutes)
        ↓
When token is about to expire (within 60 seconds):
  → App automatically refreshes using the refresh token
  → New tokens saved to PostgreSQL
  → Old tokens discarded
        ↓
Refresh token lasts 60 days
(rotated on every refresh — each refresh gives a new one)
```

If the refresh token expires (60 days of no activity), you visit `/xero/connect` again to re-authorise.

---

## Part F — Where to Connect (after app is running)

Once your app is running, open this URL in your browser:

```
http://localhost:3000/xero/connect       ← local dev
https://yourapp.up.railway.app/xero/connect  ← Railway
```

1. You are redirected to Xero's login page
2. Log in with your Xero account
3. Select your organisation → click **Allow access**
4. You are redirected back to `/dashboard`
5. Your tokens are now saved — the app is linked to your Xero org

---

## Part G — Xero Rate Limits

| Limit | Value |
|---|---|
| API calls per minute | 60 per connected org |
| Concurrent queue workers | 3 (configured in `queue/processor.js`) |
| Retry on HTTP 429 | Up to 3 times with exponential backoff |

---

## Part H — Where Invoices Appear in Xero

| Type | Code | Xero Navigation |
|---|---|---|
| Bill (default) | `ACCPAY` | Accounts → Purchases → **Bills → Drafts** |
| Sales Invoice | `ACCREC` | Accounts → Sales → **Invoices → Drafts** |

The app defaults to **ACCPAY**. To switch to ACCREC, change line 40 of `xero/invoices.js`:
```js
type: Invoice.TypeEnum.ACCREC
```

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | URI in `.env` doesn't exactly match Xero portal | Copy-paste exactly, check for trailing slash or http vs https |
| `invalid_client` | Wrong Client ID or Secret | Regenerate secret in Xero portal, copy again |
| `Token refresh failed` | Refresh token expired (60+ days old) | Visit `/xero/connect` again to re-authorise |
| `No token for tenant` | Org was disconnected | Visit `/xero/connect` again |
| Invoice not appearing | Account code `310` doesn't exist in your Xero | Xero → Accounting → Chart of Accounts → find a valid expense code → set as `DEFAULT_ACCOUNT_CODE` in `.env` |

---

## Next Step

→ [Step_3_Gmail_Setup.MD](Step_3_Gmail_Setup.MD)
