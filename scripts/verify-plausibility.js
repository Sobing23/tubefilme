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
import { extractPeople, personenAnteil } from "./lib/namen.js";

const FILME_PATH = "data/filme.json";
const CANDIDATES_PATH = "data/candidates.json";
const REJECTED_PATH = "data/rejected-matches.json";
const PROTOKOLL_PATH = "data/aussortiert.json";
const KORREKTUREN_PATH = "data/titel-korrekturen.json";
const TMDB_BASE = "https://api.themoviedb.org/3";
// Wird die Prüflogik verschärft, zählt diese Nummer hoch: Einträge mit
// älterer (oder ohne) Version werden erneut geprüft. Version 2 (11.10.2026):
// Vergleich in beide Richtungen, keine Ein-Wort-Treffer gegen den Fließtext.
// Version 3 (13.10.2026): Laufzeit-Widerspruch auch bei Videos unter 40 min.
// Version 4 (21.10.2026): Besetzung nach scripts/lib/namen.js (Nachname
// allein reicht nicht, wenn der Vorname widerspricht), Personen auch aus dem
// Videotitel ("mit Keith Carradine"); der Hinweistext einer früheren Suche
// zählt nur noch, wenn das Video gar keine Namen nennt.
const PRUEF_VERSION = 4;
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

const ROEMISCH = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Römische Zahlen als Wort -> Ziffer ("Phantasm IV" = "Das Böse 4")
    .split(" ")
    .map((w) => ROEMISCH[w] || w)
    .join(" ");
}

// Achtung: in der Schreibweise NACH norm() -- Umlaute verlieren die Punkte
// ("Komödie" -> "komodie", "Märchen" -> "marchen"), ß wird "ss".
const STOPP = new Set(
  ("der die das und the ein eine von mit auf of and in a an le la les il el los las den dem des to " +
    "ganzer film filme deutsch kostenlos voller komplett kompletter hd 4k uhd ganze ganzen teil jetzt neu neue neuer " +
    // Gattungs- und Werbewörter aus Videotiteln -- sie sagen nichts über den Film
    "krimi thriller action actionfilm komodie western drama horror horrorfilm abenteuer abenteuerfilm kriegsfilm " +
    "spielfilm kino klassiker kultfilm german stream online ansehen anschauen full movie " +
    "familienfilm kinderfilm trickfilm zeichentrick animationsfilm liebesfilm marchen marchenfilm defa uncut remastered").split(" ")
);

// Bedeutungstragende Wörter; einzelne Ziffern zählen mit ("Das Böse 5"),
// Jahreszahlen nicht ("Heimatland, 1955" = "Heimatland").
function woerter(s) {
  return new Set(
    norm(s)
      .split(" ")
      .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOPP.has(w) && !/^(18|19|20)\d\d$/.test(w))
  );
}

function gleicheWoerter(A, B) {
  return A.size > 0 && A.size === B.size && [...A].every((w) => B.has(w));
}

// Passen zwei Titel zusammen? Bewusst in BEIDE Richtungen gemessen (am
// längeren Text), nicht am kürzeren: Der alte Vergleich ließ "Hercules"
// gegen "Hercules - Die grosse Schlacht um Hellas" und "The Family" gegen
// "The Boss Baby: Family Business" durch, weil das eine Wort im anderen
// vorkam. Ein Titel passt, wenn
//   - beide normalisiert gleich sind, oder
//   - mindestens die Hälfte der Wörter des LÄNGEREN im anderen vorkommt, oder
//   - der kürzere mindestens zwei bedeutungstragende Wörter hat und
//     vollständig im längeren steckt ("Wo waren Sie, Dr. Highley?" in
//     "Mary Higgins Clark - Mysteriöse Verbrechen: Wo waren Sie, Dr. Highley?"), oder
//   - der Videokandidat den TMDB-Titel BEGINNT ("Der Superbulle" | ... ->
//     "Der Superbulle jagt den Paten"). Nur in dieser Richtung: Beginnt
//     umgekehrt der TMDB-Titel den Videotitel ("Hercules" ->  "Hercules -
//     Die grosse Schlacht um Hellas"), ist das genauso oft ein anderer Film
//     wie ein fehlender Untertitel -- das entscheidet die Alternativtitel-
//     Stufe.
// Reihenfolge der Argumente: zuerst der TMDB-Titel, dann der Videokandidat.
function passt(tmdb, kandidat) {
  const nt = norm(tmdb), nk = norm(kandidat);
  if (!nt || !nk) return false;
  if (nt === nk) return true;
  const T = woerter(tmdb), K = woerter(kandidat);
  if (!T.size || !K.size) return false;
  if (gleicheWoerter(T, K)) return true; // "Die Kampfmaschine – Uncut" = "Die Kampfmaschine"
  const gemeinsam = [...T].filter((w) => K.has(w)).length;
  // Ein einzelnes gemeinsames Wort reicht nie ("Family Business" ~ "The
  // Family"); gleiche Einwort-Titel fängt gleicheWoerter oben.
  if (gemeinsam >= 2 && gemeinsam / Math.max(T.size, K.size) >= 0.5) return true;
  const kleiner = Math.min(T.size, K.size);
  if (kleiner >= 2 && gemeinsam === kleiner) return true;
  if (nk.length >= 5 && nt.startsWith(nk + " ")) return true;
  // Ohne Leerzeichen: "8MM2" = "8MM 2 - Hölle aus Samt", "A*P*E" = "APE"
  const ot = nt.replace(/ /g, ""), ok = nk.replace(/ /g, "");
  if (ok.length >= 3 && ot === ok) return true;
  return ok.length >= 4 && ot.startsWith(ok);
}

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

