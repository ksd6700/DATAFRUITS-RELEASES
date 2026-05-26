const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "https://releases.datafruits.fm";
const DEFAULT_TSV_URL =
  process.env.DATAFRUITS_TSV_URL ||
  "https://docs.google.com/spreadsheets/d/1Ri22Wj-FmM0lK63KstmzFGFtE5XPIsvwbybxUFW7B_Q/edit?gid=0#gid=0";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const INITIAL_RENDER_COUNT = 36;
const pageCache = new Map();

const headerAliases = {
  catalog: ["catalog_id", "catalog ID", "catalog", "catalog_no", "catalogue", "cat", "id", "number", "品番"],
  artist: ["artist", "artists", "アーティスト", "artist_name"],
  title: ["title", "release", "album", "name", "リリース", "タイトル"],
  releaseDate: ["date", "release_date", "released", "発売日", "リリース日"],
  cover: ["image_url", "image URL", "image", "cover", "artwork", "jacket", "画像", "ジャケット"],
  url: ["url", "link", "bandcamp", "purchase", "listen", "リンク"],
  series: ["series", "series_name", "label", "collection", "シリーズ"],
  format: ["package", "format", "type", "フォーマット"],
  tags: ["tags", "tag", "genre", "genres", "タグ", "ジャンル"],
  description: ["description", "notes", "note", "memo", "説明", "メモ"],
  tracklist: ["track_list", "tracklist", "track list", "tracks", "曲目", "トラックリスト"],
  credit: ["credit", "credits", "liner_notes", "liner notes", "クレジット"],
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function parsePort() {
  const portArgIndex = process.argv.indexOf("--port");
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    return Number(process.argv[portArgIndex + 1]);
  }
  return Number(process.env.PORT || 8000);
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeLookupValue(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getField(row, key) {
  const names = headerAliases[key] || [key];
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseReleaseText(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^(DF|DV|DATAVEGETABLES)\s*0?(\d{1,3})\s*-\s*(.+)$/i);
  const catalog = match ? `${match[1].toUpperCase()}${String(match[2]).padStart(3, "0")}` : "";
  const rest = match ? match[3] : trimmed;
  const parts = rest.split(/\s+-\s+/);

  if (parts.length >= 2) {
    return {
      catalog,
      artist: parts.slice(0, -1).join(" - ").trim(),
      title: parts.at(-1).trim(),
    };
  }

  return { catalog, artist: "", title: rest };
}

function splitTags(value) {
  return String(value || "")
    .split(/[|,;]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function getCatalogNumber(catalog) {
  const match = String(catalog || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function parseReleaseDate(value) {
  const trimmed = String(value || "").trim();
  const dateOnly = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);

  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }

  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? undefined : new Date(time);
}

function getIsoDate(value) {
  const date = parseReleaseDate(value);
  if (!date) return undefined;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isWithinRecentDays(value, days) {
  const releaseDate = parseReleaseDate(value);
  if (!releaseDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - days);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return releaseDate >= cutoff && releaseDate < tomorrow;
}

function resolveUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed, PUBLIC_ORIGIN).href;
  } catch {
    return "";
  }
}

function getGoogleSheetGid(url) {
  return url.searchParams.get("gid") || url.hash.match(/gid=(\d+)/)?.[1] || "0";
}

function getGoogleSheetRange(url) {
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  return url.searchParams.get("range") || hashParams.get("range") || "";
}

function normalizeSourceUrl(source) {
  const trimmed = String(source || "").trim();
  if (!trimmed) return DEFAULT_TSV_URL;

  try {
    const url = new URL(trimmed, PUBLIC_ORIGIN);
    const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    if (url.hostname === "docs.google.com" && sheetMatch) {
      const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/export`);
      exportUrl.searchParams.set("format", "tsv");
      exportUrl.searchParams.set("gid", getGoogleSheetGid(url));
      const range = getGoogleSheetRange(url);
      if (range) {
        exportUrl.searchParams.set("range", range);
      }
      return exportUrl.href;
    }
    return url.href;
  } catch {
    return trimmed;
  }
}

function createTsvParser(onRecord) {
  let row = [];
  let field = "";
  let inQuotes = false;
  let lastWasCR = false;

  function pushField() {
    row.push(field);
    field = "";
  }

  function pushRow() {
    if (row.length === 1 && row[0].trim() === "") {
      row = [];
      return;
    }
    onRecord(row);
    row = [];
  }

  function push(chunk) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];

      if (lastWasCR && char === "\n") {
        lastWasCR = false;
        continue;
      }
      lastWasCR = false;

      if (inQuotes) {
        if (char === '"') {
          if (chunk[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"' && field === "") {
        inQuotes = true;
      } else if (char === "\t") {
        pushField();
      } else if (char === "\n") {
        pushField();
        pushRow();
      } else if (char === "\r") {
        pushField();
        pushRow();
        lastWasCR = true;
      } else {
        field += char;
      }
    }
  }

  function end() {
    if (field.length > 0 || row.length > 0) {
      pushField();
      pushRow();
    }
  }

  return { push, end };
}

function parseTsv(text) {
  const records = [];
  const parser = createTsvParser((record) => records.push(record));
  parser.push(text);
  parser.end();
  return records;
}

function rowToObject(headers, record) {
  return headers.reduce((row, header, index) => {
    row[normalizeHeader(header)] = record[index] ? String(record[index]).trim() : "";
    return row;
  }, {});
}

function normalizeRelease(row, index) {
  const combined = getField(row, "title");
  const parsed = parseReleaseText(combined);
  const catalog = getField(row, "catalog") || parsed.catalog || `ROW${String(index + 1).padStart(3, "0")}`;
  const artist = getField(row, "artist") || parsed.artist || "Unknown artist";
  const artistKey = normalizeLookupValue(artist);
  const title = getField(row, "title") && getField(row, "artist") ? getField(row, "title") : parsed.title;
  const releaseDate = getField(row, "releaseDate");
  const series = getField(row, "series");
  const tags = splitTags(getField(row, "tags"));
  const url = resolveUrl(getField(row, "url"));
  const cover = resolveUrl(getField(row, "cover"));
  const description = getField(row, "description");
  const format = getField(row, "format");
  const tracklist = getField(row, "tracklist");
  const credit = getField(row, "credit");
  const featured = isWithinRecentDays(releaseDate, 180);
  const catalogNumber = getCatalogNumber(catalog);
  const searchText = [catalog, artist, title, releaseDate, series, format, description, tracklist, credit, ...tags]
    .join(" ")
    .toLowerCase();

  return {
    id: `${catalog}-${index}`,
    index,
    catalog,
    catalogNumber,
    artist,
    artistKey,
    title: title || combined || catalog,
    releaseDate,
    cover,
    url,
    series,
    format,
    tags,
    description,
    featured,
    searchText,
  };
}

function getCoverHue(release) {
  let total = 0;
  for (const char of release.catalog + release.title) {
    total += char.charCodeAt(0);
  }
  return total % 360;
}

function getCoverMarkup(release) {
  const label = escapeHtml(release.catalog);
  const fallback = `<div class="cover-fallback" style="--cover-hue: ${getCoverHue(release)}"><span>${label}</span></div>`;
  if (release.cover) {
    return `<img src="${escapeHtml(release.cover)}" alt="${escapeHtml(`${release.title} jacket`)}" loading="lazy" decoding="async" onerror="this.remove();">${fallback}`;
  }
  return fallback;
}

function renderTags(tags) {
  if (!tags.length) return "";
  const items = tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join("");
  return `<ul class="tag-list" aria-label="tags">${items}</ul>`;
}

function renderCard(release) {
  const cover = `<div class="cover-wrap">${getCoverMarkup(release)}</div>`;
  const coverNode = release.url
    ? `<a class="cover-link" href="${escapeHtml(release.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(release.title)} in a new tab" title="Open release in a new tab">${cover}</a>`
    : `<div class="cover-static">${cover}</div>`;
  const newMark = release.featured ? '<img class="new-mark" src="./img/new.gif" alt="NEW" width="76" height="32">' : "";
  const date = release.releaseDate ? `<span>${escapeHtml(release.releaseDate)}</span>` : '<span aria-hidden="true">&nbsp;</span>';
  const format = release.format ? `<span>${escapeHtml(release.format)}</span>` : "";
  const detail = [date, format].filter((item) => item.trim() !== "").join(" / ");
  const description = release.description ? `<p class="release-detail">${escapeHtml(release.description)}</p>` : "";
  const seriesPill = release.series ? `<span class="pill">${escapeHtml(release.series)}</span>` : "";

  return `
    <article class="release-card">
      ${coverNode}
      <div class="release-body">
        <div class="meta-line">
          <span class="catalog-code">${escapeHtml(release.catalog)}</span>
          ${seriesPill}
          ${newMark}
        </div>
        <h2>${escapeHtml(release.title)}</h2>
        <p class="release-artist">${escapeHtml(release.artist)}</p>
        <p class="release-detail">${detail}</p>
        ${description}
        ${renderTags(release.tags)}
      </div>
    </article>
  `;
}

function renderReleaseItemList(releases) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "DATAFRUITS RELEASES catalog",
    itemListElement: releases.map((release, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "MusicAlbum",
        name: release.title,
        byArtist: {
          "@type": "MusicGroup",
          name: release.artist,
        },
        datePublished: getIsoDate(release.releaseDate),
        identifier: release.catalog,
        image: release.cover || undefined,
        url: release.url || `${PUBLIC_ORIGIN}/#${encodeURIComponent(release.catalog)}`,
      },
    })),
  };
}

