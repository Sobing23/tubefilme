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

async function processChannel(channel, state) {
  console.log(`\n-> ${channel.name} (${channel.channelId})`);

  const playlistId = uploadsPlaylistId(channel.channelId);
  const knownLastVideoId = state[channel.channelId]?.lastVideoId || null;
  const isFirstScan = !knownLastVideoId;

  console.log(
    isFirstScan
      ? "   Erster Scan dieses Kanals -- vollständiger Durchlauf"
      : `   Inkrementeller Scan (Stopp bei ${knownLastVideoId})`
  );

  const rawItems = await fetchNewPlaylistItems(playlistId, knownLastVideoId);

  if (rawItems.length === 0) {
    console.log("   Keine neuen Videos seit dem letzten Scan.");
    return 0;
  }

  const videoIds = rawItems.map((i) => i.contentDetails.videoId);
  const durations = await fetchDurations(videoIds);
  const newVideos = buildVideoObjects(rawItems, durations, channel);

  const outPath = path.join(RAW_DIR, `${channel.channelId}.json`);
  const existing = await loadJson(outPath, []);
  const merged = dedupeByVideoId([...newVideos, ...existing]); // neueste zuerst, ohne Duplikate

  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(merged, null, 2), "utf-8");
  console.log(
    `   ${newVideos.length} neue Videos verarbeitet, ${merged.length} insgesamt gespeichert (dedupliziert)`
  );

  // Neuestes Video dieses Laufs wird der neue Referenzpunkt fürs nächste Mal
  state[channel.channelId] = {
    lastVideoId: newVideos[0].videoId,
    lastRunAt: new Date().toISOString(),
  };

  return newVideos.length;
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  const channels = config.channels.filter(
    (c) => c.channelId && !c.channelId.startsWith("UCxxxx")
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
