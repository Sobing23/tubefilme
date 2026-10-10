// Ergänzt jeden TMDB-zugeordneten Film um die Laufzeit (Minuten) aus dem
// TMDB-Hauptdatensatz. Die Laufzeit ist das einzige Merkmal, das das Video
// selbst verlässlich mitbringt (duration) und das sich mit TMDB vergleichen
// lässt -- unabhängig von Titel, Jahr und Besetzung.
//
// Genutzt von verify-plausibility.js:
//   - bestätigt eine Zuordnung, bei der der TMDB-Titel nur den Anfang des
//     Videotitels bildet ("Chuka" -> "Chuka - Alleingang am Fort Clendennon"),
//     wenn die Laufzeit passt
//   - verwirft eine Zuordnung, deren Laufzeit grob abweicht (gleichnamige
//     andere Verfilmung: "Das Dschungelbuch" 1967 mit 78 min für ein Video
//     mit 105 min)
//
// Läuft inkrementell wie fetch-fsk.js: nur Filme ohne "runtime"-Feld. Kennt
// TMDB keine Laufzeit, wird 0 gespeichert ("geprüft, nichts gefunden").
// Muss VOR verify-plausibility.js laufen, damit neue Zuordnungen die
// Laufzeit schon haben.

import fs from "fs/promises";

const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const FILME_PATH = "data/filme.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 120;

if (!BEARER_TOKEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRuntime(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429) {
    await sleep(1000);
    return fetchRuntime(tmdbId);
  }
  if (res.status === 404) return 0; // Film bei TMDB gelöscht -- nichts zu holen
  if (!res.ok) throw new Error(`TMDB Fehler ${res.status}`);
  const json = await res.json();
  return Number.isFinite(json.runtime) ? json.runtime : 0;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const offen = filme.filter((m) => m.tmdbId && m.runtime === undefined);
  console.log(`${filme.length} Filme insgesamt, ${offen.length} ohne Laufzeit.`);
  if (offen.length === 0) {
    console.log("Nichts zu tun.");
    return;
  }

  let n = 0;
  let gefunden = 0;
  let fehler = 0;
  for (const m of offen) {
    n++;
    if (n % 500 === 0) {
      console.log(`... ${n} / ${offen.length}`);
      // Zwischenstand sichern -- ein Abbruch nach 5.000 Anfragen soll nicht
      // alles verwerfen.
      await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
    }
    try {
      m.runtime = await fetchRuntime(m.tmdbId);
      if (m.runtime) gefunden++;
    } catch (err) {
      fehler++;
      console.error(`   Fehler bei "${m.title}": ${err.message} -- wird beim nächsten Lauf erneut versucht`);
    }
    await sleep(DELAY_MS);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  console.log(`Laufzeit ergänzt für ${offen.length - fehler} Filme (${gefunden} mit Angabe, ${fehler} Fehler).`);
}

main();
