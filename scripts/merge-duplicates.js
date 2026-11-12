// Führt Mehrfacheinträge desselben Films in data/filme.json zusammen.
//
// cleanup-matches.js erkennt Doppelte nur über die tmdbId. Filme ohne
// TMDB-Treffer, die mehrere Kanäle zeigen (oder ein Kanal mehrfach
// hochgeladen hat), standen deshalb mehrfach in der Bibliothek -- am
// 11.11.2026 317 Titel mit 768 Einträgen. Wann zwei Einträge derselbe Film
// sind und welcher bleibt, steht in scripts/lib/doppel.js.
//
// Je Gruppe bleibt ein Eintrag. Die anderen
//   - wandern als Ersatz-Upload nach data/duplicates.json, mit "ersatzFuer"
//     (Video-ID des bleibenden Eintrags) -- repair-unavailable.js weicht
//     darauf aus, wenn das Video des bleibenden Eintrags stirbt, auch ohne
//     tmdbId;
//   - hinterlassen ihre Adresse in data/weiterleitungen.json. build-site.js
//     macht daraus eine dauerhafte Weiterleitung auf die bleibende Seite,
//     damit Verweise und Suchmaschinen nicht auf einer 404 landen.
//
// Läuft nach fix-titles.js, weil erst ein bereinigter Titel manche
// Gleichheit zeigt. Idempotent: Ein zweiter Lauf findet nichts mehr.
//
//   node scripts/merge-duplicates.js              zusammenführen
//   node scripts/merge-duplicates.js --nur-pruefen  nur auflisten, nichts schreiben

import fs from "fs/promises";
import { gleicherFilm, rangfolge, normTitel, minuten } from "./lib/doppel.js";

const FILME_PATH = "data/filme.json";
const DUPLICATES_PATH = "data/duplicates.json";
const WEITERLEITUNGEN_PATH = "data/weiterleitungen.json";
const NUR_PRUEFEN = process.argv.includes("--nur-pruefen");

async function lade(pfad, standard) {
  try {
    return JSON.parse(await fs.readFile(pfad, "utf-8"));
  } catch {
    return standard;
  }
}

async function main() {
  const filme = await lade(FILME_PATH, []);
  const duplicates = await lade(DUPLICATES_PATH, []);
  const weiterleitungen = await lade(WEITERLEITUNGEN_PATH, []);

  // Nach Titel vorsortieren; innerhalb des Titels der beste Eintrag zuerst,
  // damit jeder Gruppenkopf schon der bleibende Eintrag ist.
  const nachTitel = new Map();
  for (const m of filme) {
    const k = normTitel(m.title);
    if (!k) continue;
    if (!nachTitel.has(k)) nachTitel.set(k, []);
    nachTitel.get(k).push(m);
  }

  const raus = new Map(); // videoId -> bleibender Eintrag
  const gruppen = [];
  for (const liste of nachTitel.values()) {
    if (liste.length < 2) continue;
    liste.sort(rangfolge);
    const koepfe = [];
    for (const m of liste) {
      const kopf = koepfe.find((k) => gleicherFilm(k.kopf, m));
      if (kopf) kopf.rest.push(m);
      else koepfe.push({ kopf: m, rest: [] });
    }
    for (const g of koepfe) {
      // Nur zusammenführen, wenn mindestens ein Eintrag ohne TMDB beteiligt
      // ist -- gleiche tmdbIds räumt cleanup-matches.js schon auf.
      if (g.rest.length === 0) continue;
      gruppen.push(g);
      for (const m of g.rest) raus.set(m.videoId, g.kopf);
    }
  }

  const heute = new Date().toISOString().slice(0, 10);
  for (const g of gruppen) {
    const zeile = [g.kopf, ...g.rest]
      .map((m) => `${m.channelName} ${Math.round(minuten(m.duration))}min${m.tmdbId ? " TMDB" : ""}`)
      .join(", ");
    console.log(`   ${g.kopf.title}  [bleibt: ${g.kopf.channelName}${g.kopf.slug ? " /" + g.kopf.slug : ""}]  ${zeile}`);
  }
  console.log(`\nGruppen: ${gruppen.length}, Einträge zusammengeführt: ${raus.size}`);
  if (NUR_PRUEFEN || raus.size === 0) return;

  const vorhanden = new Set(duplicates.map((d) => d.videoId));
  const schonWeiter = new Set(weiterleitungen.map((w) => w.von));
  for (const m of filme) {
    const kopf = raus.get(m.videoId);
    if (!kopf) continue;
    if (!vorhanden.has(m.videoId)) {
      duplicates.push({
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        channelName: m.channelName,
        channelId: m.channelId,
        tmdbId: kopf.tmdbId ?? null,
        title: kopf.title,
        bereitsVorhandenAufKanal: kopf.channelName,
        ersatzFuer: kopf.videoId,
        hinweis: `zusammengeführt ${heute}: derselbe Film wie ${kopf.videoId} (gleicher Titel, Laufzeit ${Math.round(minuten(m.duration))}/${Math.round(minuten(kopf.duration))} min)`,
      });
    }
    if (m.slug && !schonWeiter.has(m.slug)) {
      weiterleitungen.push({ von: m.slug, zielVideoId: kopf.videoId, zielSlug: kopf.slug || null, seit: heute, grund: "zusammengeführt" });
      schonWeiter.add(m.slug);
    }
  }

  await fs.writeFile(FILME_PATH, JSON.stringify(filme.filter((m) => !raus.has(m.videoId)), null, 2), "utf-8");
  await fs.writeFile(DUPLICATES_PATH, JSON.stringify(duplicates, null, 2), "utf-8");
  await fs.writeFile(WEITERLEITUNGEN_PATH, JSON.stringify(weiterleitungen, null, 2), "utf-8");
  console.log(`Bibliothek jetzt: ${filme.length - raus.size}, Weiterleitungen: ${weiterleitungen.length}`);
}

main();
