# sleep-view

A privacy-first, fully client-side sleep-data visualizer for GitHub Pages.

## What it does

- Accepts `.zip` / `.oscar` archives in the browser.
- Detects and parses practical OSCAR-compatible formats:
  - OSCAR profile backup bundles containing SQL payloads (`manifest.json` + `database/**/*.sql`)
  - Generic SQL-only bundles with OSCAR-style `INSERT INTO ... VALUES ...` statements
  - CSV-based ZIP exports (fallback parser)
- Translates parsed records into a normalized in-memory model for trends and metrics.
- Renders interactive charts (nightly trends, event distribution, machine mix).

## Privacy model

- No backend, no auth, no database, no uploads.
- Data is parsed in memory in your browser session only.
- Suitable for static hosting on GitHub Pages.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The Vite `base` is configured for GitHub Pages deployment at `/sleep-view/` in production builds.
