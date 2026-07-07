// Schritt 1 der Pipeline: rohe Video-Metadaten von YouTube abrufen.
// Nutzt NUR playlistItems.list (1 Unit/Aufruf) + videos.list für die Dauer (1 Unit je 50 IDs).
// Kein Scraping, keine Bot-Umgehung -- ausschließlich offizielle API.

import fs from "fs/promises";
import path from "path";

const API_KEY = process.env.YOUTUBE_API_KEY;
const CONFIG_PATH = "config/channels.json";
const RAW_DIR = "data/raw";

if (!API_KEY) {
  console.error("Fehler: YOUTUBE_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

// Uploads-Playlist-ID aus der channelId ableiten: UC... -> UU... (kostenlos, kein API-Call nötig)
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

// Alle Items einer Playlist abrufen (mit Pagination)
async function fetchAllPlaylistItems(playlistId) {
  const items = [];
  let pageToken = "";

  do {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems` +
      `?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}` +
      `&pageToken=${pageToken}&key=${API_KEY}`;

    const json = await apiCall(url);
    items.push(...json.items);
    pageToken = json.nextPageToken || "";
  } while (pageToken);

  return items;
}

// Dauer (contentDetails.duration) für eine Liste von Video-IDs abrufen, in 50er-Batches
async function fetchDurations(videoIds) {
  const durations = {};

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url =
      `https://www.googleapis.com/youtube/v3/videos` +
      `?part=contentDetails&id=${batch.join(",")}&key=${API_KEY}`;

    const json = await apiCall(url);
    for (const item of json.items) {
      durations[item.id] = item.contentDetails.duration; // ISO 8601, z.B. PT1H32M
    }
  }

  return durations;
}

async function processChannel(channel) {
  console.log(`\n-> ${channel.name} (${channel.channelId})`);

  const playlistId = uploadsPlaylistId(channel.channelId);
  const rawItems = await fetchAllPlaylistItems(playlistId);
  console.log(`   ${rawItems.length} Videos gefunden`);

  const videoIds = rawItems.map((i) => i.contentDetails.videoId);
  const durations = await fetchDurations(videoIds);

  const videos = rawItems.map((item) => {
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

  const outPath = path.join(RAW_DIR, `${channel.channelId}.json`);
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(videos, null, 2), "utf-8");
  console.log(`   gespeichert: ${outPath}`);

  return videos.length;
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
  const channels = config.channels.filter(
    (c) => c.channelId && !c.channelId.startsWith("UCxxxx")
  );

  if (channels.length === 0) {
    console.log(
      "Keine echten Kanäle in config/channels.json eingetragen (nur der Platzhalter). Nichts zu tun."
    );
    return;
  }

  let total = 0;
  for (const channel of channels) {
    try {
      total += await processChannel(channel);
    } catch (err) {
      console.error(`   Fehler bei ${channel.name}:`, err.message);
    }
  }

  console.log(`\nFertig. ${total} Videos über ${channels.length} Kanal/Kanäle verarbeitet.`);
}

main();
