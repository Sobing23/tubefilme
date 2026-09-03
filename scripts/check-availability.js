// Prüft, ob die Filme der Bibliothek bei YouTube überhaupt noch abspielbar
// sind -- und zwar nicht nur, ob das Video existiert.
//
// Ein Film kann aus vier Gründen für Besucher nicht funktionieren:
//
//   1. geloescht     Video existiert nicht mehr (oder wurde auf privat gesetzt)
//   2. nicht_oeffentlich  existiert, ist aber nicht öffentlich
//   3. nicht_einbettbar   existiert und ist öffentlich, darf aber nicht auf
//                         fremden Seiten eingebettet werden -- genau das
//                         erzeugt bei uns den schwarzen Kasten, obwohl das
//                         Video bei YouTube selbst einwandfrei läuft
//   4. gesperrt_de   in Deutschland nicht abrufbar
//
// Punkt 3 wird gerne übersehen: Das Video ist auffindbar, unser Player kann
// es aber nicht zeigen. Ohne diese Prüfung bliebe genau dieser Fall unentdeckt.
//
// Das Werkzeug ÄNDERT NICHTS an der Bibliothek. Es schreibt ausschließlich
// data/unavailable.json -- was damit geschieht (Weiterleitung, Hinweis auf der
// Seite, Löschen), wird bewusst getrennt entschieden.
//
// Aufrufbeispiele:
//   node scripts/check-availability.js
//   node scripts/check-availability.js --kanal "Netzkino"
//   node scripts/check-availability.js --video dQw4w9WgXcQ
//   node scripts/check-availability.js --limit 200

import fs from "fs/promises";

const API_KEY = process.env.YOUTUBE_API_KEY;
const FILME_PATH = "data/filme.json";
const OUT_PATH = "data/unavailable.json";
const BATCH = 50; // so viele IDs nimmt die Schnittstelle pro Abfrage entgegen
const DELAY_MS = 60;

