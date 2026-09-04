// Wertet data/unavailable.json aus und repariert die Bibliothek, soweit
// möglich -- ohne dass sich für Besucher oder Suchmaschinen eine Adresse
// ändert.
//
// Zwei Fälle:
//
//   1. Ersatz vorhanden
//      Derselbe Film (gleiche tmdbId) liegt als Zweitupload eines anderen
//      Kanals in data/duplicates.json. Dann wird im bestehenden Eintrag
//      lediglich die Video-ID ausgetauscht. Adresse, Seite, Titel und alle
//      Metadaten bleiben unverändert -- nur das Video läuft wieder. Das ist
//      einer Weiterleitung deutlich vorzuziehen: Für Besucher passiert
//      nichts Sichtbares, und aufgebaute Sichtbarkeit bei Suchmaschinen
//      geht nicht verloren.
//
//   2. Kein Ersatz
//      Der Film wird als nicht verfügbar gekennzeichnet. Er verschwindet
//      aus dem Kachelraster und aus der Sitemap, seine Seite bleibt aber
//      bestehen (mit Hinweis und Vorschlägen), damit bestehende Verweise
//      von außen nicht ins Leere laufen.
//
// Filme, die in unavailable.json NICHT mehr auftauchen, gelten wieder als
// verfügbar -- so verschwindet die Kennzeichnung von selbst, wenn ein
// Kanal ein Video wieder freischaltet.
//
// In Deutschland gesperrte Filme werden wie tote behandelt: Das Video ist
// zwar intakt, für das hiesige Publikum aber nicht abspielbar.

import fs from "fs/promises";

const API_KEY = process.env.YOUTUBE_API_KEY;

