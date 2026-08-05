/*
 * Generates SVG artboard templates with safe-area guides for every Discord
 * asset Draw-tionary needs.
 *
 * Every size here is either taken from Discord's official Activity docs or
 * marked as a project decision. Open the SVGs in Affinity Designer, put your
 * artwork on a layer below the guides, then hide the "guides" layer to export.
 *
 *   node tools/build-art-templates.js
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "art", "templates");
mkdirSync(outDir, { recursive: true });

const TEMPLATES = [
  {
    file: "app-icon",
    w: 1024, h: 1024,
    title: "App icon",
    note: "Always masked to a circle. Renders as small as 20px.",
    guides: [
      { type: "circle", cx: 512, cy: 512, r: 512, label: "circle mask" },
      { type: "circle", cx: 512, cy: 512, r: 440, label: "safe — keep art inside" },
      { type: "rect", x: 262, y: 262, w: 500, h: 500, label: "legible at 20px" }
    ]
  },
  {
    file: "bot-avatar",
    w: 1024, h: 1024,
    title: "Bot avatar",
    note: "Separate from the app icon. Shown beside every message the bot posts, at 40px.",
    guides: [
      { type: "circle", cx: 512, cy: 512, r: 512, label: "circle mask" },
      { type: "circle", cx: 512, cy: 512, r: 440, label: "safe" }
    ]
  },
  {
    file: "cover-art",
    w: 2048, h: 1732,
    title: "Cover art — Activity Shelf",
    note: "Discord crops this to BOTH 16:9 and 13:11. Artboard is 13:11; keep the title inside the 16:9 band.",
    guides: [
      { type: "rect", x: 0, y: 290, w: 2048, h: 1152, label: "16:9 crop — title must live here" },
      { type: "rect", x: 154, y: 420, w: 1740, h: 892, label: "safe for text" }
    ]
  },
  {
    file: "embedded-background",
    w: 1920, h: 1080,
    title: "Embedded background — Grid view",
    note: "Discord overlays UI on the centre. Cluster artwork around the edges.",
    guides: [
      { type: "rect", x: 384, y: 216, w: 1152, h: 648, label: "UI sits here — keep clear", fill: true },
      { type: "rect", x: 96, y: 54, w: 1728, h: 972, label: "safe from edge crop" }
    ]
  },
  {
    file: "video-preview",
    w: 640, h: 360,
    title: "Video preview (frame reference)",
    note: "Export MP4 at this size. Under 10 seconds, under 1 MB. A sped-up drawing replay is ideal.",
    guides: [
      { type: "rect", x: 32, y: 18, w: 576, h: 324, label: "safe" }
    ]
  },
  {
    file: "canvas-frame",
    w: 1200, h: 900,
    title: "Drawing canvas — 4:3 (project decision)",
    note: "Fixed aspect so every drawing posted to the channel is the same shape. Not a Discord requirement.",
    guides: [
      { type: "rect", x: 60, y: 60, w: 1080, h: 780, label: "comfortable drawing area" }
    ]
  },
  {
    file: "channel-post",
    w: 1200, h: 900,
    title: "Channel post image — replay still or GIF",
    note: "Discord renders embedded images ~550px wide on desktop, so 1200px gives a crisp 2x. Keep files under 8 MB.",
    guides: [
      { type: "rect", x: 0, y: 0, w: 1200, h: 900, label: "4:3, matches the canvas" }
    ]
  },
  {
    file: "tier-badges",
    w: 900, h: 300,
    title: "Tier badges — easy / medium / hard",
    note: "Small marks shown beside the word and in results. Must read at 16px tall.",
    guides: [
      { type: "rect", x: 50, y: 50, w: 200, h: 200, label: "easy · 10" },
      { type: "rect", x: 350, y: 50, w: 200, h: 200, label: "medium · 20" },
      { type: "rect", x: 650, y: 50, w: 200, h: 200, label: "hard · 35" }
    ]
  }
];

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(t) {
  const guides = t.guides.map(g => {
    if (g.type === "circle") {
      return `      <circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="none"
              stroke="#e5177f" stroke-width="3" stroke-dasharray="12 10"/>
      <text x="${g.cx}" y="${g.cy - g.r + 34}" class="lbl" text-anchor="middle">${esc(g.label)}</text>`;
    }
    const fill = g.fill ? 'fill="#e5177f" fill-opacity="0.07"' : 'fill="none"';
    return `      <rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" ${fill}
            stroke="#e5177f" stroke-width="3" stroke-dasharray="12 10"/>
      <text x="${g.x + 14}" y="${g.y + 32}" class="lbl">${esc(g.label)}</text>`;
  }).join("\n\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${t.title}
  ${t.w} x ${t.h}
  ${t.note}

  Put artwork BELOW the "guides" group, then hide or delete that group to export.
-->
<svg xmlns="http://www.w3.org/2000/svg"
     width="${t.w}" height="${t.h}" viewBox="0 0 ${t.w} ${t.h}">
  <style>
    .lbl { font: 22px ui-sans-serif, system-ui, sans-serif; fill: #e5177f; }
    .meta { font: 26px ui-sans-serif, system-ui, sans-serif; fill: #6b7280; }
  </style>

  <g id="artwork">
    <rect width="${t.w}" height="${t.h}" fill="#ffffff"/>
  </g>

  <g id="guides">
${guides}

    <text x="14" y="${t.h - 16}" class="meta">${esc(t.title)} — ${t.w} × ${t.h}</text>
  </g>
</svg>
`;
}

for (const t of TEMPLATES) {
  writeFileSync(join(outDir, t.file + ".svg"), render(t));
  console.log(`  ${t.file}.svg`.padEnd(30) + `${t.w} × ${t.h}`.padEnd(14) + t.title);
}

console.log(`\n${TEMPLATES.length} templates written to art/templates/`);
