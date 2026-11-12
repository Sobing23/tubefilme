// Schritt 1 der Pipeline: rohe Video-Metadaten von YouTube abrufen.
// Nutzt NUR playlistItems.list (1 Unit/Aufruf) + videos.list für die Dauer (1 Unit je 50 IDs).
// Kein Scraping, keine Bot-Umgehung -- ausschließlich offizielle API.
//
// INKREMENTELL: Die Uploads-Playlist eines Kanals ist immer neueste-zuerst
// sortiert. Pro Kanal merken wir uns in data/state.json die videoId des
// zuletzt gesehenen (also neuesten) Videos. Beim nächsten Lauf blättern wir
// nur so lange, bis wir dieses Video wiedertreffen, und brechen dann ab --
// alles Ältere ist garantiert schon bekannt. Ein Kanal ohne Eintrag in
// state.json (neu hinzugefügt) wird einmalig komplett gescannt.
//
// PLAYLISTS (seit 12.11.2026): Ein Eintrag mit "playlistIds" (Liste; alt:
// "playlistId") liest statt der Uploads des Kanals nur diese Playlists -- für Kanäle, die neben Filmen vor
// allem anderes hochladen (DasFliegendeGehirn: TV-Mitschnitte, Filme nur in
// der Playlist "Filme"). Eine selbst angelegte Playlist ist NICHT
// neueste-zuerst sortiert, neue Videos können überall stehen. Deshalb wird
// sie bei jedem Lauf vollständig gelesen (50 Videos = 1 Unit) und ersetzt
// die Rohdaten: Was der Kanal aus der Playlist nimmt, fällt auch hier raus.
// Gelöschte und private Videos (ohne Dauer) werden übersprungen.

import fs from "fs/promises";
import path from "path";

const API_KEY = process.env.YOUTUBE_API_KEY;
const CONFIG_PATH = "config/channels.json";
const RAW_DIR = "data/raw";
const STATE_PATH = "data/state.json";

