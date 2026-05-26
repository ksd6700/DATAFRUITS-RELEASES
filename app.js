const DEFAULT_SOURCE = new URL("./data/releases.sample.tsv", window.location.href).href;
const SOURCE_PARAM = new URLSearchParams(window.location.search).get("src");
const CONFIGURED_SOURCE = window.DATAFRUITS_TSV_URL && window.DATAFRUITS_TSV_URL.trim();
const CONFIGURED_ARTISTS_SOURCE = window.DATAFRUITS_ARTISTS_URL && window.DATAFRUITS_ARTISTS_URL.trim();
const INITIAL_RENDER_COUNT = 36;
const RENDER_CHUNK_SIZE = 24;
const AUTO_REFRESH_INTERVAL_MS = 60_000;
const WIKI_GIF_BASE_URL = "https://datafruits.fm/assets/images/emojis/";
const WIKI_GIF_SOURCES = [
  "grumby.gif",
  "grumby_spin.gif",
  "alligottadoisfindthemustard.gif",
  "lemoner.gif",
  "greasyhotdogs.gif",
  "strawbur.gif",
  "orangey.gif",
  "banaynay.gif",
  "watermel.gif",
  "cabbage.gif",
  "datafruits.gif",
  "jambox.gif",
  "viz.gif",
  "garf.gif",
  "thisisamazing.gif",
].map((fileName) => `${WIKI_GIF_BASE_URL}${fileName}`);
const WIKI_GIF_COUNT = 12;
const WIKI_GIF_ZONES = [
  { x: [-2, 14], y: [8, 78] },
  { x: [84, 98], y: [8, 78] },
  { x: [18, 76], y: [2, 20] },
  { x: [3, 38], y: [72, 90] },
  { x: [56, 94], y: [70, 90] },
];

const elements = {
  wikiGifDecorations: document.querySelector("#wikiGifDecorations"),
  toolbar: document.querySelector("#releaseToolbar"),
  searchInput: document.querySelector("#searchInput"),
  seriesFilter: document.querySelector("#seriesFilter"),
  artistFilter: document.querySelector("#artistFilter"),
  gridViewButton: document.querySelector("#gridViewButton"),
  listViewButton: document.querySelector("#listViewButton"),
  releaseGrid: document.querySelector("#releaseGrid"),
  loadSentinel: document.querySelector("#loadSentinel"),
  resultsMeta: document.querySelector("#resultsMeta"),
  emptyTemplate: document.querySelector("#emptyTemplate"),
};

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

const state = {
  source: SOURCE_PARAM || CONFIGURED_SOURCE || DEFAULT_SOURCE,
  headers: [],
  releases: [],
  artists: [],
  query: "",
  series: "all",
  artist: "all",
  view: window.localStorage.getItem("datafruits:view") || "grid",
  loadedRows: 0,
  renderLimit: INITIAL_RENDER_COUNT,
  isLoading: false,
};