if (!API_KEY) {
  console.error("Fehler: YOUTUBE_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Sehr einfache Auswertung der Aufrufparameter -- bewusst ohne Zusatzpaket.
function leseArgumente() {
  const args = process.argv.slice(2);
  const opt = { kanal: null, video: null, limit: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kanal") opt.kanal = args[++i];
    else if (args[i] === "--video") opt.video = args[++i];
    else if (args[i] === "--limit") opt.limit = parseInt(args[++i], 10);
  }
  return opt;
}

async function frageStapelAb(ids) {
  const url =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=status,contentDetails,snippet&id=${ids.join(",")}&key=${API_KEY}`;

  const res = await fetch(url);
  if (res.status === 403) {
    const text = await res.text();
    throw new Error(`Zugriff verweigert (Kontingent erschöpft?): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`YouTube-Fehler ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return json.items || [];
}

// Entscheidet für ein vorhandenes Video, ob es für unsere Besucher nutzbar ist.
function pruefeVideo(item) {
  const status = item.status || {};
  const regionen = (item.contentDetails || {}).regionRestriction || {};

  if (status.privacyStatus && status.privacyStatus !== "public") {
    return { grund: "nicht_oeffentlich", detail: status.privacyStatus };
  }
  if (status.uploadStatus && status.uploadStatus !== "processed") {
    return { grund: "nicht_verfuegbar", detail: status.uploadStatus };
  }
  if (status.embeddable === false) {
    return { grund: "nicht_einbettbar", detail: "Einbetten vom Kanal untersagt" };
  }
  if (Array.isArray(regionen.blocked) && regionen.blocked.includes("DE")) {
    return { grund: "gesperrt_de", detail: "in Deutschland gesperrt" };
  }
  if (Array.isArray(regionen.allowed) && !regionen.allowed.includes("DE")) {
    return { grund: "gesperrt_de", detail: "nur in anderen Ländern freigegeben" };
  }
  return null;
}

async function main() {
  const opt = leseArgumente();
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));

  let zuPruefen = filme;
  if (opt.video) {
    zuPruefen = filme.filter((m) => m.videoId === opt.video);
    if (zuPruefen.length === 0) {
      console.log(`Video ${opt.video} ist nicht in der Bibliothek.`);
      return;
    }
  } else if (opt.kanal) {
    zuPruefen = filme.filter((m) => m.channelName === opt.kanal);
    if (zuPruefen.length === 0) {
      console.log(`Kein Film vom Kanal "${opt.kanal}" gefunden.`);
      const kanaele = [...new Set(filme.map((m) => m.channelName))].sort();
      console.log("Vorhandene Kanäle:", kanaele.join(", "));
      return;
    }
  }
  if (opt.limit) zuPruefen = zuPruefen.slice(0, opt.limit);

  const abfragen = Math.ceil(zuPruefen.length / BATCH);
  console.log(`Prüfe ${zuPruefen.length} Filme in ${abfragen} Abfragen...\n`);

  const nichtVerfuegbar = [];
  const nachGrund = {};
  let geprueft = 0;

  for (let i = 0; i < zuPruefen.length; i += BATCH) {
    const stapel = zuPruefen.slice(i, i + BATCH);
    const ids = stapel.map((m) => m.videoId);

    let items;
    try {
      items = await frageStapelAb(ids);
    } catch (err) {
      console.error(`Abbruch bei Abfrage ${Math.floor(i / BATCH) + 1}: ${err.message}`);
      break;
    }

    const gefunden = new Map(items.map((it) => [it.id, it]));

    for (const film of stapel) {
      const item = gefunden.get(film.videoId);

      // Nicht in der Antwort enthalten = existiert nicht mehr oder ist privat
      const befund = item
        ? pruefeVideo(item)
        : { grund: "geloescht", detail: "Video nicht mehr abrufbar" };

      if (befund) {
        nichtVerfuegbar.push({
          videoId: film.videoId,
          title: film.title,
          channelName: film.channelName,
          tmdbId: film.tmdbId ?? null,
          grund: befund.grund,
          detail: befund.detail,
          geprueftAm: new Date().toISOString().slice(0, 10),
        });
        nachGrund[befund.grund] = (nachGrund[befund.grund] || 0) + 1;
      }
    }

    geprueft += stapel.length;
    if (abfragen > 20 && (i / BATCH) % 20 === 19) {
      console.log(`... ${geprueft} / ${zuPruefen.length} geprüft`);
    }
    await sleep(DELAY_MS);
  }

  // Bei Teilprüfungen (einzelner Film, ein Kanal) die Befunde der übrigen
  // Filme erhalten -- sonst würde eine Prüfung eines Kanals alle vorherigen
  // Ergebnisse verwerfen.
  let bestand = [];
  try {
    bestand = JSON.parse(await fs.readFile(OUT_PATH, "utf-8"));
  } catch {
    // noch keine Datei
  }
  const geprueftIds = new Set(zuPruefen.map((m) => m.videoId));
  const uebrig = bestand.filter((e) => !geprueftIds.has(e.videoId));
  const gesamt = [...uebrig, ...nichtVerfuegbar];

  await fs.writeFile(OUT_PATH, JSON.stringify(gesamt, null, 2), "utf-8");

  console.log(`\nGeprüft:            ${geprueft}`);
  console.log(`Nicht abspielbar:   ${nichtVerfuegbar.length}`);
  if (Object.keys(nachGrund).length) {
    console.log("\nNach Grund:");
    const bezeichnung = {
      geloescht: "gelöscht oder privat gestellt",
      nicht_oeffentlich: "nicht öffentlich",
      nicht_einbettbar: "Einbetten untersagt (läuft nur auf YouTube selbst)",
      gesperrt_de: "in Deutschland gesperrt",
      nicht_verfuegbar: "noch nicht verarbeitet / nicht verfügbar",
    };
    Object.entries(nachGrund)
      .sort((a, b) => b[1] - a[1])
      .forEach(([g, n]) => console.log(`  ${String(n).padStart(4)}  ${bezeichnung[g] || g}`));
  }

  if (nichtVerfuegbar.length) {
    console.log("\nBeispiele:");
    nichtVerfuegbar.slice(0, 10).forEach((e) =>
      console.log(`  [${e.channelName}] ${e.title} -- ${e.grund}`)
    );
  }

  console.log(`\nGesamtstand in ${OUT_PATH}: ${gesamt.length} Filme`);
  console.log("Hinweis: Die Bibliothek wurde NICHT verändert.");
}

main();