// Prüft eine Liste von Video-IDs bei YouTube und gibt zurück, welche davon
// tatsächlich abspielbar sind.
//
// Das ist zwingend nötig: Die Ersatz-Uploads stammen aus duplicates.json und
// wurden nie auf Verfügbarkeit geprüft -- die Prüfung lief nur über die
// Bibliothek. Ohne diesen Schritt wird ein totes Video womöglich durch ein
// ebenso totes ersetzt, und der Fehler bleibt unbemerkt.
async function pruefeAbspielbar(ids) {
  const abspielbar = new Set();
  if (!API_KEY || ids.length === 0) return abspielbar;

  for (let i = 0; i < ids.length; i += 50) {
    const stapel = ids.slice(i, i + 50);
    const url =
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=status,contentDetails&id=${stapel.join(",")}&key=${API_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      for (const item of json.items || []) {
        const st = item.status || {};
        const reg = (item.contentDetails || {}).regionRestriction || {};
        if (st.privacyStatus && st.privacyStatus !== "public") continue;
        if (st.embeddable === false) continue;
        if (Array.isArray(reg.blocked) && reg.blocked.includes("DE")) continue;
        if (Array.isArray(reg.allowed) && !reg.allowed.includes("DE")) continue;
        abspielbar.add(item.id);
      }
    } catch {
      // Bei einem Fehler lieber keinen Ersatz einsetzen als einen ungeprüften
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return abspielbar;
}

const FILME_PATH = "data/filme.json";
const UNAVAILABLE_PATH = "data/unavailable.json";
const DUPLICATES_PATH = "data/duplicates.json";
const REPAIR_LOG = "data/repaired.json";

async function leseJson(pfad, standard) {
  try {
    return JSON.parse(await fs.readFile(pfad, "utf-8"));
  } catch {
    return standard;
  }
}

async function main() {
  const filme = await leseJson(FILME_PATH, []);
  const unavailable = await leseJson(UNAVAILABLE_PATH, []);
  const duplicates = await leseJson(DUPLICATES_PATH, []);

  if (unavailable.length === 0) {
    console.log("Keine nicht abspielbaren Filme vermerkt -- nichts zu tun.");
    return;
  }

  const totIds = new Set(unavailable.map((e) => e.videoId));
  const befundNachVideo = new Map(unavailable.map((e) => [e.videoId, e]));

  // Video-IDs, die bereits in der Bibliothek stehen -- ein Ersatz darf nicht
  // auf einen Upload zeigen, der ohnehin schon als eigener Film geführt wird.
  const inBibliothek = new Set(filme.map((m) => m.videoId));

  // Alle in Frage kommenden Ersatz-Uploads vorab sammeln und in einem Zug
  // gegen YouTube prüfen -- ein einziger Aufruf je 50 Kandidaten.
  const kandidatenIds = new Set();
  for (const film of filme) {
    if (!befundNachVideo.has(film.videoId) || !film.tmdbId) continue;
    duplicates
      .filter((d) => d.tmdbId === film.tmdbId && d.videoId !== film.videoId && !totIds.has(d.videoId) && !inBibliothek.has(d.videoId))
      .forEach((d) => kandidatenIds.add(d.videoId));
  }

  const geprueftAbspielbar = await pruefeAbspielbar([...kandidatenIds]);
  console.log(`Ersatzkandidaten geprüft: ${kandidatenIds.size}, davon abspielbar: ${geprueftAbspielbar.size}\n`);

  const reparaturen = [];
  const verbrauchteErsatzIds = new Set();
  let getauscht = 0;
  let markiert = 0;
  let entmarkiert = 0;

  for (const film of filme) {
    const befund = befundNachVideo.get(film.videoId);

    // Film ist (wieder) in Ordnung -> alte Kennzeichnung entfernen
    if (!befund) {
      if (film.verfuegbar === false) {
        delete film.verfuegbar;
        delete film.nichtVerfuegbarGrund;
        entmarkiert++;
      }
      continue;
    }

    // Ersatz suchen: gleicher Film, anderer Upload, selbst nicht tot,
    // noch nicht anderweitig vergeben und nicht schon in der Bibliothek
    const ersatz = film.tmdbId
      ? duplicates.find(
          (d) =>
            d.tmdbId === film.tmdbId &&
            d.videoId !== film.videoId &&
            !totIds.has(d.videoId) &&
            !verbrauchteErsatzIds.has(d.videoId) &&
            !inBibliothek.has(d.videoId) &&
            geprueftAbspielbar.has(d.videoId)
        )
      : null;

    if (ersatz) {
      reparaturen.push({
        titel: film.title,
        alterUpload: `${film.channelName} (${film.videoId})`,
        neuerUpload: `${ersatz.channelName} (${ersatz.videoId})`,
        grund: befund.grund,
        ersetztAm: new Date().toISOString().slice(0, 10),
      });

      film.videoId = ersatz.videoId;
      film.channelName = ersatz.channelName;
      film.channelId = ersatz.channelId || film.channelId;
      film.youtubeTitle = ersatz.youtubeTitle || film.youtubeTitle;
      // Das Vorschaubild gehört zum alten Video und wäre nicht mehr abrufbar
      film.youtubeThumbnail = `https://i.ytimg.com/vi/${ersatz.videoId}/hqdefault.jpg`;
      delete film.verfuegbar;
      delete film.nichtVerfuegbarGrund;

      verbrauchteErsatzIds.add(ersatz.videoId);
      inBibliothek.add(ersatz.videoId);
      getauscht++;
      continue;
    }

    // Kein Ersatz -> kennzeichnen
    film.verfuegbar = false;
    film.nichtVerfuegbarGrund = befund.grund;
    markiert++;
  }

  // Ausgetauschte Uploads sind jetzt Hauptfassung und keine Duplikate mehr;
  // die toten Uploads wandern stattdessen dorthin, damit sie beim nächsten
  // Lauf nicht erneut als neuer Film aufgenommen werden.
  const bereinigteDuplikate = duplicates.filter((d) => !verbrauchteErsatzIds.has(d.videoId));
  for (const r of reparaturen) {
    const alteId = r.alterUpload.match(/\(([^)]+)\)$/)[1];
    if (!bereinigteDuplikate.some((d) => d.videoId === alteId)) {
      bereinigteDuplikate.push({
        videoId: alteId,
        youtubeTitle: r.titel,
        channelName: r.alterUpload.replace(/\s*\([^)]+\)$/, ""),
        tmdbId: null,
        title: r.titel,
        hinweis: `bei YouTube nicht mehr abspielbar (${r.grund}), durch anderen Upload ersetzt`,
      });
    }
  }

  // Erledigte Fälle aus der Liste der nicht abspielbaren Filme entfernen
  const getauschteAlteIds = new Set(
    reparaturen.map((r) => r.alterUpload.match(/\(([^)]+)\)$/)[1])
  );
  const verbleibend = unavailable.filter((e) => !getauschteAlteIds.has(e.videoId));

  // Reparaturprotokoll fortschreiben
  const bisherige = await leseJson(REPAIR_LOG, []);
  await fs.writeFile(REPAIR_LOG, JSON.stringify([...bisherige, ...reparaturen], null, 2), "utf-8");

  await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  await fs.writeFile(UNAVAILABLE_PATH, JSON.stringify(verbleibend, null, 2), "utf-8");
  await fs.writeFile(DUPLICATES_PATH, JSON.stringify(bereinigteDuplikate, null, 2), "utf-8");

  console.log(`Durch Ersatz-Upload repariert:      ${getauscht}`);
  console.log(`Als nicht verfügbar gekennzeichnet: ${markiert}`);
  console.log(`Kennzeichnung wieder entfernt:      ${entmarkiert}`);
  console.log(`Verbleibend in unavailable.json:    ${verbleibend.length}`);

  if (reparaturen.length) {
    console.log("\nBeispiele für reparierte Filme:");
    reparaturen.slice(0, 8).forEach((r) =>
      console.log(`  ${r.titel}\n     ${r.alterUpload}  ->  ${r.neuerUpload}`)
    );
  }
}

main();
