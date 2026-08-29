#!/usr/bin/env node
"use strict";

/*
 * Regenerates the vendored Anime2.5DRig embed and local avatar PSD inside
 * public/local-avatar/local-avatar.js.
 *
 * Default builds embed a deterministic procedural PSD with provenance
 * "procedural".
 *
 * `--model /path/to/model.psd` swaps in a local external PSD for tuning-only
 * builds. External-model builds are local use only and must never be committed;
 * the shipped public/local-avatar/local-avatar.js must keep provenance
 * "procedural" so the test guard stays honest.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const agPsd = require("./vendor/anime25drig/ag-psd.min.js");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "public", "local-avatar", "local-avatar.js");
const VENDOR_DIR = path.join(__dirname, "vendor", "anime25drig");
const VENDOR_BEGIN = "/* @rig-vendor-begin */";
const VENDOR_END = "/* @rig-vendor-end */";
const MODEL_BEGIN = "/* @rig-model-begin */";
const MODEL_END = "/* @rig-model-end */";
const VENDOR_HASHES = Object.freeze({
  "LICENSE": "15183bfbec774052a5817a28eb03730c40ec941a642097b597f0c50092594adb",
  "ag-psd.min.js": "1df9691925fbd64bdc9f7e3e74a42733cc443ecee770df996f2349a7102c0fe6",
  "genericparts.js": "a165e6271ca7e177d99beb658a5961a60780136785e3cd5580ed076ac752d166",
  "index.html": "716c062909e3832a936901dad99e03e83d2a474cf80b3ce9926bf273f0ee163a",
  "rigger.js": "186a56d7a1e28ea5380d25ae4363f292eb6d719d14aa5793f4a483eb4d016667",
});

function image(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, color, alpha = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 4;
    if (alpha < data[offset + 3]) return;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = alpha;
  };
  painter({ width, height, set });
  return { width, height, data };
}

function ellipse(width, height, color, insetX = 1, insetY = 1) {
  return image(width, height, ({ set }) => {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const rx = Math.max(1, cx - insetX);
    const ry = Math.max(1, cy - insetY);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) set(x, y, color, d > 0.92 ? Math.round(255 * (1 - d) / 0.08) : 255);
      }
    }
  });
}

function rounded(width, height, radius, color) {
  return image(width, height, ({ set }) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = Math.max(radius - x, 0, x - (width - 1 - radius));
        const dy = Math.max(radius - y, 0, y - (height - 1 - radius));
        if (dx * dx + dy * dy <= radius * radius) set(x, y, color);
      }
    }
  });
}

function pairedEllipses(width, height, color, rx, ry, centers) {
  return image(width, height, ({ set }) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (const [cx, cy] of centers) {
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (d <= 1) {
            set(x, y, color, d > 0.86 ? Math.round(255 * (1 - d) / 0.14) : 255);
            break;
          }
        }
      }
    }
  });
}

function pairedLines(width, height, color, centers, thickness, curve = 0) {
  return image(width, height, ({ set }) => {
    for (const [cx, cy, half] of centers) {
      for (let x = Math.max(0, cx - half); x <= Math.min(width - 1, cx + half); x += 1) {
        const normalized = (x - cx) / half;
        const targetY = Math.round(cy + curve * normalized * normalized);
        for (let dy = -thickness; dy <= thickness; dy += 1) set(x, targetY + dy, color);
      }
    }
  });
}

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[previous];
    const intersects = (y1 > py) !== (y2 > py)
      && px < ((x2 - x1) * (py - y1)) / ((y2 - y1) || 1e-6) + x1;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegmentSquared(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

function fillPolygon(target, points, color) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!pointInPolygon(px, py, points)) continue;
      let minDistance = Infinity;
      for (let index = 0; index < points.length; index += 1) {
        const [ax, ay] = points[index];
        const [bx, by] = points[(index + 1) % points.length];
        minDistance = Math.min(minDistance, distanceToSegmentSquared(px, py, ax, ay, bx, by));
      }
      const alpha = minDistance >= 1.6 ? 255 : Math.max(96, Math.round(255 * Math.sqrt(minDistance) / 1.6));
      target.set(x, y, color, alpha);
    }
  }
}

function frontHairShape(width, height, color, polygons) {
  return image(width, height, (target) => {
    for (const points of polygons) fillPolygon(target, points, color);
  });
}

function hairShape(width, height, color, phase) {
  return image(width, height, ({ set }) => {
    const cx = (width - 1) / 2;
    for (let y = 0; y < height; y += 1) {
      const t = y / Math.max(1, height - 1);
      const half = width * (0.46 - 0.16 * t) + 12 * Math.sin(t * 10 + phase);
      const sway = 9 * Math.sin(t * 6 + phase);
      for (let x = 0; x < width; x += 1) {
        const edge = Math.abs(x - cx - sway) - half;
        if (edge <= 0) set(x, y, color, edge > -3 ? Math.round(255 * -edge / 3) : 255);
      }
    }
  });
}

function layer(name, left, top, imageData) {
  return {
    name,
    left,
    top,
    right: left + imageData.width,
    bottom: top + imageData.height,
    imageData,
  };
}

