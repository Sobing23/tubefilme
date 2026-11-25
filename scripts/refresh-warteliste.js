// Holt für die Filme der Warteliste (Titel ist noch ein Werbesatz,
// "titelUnsicher") Titel und Beschreibung frisch von YouTube.
//
// Der Scan liest ein Video nur einmal, beim Hochladen. Manche Kanäle tragen
// den Filmnamen aber später nach oder ändern den Videotitel. Ohne diesen
// Schritt sähen die Titelregeln (fix-titles.js) immer nur den alten Text,
// und der Film bliebe für immer ohne Namen.
//
// Geändert wird nur, was sich bei YouTube geändert hat:
//   - data/raw/<channelId>.json   (Titel, Beschreibung) -- filter-movies.js
//     schreibt daraus im selben Lauf candidates.json neu
//   - data/filme.json             (youtubeTitle)
// Die Titelregeln laufen danach wie gewohnt und nehmen die Markierung weg,
// sobald ein Filmname erkennbar ist.
//
// Kosten: eine Abfrage je 50 Videos.
//
//   node scripts/refresh-warteliste.js

import fs from "fs/promises";
import path from "path";

const API_KEY = process.env.YOUTUBE_API_KEY;
const FILME_PATH = "data/filme.json";
const RAW_DIR = "data/raw";
const BATCH = 50;

if (!API_KEY) {
  console.error("Fehler: YOUTUBE_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

async function holeSnippets(ids) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(",")}&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube Fehler ${res.status}`);
  const json = await res.json();
  return new Map((json.items || []).map((i) => [i.id, { title: i.snippet.title, description: i.snippet.description || "" }]));
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  const warteliste = filme.filter((m) => m.titelUnsicher && m.verfuegbar !== false);
  console.log(`Warteliste (Titel ist ein Werbesatz): ${warteliste.length} abspielbare Filme.`);
  if (warteliste.length === 0) return;

  const frisch = new Map();
  for (let i = 0; i < warteliste.length; i += BATCH) {
    const ids = warteliste.slice(i, i + BATCH).map((m) => m.videoId);
    for (const [id, s] of await holeSnippets(ids)) frisch.set(id, s);
  }

  // je Kanal die Rohdatei einmal laden und nur bei Änderung schreiben
  const nachKanal = new Map();
  for (const m of warteliste) {
    if (!frisch.has(m.videoId) || !m.channelId) continue;
    if (!nachKanal.has(m.channelId)) nachKanal.set(m.channelId, []);
    nachKanal.get(m.channelId).push(m);
  }

  let geaendert = 0;
  for (const [channelId, liste] of nachKanal) {
    const pfad = path.join(RAW_DIR, `${channelId}.json`);
    let roh;
    try {
      roh = JSON.parse(await fs.readFile(pfad, "utf-8"));
    } catch {
      continue; // Kanal ohne Rohdatei -- nichts zu aktualisieren
    }
    const nachId = new Map(roh.map((v) => [v.videoId, v]));
    let dateiGeaendert = false;
    for (const m of liste) {
      const s = frisch.get(m.videoId);
      const v = nachId.get(m.videoId);
      if (!v) continue;
      if (v.title !== s.title || (v.description || "") !== s.description) {
        console.log(`   geändert bei YouTube: ${m.youtubeTitle}  ->  ${s.title}`);
        v.title = s.title;
        v.description = s.description;
        m.youtubeTitle = s.title;
        dateiGeaendert = true;
        geaendert++;
      }
    }
    if (dateiGeaendert) await fs.writeFile(pfad, JSON.stringify(roh, null, 2), "utf-8");
  }

  if (geaendert > 0) await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  console.log(`Bei YouTube geänderte Titel/Beschreibungen übernommen: ${geaendert}`);
}

main();
