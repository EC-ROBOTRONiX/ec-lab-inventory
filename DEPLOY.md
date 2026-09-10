# Deploying EC Lab Inventory

Two halves: the **backend** (a Google Sheet plus an Apps Script web app) and the
**front end** (three static files on GitHub Pages). Budget about twenty minutes
the first time.

---

## Part 1 — The Google Sheet backend

### 1. Create the spreadsheet

Go to <https://sheets.new> while signed in as the lab account and name it
**EC Lab Inventory DB**. This spreadsheet is the database; everything the app
stores ends up here, and you can always open it and read or fix a row by hand.

### 2. Add the script

**Extensions → Apps Script**. Delete the `myFunction` stub, paste the entire
contents of `apps-script/Code.gs`, and save (Ctrl+S). Name the project
**EC Lab Inventory API**.

### 3. Create the tabs

In the Apps Script editor pick **setupSheets** from the function dropdown and
press **Run**.

The first run asks for authorisation. Google shows "Google hasn't verified this
app" — that is expected for a script you wrote yourself. Choose **Advanced →
Go to EC Lab Inventory API (unsafe)** and allow it. You are granting your own
script access to your own spreadsheet.

When it finishes, the spreadsheet has four tabs — `Inventory`, `Issues`,
`Activity`, `Settings` — and a dialog shows the starting admin PIN (`EC2580`).

### 4. Load the 380 components

Back in the spreadsheet:

1. Click the **Inventory** tab.
2. **File → Import → Upload**, choose `data/inventory-seed.csv`.
3. Import location: **Replace current sheet**. Separator: **Comma**.
4. Set "Convert text to numbers, dates and formulas" to **No** — this keeps IDs
   and timestamps as plain text.

Do the same for `data/settings-seed.csv` into the **Settings** tab if you want
the category minimums preloaded.

Check that row 1 still reads `id, name, type, smd, place, qty, min, approx,
unknown, updatedAt, updatedBy`. The script matches columns by position, so the
header row must stay exactly as it is.

### 5. Publish the API

In the Apps Script editor: **Deploy → New deployment → ⚙ → Web app**.

| Field | Value |
| --- | --- |
| Description | `v1` |
| Execute as | **Me** (your lab account) |
| Who has access | **Anyone** |

Press **Deploy** and copy the **Web app URL**. It looks like:

```
https://script.google.com/macros/s/AKfycbx…/exec
```

Why *Anyone*: a static page on GitHub Pages cannot complete Google's sign-in
redirect, so "Anyone with a Google account" would break every request. *Execute
as: Me* means the script touches only your spreadsheet, and every write is
gated by the PIN inside the script.

Paste the URL into a browser tab to check it — you should see a wall of JSON
starting with `{"ok":true,...`.

---

## Part 2 — The front end

### 6. Point the page at your API

Open `docs/config.js` and replace the placeholder:

```js
window.EC_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/AKfycbx…/exec",
  labName: "EC Lab"
};
```

### 7. Test it locally first

From the repository root:

```bash
python -m http.server 8000 --directory docs
```

Open <http://localhost:8000>. You should get the sign-in screen with
"380 components loaded from the lab sheet" underneath. Sign in as admin with
the PIN and change a quantity — then look at the spreadsheet and watch the row
update.

Opening `index.html` by double-clicking will **not** work: browsers block
`fetch` from `file://` pages. Use the command above.

### 8. Push to GitHub

```bash
cd ec-lab-inventory
git init
git add .
git commit -m "EC Lab inventory system"
git branch -M main
git remote add origin https://github.com/<your-username>/ec-lab-inventory.git
git push -u origin main
```

### 9. Turn on GitHub Pages

In the repository: **Settings → Pages**.

- Source: **Deploy from a branch**
- Branch: **main**, folder: **/docs**
- Save.

A minute later the site is live at
`https://<your-username>.github.io/ec-lab-inventory/`.

### 10. Change the PIN

Sign in as admin, open **Settings**, set a new PIN. It is stored server-side in
Script Properties, so it takes effect immediately for everyone.

---

## Updating the script later

Edit `Code.gs`, save, then **Deploy → Manage deployments → ✏️ → Version: New
version → Deploy**. The URL stays the same. If you create a *new deployment*
instead, you get a new URL and have to update `config.js`.

## Tighter access

The default setup leaves reads open to anyone holding the URL. Two ways to
narrow that:

- **Keep the URL private.** Do not put the Pages link in a public README or
  README badge, and keep the repository private (Pages works on private repos
  for GitHub Free on personal accounts only for public repos — check your plan).
- **Require a viewer PIN as well.** In `Code.gs`, add a check in `doGet` that
  compares `e.parameter.key` against a second Script Property, and append
  `&key=…` to the URL in `apiGet()`. This stops casual access, though the key is
  then visible in `config.js`.

For real per-user accounts you would move the backend to something with proper
auth (Supabase, Firebase). That is a bigger change than this project needs.

## Troubleshooting

**"Could not reach the lab sheet"**
The URL in `config.js` is wrong, or the deployment is not set to *Anyone*.
Open the URL directly — if you see a Google sign-in page instead of JSON, fix
the access setting and redeploy.

**Writes fail but reads work**
Wrong PIN, or the deployment is set to *Execute as: User accessing the web app*.
It must be *Me*.

**Changes do not appear for other people**
The page re-reads the sheet every 60 seconds and on tab focus. Press the Sync
button in the top bar to force it.

**A component shows the wrong quantity after issuing**
Open the `Issues` tab. An issue row with `status = open` is still counted as
out. Set its `status` to `returned` by hand if a record was created in error.

**`setupSheets()` says a sheet is missing**
Run it again — it only creates what is absent and never clears existing rows.

## Backups

The spreadsheet is the database, so **File → Version history** is your backup
and rollback. For a copy outside Google, use **Settings → Full inventory CSV**
in the app, or **File → Download → Microsoft Excel** on the sheet.