// Felder des Videotitels: nur am "|" getrennt, denn Bindestrich-Teile
// gehören meist zusammen ("Hercules - Die grosse Schlacht um Hellas" ist EIN
// Titel; "Ermittlung gegen die Mächtigen | Der Superbulle (1978) | Krimi"
// sind drei Felder). Symbole vorn und Klammern hinten fallen weg.
// Klammerinhalte werden eigene Kandidaten ("The Burglars (Der Coup)"),
// ebenso Schrägstrich-Varianten ("Die verrückten Nachbarn / Neighbors").
function videotitelKerne(t) {
  const aus = [];
  for (const feld of (t || "").split(/\s*[|]\s*|\s\/\s/)) {
    for (const klammer of feld.matchAll(/[(\[]([^)\]]{2,80})[)\]]/g)) aus.push(klammer[1]);
    // Führende Klammern weg ("(x) The Binding"), dann ab der ersten Klammer
    // abschneiden -- dahinter stehen Jahr, Genre und Werbesatz.
    aus.push(
      feld
        .replace(/^(?:\s*[(\[][^)\]]*[)\]])+/, "")
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/\s*[(\[].*$/, "")
        .trim()
    );
  }
  return aus.filter((x) => norm(x).replace(/ /g, "").length >= 2);
}

