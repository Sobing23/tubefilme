// Ergänzt jeden Film in data/filme.json um die Hauptdarsteller (Cast),
// damit die Suche im Frontend auch nach Schauspielern filtern kann.
//
// Läuft inkrementell wie cache-images.js: nur Filme, die noch kein
// "cast"-Feld haben, werden abgefragt -- das deckt sowohl den einmaligen
// Rückstand (alle bisherigen ~2000 Filme) als auch künftige neue Filme ab.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const FILME_PATH = "data/filme.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120;
const CAST_COUNT = 5; // Hauptdarsteller pro Film

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCast(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits?language=de-DE`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });

  if (res.status === 429) {
    await sleep(1000);
    return fetchCast(tmdbId);
  }
  if (!res.ok) {
    throw new Error(`TMDB Fehler ${res.status}`);
  }

  const json = await res.json();
  return (json.cast || []).slice(0, CAST_COUNT).map((c) => c.name);
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const missing = filme.filter((m) => !Array.isArray(m.cast));

  console.log(`${filme.length} Filme insgesamt, ${missing.length} ohne Cast-Daten.`);

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
      movie.cast = await fetchCast(movie.tmdbId);
    } catch (err) {
      movie.cast = [];
      failed++;
      console.error(`   Fehler bei "${movie.title}": ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");

  console.log(`\nCast ergänzt für ${missing.length} Filme (${failed} Fehler).`);
}

main();
