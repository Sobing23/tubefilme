// Erzeugt aus data/filme.json alles, was die öffentliche Seite braucht:
//
//   data/index.json     schlanker Index für das Kachelraster (~1.7 statt 7 MB)
//   film/<slug>.html    eine echte Seite pro Film
//   sitemap.xml         Verzeichnis aller Seiten für Suchmaschinen
//   robots.txt
//
// Warum echte Seiten statt eines Overlays: Menschen suchen bei Google nach
// "<Titel> ganzer Film deutsch". Ohne eigene Seite je Film ist für eine
// Suchmaschine nur EINE Seite vorhanden -- der gesamte Bestand bleibt
// unsichtbar. Jede Filmseite bringt Titel, Beschreibung, Jahr, Besetzung und
// strukturierte Daten (schema.org) direkt im HTML mit, ohne dass dafür erst
// JavaScript laufen muss.
//
// INKREMENTELL: Eine Seite wird nur geschrieben, wenn sie fehlt oder sich ihr
// Inhalt geändert hat. Dadurch entstehen beim nächtlichen Lauf nur für neue
// Filme Änderungen, und das Repository wächst nicht bei jedem Durchlauf.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const FILME_PATH = "data/filme.json";
const INDEX_PATH = "data/index.json";
const FILM_DIR = "film";
const BASE_URL = "https://www.tubefilme.de";

const GENRES = {
  28: "Action", 12: "Abenteuer", 16: "Animation", 35: "Komödie", 80: "Krimi",
  99: "Dokumentation", 18: "Drama", 10751: "Familie", 14: "Fantasy", 36: "Historie",
  27: "Horror", 10402: "Musik", 9648: "Mystery", 10749: "Romantik", 878: "Science Fiction",
  10770: "TV-Film", 53: "Thriller", 10752: "Kriegsfilm", 37: "Western",
};

const SEITEN_CSS = `:root{--bg:#121212;--bg-card:#1e1e1e;--text:#f2f2f2;--text-dim:#9a9a9a;--accent:#e5533c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
header{padding:16px 20px;border-bottom:1px solid #2a2a2a}
header a{color:var(--text);text-decoration:none;font-size:20px;font-weight:bold}
header a span{color:var(--accent)}
main{max-width:960px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:26px;margin:0 0 6px}
.sub{color:var(--text-dim);font-size:14px;margin-bottom:18px}
.player{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;cursor:pointer}
.player img{width:100%;height:100%;object-fit:cover;display:block}
.player .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
.player .play svg{width:68px;height:48px}
.player iframe{width:100%;height:100%;border:0;display:block}
.hinweis{background:#2a1f1c;border:1px solid #5c3a33;border-radius:8px;padding:18px 20px}
.hinweis strong{color:#e5533c;display:block;margin-bottom:6px}
.hinweis p{margin:0;color:#ddd}
.meta{margin-top:20px;color:#ddd}
.meta p{margin:0 0 14px}
.meta .label{color:var(--text-dim);font-size:13px}
.similar{margin-top:34px}
.similar h2{font-size:15px;color:var(--text-dim);font-weight:normal;margin:0 0 10px}
.similar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
.similar-grid a{text-decoration:none;color:var(--text)}
.similar-grid img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:6px;background:#222;display:block}
.similar-grid div{font-size:12px;margin-top:4px;line-height:1.3}
footer{border-top:1px solid #2a2a2a;padding:18px 20px;color:var(--text-dim);font-size:12px;text-align:center}
footer a{color:var(--text-dim)}
`;

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Erzeugt aus dem Titel einen sprechenden Adressbestandteil. Die videoId
// hängt hinten dran, damit gleichnamige Filme sich nicht überschreiben.
function makeSlug(title, videoId) {
  const basis = String(title || "film")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${basis || "film"}-${videoId}`;
}

function jahrVon(m) {
  return (m.releaseDate || "").slice(0, 4) || "";
}

function genreNamen(ids) {
  return (ids || []).map((id) => GENRES[id]).filter(Boolean);
}

function posterFuer(m) {
  if (m.posterUrl) return m.posterUrl;
  if (m.videoId) return `https://i.ytimg.com/vi/${m.videoId}/maxresdefault.jpg`;
  return "";
}

