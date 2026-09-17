# Corporate Expense Claim Intelligence Guidelines

This document specifies the rules, business justifications, and heuristic logic used by the AI to extract, classify, and format corporate expense claims for accounting in Xero.

> **Implementation note**: This logic is automatically applied server-side across all three ingestion pathways (batch ZIP import, Add Claim manual upload, phone camera capture) via `main/claims/claim-import.js` and `main/routes/receipts.js`. No manual input is required from the user — the AI generates a compliant description from each receipt automatically.

---

## 1. Core Principle: Business Justification First

In corporate finance and tax compliance (IRAS Singapore, LHDN Malaysia, HMRC, etc.), an expense claim is **never approved based merely on what was purchased** (e.g., food dishes or items). Approvals require clear evidence of **why the expense was incurred for the company** and whether it satisfies **company policy limits**.

Every claim description must answer:
1. **Expense Category**: What accounting category does this fall under? — *the reader decides this from what was bought and when.*
2. **Business Purpose**: What business activity justified this cost? — *the claimant supplies this at review. The reader never invents it: a receipt does not say who the lunch was with or why the ride was taken, and a description that claims it does is fabricated evidence.*
3. **Contextual Metadata**: Merchant name, timestamp (`HH:MM`), and route (for transit) — *the reader copies these from the receipt, and adds nothing that is not printed.*

### Standard Claim Description Formula:
```
[Category] <Business Purpose> @ <Merchant> (<Time/Location Context>)
```
*What the reader writes (what was bought, where, when):*
- `[Entertainment/Meals] Lunch for 2 @ Dong Seoul Supply (12:01)`
- `[Staff Welfare] Pastries and coffee @ Isetan Chateraise (16:37)`
- `[Local Travel] Home to Apple Orchard @ CDG Zig (08:08)`
- `[Overtime Transport] Esplanade to Home @ Gojek (22:09)`
- `[Overseas Travel] Hotel, Aug 17–24 @ Agoda`

*What the claimant adds at review (the purpose):* "with Acme to close the Q3 order", "team planning lunch", "ride home after the launch event". The `[Category] … @ Merchant (time)` part stays; the purpose is typed in front of the merchant.

---

## 2. Standard Expense Categories

The list lives in `main/claims/categories.js` and nowhere else: the reader's prompt offers exactly these names, anything else the model returns is dropped, and the account hints below are keyed by them (a test fails if the two drift).

**Which Xero account a claim lands on** is decided at claim time by matching the category against the org's *own* chart of accounts by name (`main/claims/category-account.js`) — "Staff Welfare" looks for an account whose name contains *staff welfare*, then *welfare*, then *pantry*, and finally falls back to an *entertainment* account. No code is fixed: 429 is General Expenses in one org and something else in the next. When nothing matches, the user's default claim account stands.

| Category Tag | Description & Scope | Typical Merchants |
| :--- | :--- | :--- |
| **`[Entertainment/Meals]`** | Client lunches, business dinners, partner discussions, vendor meetings. | Restaurants, Cafes, GrabFood |
| **`[Staff Welfare]`** | Internal team milestone meals, department planning lunches, pantry snacks/coffee. | Cafes, Bakeries, Supermarkets |
| **`[Staff Overtime Meal]`** | Dinners purchased when required to work late past company cutoff (typically past 8:00 PM / 8:30 PM). | Food delivery, Casual dining |
| **`[Local Travel]`** | Travel between office and client sites, partner offices, or events during work hours. | Grab, Gojek, CDG Zig, Taxis, Petrol |
| **`[Overtime Transport]`** | Taxi or ride-hailing home after working late (typically past 9:30 PM / 10:00 PM). | Grab, Gojek, CDG Zig |
| **`[Overseas Travel]`** | Flights, hotels, trains, and visas for business trips or overseas conferences. | Agoda, Airlines, Booking.com |
| **`[Office Supplies]`** | Stationery, printer toner, desk accessories, minor equipment for office operations. | Popular, OfficeMate, Hardware stores |
| **`[Software/Utilities]`** | Cloud servers, SaaS subscriptions, telecom, internet bills. | AWS, Google Cloud, Zoom, Slack |
| **`[Medical/Dental]`** | Outpatient clinic visits, prescription medicine, dental checkups under employee benefits. | Medical clinics, Hospitals |
| **`[General Expense]`** | Courier fees, postage, bank charges, cleaning, general miscellaneous costs. | SingPost, DHL, NinjaVan |

---

## 3. What the Time on the Receipt Decides

Only the **category**, and only in two cases:

| Receipt | Time paid | Category |
| :--- | :--- | :--- |
| A meal | at or after 21:00 | `[Staff Overtime Meal]` |
| A meal | before 21:00 | `[Entertainment/Meals]` (or `[Staff Welfare]` for pantry-type purchases) |
| A taxi / ride-hailing trip | at or after 21:30 | `[Overtime Transport]` |
| A taxi / ride-hailing trip | before 21:30 | `[Local Travel]` |

The time is copied into the description as printed (`(12:01)`), so the reviewer can see it. It does **not** license a purpose: a 12:01 lunch is "Lunch for 2", not "Business working lunch with client"; a 20:09 ride is "Esplanade to Home", not "late-night event commute". Earlier versions of this document inferred a business purpose from the time window; that produced descriptions that read as evidence the receipt does not contain, and it has been removed.

---

## 4. Route & Mobility Intelligence (Ride-Hailing & Taxis)

For Grab, Gojek, ComfortDelGro (CDG Zig), and taxi receipts:
1. **Origin & Destination**: Extract pickup and dropoff points whenever visible on the receipt or invoice snippet (e.g. *Apple Orchard to Spotify*, *Esplanade to Home*).
2. **Only the route is copied.** `Orchard Rd to Changi Airport @ Grab (08:08)` is the whole description; whether it was a client visit or an airport run is the claimant's to say at review.

---

## 5. Benchmark Case Studies (From Real Project Samples)

### Case 1: `sample_expenses/SG-2.jpeg`
- **Merchant**: `DONG SEOUL SUPPLY SDN BHD` (Skudai, Johor)
- **Time**: `12:01:47 PM` (Lunchtime)
- **Amount**: `MYR 232.00` (incl. 5% service charge, 6% SST)
- **Dishes**: Beef prime rib, fried octopus, kimbap, rose tteokbokki, noodles (5 dishes)
- **Reader writes**: `[Entertainment/Meals] Lunch, 5 dishes @ Dong Seoul Supply (12:01)`
- **Claimant adds at review**: who the lunch was with, or that it was during the Johor site visit

### Case 2: `sample_expenses/SG-1.jpg`
- **Merchant**: `ISETAN (SINGAPORE) LIMITED` (Jurong East)
- **Time**: `16:37` (Afternoon)
- **Amount**: `SGD 6.60` (Tax SGD 0.43)
- **Items**: Chateraise confectionery / bakery items (2 items)
- **Reader writes**: `[Staff Welfare] Chateraise bakery items, 2 @ Isetan (16:37)`
- **Claimant adds at review**: "office pantry" or "team meeting snacks"

### Case 3: `Jan to May 13/Screenshot ... at 8.09.12 PM.png` (Gojek)
- **Merchant**: `Gojek`
- **Date & Time**: `2026-03-10 20:09`
- **Route**: `Esplanade to Home` (Return from The Paperkites concert/event)
- **Amount**: `SGD 25.00`
- **Reader writes**: `[Local Travel] Esplanade to Home @ Gojek (20:09)` — before 21:30, so not Overtime Transport
- **Claimant adds at review**: "return from the company event"

### Case 4: `Jan to May 13/Screenshot ... at 8.08.26 PM.png` (CDG Zig)
- **Merchant**: `CDG Zig`
- **Date & Time**: `2026-02-26 08:08`
- **Route**: `Home to Apple`
- **Amount**: `SGD 30.60`
- **Reader writes**: `[Local Travel] Home to Apple @ CDG Zig (08:08)`
- **Claimant adds at review**: "client meeting at Apple"

### Case 5: `sample_expenses/#note Agoda receipt #note.eml`
- **Merchant**: `Agoda Company Pte. Ltd.`
- **Dates**: `Aug 17–24, 2026` (7 nights)
- **Amount**: `SGD 1,443.21`
- **Reader writes**: `[Overseas Travel] Hotel, Aug 17–24, 7 nights @ Agoda` — read from the PDF's text, not from an image
- **Claimant adds at review**: "ASOBIEXPO Tokyo conference"

---

## 6. How a Receipt Is Read

- **A photo** goes to the vision reader. Several receipts in one photo are split into one record each when the evidence is clean.
- **A PDF with a text layer** (an emailed Agoda or Grab receipt, a print-to-PDF) is read from its text — the whole file, or page by page when each page is its own receipt. No image is rendered.
- **A scanned PDF** (every page an image, no text) is stored but not read; the review page says so and the fields are typed in by hand.
- **Re-read** on the review page repeats whichever of these applies, on the page that record owns.
