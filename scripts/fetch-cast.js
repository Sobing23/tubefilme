// Ergänzt jeden Film in data/filme.json um Hauptdarsteller, Regie und
// Drehbuch, damit die Suche im Frontend auch danach filtern kann.
//
// Läuft inkrementell wie cache-images.js: nur Filme, denen eines der drei
// Felder fehlt, werden abgefragt -- das deckt sowohl Rückstände als auch
// künftige neue Filme ab. Alle drei kommen aus derselben TMDB-Anfrage
// (Credits-Endpunkt liefert cast UND crew gemeinsam), kostet also nicht mehr
// als vorher.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const FILME_PATH = "data/filme.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120;
const CAST_COUNT = 5; // Hauptdarsteller pro Film
const WRITER_JOBS = new Set(["Writer", "Screenplay", "Author", "Story"]);

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupe(names) {
  return names.filter((name, idx) => names.indexOf(name) === idx);
}

async function fetchCredits(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits?language=de-DE`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });

  if (res.status === 429) {
    await sleep(1000);
    return fetchCredits(tmdbId);
  }
  if (!res.ok) {
    throw new Error(`TMDB Fehler ${res.status}`);
  }

  const json = await res.json();
  const cast = (json.cast || []).slice(0, CAST_COUNT).map((c) => c.name);
  const director = dedupe((json.crew || []).filter((c) => c.job === "Director").map((c) => c.name));
  const writer = dedupe((json.crew || []).filter((c) => WRITER_JOBS.has(c.job)).map((c) => c.name)).slice(0, 3);

  return { cast, director, writer };
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const missing = filme.filter((m) => !Array.isArray(m.cast) || !Array.isArray(m.director));

  console.log(`${filme.length} Filme insgesamt, ${missing.length} ohne vollständige Credits.`);

  if (missing.length === 0) {
    console.log("Nichts zu tun.");
    return;
  }

  let processed = 0;
  let failed = 0;

  for (const movie of missing) {
    processed++;
    if (processed % 200 === 0) {
      console.log(`... ${processed} / ${missing.length}`);
    }

    try {
      const credits = await fetchCredits(movie.tmdbId);
      movie.cast = credits.cast;
      movie.director = credits.director;
      movie.writer = credits.writer;
    } catch (err) {
      movie.cast = movie.cast || [];
      movie.director = movie.director || [];
      movie.writer = movie.writer || [];
      failed++;
      console.error(`   Fehler bei "${movie.title}": ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");

  console.log(`\nCredits ergänzt für ${missing.length} Filme (${failed} Fehler).`);
}

main();
