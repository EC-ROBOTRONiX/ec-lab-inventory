# EC Lab Inventory

Component stock and bin-location register for the EC Lab: 380 components across
58 storage positions, with search, low-stock alerts and issue/return tracking.

Runs on infrastructure you already own — a Google Sheet holds the data, Google
Apps Script serves it, and GitHub Pages hosts the page. No server to maintain,
no monthly cost, no third-party account beyond the Google account you already
use for the lab.

```
Browser  ──GET/POST──▶  Apps Script Web App  ──▶  Google Sheet (the database)
(GitHub Pages)                                    Inventory · Issues · Activity · Settings
```

## What it does

| Screen | What you get |
| --- | --- |
| **Overview** | Component count, units on shelf, low/out counts, what is issued out, restocking shortlist, category breakdown, recent activity |
| **Search** | Type `1k resistor` and get **1K Ω Resistor → A2**. Understands `Ω` and `ohm`, part numbers like `LM35`, and bare bin codes like `D5` |
| **All components** | Sortable, filterable table of the whole register; one-click +/− on quantities |
| **Low stock** | Auto-built restocking list: out of stock, below minimum, and never counted |
| **Rack map** | Every bin from A1 to H4 plus the named boxes; click a bin to see its contents |
| **Issue & return** | Issue to a person and stock drops automatically; record the return and it goes back |
| **Activity log** | Every add, edit, issue and return, with who did it |
| **Add / update** | New-component form with duplicate warning, quick top-up of existing lines, and a bulk stock-take for a whole bin |
| **Settings** | Low-stock minimum per category, admin PIN, CSV export |

## Access model

Two roles, chosen on the landing screen:

- **Viewer** — search and read. No PIN needed.
- **Admin** — everything else. Requires the lab PIN.

The PIN is checked **on the server**, inside Apps Script, and is stored in Script
Properties. It is never present in the published front-end code.

One thing to be clear about: the web app has to be deployed as *Anyone*, because
a static page cannot complete a Google sign-in redirect. So anyone who has the
web-app URL can **read** the stock list. Writes are the part the PIN protects.
If you need reads locked down too, see "Tighter access" in [DEPLOY.md](DEPLOY.md).

## Repository layout

```
docs/                  the site — GitHub Pages serves this folder
  index.html           markup
  styles.css           all styling, light and dark themes
  app.js               application logic and the API client
  config.js            ← your Apps Script URL goes here
apps-script/
  Code.gs              the backend: sheet-backed JSON API
  appsscript.json      Apps Script manifest
data/
  inventory-seed.csv   380 components, ready to import into the Inventory sheet
  settings-seed.csv    starting low-stock minimums per category
DEPLOY.md              step-by-step setup
```

## Setup

Full walkthrough in [DEPLOY.md](DEPLOY.md). The short version:

1. Create a Google Sheet, open **Extensions → Apps Script**, paste `apps-script/Code.gs`.
2. Run `setupSheets()` once. It creates the four tabs and sets the starting PIN.
3. Import `data/inventory-seed.csv` into the **Inventory** tab.
4. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*. Copy the URL.
5. Paste that URL into `docs/config.js`.
6. Push this repo to GitHub and turn on Pages for the `docs/` folder on `main`.

Change the PIN from the Settings screen as soon as you are in.

## Data notes

Imported from the original spreadsheet register on 9 September 2026:

- Quantities written as `50+` were read as 50; the `approx` column marks them.
- Quantities written as `?` were left blank and show as **Not counted** — 46 items still need a physical count.
- Category spellings were unified (`RES.` / `RES` → `Resistor`, `CAP (SMD)` → `Capacitor` with the SMD flag set).
- Rows with no location went to `UNASSIGNED` so they stay visible.

## Browser support

Any current browser. No build step, no bundler, no dependencies — the three
files in `docs/` are the whole application. IBM Plex Sans and IBM Plex Mono load
from Google Fonts; the page falls back to system fonts if they are blocked.

## Licence

MIT — see [LICENSE](LICENSE).
