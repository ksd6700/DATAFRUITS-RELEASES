const fs = require("node:fs/promises");
const path = require("node:path");

const { renderIndex } = require("../server");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "https://releases.datafruits.fm";
const PAGES_CNAME = process.env.PAGES_CNAME || "releases.datafruits.fm";

async function copyPath(source, destination) {
  const stats = await fs.stat(source);
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source);
    await Promise.all(entries.map((entry) => copyPath(path.join(source, entry), path.join(destination, entry))));
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function build() {
  await fs.rm(DIST, { force: true, recursive: true });
  await fs.mkdir(DIST, { recursive: true });

  const html = await renderIndex(new URL("/", PUBLIC_ORIGIN));
  await fs.writeFile(path.join(DIST, "index.html"), html);

  await Promise.all([
    copyPath(path.join(ROOT, "app.js"), path.join(DIST, "app.js")),
    copyPath(path.join(ROOT, "styles.css"), path.join(DIST, "styles.css")),
    copyPath(path.join(ROOT, "img"), path.join(DIST, "img")),
    copyPath(path.join(ROOT, "data"), path.join(DIST, "data")),
    fs.writeFile(path.join(DIST, ".nojekyll"), ""),
    fs.writeFile(path.join(DIST, "CNAME"), `${PAGES_CNAME}\n`),
  ]);

  console.log(`SSG build complete: ${path.relative(ROOT, DIST)}/index.html`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
