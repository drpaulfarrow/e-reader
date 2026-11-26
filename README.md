# Folio

A document reader for phones. It opens **PDF, EPUB, Markdown and HTML** files and
lays each one out for the screen it is on, instead of showing tiny fixed pages:

- **Text reflows** into a single readable column with adjustable size, font and theme.
- **Tables become cards** (one card per row, column headers as labels); small numeric
  tables stay as tables.
- **Figures and diagrams** are scaled to the screen width; tap one to pinch-zoom it.
- **Callout boxes, lists and headings** are detected and restyled; running headers,
  footers and page numbers are dropped.
- **Your place is saved** continuously and restored when you come back, per document.
- A **Contents** list is built from the headings, and an **Original pages** view is
  one tap away if you want to see the PDF as it was designed.

The reflowing happens in the browser, and the app works offline once loaded.
PDFs are kept on the device and, when Folio is hosted with its server (below),
also on that server so your library and reading position follow you across devices.

## Host it on Fly.io (uploads and sync)

`server.js` serves the app and stores uploaded PDFs, the library and reading
positions on a Fly volume, behind a single password. It has no dependencies.

```sh
fly launch --copy-config --no-deploy     # pick an app name and region; keep the existing fly.toml
fly volumes create folio_data --size 1   # 1 GB for PDFs, in the same region
fly secrets set FOLIO_PASSWORD='choose-a-long-password'
fly deploy
```

Open `https://<app-name>.fly.dev` on your phone, enter the password once, then add
it to the home screen:

- **iPhone / iPad (Safari):** Share button > **Add to Home Screen**.
- **Android (Chrome):** menu > **Add to Home screen** / **Install app**.

Notes:

- Without `FOLIO_PASSWORD` the server refuses all uploads and downloads.
- The machine stops when idle and starts on the next request, so the first load
  after a break takes a couple of seconds.
- The volume lives on one machine: keep the app at a single machine
  (`fly scale count 1`).

## Static hosting (no uploads)

The app also runs from any static host such as GitHub Pages (Settings > Pages >
Deploy from a branch > this branch, `/ (root)`). PDFs then stay on each device
and nothing is synced.

## Run locally

```sh
FOLIO_PASSWORD=dev node server.js      # with uploads and sync, http://localhost:8080
python3 -m http.server 8000            # static only, http://localhost:8000
```

(A server is needed because the app uses ES modules and a service worker.)

## How it works

| File | Role |
| --- | --- |
| `js/reflow.js` | The reflow engine. Reads each page's text and drawing commands through pdf.js and turns them into blocks: headings, paragraphs, list items, callouts, tables, figures. Handles multi-column pages with a recursive XY-cut. |
| `js/app.js` | Library, reader, reading-position tracking, settings, image viewer. |
| `js/formats.js` | Markdown, HTML and EPUB input. These formats already carry their structure, so they are converted directly into the same blocks (own Markdown parser, EPUB unzipped in the browser, all HTML sanitised through an allowlist). |
| `js/store.js` | IndexedDB (PDFs and parsed layouts) and localStorage (position, settings). |
| `js/sync.js` | Talks to the server when there is one: uploads, downloads, position sync. |
| `server.js` | Zero-dependency Node server: static files plus a small password-protected API storing PDFs on disk. |
| `sw.js` | Service worker for offline use. |
| `vendor/pdfjs/` | pdf.js 4.10 (Apache 2.0), vendored. |

## Which format to use

PDF describes ink on a page, so Folio has to infer headings, tables and reading
order. Markdown and EPUB state their structure outright and come out exact. If a
document is being generated for reading here (for example by an AI assistant),
ask for Markdown; use EPUB for full books.

## Limits

- EPUB styling is simplified to the reader's own (bold and italic are kept), internal
  cross-references are not links, and copy-protected (DRM) books cannot be opened.
- Markdown images must be web URLs or embedded data URIs; relative image paths are skipped.

- Reflow is heuristic. Tables without ruled lines are read row by row as text, and
  complex layouts can come out imperfect; the Original pages view is the fallback.
- Scanned PDFs without a text layer are shown as page images.
- Password-protected PDFs are not supported.
