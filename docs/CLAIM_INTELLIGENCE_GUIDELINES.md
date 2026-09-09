# Corporate Expense Claim Intelligence Guidelines

This document specifies the rules, business justifications, and heuristic logic used by the AI to extract, classify, and format corporate expense claims for accounting in Xero.

> **Implementation note**: This logic is automatically applied server-side across all three ingestion pathways (batch ZIP import, Add Claim manual upload, phone camera capture) via `main/claims/claim-import.js` and `main/routes/receipts.js`. No manual input is required from the user — the AI generates a compliant description from each receipt automatically.

---

## 1. Core Principle: Business Justification First

In corporate finance and tax compliance (IRAS Singapore, LHDN Malaysia, HMRC, etc.), an expense claim is **never approved based merely on what was purchased** (e.g., food dishes or items). Approvals require clear evidence of **why the expense was incurred for the company** and whether it satisfies **company policy limits**.

Every AI-generated claim description must answer:
1. **Expense Category**: What accounting category does this fall under?
2. **Business Purpose**: What business activity justified this cost? (Client entertainment, working lunch, overtime meal, site transit, etc.)
3. **Contextual Metadata**: Merchant name, timestamp (`HH:MM`), location, and route (for transit).

### Standard Claim Description Formula:
```
[Category] <Business Purpose> @ <Merchant> (<Time/Location Context>)
```
*Examples:*
- `[Entertainment/Meals] Business working lunch with client @ Dong Seoul Supply (12:01 PM, Johor)`
- `[Staff Welfare] Office pantry refreshments & team snacks @ Isetan Chateraise (16:37)`
- `[Local Travel] Business transit to client meeting: Home to Apple Orchard (CDG Zig)`
- `[Local Travel] Late-night event commute: Esplanade to Home (Gojek, 20:09)`
- `[Overseas Travel] Hotel accommodation for ASOBIEXPO Tokyo conference @ Agoda (Aug 17–24)`

---

## 2. Standard Expense Categories (Matching Xero Chart of Accounts)

| Category Tag | Description & Scope | Typical Merchants | Default Xero Account |
| :--- | :--- | :--- | :--- |
| **`[Entertainment/Meals]`** | Client lunches, business dinners, partner discussions, vendor meetings. | Restaurants, Cafes, GrabFood | `420 - Entertainment` |
| **`[Staff Welfare]`** | Internal team milestone meals, department planning lunches, pantry snacks/coffee. | Cafes, Bakeries, Supermarkets | `420 / 460 - Staff Welfare` |
| **`[Staff Overtime Meal]`** | Dinners purchased when required to work late past company cutoff (typically past 8:00 PM / 8:30 PM). | Food delivery, Casual dining | `420 - Meals (Overtime)` |
| **`[Local Travel]`** | Travel between office and client sites, partner offices, or events during work hours. | Grab, Gojek, CDG Zig, Taxis, Petrol | `429 - Travel & Transport` |
| **`[Overtime Transport]`** | Taxi or ride-hailing home after working late (typically past 9:30 PM / 10:00 PM). | Grab, Gojek, CDG Zig | `429 - Travel & Transport` |
| **`[Overseas Travel]`** | Flights, hotels, trains, and visas for business trips or overseas conferences. | Agoda, Airlines, Booking.com | `430 - Travel (Overseas)` |
| **`[Office Supplies]`** | Stationery, printer toner, desk accessories, minor equipment for office operations. | Popular, OfficeMate, Hardware stores | `453 - Office Expenses` |
| **`[Software/Utilities]`** | Cloud servers, SaaS subscriptions, telecom, internet bills. | AWS, Google Cloud, Zoom, Slack | `489 - Subscriptions / Telco`|
| **`[Medical/Dental]`** | Outpatient clinic visits, prescription medicine, dental checkups under employee benefits. | Medical clinics, Hospitals | `425 - Medical Benefits` |
| **`[General Expense]`** | Courier fees, postage, bank charges, cleaning, general miscellaneous costs. | SingPost, DHL, NinjaVan | `499 - General Expenses` |

---

## 3. Temporal & Time-of-Day Intelligence Matrix

When reading receipt timestamps, the AI infers the natural business context:

| Time Window | Detected Window | Inferred Business Claim Purpose | Example Output Description |
| :--- | :--- | :--- | :--- |
| **07:00 – 10:59** | Morning / Breakfast | Morning client breakfast or meeting coffee | `[Entertainment/Meals] Morning breakfast meeting @ Starbucks (08:45)` |
| **11:00 – 14:59** | Lunchtime | Business working lunch or team project lunch | `[Entertainment/Meals] Business working lunch @ Dong Seoul Supply (12:01 PM, Johor)` |
| **15:00 – 17:59** | Afternoon | Office pantry supplies or team meeting refreshments | `[Staff Welfare] Office pantry refreshments & snacks @ Isetan Chateraise (16:37)` |
| **18:00 – 20:59** | Evening / Dinner | Client business dinner or partner entertainment | `[Entertainment/Meals] Client business dinner discussion @ Restaurant (19:30)` |
| **21:00 – 06:00** | Late Night (Meals) | Staff overtime dinner (working late past cutoff) | `[Staff Overtime Meal] Overtime dinner while working late on deadline (21:15)` |
| **08:00 – 19:59** | Business Hours (Rides) | Business transit between office and client sites | `[Local Travel] Business transit to client meeting: Home to Apple (08:08)` |
| **20:00 – 06:00** | Night Hours (Rides) | Event return commute or late-night overtime ride home | `[Local Travel] Late-night event commute: Esplanade to Home (Gojek, 20:09)` |

---

## 4. Route & Mobility Intelligence (Ride-Hailing & Taxis)

For Grab, Gojek, ComfortDelGro (CDG Zig), and taxi receipts:
1. **Origin & Destination**: Extract pickup and dropoff points whenever visible on the receipt or invoice snippet (e.g. *Apple Orchard to Spotify*, *Esplanade to Home*).
2. **Commute vs. Meeting**:
   - `Office to Client Site` &rarr; `Business transit to client meeting`
   - `Site A to Site B` &rarr; `Inter-site business transit`
   - `Office / Event to Home` &rarr; `Late-night event / overtime commute home`

---

## 5. Benchmark Case Studies (From Real Project Samples)

### Case 1: `sample_expenses/SG-2.jpeg`
- **Merchant**: `DONG SEOUL SUPPLY SDN BHD` (Skudai, Johor)
- **Time**: `12:01:47 PM` (Lunchtime)
- **Amount**: `MYR 232.00` (incl. 5% service charge, 6% SST)
- **Dishes**: Beef prime rib, fried octopus, kimbap, rose tteokbokki, noodles (5 dishes)
- **Claim Purpose**: `[Entertainment/Meals] Business working lunch with client @ Dong Seoul Supply (12:01 PM, Johor)`
- **Alternative (Site Visit)**: `[Local Travel] Lunch expense during Johor client/site visit @ Dong Seoul Supply (12:01 PM)`

### Case 2: `sample_expenses/SG-1.jpg`
- **Merchant**: `ISETAN (SINGAPORE) LIMITED` (Jurong East)
- **Time**: `16:37` (Afternoon)
- **Amount**: `SGD 6.60` (Tax SGD 0.43)
- **Items**: Chateraise confectionery / bakery items (2 items)
- **Claim Purpose**: `[Staff Welfare] Office pantry refreshments & team snacks @ Isetan Chateraise (16:37)`

### Case 3: `Jan to May 13/Screenshot ... at 8.09.12 PM.png` (Gojek)
- **Merchant**: `Gojek`
- **Date & Time**: `2026-03-10 20:09`
- **Route**: `Esplanade to Home` (Return from The Paperkites concert/event)
- **Amount**: `SGD 25.00`
- **Claim Purpose**: `[Local Travel] Company event return commute: Esplanade to Home (Gojek, 20:09)`

### Case 4: `Jan to May 13/Screenshot ... at 8.08.26 PM.png` (CDG Zig)
- **Merchant**: `CDG Zig`
- **Date & Time**: `2026-02-26 08:08`
- **Route**: `Home to Apple`
- **Amount**: `SGD 30.60`
- **Claim Purpose**: `[Local Travel] Business transit to client meeting: Home to Apple (CDG Zig, 08:08)`

### Case 5: `sample_expenses/#note Agoda receipt #note.eml`
- **Merchant**: `Agoda Company Pte. Ltd.`
- **Dates**: `Aug 17–24, 2026` (7 nights)
- **Amount**: `SGD 1,443.21`
- **Purpose**: ASOBIEXPO Tokyo conference hotel stay
- **Claim Purpose**: `[Overseas Travel] Hotel accommodation for ASOBIEXPO Tokyo conference @ Agoda (Aug 17–24)`
