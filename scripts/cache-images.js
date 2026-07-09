// Schritt 4 der Pipeline: Poster-Bilder aus data/filme.json lokal nach
// img/posters/<tmdbId>.jpg herunterladen, statt sie nur per Direktlink von
// TMDB einzubinden. Vorteile: Seite bleibt unabhängig von TMDB-Erreichbarkeit,
// kein Hotlinking, schnelleres Laden vom eigenen Server.
//
// INKREMENTELL: Ist die Datei für eine tmdbId schon vorhanden, wird sie
// nicht erneut heruntergeladen.

import fs from "fs/promises";
import path from "path";

const FILME_PATH = "data/filme.json";
const IMG_DIR = "img/posters";
const DELAY_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

async function main() {
  const filme = JSON.parse(await fs.readFile(FILME_PATH, "utf-8"));
  await fs.mkdir(IMG_DIR, { recursive: true });

  let downloaded = 0;
  let skippedExisting = 0;
  let skippedNoPoster = 0;
  let failed = 0;
  let changed = false;

  for (const movie of filme) {
    if (!movie.posterUrl) {
      skippedNoPoster++;
      continue;
    }

    const localRelativePath = `${IMG_DIR}/${movie.tmdbId}.jpg`;

    if (await fileExists(localRelativePath)) {
      skippedExisting++;
      if (movie.posterLocal !== localRelativePath) {
        movie.posterLocal = localRelativePath;
        changed = true;
      }
      continue;
    }

    try {
      await downloadImage(movie.posterUrl, localRelativePath);
      movie.posterLocal = localRelativePath;
      changed = true;
      downloaded++;
      if (downloaded % 200 === 0) {
        console.log(`... ${downloaded} Poster heruntergeladen`);
      }
    } catch (err) {
      console.error(`   Fehler bei tmdbId ${movie.tmdbId}: ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  if (changed) {
    await fs.writeFile(FILME_PATH, JSON.stringify(filme, null, 2), "utf-8");
  }

  console.log(`\nNeu heruntergeladen: ${downloaded}`);
  console.log(`Schon vorhanden:     ${skippedExisting}`);
  console.log(`Kein Poster bei TMDB: ${skippedNoPoster}`);
  console.log(`Fehlgeschlagen:      ${failed}`);
}

main();
