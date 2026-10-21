// Erkennt Videotitel, bei denen VOR dem eigentlichen Filmtitel ein Vorsatz
// steht -- ein Star, eine Genre-Angabe oder ein Werbesatz -- und liefert den
// Filmtitel dahinter.
//
// Gefunden am 21.10.2026 in den aus YouTube übernommenen Einträgen. Bis dahin
// galt immer der Teil vor dem ersten "|" als Titel, und die Bibliothek zeigte:
//
//   "Roy Rogers | Arizona Kid (1939) [Western] | Film (deutsch)"   -> "Roy Rogers"
//   "MARTIAL-ARTS-HIT | Der Todesbiss der Gelben Schlange (...)"    -> "MARTIAL-ARTS-HIT"
//   "Historisches Liebesdrama: DIE JUNGE KATHARINA | ..."           -> der ganze Vorsatz
//   "Kann sie die Pferderanch vor dem Ruin bewahren? | A Horse Called Hope (2016)"
//
// Auch die TMDB-Suche ging daran vorbei: Der Teil hinter dem "|" wurde samt
// "(1939) [Western]" gesucht und fand nichts.
//
// Drei Regeln (Regel 3 wird zuerst geprüft, siehe unten):
//
//   1. Jahres-Segment: Der erste Teil hat KEIN Jahr, ein späterer Teil hat
//      die Form "Titel (JAHR)". Dann ist der spätere Teil der Film. An allen
//      49 Videos dieser Form geprüft: Bei jedem Kanal außer Comfy Movies
//      steht vorne ein Star, ein Genre oder ein Werbesatz. Comfy Movies
//      schreibt vorne den deutschen Titel und hinten den Originaltitel -- dort
//      bleibt der deutsche Titel stehen (Profil "pipeIstOriginaltitel").
//      Ist der Jahres-Teil selbst nur Genre/Werbung ("Martial-Arts Klassiker
//      (1978)", "Ganzer Film auf Deutsch (1984)"), greift die Regel nicht.
//
//   2. Genre-Vorsatz in Großbuchstaben: "MARTIAL-ARTS-HIT | ...",
//      "KOMÖDIEN-KLASSIKER | ...". Der erste Teil enthält keinen
//      Kleinbuchstaben und endet auf ein Gattungswort. Ein großgeschriebener
//      echter Titel ("EINE KRIMINELLE LIEBE | Ganzer Thrillerfilm") endet
//      nicht so und bleibt.
//
//   3. Genre-Vorsatz mit Doppelpunkt: "Historisches Liebesdrama: DIE JUNGE
//      KATHARINA", "SCI-FI-HORROR: Recreator (Cloned) (2012)". Höchstens fünf
//      Wörter vor dem Doppelpunkt, das letzte endet auf ein Gattungswort.
//      "Movie" zählt bewusst nicht ("Bee Movie: Das Honigkomplott").
//
// Liefert { titel, jahr, regel } oder null.

const JAHR_IN_KLAMMERN = /\(((?:19|20)\d{2})\)/;

// Wortenden, die eine Gattung bezeichnen ("Liebesdrama", "PSYCHOTHRILLER",
// "KULTKLASSIKER", "Weihnachtskomödie", "MARTIAL-ARTS-HIT").
const GATTUNG_ENDE =
  /(hit|klassiker|horror|thriller|film|action|komödie|komoedie|western|krimi|drama|kracher|knaller|abenteuer|fantasy|mystery|märchen)$/i;

// Wörter, aus denen ein reines Genre- oder Werbesegment besteht
const GENRE_WORT =
  /^(sci|fi|scifi|science|fiction|action|martial|arts|kung|fu|klassiker|kult|western|eastern|horror|thriller|drama|krimi|komödie|komoedie|fantasy|mystery|abenteuer|romantik|romanze|erotik|spannung|epischer?|epische|packender?|spannender?|ganzer?|ganze|film|filme|spielfilm|deutsch|german|hd|4k|uhd|neu|kostenlos|komplett|kompletter|voller|länge|auf|in|und|der|die|das)$/i;

const WERBUNG = /ganzer?\s+film|ganze\s+filme|auf deutsch|kostenlos|voller länge|komplett|filme? deutsch/i;

