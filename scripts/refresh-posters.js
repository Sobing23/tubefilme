// Sucht für Filme MIT TMDB-Treffer, aber OHNE Poster nachträglich ein Poster.
//
// Stand 25.11.2026: 86 solche Filme. match-tmdb.js übernimmt das Poster aus
// dem Suchergebnis (poster_path); fehlt es dort, blieb der Film für immer
// ohne Poster und stand dauerhaft im Review-Reiter "Kein Cover" -- obwohl
// die Seite in diesem Fall ohnehin das YouTube-Vorschaubild zeigt.
//
// Dieser Schritt fragt den Bilder-Endpunkt von TMDB ab, der ALLE Poster in
// allen Sprachen liefert, und nimmt das beste: deutsch vor englisch vor
// sprachlos vor allen anderen, bei Gleichstand die bessere Bewertung.
//
// Findet sich keins, wird "posterGeprueft" (Datum) gesetzt. Der Film
// verschwindet damit aus dem Review-Reiter und wird erst nach
// ERNEUT_NACH_TAGEN wieder abgefragt -- TMDB bekommt laufend neue Poster.
//
// Aus YouTube übernommene Filme ohne tmdbId sind nicht betroffen.
//
//   node scripts/refresh-posters.js

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const FILME_PATH = "data/filme.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120;
const ERNEUT_NACH_TAGEN = 30;

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tageSeit(datum) {
  const t = Date.parse(datum);
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
}

const SPRACH_RANG = { de: 0, en: 1, null: 2 };

export function bestesPoster(poster) {
  const rang = (p) => SPRACH_RANG[String(p.iso_639_1)] ?? 3;
  return [...(poster || [])]
    .filter((p) => p && p.file_path)
    .sort((a, b) => rang(a) - rang(b) || (b.vote_average || 0) - (a.vote_average || 0))[0] || null;
}

async function holePoster(tmdbId, versuch = 0) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/images`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429 && versuch < 5) {
    await sleep(1000);
    return holePoster(tmdbId, versuch + 1);
  }
  if (res.status === 404) return null; // Film bei TMDB gelöscht
  if (!res.ok) throw new Error(`TMDB Fehler ${res.status}`);
  const json = await res.json();
  return bestesPoster(json.posters);
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const offen = filme.filter(
    (m) => m.tmdbId && !m.posterUrl && (!m.posterGeprueft || tageSeit(m.posterGeprueft) >= ERNEUT_NACH_TAGEN)
  );
  console.log(`${filme.filter((m) => m.tmdbId && !m.posterUrl).length} Filme mit TMDB-Treffer ohne Poster, ${offen.length} jetzt zu prüfen.`);
  if (offen.length === 0) return;

  const heute = new Date().toISOString().slice(0, 10);
  let gefunden = 0;
  let fehler = 0;
  for (const m of offen) {
    try {
      const p = await holePoster(m.tmdbId);
      if (p) {
        m.posterUrl = `https://image.tmdb.org/t/p/w500${p.file_path}`;
        delete m.posterGeprueft;
        gefunden++;
        console.log(`   Poster gefunden: ${m.title}`);
      } else {
        m.posterGeprueft = heute;
      }
    } catch (e) {
      fehler++; // nicht als geprüft markieren -- nächster Lauf versucht es erneut
      console.log(`   Fehler bei ${m.title}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  console.log(`Poster nachgetragen: ${gefunden}, weiter ohne Poster: ${offen.length - gefunden - fehler}, Fehler: ${fehler}`);
}

main();
