#!/usr/bin/env node
"use strict";

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
    layer("front hair_1", 294, 102, hairShape(234, 360, hairLight, 1.8)),
    layer("front hair_2", 496, 98, hairShape(236, 372, hair, 4.2)),
  ];
  return { width: 1024, height: 1024, children };
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
  const generic = sanitizeVendor("genericparts.js")
    .replace(/typeof self!==\'undefined\'\?self:this/, "rigVendorRoot");
  return `function loadRigVendor(rigVendorRoot) {\n${ag}\n${rigger}\n${generic}\nreturn { agPsd: rigVendorRoot.agPsd, Rigger: rigVendorRoot.Rigger, GenericParts: rigVendorRoot.GenericParts };\n}`;
}

function buildModelSection() {
  const bytes = agPsd.writePsdUint8Array(buildModelPsd(), { generateThumbnail: false });
  const base64 = Buffer.from(bytes).toString("base64").replace(/\/\//g, '/" + "/');
  return `const RIG_MODEL_BASE64 = "${base64}";`;
}

function build() {
  verifyVendor();
  let output = fs.readFileSync(TARGET, "utf8");
  output = replaceSection(output, VENDOR_BEGIN, VENDOR_END, buildVendorSection());
  output = replaceSection(output, MODEL_BEGIN, MODEL_END, buildModelSection());
  const forbiddenUrl = /\b(?:https?:)?\/\//i.exec(output);
  if (forbiddenUrl) {
    throw new Error(`generated page script contains a forbidden URL-shaped token near ${output.slice(Math.max(0, forbiddenUrl.index - 24), forbiddenUrl.index + 48)}`);
  }
  fs.writeFileSync(TARGET, output.endsWith("\n") ? output : `${output}\n`);
}

if (require.main === module) build();

module.exports = { build, buildModelPsd };