function woerter(s) {
  return (s || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Ist das Segment nur Genre, Jahr oder Werbung -- also kein Filmtitel?
function istKeinTitel(s) {
  if (!s || s.length < 2 || !/\p{L}/u.test(s)) return true;
  if (WERBUNG.test(s)) return true;
  const w = woerter(s);
  return w.every((x) => GENRE_WORT.test(x) || GATTUNG_ENDE.test(x) || /^(19|20)\d{2}$/.test(x));
}

// "Arizona Kid (1939) [Western]"                       -> "Arizona Kid"
// "Exchange – Ein Leben für ein Leben (2022) – Der Krieg ..." -> "Exchange – Ein Leben für ein Leben"
// "Das Haus des Bösen (Silent Night, Bloody Night) (1972)"   -> "Das Haus des Bösen"
// "Der Todesbiss der Gelben Schlange (Filme auf Deutsch ...)" -> "Der Todesbiss der Gelben Schlange"
// "Der Satan ohne Gesicht (La bambola di Satana) 1969 HD"    -> "Der Satan ohne Gesicht", 1969
// Klammern mit EINEM Wort bleiben, sofern es kein Genre ist -- sie gehören
// oft zum Titel ("18 und immer (noch) Jungfrau", "Recreator (Cloned)").
function bereinige(seg) {
  let t = (seg || "").replace(/\[[^\]]{1,30}\]/g, " ");
  const jm = t.match(JAHR_IN_KLAMMERN);
  let jahr = jm ? jm[1] : null;
  if (jm) t = t.slice(0, jm.index);
  // nicht geschlossene Klammer am Ende (abgeschnittener Werbetext)
  t = t.replace(/\([^)]*$/, " ");
  t = t.replace(/\(([^)]*)\)/g, (ganz, innen) => {
    const w = woerter(innen);
    return w.length === 1 && !istKeinTitel(innen) ? ganz : " ";
  });
  // nachgestelltes Jahr und Qualitätsangabe ohne Klammern ("... 1969 HD")
  t = t.replace(/\s+(?:HD|4K|UHD)\s*$/i, "");
  const nachJahr = t.match(/\s((?:19|20)\d{2})\s*$/);
  if (nachJahr && t.trim().split(/\s+/).length > 2) {
    jahr = jahr || nachJahr[1];
    t = t.slice(0, nachJahr.index);
  }
  t = t.replace(/[^\p{L}\p{N}!?.)'"]+$/u, "");
  t = t.replace(/^[^\p{L}\p{N}"„]+/u, "");
  return { titel: t.replace(/\s{2,}/g, " ").trim(), jahr };
}

function istGattungsVorsatzGross(s) {
  if (!s || /[a-zäöüß]/.test(s) || !/\p{L}/u.test(s)) return false;
  const w = woerter(s);
  return w.length > 0 && w.length <= 5 && GATTUNG_ENDE.test(w[w.length - 1]);
}

export function titelHinterVorsatz(roh, profil = {}) {
  const segmente = (roh || "").split(/\s+\|\s+/).map((s) => s.trim()).filter(Boolean);
  const erster = segmente[0] || "";

  // Regel 3 zuerst: "Gattung: Titel" im ersten Segment. Vorrang vor Regel 1,
  // weil dort der deutsche Titel steht ("GANZER FILM: Der letzte Zug nach
  // Durango | Un treno per Durango (1968)")
  const m = erster.match(/^([^:]{3,60}?):\s+(.{2,})$/);
  if (m) {
    const w = woerter(m[1]);
    if (w.length >= 1 && w.length <= 5 && GATTUNG_ENDE.test(w[w.length - 1])) {
      const b = bereinige(m[2]);
      if (!istKeinTitel(b.titel)) return { titel: b.titel, jahr: b.jahr, regel: "gattung-doppelpunkt", vorsatz: m[1].trim() };
    }
  }

  // Regel 1: Jahres-Segment hinter einem Vorsatz ohne Jahr
  if (segmente.length >= 2 && !JAHR_IN_KLAMMERN.test(erster) && profil.pipeIstOriginaltitel !== true) {
    for (let i = 1; i < segmente.length; i++) {
      if (!JAHR_IN_KLAMMERN.test(segmente[i])) continue;
      const b = bereinige(segmente[i]);
      if (!istKeinTitel(b.titel)) return { titel: b.titel, jahr: b.jahr, regel: "jahr-segment", vorsatz: erster };
      break;
    }
  }

  // Regel 2: Genre-Vorsatz in Großbuchstaben vor dem ersten "|"
  if (segmente.length >= 2 && istGattungsVorsatzGross(erster)) {
    const b = bereinige(segmente[1]);
    if (!istKeinTitel(b.titel)) return { titel: b.titel, jahr: b.jahr, regel: "gattung-gross", vorsatz: erster };
  }

  return null;
}
