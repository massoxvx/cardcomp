# CardComp

TCG collection tracker + market comps + offer pricer for serious collectors and flippers.

## Features

- **Collection** — Track cards with live market values and real after-fee liquidation prices
- **Search** — TCGPlayer, eBay sold data, PSA/BGS/CGC grades, price history, Grade ROI calculator
- **Pricer** — Build offers with percentage slider, bulk lines, printable offer sheets, Show Mode for card shows

## Stack

- Pure frontend (HTML + CSS + vanilla JS)
- Chart.js for price history
- External price API (see `WORKER_URL` in `app.js`)
- Data stored in browser localStorage

## Local development

Just open `index.html` in a browser, or use a simple local server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Project structure

```
index.html   — page structure & markup
styles.css   — all styles
app.js       — application logic
```

## Notes

This is a cleaned-up split of the v7 single-file prototype.  
Next priorities: search precision improvements, further code organization, and deployment.
