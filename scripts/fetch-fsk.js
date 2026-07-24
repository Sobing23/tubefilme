// Ergänzt jeden Film in data/filme.json um die deutsche FSK-Einstufung
// (0/6/12/16/18), damit sie im Frontend angezeigt und gefiltert werden kann.
//
// TMDB führt Alterseinstufungen nicht im Hauptdatensatz, sondern über einen
// eigenen "Release Dates"-Endpunkt pro Film, der Zertifizierungen je Land
// zurückgibt. Wir picken uns daraus den deutschen Eintrag (DE) raus.
//
// Läuft inkrementell wie cache-images.js/fetch-cast.js: nur Filme ohne
// "fsk"-Feld werden abgefragt. Findet TMDB keine deutsche Einstufung (kommt
// bei sehr obskuren/nur-online-verfügbaren Filmen vor), wird explizit
// "fsk: null" gespeichert -- das markiert "geprüft, aber nichts gefunden"
// und verhindert, dass der Film jede Nacht erneut abgefragt wird.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const FILME_PATH = "data/filme.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120;

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFsk(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/release_dates`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });

  if (res.status === 429) {
    await sleep(1000);
    return fetchFsk(tmdbId);
  }
  if (!res.ok) {
    throw new Error(`TMDB Fehler ${res.status}`);
  }

  const json = await res.json();
  const de = (json.results || []).find((r) => r.iso_3166_1 === "DE");
  if (!de) return null;

  // Ein Land kann mehrere Release-Einträge haben (Kino, Digital, ...) --
  // wir nehmen die erste nicht-leere Zertifizierung.
  const cert = (de.release_dates || []).map((rd) => rd.certification).find((c) => c && c.trim());
  return cert || null;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const missing = filme.filter((m) => m.fsk === undefined);

  console.log(`${filme.length} Filme insgesamt, ${missing.length} ohne FSK-Daten.`);

  if (missing.length === 0) {
    console.log("Nichts zu tun.");
    return;
  }

  let processed = 0;
  let found = 0;
  let failed = 0;

  for (const movie of missing) {
    processed++;
    if (processed % 200 === 0) {
      console.log(`... ${processed} / ${missing.length}`);
    }

    try {
      movie.fsk = await fetchFsk(movie.tmdbId);
      if (movie.fsk) found++;
    } catch (err) {
      movie.fsk = null;
      failed++;
      console.error(`   Fehler bei "${movie.title}": ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");

  console.log(`\nFSK ergänzt für ${missing.length} Filme (${found} mit Einstufung gefunden, ${failed} Fehler).`);
}

main();
