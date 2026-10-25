# Money Log

A personal money tracker with two parts: a **Spend Logger** for credit card spending and an **Investment Logger** that shows where each month's income goes. It is a static PWA: plain HTML, CSS and JavaScript with no framework, no build step and no backend. It installs to your phone's home screen and works fully offline.

The app opens on a landing page with two big buttons, one for each logger. Each button shows a one-line summary of the current cycle or month. Use **‹** at the top, or the phone's back button, to return to the landing page.

**Your data never leaves your phone.** Everything is stored in the browser's `localStorage` on the device. Nothing is sent anywhere, and nothing personal is in this repo. Use **Settings → Backup** to export a JSON file now and then.

## Investment Logger

A simple record of each calendar month: money in, and how much of it went into investments and savings.

- **Entry types:** each entry is **Income** (e.g. Salary ₹2,50,000), **Investment** (e.g. Groww SIP ₹80,000, IndMoney ₹50,000) or **Savings** (e.g. FD, RD, emergency fund).
- **Month summary:** total income, with a split bar and the amount and percentage invested, saved, and left for spending. A pill shows the share of income put away.
- **"From last month" chips:** last month's entries that aren't logged yet this month. Tap one to log it again, or use **Add all**. Every log has an undo toast.
- **Add sheet:** pick a type, then a name (suggestions include names you've used before). Choosing a name you've used before fills in its last amount. A hint under the amount shows it in lakh, e.g. ₹2.5L.
- **Charts and totals:** a 6-month bar chart (income, with invested and saved stacked inside) and totals for the Indian financial year (Apr–Mar) so far.
- **Editing:** tap an entry to edit or delete it.

## Spend Logger features

- **Billing cycle from the 19th to the 18th.** The app picks the current cycle from today's date. Use ‹ › to look at past cycles, and tap the cycle name to jump back to the current one.
- **Bill meter:** "₹X of ₹22,000", where X includes fixed costs that haven't been charged yet.
- **Projection:** fixed costs + (variable spend ÷ days elapsed × days in cycle). It shows green at or below 90% of budget, amber up to 100%, and red above.
- **Daily allowance:** (budget − spent − uncharged fixed costs) ÷ days left.
- **Small-spend counter:** the count and total of transactions under ₹200.
- **Quick-add presets:** tap to log the preset, or hold to change the amount first. An undo toast appears after each log.
- **Category bars:** amber at 75% of the category budget, red at 100%.
- **Pause screen** for anything ₹1,000 or more: "This is X days of your daily allowance. Still buy?"
- **Fixed costs** (one-time or recurring) count from day one of their cycle. Tap **Mark charged** on Home when one shows up on the card. This logs the actual amount and replaces the expected one.
- **History:** tap a transaction to edit or delete it. Enter the statement total to see "Logged ₹A vs Statement ₹B, gap ₹C". A 6-cycle bar chart is drawn in inline SVG.
- **Import from statement** (History tab) logs past spends from statement screenshots:
  1. Tap **Copy prompt**. The prompt lists your current category names, so Claude uses exactly those.
  2. Paste the prompt into a Claude chat along with your statement screenshots.
  3. Copy Claude's table, using the copy button on the reply or by selecting the table. Paste it into the box.
  4. Review the rows. Rows matching an expense you've already logged (same date and amount) are unticked. Unknown categories are flagged, and you can change any category.
  5. Tap **Import**. Refunds come in as negative amounts. An imported EMI that matches a pending fixed cost marks that cost as charged. If Claude includes the `STATEMENT_TOTAL` line, the reconcile total is filled in too. You can undo the whole import.

  The importer reads markdown tables, tab-separated text and CSV. Dates can be YYYY-MM-DD, DD/MM/YYYY or "25 Oct 2026".
- **Settings:** monthly budget, theme, categories, presets, fixed costs, and JSON export/import. A banner reminds you when your last backup is more than 14 days old.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, landing page, dialogs, tab bar |
| `app.js` | Landing page, screen switching, Spend Logger, backup (split into numbered sections) |
| `invest.js` | Investment Logger |
| `statement-import.js` | Paste-a-table statement import and the Claude prompt |
| `styles.css` | Mobile-first styles, light/dark themes |
| `manifest.json` | PWA install metadata |
| `service-worker.js` | Offline caching |
| `icons/` | App icons (192, 512, maskable 512, Apple touch 180) |

## Run locally

A service worker needs `http://localhost` or HTTPS. Opening the file directly with `file://` won't work. From the project folder, run:

```bash
python -m http.server 8080
```

Then open http://localhost:8080.

## Deploy to GitHub Pages

1. Create a new **public** repository on GitHub, for example `spend-logger`. Don't add a README from GitHub, because this folder already has one.
2. Push this folder to it:

   ```bash
   git init
   ```
   ```bash
   git add .
   ```
   ```bash
   git commit -m "Spend Logger PWA"
   ```
   ```bash
   git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/<your-username>/spend-logger.git
   ```
   ```bash
   git push -u origin main
   ```

3. On GitHub, open the repo and go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to `main`, and the folder to `/ (root)`. Click **Save**.
5. Wait a minute or two. The site will be live at `https://<your-username>.github.io/spend-logger/`.
6. Install it on your phone:
   - **Android (Chrome):** open the URL, then use ⋮ → **Add to Home screen** (or **Install app**).
   - **iPhone (Safari):** open the URL, then use Share → **Add to Home Screen**.
7. Open the installed app once while you're online. After that it works offline.

All paths in the app are relative, so it works from the `/spend-logger/` sub-path without any configuration.

### Updating

Push your changes. The service worker serves the cached version first and fetches updates in the background, so **close and reopen the app once** to see a new version. If you add or rename files, add them to `ASSETS` in `service-worker.js` and bump `CACHE_VERSION`.

## Keeping data safe

- `localStorage` belongs to the browser and site. Uninstalling the app or clearing site data **deletes everything**, so export a backup regularly. The app reminds you after 14 days.
- On Android, **Share…** sends the backup straight to Google Drive, email and so on. **Export JSON** downloads it.
- One backup file holds both loggers. You can export and import from the landing page or from Spend Logger → Settings.
- To restore, use **Import** and pick the JSON file. This replaces all current data. An older backup with no investment data leaves your investment entries as they are.
- `.gitignore` excludes `*backup*.json` so a backup can't be committed to the public repo by accident.
- The app's data lives under the GitHub Pages URL. If you rename the repo or change the URL, export first and import again at the new address.

## Customising

These constants are at the top of `app.js`:

```js
const CYCLE_START_DAY = 19;       // cycle runs 19th → 18th
const SMALL_SPEND_LIMIT = 200;
const PAUSE_THRESHOLD = 1000;
const BACKUP_REMINDER_DAYS = 14;
```

Default categories, presets and fixed costs are in `defaultState()`. They are only used on first run. After that, edit them in Settings.