async function loadTsvText(source) {
  const normalizedSource = normalizeSourceUrl(source);
  try {
    const response = await fetch(normalizedSource, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { source: normalizedSource, text: await response.text(), fallback: false };
  } catch (error) {
    const samplePath = path.join(ROOT, "data", "releases.sample.tsv");
    const text = await fs.readFile(samplePath, "utf8");
    console.warn(`TSV fetch failed (${error.message}); rendering local sample data.`);
    return { source: normalizedSource, text, fallback: true };
  }
}

async function loadCatalog(source) {
  const { source: normalizedSource, text, fallback } = await loadTsvText(source);
  const records = parseTsv(text);
  const headers = records[0] || [];
  const releases = records
    .slice(1)
    .map((record) => rowToObject(headers, record))
    .map((row, index) => normalizeRelease(row, index))
    .sort((a, b) => b.catalogNumber - a.catalogNumber || b.index - a.index);

  return { fallback, headers, releases, source: normalizedSource };
}

async function renderIndex(requestUrl) {
  const source = requestUrl.searchParams.get("src") || DEFAULT_TSV_URL;
  const cacheKey = normalizeSourceUrl(source);
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.html;
  }

  const template = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
  const catalog = await loadCatalog(source);
  const releaseCards = catalog.releases.map(renderCard).join("");
  const resultText = catalog.fallback
    ? `${catalog.releases.length} shown / local fallback loaded`
    : `${catalog.releases.length} shown / ${catalog.releases.length} loaded`;
  const ssrData = {
    generatedAt: new Date().toISOString(),
    headers: catalog.headers,
    loadedRows: catalog.releases.length,
    releases: catalog.releases,
    renderLimit: catalog.releases.length,
    source: catalog.source,
  };
  const ssrScript = [
    `    <script type="application/json" id="ssrReleaseData">${escapeJsonForHtml(ssrData)}</script>`,
  ].join("\n");
  const itemListScript = `    <script type="application/ld+json" id="releaseItemListJson">${escapeJsonForHtml(renderReleaseItemList(catalog.releases))}</script>`;

  const html = template
    .replace('<p id="resultsMeta">Waiting for TSV rows.</p>', `<p id="resultsMeta">${escapeHtml(resultText)}</p>`)
    .replace('<section id="releaseGrid" class="release-grid" aria-label="release list"></section>', `<section id="releaseGrid" class="release-grid" aria-label="release list">${releaseCards}</section>`)
    .replace('<script type="module" src="./app.js"></script>', `${ssrScript}\n    <script type="module" src="./app.js"></script>`)
    .replace("</head>", `${itemListScript}\n  </head>`);

  pageCache.set(cacheKey, { createdAt: Date.now(), html });
  return html;
}

function send(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Cache-Control": contentType.startsWith("text/html") ? "public, max-age=30, stale-while-revalidate=60" : "public, max-age=31536000, immutable",
    "Content-Type": contentType,
  });
  response.end(body);
}

async function serveStatic(pathname, response) {
  const cleanPath = pathname.replace(/^\/+/, "") || "index.html";
  const filePath = path.normalize(path.join(ROOT, cleanPath));
  if (!filePath.startsWith(ROOT)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    send(response, 200, content, contentType);
  } catch {
    send(response, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, PUBLIC_ORIGIN);
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      const html = await renderIndex(requestUrl);
      send(response, 200, request.method === "HEAD" ? "" : html, "text/html; charset=utf-8");
      return;
    }

    await serveStatic(requestUrl.pathname, response);
  } catch (error) {
    console.error(error);
    send(response, 500, "Internal server error", "text/plain; charset=utf-8");
  }
});

server.listen(parsePort(), () => {
  const address = server.address();
  console.log(`DATAFRUITS RELEASES SSR listening on http://127.0.0.1:${address.port}/`);
});
