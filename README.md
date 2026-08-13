# tubefilme.de — Dokumentation

Serverless betriebenes Archiv deutschsprachiger Filme, die auf YouTube legal in voller Länge verfügbar sind. Kein Server, keine Datenbank, kein Build-Schritt: Eine nächtliche GitHub Action sammelt die Daten ein und legt sie als JSON ins Repository, das Frontend liest sie direkt aus.

- **Repository:** `Sobing23/tubefilme`
- **Hosting:** Vercel, verbunden mit `main` — jeder Commit löst ein Deployment aus
- **Domain:** `tubefilme.de` (bei Strato, per A-Record und CNAME auf Vercel gezeigt)

---

## Inhalt

1. [Aufbau](#aufbau)
2. [Die Pipeline Schritt für Schritt](#die-pipeline-schritt-für-schritt)
3. [Datendateien](#datendateien)
4. [Die Zuordnungslogik im Detail](#die-zuordnungslogik-im-detail)
5. [Anbieter-Profile](#anbieter-profile)
6. [Frontend](#frontend)
7. [Review-Werkzeug](#review-werkzeug)
8. [Wiederkehrende Aufgaben](#wiederkehrende-aufgaben)
9. [Fallstricke](#fallstricke)

---

## Aufbau

```
.github/workflows/
  scan.yml        nächtlich 02:00 UTC + manuell   -> normaler Durchlauf
  rematch.yml     nur manuell                     -> Neubewertung bestehender Zuordnungen

config/
  channels.json   Kanalliste + Anbieter-Profile

scripts/
  fetch-youtube.js      Videos je Kanal einsammeln (inkrementell)
  filter-movies.js      Shorts, Trailer, Serienfolgen aussortieren
  match-tmdb.js         TMDB-Zuordnung — das Herzstück
  cleanup-matches.js    Sicherheitsnetz gegen doppelte tmdbIds
  auto-verify.js        unsichere Zuordnungen automatisch nachprüfen
  absorb-unmatched.js   nicht auffindbare Filme aus YouTube-Daten übernehmen
  fetch-cast.js         Besetzung, Regie, Drehbuch von TMDB
  fetch-fsk.js          deutsche Alterseinstufung von TMDB
  cache-images.js       Poster lokal ablegen
  reset-for-rematch.js  fragwürdige Zuordnungen zur Neubewertung freigeben
  resolve-channel.js    @handle -> Kanal-ID

data/                   sämtliche Daten als JSON (siehe unten)
img/posters/            zwischengespeicherte Poster, Dateiname = tmdbId
index.html              öffentliche Seite
review.html             privates Pflegewerkzeug (nicht verlinkt)
```

**Benötigte Secrets** (Repository → Settings → Secrets → Actions):
`YOUTUBE_API_KEY`, `TMDB_BEARER_TOKEN`

---

## Die Pipeline Schritt für Schritt

Reihenfolge in `scan.yml` — sie ist nicht beliebig:

| # | Schritt | Was passiert | API-Kosten |
|---|---|---|---|
| 1 | `fetch-youtube` | Neue Videos je Kanal. Über `data/state.json` inkrementell: bekannte Videos beenden die Suche vorzeitig. Neue Kanäle laufen automatisch einmal vollständig durch. | YouTube |
| 2 | `filter-movies` | Aussortiert: kürzer als 15 Minuten, Trailer/Teaser/Clip im Titel, Serienschlüsselwörter (Folge, Staffel, Miniserie). | — |
| 3 | `match-tmdb` | Zuordnung zu TMDB. Details unten. | TMDB |
| 4 | `cleanup-matches` | Entfernt doppelte tmdbIds. Einträge **ohne** tmdbId sind ausgenommen. | — |
| 5 | `auto-verify` | Prüft unsichere Zuordnungen gegen die bereits gespeicherte Besetzung. | keine |
| 6 | `absorb-unmatched` | Übernimmt endgültig nicht auffindbare Filme mit YouTube-Metadaten. | keine |
| 7 | `fetch-cast` | Besetzung/Regie/Drehbuch nachladen. Überspringt Filme, die diese Felder schon haben. | TMDB |
| 8 | `fetch-fsk` | FSK nachladen (eigener TMDB-Endpunkt für Freigaben je Land). | TMDB |
| 9 | `cache-images` | Poster herunterladen nach `img/posters/<tmdbId>.jpg`. Überspringt vorhandene. | — |
| 10 | Commit | `git add data/ img/`, committen und pushen. | — |

**Warum diese Reihenfolge:** `auto-verify` braucht die Besetzung aus einem *früheren* Lauf (deshalb vor `fetch-cast`, nicht danach). `absorb-unmatched` muss nach `auto-verify` laufen, damit verworfene Zuordnungen nicht sofort mit schwächeren Daten übernommen werden. `fetch-cast` und `fetch-fsk` überspringen übernommene Einträge automatisch, weil deren Felder bereits gesetzt sind.

**Abbrechen ist ungefährlich:** Committet wird erst im letzten Schritt. Ein mittendrin gestoppter Lauf hinterlässt keinen halben Zustand.

---

## Datendateien

| Datei | Inhalt |
|---|---|
| `raw/<channelId>.json` | Rohdaten aller Videos eines Kanals |
| `state.json` | letzte gesehene videoId je Kanal (Grundlage des inkrementellen Scans) |
| `candidates.json` | gefilterte Filmkandidaten inkl. voller Beschreibung |
| `excluded.json` | aussortierte Videos mit Begründung |
| **`filme.json`** | **die Bibliothek — was das Frontend anzeigt** |
| `unmatched.json` | (noch) nicht zuordenbar, mit Grund und verwendetem Suchbegriff |
| `duplicates.json` | derselbe Film über mehrere Kanäle; erster Fund gewinnt |
| `manual-matches.json` | `{videoId: tmdbId}` — deine Korrekturen, haben immer Vorrang |
| `ignored.json` | videoIds, die nie wieder verarbeitet werden (gelöscht/nicht auffindbar) |
| `reviewed.json` | im Review-Werkzeug als gesichtet markierte Filme |
| `cover-dismissed.json` | Filme, bei denen der Platzhalter akzeptiert wurde |
| `rejected-matches.json` | `{videoId: [tmdbId, ...]}` — als falsch erkannte Zuordnungen, bei der Suche gesperrt |
| `unmatched-attempts.json` | Fehlversuche je Video (Schonfrist vor der Übernahme) |

### Felder eines Films in `filme.json`

```
videoId, youtubeTitle, youtubeThumbnail, duration (ISO 8601), publishedAt,
channelName, channelId,
tmdbId            null bei aus YouTube übernommenen Filmen
title, originalTitle, overview, releaseDate
posterUrl, backdropUrl, voteAverage, genreIds[]
cast[], director[], writer[]
fsk               "0"|"6"|"12"|"16"|"18" oder null
matchSource       originaltitel+jahr | originaltitel-ohne-jahr | titel-fallback
                  | manuell | youtube
matchConfidence   hoch | mittel | niedrig | youtube
hinweis           Klartext-Erklärung bei Unsicherheit (optional)
```

---

## Die Zuordnungslogik im Detail

Das ist der Teil, der am meisten Arbeit gekostet hat, und der Teil, an dem beim Ändern am meisten kaputtgehen kann.

### 1. Manuelle Korrekturen zuerst

`manual-matches.json` wird **vor allem anderen** angewendet — auch auf bereits (falsch) zugeordnete Filme. Ohne diesen Schritt würde die Inkrementell-Logik ein schon verarbeitetes Video nie wieder anfassen, und Korrekturen liefen ins Leere.

### 2. Suchbegriffe gewinnen

Mehrere Quellen, in absteigender Verlässlichkeit:

1. `Originaltitel:` bzw. `Originalname Film:` mit direkt davorstehendem Jahr in Klammern
2. dieselbe Zeile ohne Jahr — Jahr wird separat gesucht
3. Rückfall auf den Videotitel bis zur ersten Klammer oder zum ersten Strich

Das Jahr kommt aus drei Quellen: Klammer nach dem Titel, Fließtext `aus dem Jahr JJJJ` (538 Beschreibungen nutzen das), oder `(JJJJ)` im Videotitel.

Daraus wird eine **priorisierte Liste** von Suchbegriffen gebaut — Originaltitel, Titel ohne Schauspieler-Vorspann, Varianten an Schrägstrichen, werbetextbereinigte Fassungen, und als letzter Versuch das erste Segment vor dem ersten Strich.

### 3. Gesperrte Begriffe

Rund 60 reine Genre- und Gattungswörter (`Kriegsfilm`, `Thriller`, `Western`, `Klassiker` …) sind als Suchbegriff **komplett gesperrt**. Ohne diese Sperre entstand z. B.: Videotitel `Julius Cäsar, der Tyrann von Rom | Sandalenfilm auf Deutsch | Kriegsfilm` → der echte Titel war bei TMDB nicht auffindbar → die Suche fiel durch bis `"Kriegsfilm"` → gefunden wurde „Sturmzeichen – Ein **Kriegsfilm**". 13 Filme waren so entstanden.

### 4. Bewertung statt Reihenfolge

**Nie** einfach `results[0]` nehmen — TMDB sortiert nach Popularität, nicht nach Passgenauigkeit. Stattdessen wird jeder Treffer bewertet:

| Kriterium | Punkte |
|---|---|
| Titel exakt (normalisiert) | +100 |
| Titel teilweise | bis +55 anteilig |
| Jahr exakt / ±1 / ±3 | +45 / +35 / +18 |
| Jahr weit daneben | −12 bis −35 |
| ≥50 / ≥10 / ≥1 / 0 Bewertungen | +18 / +12 / +5 / **−25** |
| Genres vorhanden / fehlen | +8 / −15 |
| Beschreibung vorhanden / fehlt | +8 / −15 |
| Popularität | bis +7.5 |

Der Abzug für leere Datensätze ist wichtig: Ein kommerziell ausgewerteter Film hat bei TMDB praktisch immer Bewertungen, Genres und eine Beschreibung. Leere Einträge (Festivalmitschnitte, Namensdubletten) waren die Hauptquelle grotesker Fehltreffer.

### 5. Besetzungsabgleich bei Unklarheit

Liegt der beste Wert unter 140, werden die **drei besten Kandidaten** gegen die Personen aus Beschreibung *und* Videotitel geprüft (`Mit:`, `Darsteller:`, `Regie:`, sowie `… mit Vorname Nachname`) und **neu sortiert**. Nur den Favoriten abzuwerten genügt nicht — sonst wird der falsche Film zwar erkannt, der richtige aber nie ausgewählt.

Beispiel: „Night Moves – mit Jesse Eisenberg" gewann zunächst die bekanntere Fassung von 1975 (128 zu 120). Nach dem Abgleich: 180 zu 88 zugunsten der richtigen von 2013.

### 6. Belegpflicht bei schwachen Treffern

Unter Wert 90 wird ein **zweiter, unabhängiger Beleg** verlangt: exakter Titel, exakt passendes Jahr oder bestätigte Besetzung. Fehlt jeder, gibt es keine Zuordnung.

Die Schwelle einfach anzuheben wäre falsch — auch richtige Treffer landen tief, wenn deutscher und Originaltitel auseinandergehen (`Winter in Wartime` → `Mein Kriegswinter`, Wert 62). Der Unterschied ist nicht die Höhe, sondern ob es einen zweiten Hinweis gibt.

### 7. Sperrliste als Selbstkorrektur

Erkennt `auto-verify` eine Zuordnung als falsch, wandert die tmdbId nach `rejected-matches.json` und der Film gilt wieder als unbearbeitet. Beim nächsten Lauf wird er neu gesucht — ohne den als falsch erkannten Kandidaten. So arbeitet sich das System Runde für Runde zum richtigen Film vor, statt endlos denselben Fehler zu wiederholen.

### 8. Kanalübergreifende Duplikate

Derselbe Film über mehrere Kanäle: erster Fund gewinnt, jeder weitere wandert dokumentiert nach `duplicates.json`. Bei den PLAION-Kanälen (Netzkino, Moviedome, FABELLA, Dzango, Bulldox) überschneiden sich die Kataloge stark — beim Hinzufügen von Moviedome entstanden in einem Lauf 661 Duplikate.

---

## Anbieter-Profile

Die Kanäle unterscheiden sich systematisch im Aufbau von Titel und Beschreibung. Dieses Wissen steht als optionales `profil` beim jeweiligen Kanal in `config/channels.json`:

```json
{ "name": "Artflix", "channelId": "UC…", "profil": { "pipeAlsTitelvariante": false } }
```

| Schalter | Bedeutung |
|---|---|
| `pipeAlsTitelvariante` | Stehen hinter `\|` alternative Filmtitel (`true`, Standard) oder nur Genre- und Werbeangaben (`false`)? |

Fehlt ein Profil, gelten die Standardwerte — neue Kanäle funktionieren also ohne Eintrag.

**Die Anbieter in Gruppen** (gemessen am Datenbestand):

| Gruppe | Kanäle | Merkmal |
|---|---|---|
| Strukturiert | Netzkino, Bulldox, Dzango, FABELLA, Free Films Action | 92–99 % `Originaltitel:` + Besetzung — beste Trefferquote |
| Pipe-Titel mit Genrewörtern | Artflix, Bigtime, FFF Kino, Deutsch Knallhart | 100 % Striche, **0 %** Originaltitel → `pipeAlsTitelvariante: false` |
| Pipe-Titel mit Jahr | Comfy Movies, CineCult Reloaded | Jahr in 78–89 % im Titel, echte Originaltitel hinter dem Strich |
| Eigene Struktur | CiNENET Deutschland | Jahr in 61 % im Titel, Genres in eckigen Klammern |
| Fließtext | Moviedome | keine Striche, halb strukturiert, Werbeprosa |
| Reißerisch | Volle Power Filme, Amelia | Titel oft ohne echten Filmnamen — schwache Trefferquote unvermeidbar |

**Neuen Kanal hinzufügen:** `@handle` aufrufen, Kanal-ID aus der Seite ziehen, in `config/channels.json` eintragen, `scan.yml` starten. Der neue Kanal läuft automatisch einmal vollständig durch, alle anderen bleiben inkrementell. Ein Profil ist optional und lässt sich später nachschärfen.

---

## Frontend

`index.html` — bewusst funktional gehalten, das visuelle Design steht noch aus.

- Vanilla HTML/CSS/JS, keine Bibliothek außer **Fuse.js** für die Suche
- Durchsucht: Titel, Originaltitel, Genres, Besetzung, Regie, Drehbuch
- Filter: Genre, FSK, Jahrzehnt — untereinander und mit der Suche kombinierbar
- Merkliste über `localStorage`, ohne Anmeldung
- Player als Overlay, **ohne** Autoplay, mit Besetzung, Regie, Bewertung und drei ähnlichen Filmen (rein clientseitig über Genre-Überschneidung, keine zusätzlichen Anfragen)

**Poster-Darstellung, drei Stufen:**

1. TMDB-Poster, wenn vorhanden
2. sonst das YouTube-Vorschaubild: im Querformat, deshalb auf 145 % vergrößert in den Hochformat-Rahmen eingepasst, freier Rand mit einer unscharfen Fassung desselben Bildes gefüllt. Zuerst wird `maxresdefault` versucht, bei Nichtverfügbarkeit fällt es auf die gespeicherte Variante zurück
3. sonst ein Textplatzhalter

Badges (FSK, „?" bei niedriger Konfidenz) hängen an einem eigenen Rahmen um das Bild — **nicht** an der Karte. Sonst überlappen sie bei zweizeiligen Titeln den Text darunter.

---

## Review-Werkzeug

`review.html` — privat, **nicht verlinkt**, aber technisch öffentlich erreichbar. Ohne Token kann dort niemand etwas ändern; gelesen wird ohnehin nur, was ohnehin öffentlich im Repository steht.

**Zugang:** fein granulierter GitHub-Token, beschränkt auf dieses eine Repository, Berechtigung „Contents: Read and write". Er liegt ausschließlich im `localStorage` des Browsers.

| Reiter | Zweck |
|---|---|
| Unmatched | zuordnen, als nicht auffindbar markieren, löschen |
| Niedrig-Konfidenz | korrigieren, bestätigen, löschen |
| Fehlende FSK | Einstufung nachtragen |
| Kein Cover | Bild-URL eintragen oder Platzhalter akzeptieren |
| Alle Filme | suchen, **alle Felder bearbeiten**, löschen |
| Kanäle | Übersicht alphabetisch mit Filmanzahl |

In jedem Reiter gibt es einen Direktlink zum Video — bei manchen Kanälen steht der echte Filmtitel nur in der Grafik, nicht in den Metadaten.

„Löschen" entfernt den Film aus `filme.json` **und** trägt ihn in `ignored.json` ein, damit er nicht beim nächsten Lauf wiederkehrt. Von Hand bearbeitete Filme gelten als geprüft (`matchSource: manuell`) und werden von der Automatik nicht mehr angefasst.

---

## Wiederkehrende Aufgaben

**Neuen Kanal aufnehmen** → `config/channels.json` ergänzen → `scan.yml` starten.

**Zuordnungslogik verbessert, Bestand soll davon profitieren** → `rematch.yml` starten. `reset-for-rematch.js` gibt alles frei, was Konfidenz „niedrig"/„mittel" hat oder ohne Bewertung/Genres dasteht — manuelle Korrekturen und übernommene YouTube-Einträge bleiben unangetastet.

**Einzelnen Film korrigieren** → Review-Werkzeug, Reiter „Alle Filme".

**Fehlerursache verstehen** → `data/unmatched.json` enthält zu jedem Fall den verwendeten Suchbegriff, das erwartete Jahr, den Grund und den besten TMDB-Kandidaten.

---

## Fallstricke

Alles hier ist mindestens einmal schiefgegangen.

**Beim Lesen aus GitHub im Browser:**

- **Niemals `raw.githubusercontent.com` zum Lesen im Review-Werkzeug** — dieser Zwischenspeicher liefert nach eigenen Änderungen teils stundenlang veraltete Daten. Einmal zeigte er 427 Einträge, während tatsächlich nur noch 2 vorhanden waren.
- **`cache: "no-store"` bei jedem lesenden `fetch`** — sonst speichert der Browser die Antwort selbst zwischen, aufeinanderfolgende Aktionen lesen denselben veralteten Versionsstand und erzeugen einen `409`-Konflikt, den auch automatisches Wiederholen nicht auflöst.
- **Dateien über 1 MB** (`filme.json`, `candidates.json`) liefert die Contents-API nicht direkt aus; `ghGetFile()` weicht automatisch auf die Blob-API aus.
- **Schreibvorgänge müssen nacheinander laufen** (`withLock`), sonst überschreiben sich zwei schnell hintereinander ausgelöste Aktionen gegenseitig.

**Beim Ändern der Skripte:**

- **`cleanup-matches.js` muss Filme ohne tmdbId überspringen.** Sonst gelten alle aus YouTube übernommenen Einträge als Duplikate derselben `null`-ID und werden bis auf einen gelöscht.
- **Nicht an Kommata trennen**, wenn Titel zerlegt werden — „Der Spion, der niemals stirbt" wird sonst zu „Der Spion".
- **Nicht am einfachen Bindestrich trennen**, wenn Titel verglichen werden — „El Dorado – Stadt aus Gold" ist ein anderer Film als „El Dorado".
- **Klammerzusätze vor dem Trennen entfernen.** Manche Kanäle nennen zu jedem Darsteller seine bekanntesten Filme: `Mit: Odessa Young (The Professor, Shirley), …`. Beim Trennen an Kommata entstehen sonst Bruchstücke wie `Odessa Young (The Professor`.
- **`ß` zu `ss` auflösen, bevor Sonderzeichen entfernt werden.** Sonst wird „muß" zu „mu" und ist nicht mehr mit „muss" vergleichbar.
- **Neue Suchvarianten hinten anhängen, nicht bestehende ersetzen.** Filme, die mit ihrem bisherigen Begriff sicher gefunden werden, brechen die Suche vorher ab und bleiben dadurch unverändert.
- **Teilstring-Vergleiche sind zu locker.** „Duell am Wind River" enthält „Wind River", ist aber ein anderer Film.

**Beim Beurteilen von Ergebnissen:**

- **Zahlen allein reichen nicht.** Mehrfach sahen Läufe statistisch gut aus, und erst eine Stichprobe der neu zugeordneten Filme förderte echte Fehler zutage.
- **Fehlende Titelüberschneidung ist kein Fehlerindiz.** Fremdsprachige Originaltitel gehen naturgemäß nicht mit deutschen Verleihtiteln zusammen (`Belyy tigr` → `White Tiger`) — das ist korrekt.
- **Nur fünf Hauptdarsteller sind gespeichert.** Nennt eine Beschreibung Nebendarsteller, sieht das fälschlich nach Widerspruch aus. Deshalb wird nur bei belastbarer Datenlage verworfen und nie, wenn Titel und Jahr exakt stimmen.

**Zur FSK:** Für einen Teil des Bestands liefert TMDB keine deutsche Einstufung — die Daten dort sind von Nutzern gepflegt, Nischentitel ohne deutschen Kino- oder Disc-Start haben oft keine. Eine Ableitung aus Freigaben anderer Länder wäre falsch: Die FSK ist eine rechtliche Kennzeichnung, eine geschätzte Angabe wäre schlechter als gar keine.

---

## Offene Punkte

- Visuelles Design der öffentlichen Seite
- Rückmeldefunktion für Besucher (falscher Film, Video nicht abspielbar, weitere Gründe noch zu definieren)
- Weitere Kanäle
