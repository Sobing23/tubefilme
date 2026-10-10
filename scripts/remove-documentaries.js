// Entfernt Dokumentationen aus der Bibliothek -- tubefilme.de führt nur
// Spielfilme (Entscheidung vom 10.10.2026).
//
// Als Doku gilt ein Eintrag, wenn
//   - TMDB ihn als Dokumentarfilm führt (Genre 99), oder
//   - der Videotitel ein Doku-Wort enthält (Doku, Dokumentation,
//     Dokumentarfilm, Documentary, Reportage).
//
// Das zweite Kriterium ist wichtig: Viele YouTube-Dokus wurden bei TMDB einem
// gleichnamigen Spielfilm zugeordnet -- "Madagascar | Dokumentarfilm" als der
// Animationsfilm, "Dinosaurier - Wie sie wirklich lebten [Dokumentation]" als
// "Ice Age 3". Nach TMDB-Genre allein blieben genau diese Fehltreffer stehen.
//
// Was passiert:
//   - filme.json: Doku-Einträge werden entfernt
//   - unmatched.json: Einträge mit Doku-Wort werden entfernt (sie wären sonst
//     dauerhaft in der Review-Liste, weil filter-movies.js sie nicht mehr als
//     Kandidaten führt und absorb-unmatched.js sie deshalb nie übernimmt)
//   - duplicates.json: Doku-Einträge werden entfernt (sie sollen auch nicht
//     als Ersatz-Upload wieder in die Bibliothek rutschen)
//   - ignored.json: Videos, die NUR über das TMDB-Genre erkannt wurden, werden
//     eingetragen -- sonst würde match-tmdb.js sie jede Nacht neu zuordnen.
//     Videos mit Doku-Wort im Titel sortiert schon filter-movies.js aus.
//   - dokus-entfernt.json: Protokoll jedes entfernten Eintrags, damit sich der
//     Schritt nachvollziehen und bei Bedarf rückgängig machen lässt.
//
// Sonderfall "nur über TMDB-Genre erkannt": Nennt der Videotitel eine
// Spielfilm-Gattung (Western, Horrorfilm, Thriller, Krimi ...), ist nicht der
// Film eine Doku, sondern die TMDB-Zuordnung falsch -- etwa "Camp - Tödliche
// Ferien (HORRORFILM)" -> eine Doku über ein Ferienlager, oder "Massaker |
// Cowboyfilm" -> eine gleichnamige Doku. Solche Einträge werden NICHT
// gelöscht: Die falsche tmdbId kommt auf die Sperrliste
// (rejected-matches.json), und match-tmdb.js sucht den Film beim nächsten
// Lauf neu. Dasselbe gilt für Videos in data/keine-doku.json -- dort stehen
// Spielfilme, deren Videotitel keine Gattung nennt (z.B. reißerische
// KinoWelt-Titel).
//
// Ausgenommen: von Hand bearbeitete Filme (matchSource "manuell").
//
// Idempotent: Ein zweiter Lauf findet nichts mehr.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const UNMATCHED_PATH = "data/unmatched.json";
const DUPLICATES_PATH = "data/duplicates.json";
const IGNORED_PATH = "data/ignored.json";
const PROTOKOLL_PATH = "data/dokus-entfernt.json";
const REJECTED_PATH = "data/rejected-matches.json";
const KEINE_DOKU_PATH = "data/keine-doku.json";

// Gattungswörter im Videotitel, die auf einen Spielfilm hinweisen.
const SPIELFILM_SIGNAL = /spielfilm|western|horror|thriller|krimi|komödie|comedy|action|kriegsfilm|historienfilm|\bdrama\b|abenteuer|cowboy|pferdefilm|kampffilm|science.?fiction|sci-fi|liebesfilm|romcom|romanti|mystery|survival|psycho/i;

// Muss mit DOKU_KEYWORDS in filter-movies.js übereinstimmen.
export const DOKU_WORT = /\bdokus?\b|dokumentation|dokumentarfilm|documentary|\breportage|kriegsdoku|geschichtsdoku|musikdokument/i;
const TMDB_GENRE_DOKU = 99;

async function lade(pfad, standard) {
  try {
    return JSON.parse(await fs.readFile(pfad, "utf-8"));
  } catch {
    return standard;
  }
}

function hatDokuWort(titel) {
  return DOKU_WORT.test(titel || "");
}

function istTmdbDoku(m) {
  return (m.genreIds || []).includes(TMDB_GENRE_DOKU);
}