// Titelkandidaten aus der Beschreibung: die ersten Zeilen (Kopfzeilen-Kanäle
// nennen dort den Film, oft als "Name: ..."), Zeilen in Anführungszeichen
// und die "Originaltitel:"-Zeile. Nicht mehr der ganze Fließtext -- darin
// kommt jedes Wort irgendwo vor.
function beschreibungsKandidaten(desc) {
  const aus = [];
  const zeilen = (desc || "").split(/\r?\n/).map((z) => z.trim()).filter(Boolean);
  for (const z of zeilen.slice(0, 5)) {
    const t = z.replace(/^(?:name|titel|film|originaltitel)\s*:\s*/i, "").replace(/^[^\p{L}\p{N}„"']+/u, "").replace(/\s*[(\[].*$/, "").trim();
    if (t.length >= 3 && t.length <= 90 && !/https?:|abonnier|subscribe/i.test(t)) aus.push(t);
  }
  for (const m of (desc || "").slice(0, 800).matchAll(/[„"“]([^„"“”]{3,90})[“"”]/g)) aus.push(m[1].trim());
  const ot = originaltitelZeile(desc);
  if (ot) aus.push(ot);
  return aus;
}

// Zerlegt einen Titel in Segmente -- nur Segmente mit mindestens zwei
// bedeutungstragenden Wörtern zählen einzeln, sonst würde "Große Haie" aus
// "Große Haie - Kleine Fische" gegen "Haie - Tödlich und Schnell" passen.
function segmenteMitGewicht(titel) {
  return segmente(titel).filter((seg) => woerter(seg).size >= 2);
}

// Jahreszahlen, die das Video selbst nennt: in Klammern im Titel, am Ende
// der ersten Beschreibungszeilen ("TITEL (1967)") oder als eigene Zeile vor
// "Originaltitel:". Bewusst nicht jede vierstellige Zahl im Fließtext --
// Netzkino hängt das Upload-Jahr an ("ganzer Film Deutsch 2025").
function videoJahre(m, desc) {
  const jahre = new Set();
  for (const x of (m.youtubeTitle || "").matchAll(/\((?:[^)]*?\b)?((?:18|19|20)\d\d)\)/g)) jahre.add(+x[1]);
  for (const z of (desc || "").split(/\r?\n/).slice(0, 8)) {
    const x = z.trim().match(/\(((?:18|19|20)\d\d)\)\s*$/);
    if (x) jahre.add(+x[1]);
  }
  return jahre;
}

// Videolänge in Minuten aus "PT1H44M32S".
function videoMinuten(dauer) {
  const x = (dauer || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!x) return 0;
  return (+x[1] || 0) * 60 + (+x[2] || 0) + (+x[3] || 0) / 60;
}

// Laufzeit laut TMDB (fetch-runtime.js) gegen die Videolänge. "passt": auf
// 10 Minuten genau -- Vorspann, PAL-Beschleunigung und Abspann-Schnitte
// liegen darunter. "widerspricht": mehr als 30 % Abweichung bei einem
// Spielfilm -- das ist eine andere Verfilmung, kein Schnitt. Videos mit
// "Teil" im Titel sind absichtlich Ausschnitte, dort gilt kein Widerspruch.
function laufzeitPasst(m) {
  const min = videoMinuten(m.duration);
  return m.runtime > 0 && min > 0 && Math.abs(m.runtime - min) <= 10;
}

function laufzeitWiderspricht(m) {
  const min = videoMinuten(m.duration);
  if (!(m.runtime > 0) || !(min > 0)) return false;
  if (/\bteil\b|\bpart\b/i.test(m.youtubeTitle || "")) return false;
  if (m.runtime >= 40 && min >= 40) return Math.abs(m.runtime - min) / m.runtime > 0.3;
  // Kurzes Video, langer TMDB-Film: Ausschnitt, Serienfolge oder ein
  // gleichnamiger Kurzfilm -- jedenfalls nicht dieser Film. Gefunden am 13.10.:
  // "Dick Tracy" (Serial, 290 min) für ein 20-Minuten-Video, "Karl May" (187
  // min) für 20 min, "Moses" (141 min) für 32 min. Umgekehrt (langer Film,
  // kurzer TMDB-Eintrag) ebenso.
  const lang = Math.max(m.runtime, min), kurz = Math.min(m.runtime, min);
  return lang >= kurz * 1.5 && lang - kurz >= 15;
}

function jahrPasst(m, jahre) {
  const ry = parseInt((m.releaseDate || "").slice(0, 4), 10);
  if (!ry || !jahre.size) return false;
  return [...jahre].some((j) => Math.abs(j - ry) <= 1);
}

// Nennt das Video ein Jahr, das um 6 oder mehr Jahre vom TMDB-Jahr abweicht,
// ist es eine gleichnamige andere Verfilmung ("Stella (1996)" -> Stella 1990,
// "Der Verräter (1974)" -> 1935). Schwelle wie in match-tmdb.js: 5 Jahre
// Abstand kommen bei richtiger Zuordnung vor (Produktion vs. Uraufführung).
function jahrWiderspricht(m, jahre) {
  const ry = parseInt((m.releaseDate || "").slice(0, 4), 10);
  if (!ry || !jahre.size) return false;
  return [...jahre].every((j) => Math.abs(j - ry) >= 6);
}

// Passt der TMDB-Titel (oder Originaltitel) zu einem der Titelkandidaten des
// Videos (Felder des Videotitels, Kopfzeilen der Beschreibung)?
// Beginnt der TMDB-Titel den Kandidaten ("Chuka" -> "Chuka - Alleingang am
// Fort Clendennon"), reicht das nur zusammen mit einem passenden Jahr --
// ohne Jahr ist "Hercules" -> "Hercules - Die grosse Schlacht um Hellas"
// nicht zu unterscheiden, das klärt dann die Alternativtitel-Stufe.
function titelPasst(m, kandidaten, jahre) {
  // Deutscher Titel und Originaltitel zusammen decken den Kandidaten ab
  // ("The Outlaw - Geächtet" = Originaltitel "The Outlaw" + Titel "Geächtet")
  const beide = new Set([...woerter(m.title), ...woerter(m.originalTitle)]);
  for (const kern of kandidaten) {
    const K = woerter(kern);
    if (K.size >= 2 && [...K].every((w) => beide.has(w))) return true;
  }
  for (const t of [m.title, m.originalTitle]) {
    if (!t) continue;
    const nt = norm(t);
    for (const kern of kandidaten) {
      if (passt(t, kern)) return true;
      if ((jahrPasst(m, jahre) || laufzeitPasst(m)) && nt.length >= 4 && norm(kern).startsWith(nt + " ")) return true;
      // Segmente auf beiden Seiten, jeweils nur mit Gewicht
      for (const seg of segmenteMitGewicht(t)) if (passt(seg, kern)) return true;
      for (const ks of segmenteMitGewicht(kern)) if (passt(t, ks)) return true;
      // Ein-Wort-Segment des TMDB-Titels, das dem Kandidaten exakt entspricht
      // ("Alien" aus "Alien - Das unheimliche Wesen ..." gegen Feld "Alien")
      for (const seg of segmente(t)) if (gleicheWoerter(woerter(seg), woerter(kern))) return true;
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
  return (personenAnteil(erwartet, gespeichert) ?? 0) >= 0.34;
}

// Alle Namen, die das Video nennt: Beschreibung ("Mit:", "Darsteller:",
// "Regie:") und Videotitel ("mit Nicole Kidman & Sebastian Stan").
function personenAusVideo(desc, titel) {
  const p = extractPeople(desc, titel);
  return [...new Set([...personenAusBeschreibung(desc), ...p.cast, ...p.directors])];
}

// Volle Besetzung (15 Namen) und Regie bei TMDB. In filme.json stehen nur
// fünf Hauptdarsteller -- nennt die Beschreibung Nebenrollen, fände sich
// dort kein Treffer.
async function tmdbPersonen(tmdbId) {
  const res = await fetch(`${TMDB_BASE}/movie/${tmdbId}/credits`, {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}`, accept: "application/json" },
  });
  if (res.status === 429) {
    await sleep(1000);
    return tmdbPersonen(tmdbId);
  }
  if (!res.ok) throw new Error(`TMDB Fehler ${res.status}`);
  const json = await res.json();
  return [
    ...(json.cast || []).slice(0, 15).map((c) => c.name),
    ...(json.crew || []).filter((c) => c.job === "Director").map((c) => c.name),
  ];
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

  const stufen = { titel: 0, korrekturtitel: 0, originaltitel: 0, besetzung: 0, alternativtitel: 0 };
  let korrekturen = {};
  try {
    korrekturen = JSON.parse(await fs.readFile(KORREKTUREN_PATH, "utf-8")).titel || {};
  } catch {
    // keine Korrekturdatei
  }
  const verworfen = [];
  let uebersprungen = 0;
  let fehler = 0;
  let anfragen = 0;

  // Besetzungsstufe: erst gegen die gespeicherten fünf Hauptdarsteller, dann
  // gegen die volle TMDB-Besetzung. Der Hinweis "Besetzung/Regie stimmen mit
  // den Angaben im Video überein" einer früheren Suche zählt nur, wenn das
  // Video keinen einzigen Namen nennt -- dann kann nichts widersprechen.
  // Bis 21.10.2026 zählte er immer; so blieb "The Dead" als "Shaun of the
  // Dead" stehen, weil die Suche "Rob Freeman" für Martin Freeman hielt.
  let besetzungsAnfragen = 0;
  async function besetzungPasst(m, erwartet) {
    if (erwartet.length === 0) return /stimmen mit/.test(m.hinweis || "");
    if (personenPassen(erwartet, [...(m.cast || []), ...(m.director || [])])) return true;
    if (NUR_PRUEFEN) return false;
    try {
      besetzungsAnfragen++;
      const voll = await tmdbPersonen(m.tmdbId);
      await sleep(DELAY_MS);
      return personenPassen(erwartet, voll);
    } catch {
      return null; // TMDB nicht erreichbar -- Eintrag bleibt vorerst
    }
  }

  const behalten = [];
  for (const m of filme) {
    const geprueft = m.plausibel && m.plausibelVersion === PRUEF_VERSION;
    if (!m.tmdbId || m.matchSource === "manuell" || geprueft) {
      behalten.push(m);
      if (geprueft) uebersprungen++;
      continue;
    }
    const video = candById.get(m.videoId);
    const desc = video ? video.description || "" : "";
    const kandidaten = [...videotitelKerne(m.youtubeTitle), ...beschreibungsKandidaten(desc)];
    const jahre = videoJahre(m, desc);
    const ot = originaltitelZeile(desc);
    // Von Hand ermittelter Titel (data/titel-korrekturen.json): Der
    // Videotitel ist ein Werbesatz und kann nicht passen -- gegen den
    // ermittelten Titel wird stattdessen geprüft.
    const korrektur = korrekturen[m.videoId]?.titel || null;

    // Widerspricht die Laufzeit grob, ist es eine andere Verfilmung gleichen
    // Namens -- dann zählt kein Titelvergleich mehr, nur noch die Besetzung.
    const widerspruch = laufzeitWiderspricht(m) || jahrWiderspricht(m, jahre);

    let stufe = null;
    let besetzung = false;
    if (!widerspruch && titelPasst(m, kandidaten, jahre)) {
      stufe = "titel";
    } else if (!widerspruch && korrektur && (passt(m.title, korrektur) || passt(m.originalTitle, korrektur))) {
      stufe = "korrekturtitel";
    } else if (!widerspruch && ot && (passt(m.title, ot) || passt(m.originalTitle, ot))) {
      stufe = "originaltitel";
    } else if ((besetzung = await besetzungPasst(m, personenAusVideo(desc, m.youtubeTitle))) === true) {
      stufe = "besetzung";
    } else if (besetzung === null) {
      fehler++;
      console.log(`   Fehler bei "${m.title}": Besetzung bei TMDB nicht abrufbar -- bleibt vorerst`);
      behalten.push(m);
      continue;
    } else if (!widerspruch && !NUR_PRUEFEN) {
      try {
        anfragen++;
        const alt = await alternativtitel(m.tmdbId);
        await sleep(DELAY_MS);
        const ziele = [...kandidaten, ...(korrektur ? [korrektur] : [])];
        const treffer = alt.find((t) => ziele.some((z) => passt(t, z)));
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
      m.plausibelVersion = PRUEF_VERSION;
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
      grund: laufzeitWiderspricht(m)
        ? `Plausibilität: Laufzeit widerspricht (TMDB ${m.runtime} min, Video ${Math.round(videoMinuten(m.duration))} min) -- wird neu gesucht`
        : jahrWiderspricht(m, jahre)
          ? `Plausibilität: Jahr widerspricht (TMDB ${(m.releaseDate || "").slice(0, 4)}, Video ${[...jahre].join("/")}) -- wird neu gesucht`
          : "Plausibilität: weder Titel, Originaltitel, Besetzung noch Alternativtitel passen -- wird neu gesucht",
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
  console.log(`Bestätigt über Titel: ${stufen.titel}, Korrekturtitel: ${stufen.korrekturtitel}, Originaltitel: ${stufen.originaltitel}, Besetzung: ${stufen.besetzung}, Alternativtitel: ${stufen.alternativtitel} (${anfragen} TMDB-Anfragen Alternativtitel, ${besetzungsAnfragen} Besetzung)`);
  console.log(`${NUR_PRUEFEN ? "Würden verworfen" : "Verworfen, werden neu gesucht"}: ${verworfen.length}${fehler ? ` (${fehler} Fehler, bleiben vorerst)` : ""}, davon Laufzeit-Widerspruch: ${verworfen.filter(laufzeitWiderspricht).length}, Jahr-Widerspruch: ${verworfen.filter((m) => jahrWiderspricht(m, videoJahre(m, (candById.get(m.videoId) || {}).description || ""))).length}`);
  for (const m of verworfen) {
    const jv = videoJahre(m, (candById.get(m.videoId) || {}).description || "");
    const lz = (m.runtime ? ` [TMDB ${m.runtime} min, Video ${Math.round(videoMinuten(m.duration))} min]` : "") + (jahrWiderspricht(m, jv) ? ` [Jahr: Video ${[...jv].join("/")}]` : "");
    console.log(`   [${m.channelName}] ${m.youtubeTitle.slice(0, 60)}  ->  ${m.title} (${(m.releaseDate || "").slice(0, 4) || "?"})${lz}`);
  }
  console.log(`Bibliothek jetzt: ${behalten.length}`);
}

main();