// Kurzbeschreibung für Suchergebnisse und Vorschaukarten in sozialen Netzen.
function metaBeschreibung(m) {
  const jahr = jahrVon(m);
  const genres = genreNamen(m.genreIds).join(", ");
  if (m.overview && m.overview.length > 60) {
    return m.overview.replace(/\s+/g, " ").slice(0, 155).trim() + "…";
  }
  const teile = [m.title, jahr && `(${jahr})`, genres].filter(Boolean).join(" ");
  return `${teile} — kostenlos und in voller Länge auf Deutsch ansehen.`;
}

function filmSeite(m, aehnliche) {
  const jahr = jahrVon(m);
  const genres = genreNamen(m.genreIds);
  const poster = posterFuer(m);
  const titelMitJahr = jahr ? `${m.title} (${jahr})` : m.title;
  const beschreibung = metaBeschreibung(m);
  const url = `${BASE_URL}/${FILM_DIR}/${m.slug}`;

  // Strukturierte Daten, damit Suchmaschinen den Inhalt als Film erkennen
  const strukturiert = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: m.title,
    ...(m.originalTitle && m.originalTitle !== m.title ? { alternateName: m.originalTitle } : {}),
    ...(m.overview ? { description: m.overview } : {}),
    ...(poster ? { image: poster } : {}),
    ...(m.releaseDate ? { datePublished: m.releaseDate } : {}),
    ...(genres.length ? { genre: genres } : {}),
    ...(m.director && m.director.length
      ? { director: m.director.map((n) => ({ "@type": "Person", name: n })) }
      : {}),
    ...(m.cast && m.cast.length
      ? { actor: m.cast.map((n) => ({ "@type": "Person", name: n })) }
      : {}),
    ...(m.voteAverage
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: m.voteAverage,
            bestRating: 10,
            ratingCount: 1,
          },
        }
      : {}),
    url,
  };

  const infoZeile = [
    jahr,
    m.duration ? dauerLesbar(m.duration) : "",
    genres.join(", "),
    m.fsk ? `FSK ${m.fsk}` : "",
    m.voteAverage ? `★ ${Number(m.voteAverage).toFixed(1)}` : "",
  ].filter(Boolean).join(" · ");

  const nichtVerfuegbar = m.verfuegbar === false;
  const grundText = {
    geloescht: "Dieser Film wurde beim anbietenden Kanal entfernt.",
    gesperrt_de: "Dieser Film ist in Deutschland nicht abrufbar.",
    nicht_einbettbar: "Dieser Film lässt sich hier nicht abspielen -- der Kanal erlaubt die Einbindung auf anderen Seiten nicht.",
    nicht_oeffentlich: "Dieser Film ist beim anbietenden Kanal nicht mehr öffentlich.",
  }[m.nichtVerfuegbarGrund] || "Dieser Film ist derzeit nicht abrufbar.";

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(titelMitJahr)} – ganzer Film auf Deutsch | tubefilme</title>
<meta name="description" content="${escapeHtml(beschreibung)}">
${nichtVerfuegbar ? '<meta name="robots" content="noindex, follow">' : ""}
<link rel="canonical" href="${url}">
<meta property="og:type" content="video.movie">
<meta property="og:title" content="${escapeHtml(titelMitJahr)}">
<meta property="og:description" content="${escapeHtml(beschreibung)}">
${poster ? `<meta property="og:image" content="${escapeHtml(poster)}">` : ""}
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(strukturiert)}</script>
<link rel="stylesheet" href="/film/style.css">
</head>
<body>
<header><a href="/">tube<span>filme</span></a></header>
<main>
  <h1>${escapeHtml(m.title)}</h1>
  <div class="sub">${escapeHtml(infoZeile)}</div>

  ${nichtVerfuegbar ? `<div class="hinweis">
    <strong>Derzeit nicht abspielbar</strong>
    <p>${escapeHtml(grundText)} Vielleicht ist einer der Filme unten etwas für dich.</p>
  </div>` : `<div class="player" id="player" data-video="${escapeHtml(m.videoId)}">
    ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(m.title)}" onerror="this.src='https://i.ytimg.com/vi/${escapeHtml(m.videoId)}/hqdefault.jpg'">` : ""}
    <div class="play" aria-label="Film abspielen">
      <svg viewBox="0 0 68 48"><path fill="#f00" d="M66.5 7.7a8 8 0 0 0-5.6-5.7C56 .7 34 .7 34 .7s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.7C0 12.6 0 24 0 24s0 11.4 1.5 16.3a8 8 0 0 0 5.6 5.7C12 47.3 34 47.3 34 47.3s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7C68 35.4 68 24 68 24s0-11.4-1.5-16.3z"/><path fill="#fff" d="M45 24 27 14v20z"/></svg>
    </div>
  </div>`}

  <div class="meta">
    <p>${escapeHtml(m.overview || "Für diesen Film liegt keine Beschreibung vor.")}</p>
    ${m.cast && m.cast.length ? `<p><span class="label">Mit:</span> ${escapeHtml(m.cast.join(", "))}</p>` : ""}
    ${m.director && m.director.length ? `<p><span class="label">Regie:</span> ${escapeHtml(m.director.join(", "))}</p>` : ""}
    ${m.originalTitle && m.originalTitle !== m.title ? `<p><span class="label">Originaltitel:</span> ${escapeHtml(m.originalTitle)}</p>` : ""}
    <p><span class="label">Quelle:</span> ${escapeHtml(m.channelName)} auf YouTube</p>
  </div>

  ${aehnliche.length ? `<div class="similar">
    <h2>Ähnliche Filme</h2>
    <div class="similar-grid">
      ${aehnliche.map((a) => `<a href="/${FILM_DIR}/${a.slug}">
        <img src="${escapeHtml(posterFuer(a))}" loading="lazy" alt="${escapeHtml(a.title)}">
        <div>${escapeHtml(a.title)}</div>
      </a>`).join("")}
    </div>
  </div>` : ""}
</main>
<footer>
  <a href="/">Alle Filme auf tubefilme.de</a> · Wiedergabe über YouTube
</footer>
<script>
// Das Video wird erst auf Klick geladen. Ein sofort eingebundener Player
// würde die Seite deutlich verlangsamen und Daten laden, die die meisten
// Besucher gar nicht abrufen.
var playerEl = document.getElementById("player");
if (playerEl) playerEl.addEventListener("click", function () {
  var id = this.dataset.video;
  this.innerHTML = '<iframe src="https://www.youtube.com/embed/' + id +
    '?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
}, { once: true });
</script>
</body>
</html>`;
}

