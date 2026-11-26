# Folio

A PDF reader for phones. Instead of showing tiny fixed pages, Folio re-lays each
PDF out for the screen it is on:

- **Text reflows** into a single readable column with adjustable size, font and theme.
- **Tables become cards** (one card per row, column headers as labels); small numeric
  tables stay as tables.
- **Figures and diagrams** are scaled to the screen width; tap one to pinch-zoom it.
- **Callout boxes, lists and headings** are detected and restyled; running headers,
  footers and page numbers are dropped.
- **Your place is saved** continuously and restored when you come back, per document.
- A **Contents** list is built from the headings, and an **Original pages** view is
  one tap away if you want to see the PDF as it was designed.

Everything runs in the browser. PDFs are stored on the device (IndexedDB) and are
never uploaded anywhere. Once loaded, the app works offline.

## Put it on your phone

Folio is a static site with no build step, so any static host works. With GitHub Pages:

1. In the repository, open **Settings > Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch
   that contains this code and the `/ (root)` folder, then save.
3. After a minute the site is live at `https://<user>.github.io/<repo>/`.

Then add it to the home screen:

- **iPhone / iPad (Safari):** Share button > **Add to Home Screen**.
- **Android (Chrome):** menu > **Add to Home screen** / **Install app**.

It opens full screen like an app and reopens the document you were reading at the
place you stopped.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(A server is needed because the app uses ES modules and a service worker.)

## How it works

| File | Role |
| --- | --- |
| `js/reflow.js` | The reflow engine. Reads each page's text and drawing commands through pdf.js and turns them into blocks: headings, paragraphs, list items, callouts, tables, figures. Handles multi-column pages with a recursive XY-cut. |
| `js/app.js` | Library, reader, reading-position tracking, settings, image viewer. |
| `js/store.js` | IndexedDB (PDFs and parsed layouts) and localStorage (position, settings). |
| `sw.js` | Service worker for offline use. |
| `vendor/pdfjs/` | pdf.js 4.10 (Apache 2.0), vendored. |

## Limits

- Reflow is heuristic. Tables without ruled lines are read row by row as text, and
  complex layouts can come out imperfect; the Original pages view is the fallback.
- Scanned PDFs without a text layer are shown as page images.
- Password-protected PDFs are not supported.
