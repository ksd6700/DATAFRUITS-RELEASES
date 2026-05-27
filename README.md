# DATAFRUITS RELEASES TSV site

Node.js SSR catalog for `https://releases.datafruits.fm/`.

## Run locally

Build the static site:

```sh
npm run build:ssg
```

The generated site is written to `dist/`.

SSR mode:

```sh
node server.js
```

Open `http://127.0.0.1:8000/`.

Static fallback mode:

```sh
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

## SEO and SSR

`server.js` fetches the Google Sheets TSV on the server, renders release cards into the first HTML response, and injects the same normalized release data for `app.js` to hydrate. This avoids an empty client-only catalog for crawlers while preserving search, filtering, lazy rendering, hover effects, and 60-second refreshes in the browser.

If the spreadsheet fetch fails at render time, the server falls back to `data/releases.sample.tsv` instead of serving an empty page.

## Static generation

`npm run build:ssg` uses the same server-side renderer to write `dist/index.html` with the current spreadsheet data already embedded. The browser still checks the spreadsheet every 60 seconds after load, so visitors can see fresh sheet updates even if the generated HTML is from the last build.

`.github/workflows/deploy-ssg.yml` builds and deploys `dist/` to GitHub Pages:

- automatically on pushes to `main`
- hourly via GitHub Actions schedule
- manually from the workflow's **Run workflow** button

Set GitHub Pages to use **GitHub Actions** as the source. The build writes `dist/CNAME` as `releases.datafruits.fm`; override that with `PAGES_CNAME` if needed.

## Spreadsheet feed

The page streams TSV from a URL. Use either:

```text
?src=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2F...%2Fedit%3Fgid%3D0%23gid%3D0
```

or set this in `index.html`:

```html
<script>
  window.DATAFRUITS_TSV_URL = "https://docs.google.com/spreadsheets/d/.../edit?gid=0#gid=0";
</script>
```

For production SSR, the same feed can also be configured with environment variables:

```sh
DATAFRUITS_TSV_URL="https://docs.google.com/spreadsheets/d/.../edit?gid=0#gid=0" \
PUBLIC_ORIGIN="https://releases.datafruits.fm" \
PORT=8000 \
node server.js
```

Recommended columns:

```text
catalog ID	artist	title	link	image URL	date	Series	Package	Track List	Credit
```

Column aliases are accepted for common names such as `catalog`, `cover`, `artwork`, `jacket`, `image`, `url`, `bandcamp`, `format`, `genre`, `genres`, `released`, and Japanese labels like `品番`, `アーティスト`, `タイトル`, `発売日`, `ジャケット`.

`image URL` should be a public image URL or a relative image path. If it is blank or fails to load, the site renders a generated catalog jacket.

Google Sheets edit URLs are converted to TSV export URLs automatically. The app checks the spreadsheet again every 60 seconds, reads the full TSV feed, then renders the catalog progressively: the first 36 cards appear immediately and more cards are appended as the visitor scrolls. Images use native lazy loading.

Artist filter options are read from the configured artist-list sheet (`window.DATAFRUITS_ARTISTS_URL`). The first row named `Sorted Artist` is skipped. `Various Artists` is pinned under `All artists`, followed by a separator line, then the rest of the artist list.

Releases dated within the last 180 days show `img/new.gif` as the NEW mark.

The masthead also uses a small decorative layer of GIFs from DATAFRUITS wiki pages. Their positions are randomized on each load and move lightly on scroll for a parallax feel.
