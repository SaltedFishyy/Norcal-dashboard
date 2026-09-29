# GOFO NC Network Ops Console

Single static site: network operations map + analytics subpages + repo-driven price sheet.

```
index.html                     Network map (main page)
analytics/w27-pickup.html      W27 driver pickup analysis (subweb, linked from map sidebar)
data/price_adjustments.csv     Price sheet — edit this file to adjust ZIP prices
README.md
```

## Deploy once → get a shareable link (GitHub Pages)

1. Create a new repository on github.com (e.g. `nc-ops-console`). Private repos need GitHub Pro for Pages; public works on the free plan.
2. Upload everything in this folder to the repo root (drag-and-drop on github.com works: Add file → Upload files → commit).
3. In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: main, folder: / (root) → Save**.
4. After ~1 minute your shareable link is live:
   `https://<your-username>.github.io/nc-ops-console/`
   The W27 analysis is at `.../analytics/w27-pickup.html` and is also linked from the map sidebar.

Anyone with the link sees the same data. Bookmark/save the link — it stays stable across updates.

## Updating prices (the "run it" workflow)

`data/price_adjustments.csv` currently holds the full baseline (443 ZIPs, columns: `zip,price,station,route` — only the first two columns are read; station/route are reference only).

1. Edit prices in the CSV (Excel is fine — keep it saved as CSV).
2. Commit the file to the repo (on github.com: open the file → pencil icon → paste/edit → Commit, or replace via Upload files).
3. GitHub Pages redeploys automatically in ~1 minute. Everyone opening the shared link sees the new prices — ZIP colors, station/route/DSP average prices, and rankings all recompute on load.

The map sidebar shows a status line: how many ZIPs loaded and how many differ from the base data.

## Local preview before publishing

In the map sidebar, **Upload adjustment CSV (local preview)** applies a sheet only in your own browser (amber status). Use it to sanity-check an adjustment before committing. "Clear local preview" reverts. Nothing is published until you commit the CSV to the repo.

Note: opening index.html directly from disk (file://) can't auto-load the repo CSV due to browser security — the upload-preview button still works. On the GitHub Pages link everything works.

## Adding future analytics subpages

Drop new HTML files into `analytics/` and add a link in the map sidebar next to the existing one (search for `subweb-link` in index.html).
