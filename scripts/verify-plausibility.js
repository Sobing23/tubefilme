// Plausibilitätsprüfung aller TMDB-Zuordnungen -- läuft in der Neu-Zuordnung
// VOR match-tmdb.js, damit verworfene Filme im selben Lauf neu gesucht werden.
//
// Hintergrund (Prüfung vom 10.10.2026): 76 Filme standen unter einem Titel in
// der Bibliothek, der weder zum Videotitel noch zur "Originaltitel:"-Zeile
// passte und dessen Besetzung nicht bestätigt war -- "Fremde Verwandte" als
// "Ring 2", CinemaLegenden-Werbetitel als "Mission: Impossible" oder
// "Guardians of the Galaxy 3". Zwei Ursachen: Zuordnungen aus der alten
// Logik mit "hoch" ohne Begründung, die reset-for-rematch.js nie anfasst, und
// Allerweltsbegriffe aus Werbetiteln, die auf Blockbuster trafen.
//
// Rund ein Drittel dieser Fälle ist aber RICHTIG -- nur unter einem anderen
// deutschen Verleihtitel ("Lanky Fellow" = "Ohne Dollar keinen Sarg"). Darum
// wird nicht blind verworfen, sondern in Stufen bestätigt:
//
//   1. TMDB-Titel oder -Originaltitel kommt im Videotitel/der Beschreibung vor
//   2. "Originaltitel:"-Zeile passt zum TMDB-Titel/-Originaltitel
//   3. Besetzung/Regie aus der Beschreibung passt zur gespeicherten Besetzung
//   4. Ein ALTERNATIVTITEL von TMDB (alle Länder) passt zu Videotitel oder
//      Originaltitel-Zeile  -> eine TMDB-Anfrage je Film, nur hier nötig
//
// Greift keine Stufe, wird die Zuordnung gesperrt (rejected-matches.json)
// und der Film aus der Bibliothek genommen; match-tmdb.js sucht ihn dann ohne
// diesen Kandidaten neu. Findet sich nichts Besseres, übernimmt
// absorb-unmatched.js ihn mit seinen YouTube-Angaben -- besser als ein
// falscher Film mit falschem Poster.
//
// Geprüfte Filme bekommen das Feld "plausibel" (Stufe, die bestätigt hat),
// damit der nächste Lauf sie nicht erneut abfragt. Manuelle Zuordnungen sind
// ausgenommen. Protokoll der Verwerfungen: data/aussortiert.json.

import fs from "fs/promises";

const FILME_PATH = "data/filme.json";
const CANDIDATES_PATH = "data/candidates.json";
const REJECTED_PATH = "data/rejected-matches.json";
const PROTOKOLL_PATH = "data/aussortiert.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
const BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const DELAY_MS = 120;
const NUR_PRUEFEN = process.argv.includes("--nur-pruefen"); // nichts schreiben, nur berichten

if (!BEARER_TOKEN && !NUR_PRUEFEN) {
  console.error("Fehler: TMDB_BEARER_TOKEN ist nicht gesetzt.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lade(pfad, standard) {
  try {
    return JSON.parse(await fs.readFile(pfad, "utf-8"));
  } catch {
    return standard;
  }
}

// -- Textvergleich --

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPP = new Set(
  ("der die das und the ein eine von mit auf of and in a an le la les il el los las den dem des to " +
    "ganzer film filme deutsch kostenlos voller lange komplett hd ganze teil jetzt neu").split(" ")
);

function woerter(s) {
  return new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOPP.has(w)));
}

// Anteil der Wörter des kürzeren Textes, die im anderen vorkommen (0..1).
function ueberschneidung(a, b) {
  const A = woerter(a);
  const B = woerter(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size);
}

const PASST_AB = 0.5;

// Titel in seine Segmente zerlegen ("Tiefschnee - Winter der Rache" ->
// ["Tiefschnee", "Winter der Rache"]). Deutsche Verleihtitel hängen oft
// einen Zusatz an, den der Videotitel nicht nennt -- ein passendes Segment
// genügt.
function segmente(titel) {
  return (titel || "")
    .split(/\s[-–—:|]\s|:\s/)
    .map((t) => t.trim())
    .filter((t) => woerter(t).size >= 1 && norm(t).replace(/ /g, "").length >= 4);
}