if (!API_KEY) {
  console.error("Fehler: YOUTUBE_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

function uploadsPlaylistId(channelId) {
  if (!channelId.startsWith("UC")) {
    throw new Error(`Ungültige channelId (muss mit UC beginnen): ${channelId}`);
  }
  return "UU" + channelId.slice(2);
}

async function apiCall(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) {
    throw new Error(`YouTube API Fehler: ${JSON.stringify(json.error)}`);
  }
  return json;
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

// Dedupliziert nach videoId -- der erste Treffer gewinnt (also newVideos vor existing).
// Das räumt nebenbei auch etwaige Altlasten auf, falls durch einen früheren
// Lauf mal versehentlich Duplikate reingerutscht sind.
function dedupeByVideoId(videos) {
  const map = new Map();
  for (const v of videos) {
    if (!map.has(v.videoId)) map.set(v.videoId, v);
  }
  return [...map.values()];
}

// Playlist-Items abrufen, bis entweder die Liste zu Ende ist ODER
// stopAtVideoId wiedergetroffen wird (dann NICHT mehr im Ergebnis enthalten).
async function fetchNewPlaylistItems(playlistId, stopAtVideoId) {
  const items = [];
  let pageToken = "";

  do {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}` +
      `&pageToken=${pageToken}&key=${API_KEY}`;

    const json = await apiCall(url);

    for (const item of json.items) {
      if (item.contentDetails.videoId === stopAtVideoId) {
        return items; // Grenze erreicht, Rest ist schon bekannt
      }
      items.push(item);
    }

    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return items;
}

async function fetchDurations(videoIds) {
  const durations = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url =
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=contentDetails&id=${batch.join(",")}&key=${API_KEY}`;
    const json = await apiCall(url);
    for (const item of json.items) {
      durations[item.id] = item.contentDetails.duration;
    }
  }
  return durations;
}

function buildVideoObjects(rawItems, durations, channel) {
  return rawItems.map((item) => {
    const videoId = item.contentDetails.videoId;
    return {
      videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      publishedAt: item.contentDetails.videoPublishedAt,
      thumbnail:
        item.snippet.thumbnails?.high?.url ||
        item.snippet.thumbnails?.default?.url ||
        null,
      duration: durations[videoId] || null,
      channelName: channel.name,
      channelId: channel.channelId,
    };
  });
}

// Playlists eines Eintrags: "playlistIds": ["PL…", …] oder (alt) "playlistId".
function playlistsVon(channel) {
  if (Array.isArray(channel.playlistIds) && channel.playlistIds.length) return channel.playlistIds;
  return channel.playlistId ? [channel.playlistId] : null;
}

async function processChannel(channel, state) {
  const playlists = playlistsVon(channel);
  const istPlaylist = Boolean(playlists);
  console.log(`\n-> ${channel.name} (${channel.channelId || "channelId wird aus der Playlist gelesen"}${istPlaylist ? `, ${playlists.length} Playlist(s)` : ""})`);

  let rawItems;
  if (istPlaylist) {
    console.log("   Playlist -- wird bei jedem Lauf vollständig gelesen");
    rawItems = [];
    for (const pl of playlists) rawItems.push(...(await fetchNewPlaylistItems(pl, null)));
    // Fehlt die channelId noch (neuer Eintrag), gilt der Besitzer der Playlist.
    // Ohne channelId in config/channels.json hat der Eintrag kein Profil;
    // filter-movies.js sortiert seine Videos dann aus ("Kanal nicht in der
    // Kanalliste"). Die ID steht danach in data/raw/<channelId>.json und
    // wird von Hand in die Kanalliste übernommen.
    if (!channel.channelId && rawItems.length) {
      channel = { ...channel, channelId: rawItems[0].snippet.channelId };
      console.log(`   channelId aus der Playlist: ${channel.channelId}`);
    }
  } else {
    const knownLastVideoId = state[channel.channelId]?.lastVideoId || null;
    console.log(
      !knownLastVideoId
        ? "   Erster Scan dieses Kanals -- vollständiger Durchlauf"
        : `   Inkrementeller Scan (Stopp bei ${knownLastVideoId})`
    );
    rawItems = await fetchNewPlaylistItems(uploadsPlaylistId(channel.channelId), knownLastVideoId);
  }

  if (rawItems.length === 0) {
    console.log("   Keine neuen Videos seit dem letzten Scan.");
    return 0;
  }

  const videoIds = rawItems.map((i) => i.contentDetails.videoId);
  const durations = await fetchDurations(videoIds);
  let newVideos = buildVideoObjects(rawItems, durations, channel);

  const outPath = path.join(RAW_DIR, `${channel.channelId}.json`);
  const existing = await loadJson(outPath, []);
  let merged;
  let anzahlNeu;
  if (istPlaylist) {
    // videos.list liefert für gelöschte/private Videos nichts -> keine Dauer
    newVideos = dedupeByVideoId(newVideos.filter((v) => v.duration));
    const bekannt = new Set(existing.map((v) => v.videoId));
    anzahlNeu = newVideos.filter((v) => !bekannt.has(v.videoId)).length;
    merged = newVideos;
  } else {
    anzahlNeu = newVideos.length;
    merged = dedupeByVideoId([...newVideos, ...existing]); // neueste zuerst, ohne Duplikate
  }

  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(merged, null, 2), "utf-8");
  console.log(
    `   ${anzahlNeu} neue Videos verarbeitet, ${merged.length} insgesamt gespeichert (dedupliziert)`
  );

  // Neuestes Video dieses Laufs wird der neue Referenzpunkt fürs nächste Mal
  // (bei Playlists nur zur Information, dort wird immer alles gelesen)
  state[channel.channelId] = {
    lastVideoId: newVideos[0]?.videoId || null,
    lastRunAt: new Date().toISOString(),
  };

  return anzahlNeu;
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  const channels = config.channels.filter(
    (c) => (c.channelId && !c.channelId.startsWith("UCxxxx")) || (!c.channelId && playlistsVon(c))
  );

  if (channels.length === 0) {
    console.log("Keine echten Kanäle in config/channels.json eingetragen. Nichts zu tun.");
    return;
  }

  const state = await loadJson(STATE_PATH, {});

  let total = 0;
  for (const channel of channels) {
    try {
      total += await processChannel(channel, state);
    } catch (err) {
      console.error(`   Fehler bei ${channel.name}:`, err.message);
    }
  }

  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");

  console.log(`\nFertig. ${total} neue Videos über ${channels.length} Kanal/Kanäle.`);
}

main();