let currentAbortController;
let currentArtistsAbortController;
let renderHandle;
let loadObserver;
let autoRefreshTimer;
let wikiGifFrame;

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
    return new URL(trimmed, window.location.href).href;
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
  if (!trimmed) return DEFAULT_SOURCE;

  try {
    const url = new URL(trimmed, window.location.href);
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

function addCacheBuster(source) {
  try {
    const url = new URL(source, window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.searchParams.set("_", String(Date.now()));
      return url.href;
    }
  } catch {
    return source;
  }
  return source;
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

function rowToObject(headers, record) {
  return headers.reduce((row, header, index) => {
    row[normalizeHeader(header)] = record[index] ? String(record[index]).trim() : "";
    return row;
  }, {});
}

function scheduleRender() {
  if (renderHandle) return;
  renderHandle = window.requestAnimationFrame(() => {
    renderHandle = undefined;
    render();
  });
}

function setStatus(message) {
  document.documentElement.dataset.sourceStatus = message;
}

function formatRefreshTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setView(view) {
  state.view = view;
  window.localStorage.setItem("datafruits:view", view);
  elements.gridViewButton.setAttribute("aria-pressed", String(view === "grid"));
  elements.listViewButton.setAttribute("aria-pressed", String(view === "list"));
  elements.releaseGrid.classList.toggle("is-list", view === "list");
}

function getFilteredReleases() {
  const query = state.query.trim().toLowerCase();
  const filtered = state.releases.filter((release) => {
    const matchesQuery = !query || release.searchText.includes(query);
    const matchesSeries = state.series === "all" || release.series === state.series;
    const matchesArtist = state.artist === "all" || release.artistKey === state.artist;
    return matchesQuery && matchesSeries && matchesArtist;
  });

  return filtered.sort((a, b) => b.catalogNumber - a.catalogNumber || b.index - a.index);
}

function getCoverHue(release) {
  let total = 0;
  for (const char of release.catalog + release.title) {
    total += char.charCodeAt(0);
  }
  return total % 360;
}

function getReleaseTime(release) {
  return parseReleaseDate(release.releaseDate)?.getTime() || 0;
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

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function shuffle(values) {
  return values
    .map((value) => ({ value, rank: Math.random() }))
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.value);
}

function createWikiGifLayout(index) {
  const zone = WIKI_GIF_ZONES[index % WIKI_GIF_ZONES.length];
  return {
    depth: randomBetween(-0.08, 0.16),
    left: randomBetween(zone.x[0], zone.x[1]),
    rotate: `${randomBetween(-14, 14).toFixed(2)}deg`,
    size: Math.round(randomBetween(54, 106)),
    top: randomBetween(zone.y[0], zone.y[1]),
    delay: `${randomBetween(-4.6, -0.1).toFixed(2)}s`,
  };
}

function getWikiGifStyle(layout) {
  const rules = [
    `--wiki-gif-size: ${layout.size}px`,
    `--wiki-gif-delay: ${layout.delay}`,
    `top: ${layout.top.toFixed(2)}%`,
    `left: ${layout.left.toFixed(2)}%`,
  ];
  return rules.join("; ");
}

function renderWikiGifDecorations() {
  if (!elements.wikiGifDecorations) return;
  const sources = shuffle(WIKI_GIF_SOURCES).slice(0, WIKI_GIF_COUNT);
  const sprites = sources.map((src, index) => {
    const layout = createWikiGifLayout(index);
    return `
      <span
        class="wiki-gif-sprite"
        data-depth="${layout.depth}"
        data-rotate="${escapeHtml(layout.rotate)}"
        style="${escapeHtml(getWikiGifStyle(layout))}"
      >
        <img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" draggable="false">
      </span>
    `;
  }).join("");
  elements.wikiGifDecorations.innerHTML = sprites;
}

function updateWikiGifParallax() {
  if (!elements.wikiGifDecorations) return;
  const scrollY = window.scrollY || 0;
  elements.wikiGifDecorations.querySelectorAll(".wiki-gif-sprite").forEach((sprite) => {
    const depth = Number(sprite.dataset.depth || 0);
    const rotate = sprite.dataset.rotate || "0deg";
    sprite.style.transform = `translate3d(0, ${scrollY * depth}px, 0) rotate(${rotate})`;
  });
}

function scheduleWikiGifParallax() {
  if (wikiGifFrame) return;
  wikiGifFrame = window.requestAnimationFrame(() => {
    wikiGifFrame = undefined;
    updateWikiGifParallax();
  });
}

function setupWikiGifDecorations() {
  if (!elements.wikiGifDecorations) return;
  renderWikiGifDecorations();

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!motionQuery.matches) {
    updateWikiGifParallax();
    window.addEventListener("scroll", scheduleWikiGifParallax, { passive: true });
  }
  window.addEventListener("resize", scheduleWikiGifParallax);
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

function renderSeriesOptions() {
  const seriesList = Array.from(new Set(state.releases.map((release) => release.series).filter(Boolean))).sort();
  const previous = state.series;
  elements.seriesFilter.innerHTML = [
    '<option value="all">All series</option>',
    ...seriesList.map((series) => `<option value="${escapeHtml(series)}">${escapeHtml(series)}</option>`),
  ].join("");
  state.series = seriesList.includes(previous) ? previous : "all";
  elements.seriesFilter.value = state.series;
}

function getArtistLabel(artist) {
  const normalized = normalizeLookupValue(artist);
  if (normalized === "various artists") return "Various Artists";
  return artist;
}

function renderArtistOptions() {
  const previous = state.artist;
  const artistMap = new Map();

  for (const artist of state.artists) {
    const key = normalizeLookupValue(artist);
    if (key && key !== "sorted artist" && !artistMap.has(key)) {
      artistMap.set(key, getArtistLabel(artist));
    }
  }

  if (!artistMap.size) {
    for (const release of state.releases) {
      if (release.artistKey && !artistMap.has(release.artistKey)) {
        artistMap.set(release.artistKey, release.artist);
      }
    }
  }

  const entries = Array.from(artistMap.entries());
  const variousIndex = entries.findIndex(([key]) => key === "various artists");
  if (variousIndex > 0) {
    const [various] = entries.splice(variousIndex, 1);
    entries.unshift(various);
  }

  const options = ['<option value="all">All artists</option>'];
  for (const [index, [key, label]] of entries.entries()) {
    options.push(`<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`);
    if (index === 0 && key === "various artists" && entries.length > 1) {
      options.push('<option disabled value="">────────────</option>');
    }
  }

  elements.artistFilter.innerHTML = options.join("");
  state.artist = artistMap.has(previous) ? previous : "all";
  elements.artistFilter.value = state.artist;
}

function renderSummary(filtered) {
  const total = state.releases.length;
  const shown = Math.min(state.renderLimit, filtered.length);
  if (state.isLoading) {
    elements.resultsMeta.textContent = `${shown} shown / ${state.loadedRows} rows streaming`;
  } else if (shown < filtered.length) {
    elements.resultsMeta.textContent = `${shown} shown / ${filtered.length} matched / ${total} loaded`;
  } else {
    elements.resultsMeta.textContent = `${filtered.length} shown / ${total} loaded`;
  }
}

function updateLoadSentinel(filteredLength) {
  const hasMore = state.renderLimit < filteredLength;
  elements.loadSentinel.hidden = !hasMore;
  elements.loadSentinel.textContent = hasMore
    ? `${Math.min(state.renderLimit, filteredLength)} / ${filteredLength} shown`
    : "";
}

function loadMoreReleases() {
  const filtered = getFilteredReleases();
  if (state.renderLimit >= filtered.length) return;
  state.renderLimit += RENDER_CHUNK_SIZE;
  render();
}

function resetRenderLimit() {
  state.renderLimit = INITIAL_RENDER_COUNT;
}

function getDatasetSignature(releases) {
  return releases
    .map((release) =>
      [
        release.catalog,
        release.artist,
        release.title,
        release.releaseDate,
        release.cover,
        release.url,
        release.series,
        release.format,
      ].join("|"),
    )
    .join("\n");
}

function getArtistListSignature(artists) {
  return artists.map((artist) => normalizeLookupValue(artist)).join("\n");
}

function render() {
  renderSeriesOptions();
  renderArtistOptions();
  const filtered = getFilteredReleases();
  renderSummary(filtered);
  elements.releaseGrid.classList.toggle("is-list", state.view === "list");

  if (!filtered.length) {
    elements.releaseGrid.innerHTML = elements.emptyTemplate.innerHTML;
    updateLoadSentinel(0);
    return;
  }

  const visible = filtered.slice(0, state.renderLimit);
  elements.releaseGrid.innerHTML = visible.map(renderCard).join("");
  updateLoadSentinel(filtered.length);
}

function getSsrState() {
  if (window.__DATAFRUITS_SSR__) return window.__DATAFRUITS_SSR__;

  const dataNode = document.querySelector("#ssrReleaseData");
  if (!dataNode?.textContent) return undefined;

  try {
    return JSON.parse(dataNode.textContent);
  } catch {
    return undefined;
  }
}

function applySsrState() {
  const ssr = getSsrState();
  if (!ssr || !Array.isArray(ssr.releases)) return false;

  state.source = ssr.source || state.source;
  state.headers = Array.isArray(ssr.headers) ? ssr.headers : [];
  state.releases = ssr.releases;
  state.loadedRows = Number(ssr.loadedRows) || ssr.releases.length;
  state.renderLimit = Math.max(INITIAL_RENDER_COUNT, Math.min(Number(ssr.renderLimit) || ssr.releases.length, ssr.releases.length));
  state.isLoading = false;
  setStatus(`SSR loaded ${formatRefreshTime()}`);
  render();
  return true;
}

async function readTsvStream(response, onRecord) {
  const parser = createTsvParser(onRecord);

  if (!response.body || !window.TextDecoderStream) {
    parser.push(await response.text());
    parser.end();
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
}

function parseArtistRecords(records) {
  return records
    .map((record) => String(record[0] || "").trim())
    .filter((artist) => artist && normalizeLookupValue(artist) !== "sorted artist");
}

async function loadArtistsSource(source = CONFIGURED_ARTISTS_SOURCE, options = {}) {
  if (!source) return;
  if (currentArtistsAbortController) {
    currentArtistsAbortController.abort();
  }

  currentArtistsAbortController = new AbortController();
  const records = [];

  try {
    const response = await fetch(addCacheBuster(normalizeSourceUrl(source)), {
      cache: "no-store",
      signal: currentArtistsAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await readTsvStream(response, (record) => records.push(record));
    const nextArtists = parseArtistRecords(records);
    const changed = getArtistListSignature(state.artists) !== getArtistListSignature(nextArtists);
    state.artists = nextArtists;

    if (changed || !options.background) {
      render();
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    document.documentElement.dataset.artistStatus = `artist list failed: ${error.message}`;
  }
}

async function loadSource(source, options = {}) {
  if (currentAbortController) {
    currentAbortController.abort();
  }

  const requestedSource = source || DEFAULT_SOURCE;
  const fetchSource = addCacheBuster(normalizeSourceUrl(requestedSource));
  const isBackground = Boolean(options.background);
  const previousSignature = isBackground ? getDatasetSignature(state.releases) : "";
  let nextHeaders = [];
  const nextReleases = [];

  currentAbortController = new AbortController();
  state.source = requestedSource;
  if (!isBackground) {
    state.headers = nextHeaders;
    state.releases = nextReleases;
    state.loadedRows = 0;
  }
  if (!options.preserveRenderLimit) {
    resetRenderLimit();
  }
  state.isLoading = true;
  setStatus(isBackground ? "checking spreadsheet" : "streaming TSV");
  if (!isBackground) {
    scheduleRender();
  }

  try {
    const response = await fetch(fetchSource, {
      cache: "no-store",
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await readTsvStream(response, (record) => {
      if (!nextHeaders.length) {
        nextHeaders = record;
        if (!isBackground) {
          state.headers = nextHeaders;
        }
        return;
      }
      const row = rowToObject(nextHeaders, record);
      nextReleases.push(normalizeRelease(row, nextReleases.length));
      if (!isBackground) {
        state.loadedRows = nextReleases.length;
      }
      if (!isBackground && (state.loadedRows === 1 || state.loadedRows % 12 === 0)) {
        scheduleRender();
      }
    });

    const nextSignature = getDatasetSignature(nextReleases);
    state.headers = nextHeaders;
    state.releases = nextReleases;
    state.loadedRows = nextReleases.length;
    state.isLoading = false;
    if (isBackground && previousSignature === nextSignature) {
      setStatus(`spreadsheet checked ${formatRefreshTime()}`);
      return;
    }
    setStatus(
      requestedSource === DEFAULT_SOURCE
        ? `sample TSV loaded ${formatRefreshTime()}`
        : `spreadsheet loaded ${formatRefreshTime()}`,
    );
    render();
  } catch (error) {
    if (error.name === "AbortError") return;
    state.isLoading = false;
    setStatus(`load failed: ${error.message}`);
    render();
  }
}

function setupEvents() {
  elements.searchInput.addEventListener("input", () => {
    state.query = elements.searchInput.value;
    resetRenderLimit();
    render();
  });

  elements.seriesFilter.addEventListener("change", () => {
    state.series = elements.seriesFilter.value;
    resetRenderLimit();
    render();
  });

  elements.artistFilter.addEventListener("change", () => {
    state.artist = elements.artistFilter.value;
    resetRenderLimit();
    render();
  });

  elements.gridViewButton.addEventListener("click", () => {
    setView("grid");
    render();
  });

  elements.listViewButton.addEventListener("click", () => {
    setView("list");
    render();
  });
}

function setupLazyRender() {
  if (!("IntersectionObserver" in window) || !elements.loadSentinel) return;
  loadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreReleases();
      }
    },
    { rootMargin: "720px 0px" },
  );
  loadObserver.observe(elements.loadSentinel);
}

function setupCoverZoom() {
  if (!window.matchMedia("(hover: hover)").matches) return;

  elements.releaseGrid.addEventListener("pointermove", (event) => {
    const cover = event.target.closest(".cover-link, .cover-static");
    if (!cover || !elements.releaseGrid.contains(cover)) return;
    cover.classList.add("is-cover-hover");
  });

  elements.releaseGrid.addEventListener("pointerout", (event) => {
    const cover = event.target.closest(".cover-link, .cover-static");
    if (!cover || (event.relatedTarget && cover.contains(event.relatedTarget))) return;
    cover.classList.remove("is-cover-hover");
  });
}

function setupMobileToolbarAutoHide() {
  const toolbar = elements.toolbar;
  if (!toolbar) return;

  const mobileQuery = window.matchMedia("(max-width: 620px)");
  let lastScrollY = window.scrollY;
  let ticking = false;

  function showToolbar() {
    toolbar.classList.remove("is-sp-hidden");
  }

  function updateToolbar() {
    const currentScrollY = window.scrollY;
    const delta = currentScrollY - lastScrollY;
    const focusedInside = toolbar.contains(document.activeElement);
    const stickyStart = Math.max(120, toolbar.offsetTop - 20);

    if (!mobileQuery.matches || focusedInside || currentScrollY < stickyStart) {
      showToolbar();
    } else if (delta > 10) {
      toolbar.classList.add("is-sp-hidden");
    } else if (delta < -8) {
      showToolbar();
    }

    lastScrollY = currentScrollY;
    ticking = false;
  }

  function scheduleToolbarUpdate() {
    if (ticking) return;
    window.requestAnimationFrame(updateToolbar);
    ticking = true;
  }

  function handleMediaChange() {
    showToolbar();
    lastScrollY = window.scrollY;
  }

  window.addEventListener("scroll", scheduleToolbarUpdate, { passive: true });
  window.addEventListener("resize", scheduleToolbarUpdate);
  toolbar.addEventListener("focusin", showToolbar);

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", handleMediaChange);
  } else {
    mobileQuery.addListener(handleMediaChange);
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    window.clearInterval(autoRefreshTimer);
  }
  autoRefreshTimer = window.setInterval(() => {
    if (document.hidden || state.isLoading) return;
    loadSource(state.source, { background: true, preserveRenderLimit: true });
    loadArtistsSource(CONFIGURED_ARTISTS_SOURCE, { background: true });
  }, AUTO_REFRESH_INTERVAL_MS);
}

setupEvents();
setupLazyRender();
setupCoverZoom();
setupMobileToolbarAutoHide();
setupWikiGifDecorations();
startAutoRefresh();
setView(state.view === "list" ? "list" : "grid");
const hasSsrState = applySsrState();
if (hasSsrState) {
  loadSource(state.source, { background: true, preserveRenderLimit: true });
} else {
  loadSource(state.source);
}
loadArtistsSource();