// Anteil der Wörter von a, die in b vorkommen.
function anteilEnthalten(a, b) {
  const A = woerter(a);
  const B = woerter(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / A.size;
}

// Segmente des Videotitels ohne Symbole und Klammern -- eines davon trägt bei
// den meisten Kanälen den Filmnamen ("Ermittlung gegen die Mächtigen | Der
// Superbulle (1978) | Krimi").
function videotitelKerne(t) {
  return (t || "")
    .split(/\s*[|]\s*|\s[-–—]\s/)
    .map((x) => x.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s*[(\[].*$/, "").trim())
    .filter((x) => norm(x).replace(/ /g, "").length >= 4);
}

// Passt der TMDB-Titel (oder Originaltitel) zum Video?
function titelPasst(m, quelle) {
  for (const t of [m.title, m.originalTitle]) {
    if (!t) continue;
    if (ueberschneidung(t, quelle) >= PASST_AB) return true;
    if (anteilEnthalten(t, quelle) >= PASST_AB) return true;
    for (const seg of segmente(t)) {
      if (anteilEnthalten(seg, quelle) >= 0.67) return true;
    }
    // Umgekehrt: ein Segment des Videotitels steckt vollständig im TMDB-Titel
    // ("Der Superbulle" in "Der Superbulle jagt den Paten")
    for (const kern of videotitelKerne(m.youtubeTitle)) {
      if (woerter(kern).size >= 1 && anteilEnthalten(kern, t) >= 0.75) return true;
      // Zahlen ohne Leerzeichen ("8MM2" vs "8MM 2")
      const a = norm(kern).replace(/ /g, ""), b = norm(t).replace(/ /g, "");
      if (a.length >= 4 && b.length >= 4 && (b.startsWith(a) || a.startsWith(b))) return true;
    }
  }
  return false;
}

function originaltitelZeile(desc) {
  const m = (desc || "").match(/(?:Originaltitel|Originalname Film):\s*(.+)/);
  if (!m) return null;
  return m[1].trim().replace(/\s*\(.*$/, "").replace(/,\s*(19|20)\d\d.*$/, "").trim() || null;
}

// Personen aus der Beschreibung ("Mit:", "Regie:") -- gleiche Logik wie in
// match-tmdb.js, hier bewusst knapp gehalten.
function personenAusBeschreibung(desc) {
  const namen = [];
  for (const re of [/^\s*(?:Mit|Darsteller):\s*(.+)$/m, /^\s*Regie:\s*(.+)$/m]) {
    const m = (desc || "").match(re);
    if (!m) continue;
    m[1]
      .replace(/\([^)]*\)/g, "")
      .split(/[;,&]|\s+und\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 60)
      .forEach((s) => namen.push(s));
  }
  return namen;
}

function personenPassen(erwartet, gespeichert) {
  if (!erwartet.length || !gespeichert.length) return false;
  const hay = norm(gespeichert.join(" | "));
  const treffer = erwartet.filter((n) => {
    const nn = norm(n);
    if (!nn) return false;
    if (hay.includes(nn)) return true;
    const nach = nn.split(" ").pop();
    return nach && nach.length > 3 && hay.includes(nach);
  }).length;
  return treffer / erwartet.length >= 0.34;
}

async function alternativtitel(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/alternative_titles`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429) {
    await sleep(1000);
    return alternativtitel(tmdbId);
  }
  if (!res.ok) throw new Error(`TMDB Fehler ${res.status}`);
  const json = await res.json();
  return (json.titles || []).map((t) => t.title).filter(Boolean);
}

async function main() {
  const filme = await lade(FILME_PATH, []);
  const candidates = await lade(CANDIDATES_PATH, []);
  const rejected = await lade(REJECTED_PATH, {});
  const protokoll = await lade(PROTOKOLL_PATH, []);
  const candById = new Map(candidates.map((c) => [c.videoId, c]));
  const heute = new Date().toISOString().slice(0, 10);

  const stufen = { titel: 0, originaltitel: 0, besetzung: 0, alternativtitel: 0 };
  const verworfen = [];
  let uebersprungen = 0;
  let fehler = 0;
  let anfragen = 0;

  const behalten = [];
  for (const m of filme) {
    if (!m.tmdbId || m.matchSource === "manuell" || m.plausibel) {
      behalten.push(m);
      if (m.plausibel) uebersprungen++;
      continue;
    }
    const video = candById.get(m.videoId);
    const desc = video ? video.description || "" : "";
    const quelle = `${m.youtubeTitle || ""} ${desc.slice(0, 800)}`;
    const ot = originaltitelZeile(desc);

    let stufe = null;
    if (titelPasst(m, quelle)) {
      stufe = "titel";
    } else if (ot && Math.max(ueberschneidung(ot, m.title), ueberschneidung(ot, m.originalTitle)) >= PASST_AB) {
      stufe = "originaltitel";
    } else if (/stimmen mit/.test(m.hinweis || "") || personenPassen(personenAusBeschreibung(desc), [...(m.cast || []), ...(m.director || [])])) {
      stufe = "besetzung";
    } else if (!NUR_PRUEFEN) {
      try {
        anfragen++;
        const alt = await alternativtitel(m.tmdbId);
        await sleep(DELAY_MS);
        const treffer = alt.find(
          (t) => ueberschneidung(t, m.youtubeTitle) >= PASST_AB || (ot && ueberschneidung(t, ot) >= PASST_AB)
        );
        if (treffer) {
          stufe = "alternativtitel";
          m.hinweis = [m.hinweis, `Alternativtitel bei TMDB bestätigt: "${treffer}"`].filter(Boolean).join(" · ");
        }
      } catch (err) {
        fehler++;
        console.log(`   Fehler bei "${m.title}": ${err.message} -- bleibt vorerst`);
        behalten.push(m);
        continue;
      }
    }

    if (stufe) {
      stufen[stufe]++;
      m.plausibel = stufe;
      behalten.push(m);
      continue;
    }

    if (NUR_PRUEFEN) {
      verworfen.push(m);
      behalten.push(m);
      continue;
    }

    const liste = rejected[m.videoId] || [];
    if (!liste.includes(m.tmdbId)) liste.push(m.tmdbId);
    rejected[m.videoId] = liste;
    protokoll.push({
      datum: heute,
      quelle: "filme.json",
      grund: "Plausibilität: weder Titel, Originaltitel, Besetzung noch Alternativtitel passen -- wird neu gesucht",
      videoId: m.videoId,
      youtubeTitle: m.youtubeTitle,
      title: m.title,
      tmdbId: m.tmdbId,
      channelName: m.channelName,
    });
    verworfen.push(m);
  }

  if (!NUR_PRUEFEN) {
    await fs.writeFile(FILME_PATH, JSON.stringify(behalten, null, 2), "utf-8");
    await fs.writeFile(REJECTED_PATH, JSON.stringify(rejected, null, 2), "utf-8");
    await fs.writeFile(PROTOKOLL_PATH, JSON.stringify(protokoll, null, 2), "utf-8");
  }

  console.log(`Plausibilität geprüft (${uebersprungen} bereits früher bestätigt übersprungen)`);
  console.log(`Bestätigt über Titel: ${stufen.titel}, Originaltitel: ${stufen.originaltitel}, Besetzung: ${stufen.besetzung}, Alternativtitel: ${stufen.alternativtitel} (${anfragen} TMDB-Anfragen)`);
  console.log(`${NUR_PRUEFEN ? "Würden verworfen" : "Verworfen, werden neu gesucht"}: ${verworfen.length}${fehler ? ` (${fehler} Fehler, bleiben vorerst)` : ""}`);
  for (const m of verworfen) {
    console.log(`   [${m.channelName}] ${m.youtubeTitle.slice(0, 60)}  ->  ${m.title} (${(m.releaseDate || "").slice(0, 4) || "?"})`);
  }
  console.log(`Bibliothek jetzt: ${behalten.length}`);
}

main();
