/**
 * Batch PDF export — Claude 4-Stage Pipeline catalogue
 * Uses the real app rendered by React so PDFs match exactly what the user sees.
 * Usage: node scripts/export_pdfs.mjs
 */

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const BASE_URL   = "http://localhost:3000";
const USER_EMAIL = "sylvansitkey07@gmail.com";
const OUTPUT_DIR = path.resolve(
  process.env.HOME,
  "Library/CloudStorage/GoogleDrive-sylvansitkey07@gmail.com/My Drive/02 Personal Projects/Printmaster AI/Roseberys AI/Artwork Classifier Analysis/PrintMaster Analysis/print appraisal tools/PDF Reports"
);

const ITEMS = [
  { id: "f24b20d7-5dfa-4b7e-a7d2-e615afaa081b", artist: "Utagawa Toyokuni I",    title: "From an untitled series of beautiful women" },
  { id: "2a9c34ff-b621-4c84-832a-329c83b9ab17", artist: "Elisabeth Frink",         title: "Chanticleer and Pertelote" },
  { id: "6722ba0e-da13-4818-af5b-a7f415640a03", artist: "Pablo Picasso",           title: "Plate from Carmen (Prosper Mérimée)" },
  { id: "b1332b0e-7a0c-41e7-8458-b2560d9030a3", artist: "Pablo Picasso",           title: "Carmen (by Prosper Mérimée, 38 burin engravings)" },
  { id: "d8b719b4-61b0-48ce-a92d-1f06c7408474", artist: "Warrington Colescott",    title: "Patrioticks" },
  { id: "630206b2-dc80-41f4-bf1f-78f4413bbf00", artist: "Julian Trevelyan",        title: "Marlborough College" },
  { id: "63b624cf-4f59-4475-994b-f08c9905891e", artist: "Agathe Sorel",            title: "Après la Moisson (After the Harvest)" },
  { id: "9db2131f-4f3e-4f59-b2e2-3cbb3badef77", artist: "Agathe Sorel",            title: "Of Biplanes and Catamarans" },
  { id: "22e6c506-3dfb-4981-a258-ce85d93a2f63", artist: "Madame Hassia",           title: "Untitled (Nude Nu)" },
  { id: "d4739966-782f-4ff2-8d8a-751ad6f0c0ef", artist: "Jacques Villon",          title: "Le Petit Équilibriste (The Small Equilibrist)" },
  { id: "da0eaed5-5285-4a15-94ff-0f530b487076", artist: "Pablo Picasso",           title: "Plate from Carmen (plate number unidentified)" },
  { id: "470160f3-5e95-467a-b9f9-e79607e692d6", artist: "Paul Nash",               title: "Black Poplar Pond" },
  { id: "9b862592-ca65-4e85-98a7-dfdf035b5bc2", artist: "Julian Trevelyan",        title: "Birds" },
  { id: "d543f995-f617-432f-95ff-1383f40e6903", artist: "Gino Severini",           title: "Gravure Futuriste (Futurist Engraving)" },
  { id: "f6073b7f-8b18-4305-a985-52465332fd27", artist: "Georges Braque",          title: "Nike from La Théogonie dHésiode" },
  { id: "a1325099-ba77-405a-a014-c0623c4eb050", artist: "Elisabeth Frink",         title: "Canterbury Tales unidentified plate" },
  { id: "b14bde3f-f895-4d6c-be49-ec3dcc21846f", artist: "Madame Hassia",           title: "Profile of a Woman (Paris 1944)" },
  { id: "fdefb899-f683-4ec1-b614-21d190a7eed7", artist: "Julian Trevelyan RA",     title: "Boules Players" },
  { id: "404348c1-50cc-47d3-b2a6-31ca8512848d", artist: "Roberto Matta",           title: "El Verbo America" },
  { id: "4c0e3448-f380-4c5f-825e-519be927cd79", artist: "Roberto Matta",           title: "Re-Regina" },
  { id: "5d969a00-cfd9-40ef-8922-8c9c48b74020", artist: "Elisabeth Frink",         title: "Uncertain possibly The Nuns Priests Tale" },
];

function makePdfFilename(artist, title) {
  const clean = (s) => s.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  const artistPart = clean(artist).substring(0, 30).trim();
  const titlePart  = clean(title).substring(0, 20).trim();
  return `Roseberys Sept ${artistPart} ${titlePart}.pdf`;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Exporting ${ITEMS.length} PDFs via live app...\n`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Users/sylvansitkey/.cache/puppeteer/chrome/mac_arm-152.0.7977.42/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Shared page — navigate once, reuse for all items
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Pre-set localStorage before the app loads
  await page.evaluateOnNewDocument((email) => {
    localStorage.setItem("print_analyzer_user", email);
  }, USER_EMAIL);

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for React and the global export function to be registered
  await page.waitForFunction(() => typeof window.__pdfExportLoad === "function", { timeout: 15000 });

  let success = 0;
  for (const item of ITEMS) {
    const filename = makePdfFilename(item.artist, item.title);
    const outPath  = path.join(OUTPUT_DIR, filename);
    console.log(`  → ${filename}`);

    try {
      // Call the exposed React function to inject the report
      await page.evaluate(async (itemId, email) => {
        await window.__pdfExportLoad(itemId, email);
      }, item.id, USER_EMAIL);

      // Wait for the certificate container to have content
      await page.waitForFunction(() => {
        const el = document.querySelector(".certificate-print-container");
        return el && el.innerText && el.innerText.trim().length > 50;
      }, { timeout: 10000 });

      // Extra settle time for images and fonts
      await new Promise(r => setTimeout(r, 2000));

      await page.pdf({
        path: outPath,
        format: "A4",
        margin: { top: "1.4cm", bottom: "1.4cm", left: "1.8cm", right: "1.8cm" },
        printBackground: true,
      });

      console.log(`  ✓ Saved`);
      success++;
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
    }
  }

  await page.close();

  await browser.close();
  console.log(`\nDone. ${success}/${ITEMS.length} PDFs saved to:\n${OUTPUT_DIR}`);
}

main().catch(err => { console.error(err); process.exit(1); });
