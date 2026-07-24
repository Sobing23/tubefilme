// Sicherheitsnetz nach dem TMDB-Matching: entfernt Duplikate nach tmdbId,
// die es (z.B. aus früheren Läufen vor Einführung der Dedup-Logik) doppelt
// in data/filme.json geschafft haben. Der zuerst gefundene Eintrag bleibt,
// jeder weitere wandert dokumentiert nach data/duplicates.json.
//
// Die frühere zweite Aufgabe dieses Skripts -- riskante Kurz-Anfragen
// nachträglich auf "niedrig" herabstufen -- ist entfallen: match-tmdb.js
// bewertet inzwischen jeden Treffer selbst (Titel, Jahr, Substanz des
// Datensatzes, Besetzungsabgleich) und vergibt die Konfidenz daraus. Eine
// nachgelagerte Herabstufung würde diese Bewertung nur wieder überschreiben.
//
// Der Schritt ist idempotent: im Normalfall findet er nichts und ist dann
// ein günstiger Konsistenz-Check.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const DUPLICATES_PATH = "data/duplicates.json";

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  let duplicates = [];
  try {
    duplicates = JSON.parse(await fs.readFile(DUPLICATES_PATH, "utf-8"));
  } catch {
    // erster Lauf, noch keine Datei
  }

  const keep = [];
  const seenTmdbIds = new Map(); // tmdbId -> Kanalname des behaltenen Eintrags
  let removedDuplicates = 0;

  for (const m of filme) {
    if (seenTmdbIds.has(m.tmdbId)) {
      duplicates.push({
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        channelName: m.channelName,
        tmdbId: m.tmdbId,
        title: m.title,
        bereitsVorhandenAufKanal: seenTmdbIds.get(m.tmdbId),
        hinweis: "nachträglich bereinigt (doppelte tmdbId in filme.json)",
      });
      removedDuplicates++;
      continue;
    }

    seenTmdbIds.set(m.tmdbId, m.channelName);
    keep.push(m);
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(keep, null, 2), "utf-8");
  await fs.writeFile(DUPLICATES_PATH, JSON.stringify(duplicates, null, 2), "utf-8");

  console.log(`Doppelte tmdbIds entfernt: ${removedDuplicates}`);
  console.log(`Verbleibend in ${FILME_PATH}: ${keep.length}`);
}

main();