function dauerLesbar(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return "";
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  return h > 0 ? `${h} Std ${min} Min` : `${min} Min`;
}

// Drei Filme mit den meisten gemeinsamen Genres -- sorgt zugleich für interne
// Verlinkung, die Suchmaschinen beim Erfassen des Bestands hilft.
function findeAehnliche(film, alle, anzahl) {
  const genres = new Set(film.genreIds || []);
  if (genres.size === 0) return [];
  return alle
    .filter((a) => a.videoId !== film.videoId && a.verfuegbar !== false)
    .map((a) => ({ a, gemeinsam: (a.genreIds || []).filter((g) => genres.has(g)).length }))
    .filter((x) => x.gemeinsam > 0)
    .sort((x, y) => y.gemeinsam - x.gemeinsam || (y.a.voteAverage || 0) - (x.a.voteAverage || 0))
    .slice(0, anzahl)
    .map((x) => x.a);
}

async function schreibeWennGeaendert(pfad, inhalt) {
  try {
    const alt = await fs.readFile(pfad, "utf-8");
    if (alt === inhalt) return false;
  } catch {
    // Datei existiert noch nicht
  }
  await fs.writeFile(pfad, inhalt, "utf-8");
  return true;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  // Adressbestandteil je Film festlegen -- EINMALIG und danach unveränderlich.
  //
  // Der Slug wird in data/filme.json gespeichert und nie wieder neu berechnet.
  // Grund: Wird ein totes Video durch den Upload eines anderen Kanals ersetzt,
  // ändert sich die videoId. Würde die Adresse daraus neu gebildet, bekäme der
  // Film eine andere Adresse -- bestehende Verweise liefen ins Leere und die
  // bei Suchmaschinen aufgebaute Sichtbarkeit wäre verloren. Genau das soll
  // der Austausch ja verhindern.
  const vergeben = new Set(filme.map((m) => m.slug).filter(Boolean));
  let neueSlugs = 0;
  filme.forEach((m) => {
    if (m.slug) return; // bereits vergeben, bleibt für immer
    let slug = makeSlug(m.title, m.videoId);
    while (vergeben.has(slug)) slug += "-2";
    vergeben.add(slug);
    m.slug = slug;
    neueSlugs++;
  });

  // Neu vergebene Adressen zurückschreiben, damit sie dauerhaft feststehen
  if (neueSlugs > 0) {
    await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  }

  await fs.mkdir(FILM_DIR, { recursive: true });

  // Gemeinsames Stylesheet: einmal geschrieben, vom Browser einmal geladen
  // und für alle Filmseiten wiederverwendet.
  await schreibeWennGeaendert(path.join(FILM_DIR, "style.css"), SEITEN_CSS);

  // 1. Schlanker Index fürs Raster
  // Nicht verfügbare Filme erscheinen nicht mehr im Kachelraster -- niemand
  // soll auf einen Film klicken, der ohnehin nicht abspielbar ist. Ihre
  // Seite bleibt aber bestehen, damit Verweise von außen nicht ins Leere
  // laufen.
  const index = filme.filter((m) => m.verfuegbar !== false).map((m) => ({
    v: m.videoId,
    s: m.slug,
    t: m.title,
    o: m.originalTitle || null,
    y: jahrVon(m) || null,
    p: m.posterUrl || null,
    th: m.youtubeThumbnail || null,
    g: m.genreIds || [],
    f: m.fsk || null,
    r: m.voteAverage || null,
    c: m.matchConfidence,
    ca: m.cast || [],
    d: m.director || [],
  }));
  await fs.writeFile(INDEX_PATH, JSON.stringify(index), "utf-8");

  // 2. Eine Seite je Film
  let neu = 0;
  let geaendert = 0;
  for (const m of filme) {
    const aehnliche = findeAehnliche(m, filme, 6);
    const html = filmSeite(m, aehnliche);
    const pfad = path.join(FILM_DIR, `${m.slug}.html`);
    let existierte = true;
    try {
      await fs.access(pfad);
    } catch {
      existierte = false;
    }
    const veraendert = await schreibeWennGeaendert(pfad, html);
    if (veraendert) existierte ? geaendert++ : neu++;
  }

  // 3. Verwaiste Seiten entfernen (gelöschte Filme)
  const erwartet = new Set(filme.map((m) => `${m.slug}.html`));
  let entfernt = 0;
  for (const datei of await fs.readdir(FILM_DIR)) {
    if (datei.endsWith(".html") && !erwartet.has(datei)) {
      await fs.unlink(path.join(FILM_DIR, datei));
      entfernt++;
    }
  }

  // 4. Sitemap und robots.txt
  const heute = new Date().toISOString().slice(0, 10);
  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>${BASE_URL}/</loc><lastmod>${heute}</lastmod><priority>1.0</priority></url>\n` +
    filme
      .filter((m) => m.verfuegbar !== false)
      .map((m) => `  <url><loc>${BASE_URL}/${FILM_DIR}/${m.slug}</loc><lastmod>${heute}</lastmod><priority>0.7</priority></url>`)
      .join("\n") +
    `\n</urlset>\n`;
  await schreibeWennGeaendert("sitemap.xml", sitemap);
  await schreibeWennGeaendert("robots.txt", `User-agent: *\nAllow: /\nDisallow: /review\n\nSitemap: ${BASE_URL}/sitemap.xml\n`);

  const groesse = (JSON.stringify(index).length / 1048576).toFixed(2);
  console.log(`Adressen neu vergeben:   ${neueSlugs}`);
  console.log(`Index geschrieben:      ${index.length} Filme, ${groesse} MB -> ${INDEX_PATH}`);
  console.log(`Filmseiten neu:         ${neu}`);
  console.log(`Filmseiten aktualisiert:${geaendert}`);
  console.log(`Verwaiste entfernt:     ${entfernt}`);
  console.log(`Sitemap:                ${index.length + 1} Adressen`);
  console.log(`Nicht verfügbar (ohne Raster/Sitemap): ${filme.length - index.length}`);
}

main();
