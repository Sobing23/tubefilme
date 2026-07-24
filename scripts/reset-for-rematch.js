// Einmalige Neu-Zuordnung: entfernt alle fragwürdigen Einträge aus
// data/filme.json und leert data/unmatched.json, damit match-tmdb.js sie
// im selben Lauf mit der neuen Bewertungslogik (Titel + Jahr + Substanz des
// TMDB-Datensatzes + Besetzungsabgleich) frisch ermittelt.
//
// Wird NICHT beim nächtlichen Scan ausgeführt, sondern nur über den eigenen
// Workflow "Neu-Zuordnung (einmalig)".
//
// Bewusst NICHT angefasst:
//   - manuelle Zuordnungen (matchSource "manuell") -- das sind deine
//     eigenen Korrekturen, die haben immer Vorrang
//   - data/ignored.json -- gelöschte/nicht auffindbare Videos bleiben draußen
//   - data/manual-matches.json -- deine Korrekturen bleiben erhalten
//
// Zurückgesetzt wird, was nach den bisherigen Daten unzuverlässig ist:
//   - alles mit Konfidenz "niedrig" oder "mittel"
//   - zusätzlich alles ohne TMDB-Bewertung oder ohne Genres, auch wenn es
//     bisher als "hoch" galt -- genau dort steckten die Fehltreffer auf
//     obskure Datensätze (Festivalmitschnitte, Namensdubletten)

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const UNMATCHED_PATH = "data/unmatched.json";

function istFragwuerdig(m) {
  if (m.matchSource === "manuell") return false;
  if (m.matchConfidence === "niedrig" || m.matchConfidence === "mittel") return true;
  const ohneBewertung = !m.voteAverage;
  const ohneGenres = (m.genreIds || []).length === 0;
  return ohneBewertung || ohneGenres;
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  const behalten = filme.filter((m) => !istFragwuerdig(m));
  const zurueckgesetzt = filme.length - behalten.length;

  let unmatchedVorher = 0;
  try {
    unmatchedVorher = JSON.parse(await fs.readFile(UNMATCHED_PATH, "utf-8")).length;
  } catch {
    // Datei existiert noch nicht
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(behalten, null, 2), "utf-8");
  await fs.writeFile(UNMATCHED_PATH, JSON.stringify([], null, 2), "utf-8");

  console.log(`Aus filme.json zur Neu-Zuordnung entfernt: ${zurueckgesetzt}`);
  console.log(`Aus unmatched.json zur Neu-Zuordnung freigegeben: ${unmatchedVorher}`);
  console.log(`Unangetastet behalten: ${behalten.length}`);
  console.log(`\nInsgesamt werden im folgenden Schritt ${zurueckgesetzt + unmatchedVorher} Videos neu geprüft.`);
}

main();