async function main() {
  const filme = await lade(FILME_PATH, []);
  const unmatched = await lade(UNMATCHED_PATH, []);
  const duplicates = await lade(DUPLICATES_PATH, []);
  const ignored = await lade(IGNORED_PATH, []);
  const protokoll = await lade(PROTOKOLL_PATH, []);
  const rejected = await lade(REJECTED_PATH, {});
  const keineDoku = new Set(await lade(KEINE_DOKU_PATH, []));

  const heute = new Date().toISOString().slice(0, 10);
  const ignoredSet = new Set(ignored);
  const dokuTmdbIds = new Set();

  // -- Bibliothek --
  const behalten = [];
  let nachWort = 0;
  let nachGenre = 0;
  let neuSuchen = 0;
  for (const m of filme) {
    if (m.matchSource === "manuell") {
      behalten.push(m);
      continue;
    }
    const wort = hatDokuWort(m.youtubeTitle);
    const genre = istTmdbDoku(m);
    if (!wort && !genre) {
      behalten.push(m);
      continue;
    }

    // Spielfilm mit falscher Doku-Zuordnung: Zuordnung sperren, neu suchen
    if (!wort && (SPIELFILM_SIGNAL.test(m.youtubeTitle || "") || keineDoku.has(m.videoId))) {
      const liste = rejected[m.videoId] || [];
      if (!liste.includes(m.tmdbId)) liste.push(m.tmdbId);
      rejected[m.videoId] = liste;
      neuSuchen++;
      protokoll.push({
        datum: heute,
        quelle: "filme.json",
        grund: "Spielfilm mit falscher Doku-Zuordnung -- wird neu gesucht",
        videoId: m.videoId,
        youtubeTitle: m.youtubeTitle,
        title: m.title,
        tmdbId: m.tmdbId ?? null,
        channelName: m.channelName,
      });
      continue;
    }

    if (m.tmdbId) dokuTmdbIds.add(m.tmdbId);
    if (wort) nachWort++;
    else nachGenre++;
    // Nur über das Genre erkannt -> sonst würde das Video jede Nacht neu
    // zugeordnet und gleich wieder entfernt.
    if (!wort && !ignoredSet.has(m.videoId)) {
      ignored.push(m.videoId);
      ignoredSet.add(m.videoId);
    }
    protokoll.push({
      datum: heute,
      quelle: "filme.json",
      grund: wort ? "Doku-Wort im Videotitel" : "TMDB-Genre Dokumentarfilm",
      videoId: m.videoId,
      youtubeTitle: m.youtubeTitle,
      title: m.title,
      tmdbId: m.tmdbId ?? null,
      channelName: m.channelName,
    });
  }

  // -- Nicht zugeordnete --
  const unmatchedBehalten = [];
  let ausUnmatched = 0;
  for (const u of unmatched) {
    if (hatDokuWort(u.youtubeTitle)) {
      ausUnmatched++;
      protokoll.push({ datum: heute, quelle: "unmatched.json", grund: "Doku-Wort im Videotitel", videoId: u.videoId, youtubeTitle: u.youtubeTitle });
      continue;
    }
    unmatchedBehalten.push(u);
  }

  // -- Duplikate (Ersatz-Uploads) --
  const duplicatesBehalten = [];
  let ausDuplikaten = 0;
  for (const d of duplicates) {
    if (hatDokuWort(d.youtubeTitle) || dokuTmdbIds.has(d.tmdbId)) {
      ausDuplikaten++;
      continue; // nicht einzeln protokolliert -- sie waren nie sichtbar
    }
    duplicatesBehalten.push(d);
  }

  const geaendert = behalten.length !== filme.length || ausUnmatched > 0 || ausDuplikaten > 0;
  if (geaendert) {
    await fs.writeFile(FILME_PATH, JSON.stringify(behalten, null, 2), "utf-8");
    await fs.writeFile(UNMATCHED_PATH, JSON.stringify(unmatchedBehalten, null, 2), "utf-8");
    await fs.writeFile(DUPLICATES_PATH, JSON.stringify(duplicatesBehalten, null, 2), "utf-8");
    await fs.writeFile(IGNORED_PATH, JSON.stringify(ignored, null, 2), "utf-8");
    await fs.writeFile(PROTOKOLL_PATH, JSON.stringify(protokoll, null, 2), "utf-8");
    await fs.writeFile(REJECTED_PATH, JSON.stringify(rejected, null, 2), "utf-8");
  }

  console.log(`Dokus aus der Bibliothek entfernt: ${nachWort + nachGenre} (Doku-Wort im Titel: ${nachWort}, nur TMDB-Genre: ${nachGenre})`);
  console.log(`Spielfilme mit falscher Doku-Zuordnung, werden neu gesucht: ${neuSuchen}`);
  console.log(`Dokus aus unmatched.json entfernt: ${ausUnmatched}`);
  console.log(`Dokus aus duplicates.json entfernt: ${ausDuplikaten}`);
  console.log(`Bibliothek jetzt:                  ${behalten.length}`);
}

main();
