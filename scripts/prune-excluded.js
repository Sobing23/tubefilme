// Lässt neue Filterregeln rückwirkend wirken.
//
// filter-movies.js entscheidet, welche Videos Kandidaten sind. Wird eine
// Regel verschärft (z.B. ein Ausschlussmuster für einen Kanal), betrifft das
// zunächst nur künftige Videos: Was schon in der Bibliothek steht, bleibt
// stehen, weil match-tmdb.js bereits verarbeitete Videos nie wieder anfasst.
// So landeten am 10.10.2026 Interviews, TV-Shows und Serienfolgen in der
// Bibliothek, obwohl sie nach den Regeln ausgeschlossen gewesen wären.
//
// Dieses Skript gleicht ab: Jeder Eintrag in filme.json, unmatched.json und
// duplicates.json, dessen Video laut data/excluded.json inzwischen
// ausgeschlossen ist, wird entfernt und in data/aussortiert.json protokolliert.
//
// Ausgenommen: von Hand bearbeitete Filme (matchSource "manuell").
//
// Im Normalfall findet das Skript nichts -- es greift nur, wenn eine Regel
// neu dazugekommen ist. Idempotent.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const UNMATCHED_PATH = "data/unmatched.json";
const DUPLICATES_PATH = "data/duplicates.json";
const EXCLUDED_PATH = "data/excluded.json";
const PROTOKOLL_PATH = "data/aussortiert.json";

async function lade(pfad, standard) {
  try {
    return JSON.parse(await fs.readFile(pfad, "utf-8"));
  } catch {
    return standard;
  }
}

async function main() {
  const excluded = await lade(EXCLUDED_PATH, []);
  if (excluded.length === 0) {
    console.log("excluded.json leer oder nicht vorhanden -- nichts zu tun.");
    return;
  }
  const grund = new Map(excluded.map((x) => [x.videoId, x.ausschlussgrund]));

  const filme = await lade(FILME_PATH, []);
  const unmatched = await lade(UNMATCHED_PATH, []);
  const duplicates = await lade(DUPLICATES_PATH, []);
  const protokoll = await lade(PROTOKOLL_PATH, []);
  const heute = new Date().toISOString().slice(0, 10);

  const filmeNeu = [];
  for (const m of filme) {
    if (m.matchSource !== "manuell" && grund.has(m.videoId)) {
      protokoll.push({
        datum: heute,
        quelle: "filme.json",
        grund: grund.get(m.videoId),
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        title: m.title,
        tmdbId: m.tmdbId ?? null,
        channelName: m.channelName,
      });
      continue;
    }
    filmeNeu.push(m);
  }

  const unmatchedNeu = unmatched.filter((u) => !grund.has(u.videoId));
  const duplicatesNeu = duplicates.filter((d) => !grund.has(d.videoId));

  const ausFilme = filme.length - filmeNeu.length;
  const ausUnmatched = unmatched.length - unmatchedNeu.length;
  const ausDuplikaten = duplicates.length - duplicatesNeu.length;

  if (ausFilme + ausUnmatched + ausDuplikaten > 0) {
    await fs.writeFile(FILME_PATH, JSON.stringify(filmeNeu, null, 2), "utf-8");
    await fs.writeFile(UNMATCHED_PATH, JSON.stringify(unmatchedNeu, null, 2), "utf-8");
    await fs.writeFile(DUPLICATES_PATH, JSON.stringify(duplicatesNeu, null, 2), "utf-8");
    await fs.writeFile(PROTOKOLL_PATH, JSON.stringify(protokoll, null, 2), "utf-8");
  }

  console.log(`Nach aktuellen Filterregeln aussortiert -- Bibliothek: ${ausFilme}, unmatched: ${ausUnmatched}, Duplikate: ${ausDuplikaten}`);
  console.log(`Bibliothek jetzt: ${filmeNeu.length}`);
}

main();