function buildModelPsd() {
  const skin = [255, 220, 205];
  const ink = [52, 39, 59];
  const hair = [55, 73, 112];
  const hairLight = [77, 101, 150];
  const white = [249, 250, 255];
  const iris = [65, 184, 201];
  const blush = [239, 114, 135];
  const children = [
    layer("back hair", 274, 112, hairShape(476, 650, hair, 0.7)),
    layer("topwear", 298, 676, rounded(428, 330, 72, [68, 93, 142])),
    layer("neck", 454, 622, rounded(116, 154, 44, skin)),
    layer("face", 330, 190, ellipse(364, 466, skin, 8, 5)),
    layer("eyewhite", 378, 352, pairedEllipses(268, 76, white, 48, 26, [[52, 38], [216, 38]])),
    layer("irides", 392, 358, pairedEllipses(240, 64, iris, 18, 25, [[47, 32], [193, 32]])),
    layer("eyelash", 374, 337, pairedLines(276, 61, ink, [[56, 27, 50], [220, 27, 50]], 4, -8)),
    layer("eye_close", 374, 363, pairedLines(276, 42, ink, [[56, 17, 47], [220, 17, 47]], 4, 7)),
    layer("eyebrow", 382, 303, pairedLines(260, 47, hair, [[48, 26, 43], [212, 26, 43]], 5, -5)),
    layer("mouth_open", 454, 510, ellipse(116, 70, [126, 45, 66], 5, 4)),
    layer("mouth_close", 454, 532, pairedLines(116, 28, blush, [[58, 12, 48]], 3, 4)),
    layer("front hair_1", 262, 120, frontHairShape(278, 500, hairLight, [
      [[28, 18], [238, 10], [274, 44], [252, 92], [206, 126], [150, 144], [96, 148], [48, 128], [20, 74]],
      [[6, 20], [88, 22], [112, 62], [108, 166], [94, 312], [70, 456], [48, 498], [22, 470], [8, 336], [0, 152]],
    ])),
    layer("front hair_2", 484, 118, frontHairShape(276, 506, hair, [
      [[8, 26], [222, 12], [260, 42], [272, 88], [248, 118], [198, 144], [134, 152], [78, 138], [26, 108]],
      [[158, 18], [270, 12], [275, 174], [266, 346], [246, 472], [214, 504], [186, 480], [170, 336], [162, 186]],
    ])),
  ];
  return { width: 1024, height: 1024, children };
}

function initializePsdIO() {
  agPsd.initializeCanvas(
    () => { throw new Error("canvas output is unavailable in the rig builder"); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  );
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeVendor(file) {
  let source = stripComments(fs.readFileSync(path.join(VENDOR_DIR, file), "utf8"));
  if (file === "rigger.js" || file === "ag-psd.min.js") source = source.replace(/\/\/.*$/gm, "");
  if (file === "genericparts.js") source = source.replace(/\/\//g, "/'+'/ ".trim());
  source = source.replace(/[ \t]+$/gm, "");
  if (/\b(?:https?:)?\/\//i.test(source)) throw new Error(`${file} retains a forbidden URL-shaped token`);
  return source;
}

function verifyVendor() {
  for (const [file, expected] of Object.entries(VENDOR_HASHES)) {
    const bytes = fs.readFileSync(path.join(VENDOR_DIR, file));
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`vendored source hash mismatch: ${file}`);
  }
}

function replaceSection(source, begin, end, body) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start < 0 || finish < start) throw new Error(`missing generated section ${begin}`);
  return `${source.slice(0, start + begin.length)}\n${body}\n${source.slice(finish)}`;
}

function buildVendorSection() {
  const ag = sanitizeVendor("ag-psd.min.js")
    .replace(/typeof window/g, "typeof rigVendorRoot")
    .replace(/g=window/g, "g=rigVendorRoot");
  const rigger = sanitizeVendor("rigger.js")
    .replace(/typeof self !== 'undefined' \? self : this/, "rigVendorRoot");
  return `function loadRigVendor(rigVendorRoot) {\n${ag}\n${rigger}\nreturn { agPsd: rigVendorRoot.agPsd, Rigger: rigVendorRoot.Rigger };\n}`;
}

function parseArguments(argv) {
  const options = { modelPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--model") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--model requires a PSD path");
      options.modelPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--out requires a file path");
      options.outputPath = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function loadEmbeddedModel(options = {}) {
  if (!options.modelPath) return { psd: buildModelPsd(), provenance: "procedural" };
  let bytes;
  try {
    bytes = fs.readFileSync(options.modelPath);
  } catch (error) {
    throw new Error(`failed to read --model PSD ${options.modelPath}: ${error.message}`);
  }
  try {
    return {
      psd: agPsd.readPsd(bytes, { useImageData: true, skipThumbnail: true }),
      provenance: "external",
    };
  } catch (error) {
    throw new Error(`failed to parse --model PSD ${options.modelPath}: ${error.message}`);
  }
}

function buildModelSection(options = {}) {
  const model = loadEmbeddedModel(options);
  const bytes = agPsd.writePsdUint8Array(model.psd, { generateThumbnail: false });
  const base64 = Buffer.from(bytes).toString("base64").replace(/\/\//g, '/" + "/');
  return `const RIG_MODEL_PROVENANCE = "${model.provenance}";\nconst RIG_MODEL_BASE64 = "${base64}";`;
}

function build(options = {}) {
  initializePsdIO();
  verifyVendor();
  let output = fs.readFileSync(TARGET, "utf8");
  output = replaceSection(output, VENDOR_BEGIN, VENDOR_END, buildVendorSection());
  output = replaceSection(output, MODEL_BEGIN, MODEL_END, buildModelSection(options));
  const forbiddenUrl = /\b(?:https?:)?\/\//i.exec(output);
  if (forbiddenUrl) {
    throw new Error(`generated page script contains a forbidden URL-shaped token near ${output.slice(Math.max(0, forbiddenUrl.index - 24), forbiddenUrl.index + 48)}`);
  }
  fs.writeFileSync(options.outputPath || TARGET, output.endsWith("\n") ? output : `${output}\n`);
}

if (require.main === module) build(parseArguments(process.argv.slice(2)));

module.exports = { build, buildModelPsd, parseArguments };
