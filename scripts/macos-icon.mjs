// Shared macOS icon geometry + grid-master renderer.
//
// macOS 26 (Tahoe) and later render a bundled app's icon through their own icon
// compositor. An .icns whose artwork is a bare, near-full-bleed silhouette
// (transparent corners, nothing behind the art) is treated as legacy artwork:
// the system shrinks it and mounts it on a grey rounded-square plate. That is
// exactly what `tauri icon` over `static/glowing-bear.svg` produces — the SVG is
// the bear alone, so the icon asks the OS for a background.
//
// A bundled icon is drawn as authored when the artwork sits on Apple's macOS
// icon grid: a rounded-square ("squircle") body of 824pt inset 100px inside a
// 1024px transparent canvas. This module builds that master, so the .icns the
// app bundles carries its own tile instead of asking the OS for one.
//
// Dev looks different for a related reason: `tauri dev` has no bundle, so
// tauri-codegen embeds the raw .icns bytes in the dev binary (only for
// `Target::MacOS && dev`) and the runtime calls NSApp.setApplicationIconImage,
// which draws the bitmap unmasked. Putting the tile in the .icns makes the dev
// Dock tile and the bundled icon the same artwork.
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

/** Apple's macOS icon grid: an 824pt body inset 100 on a 1024 canvas. */
const CANVAS = 1024;
const BODY = 824;

// Continuous-curvature corners: a superellipse reads as Apple's squircle, while
// a plain rounded rect of the same inset reads as a card. Exponent 4 is the
// usual approximation; at icon sizes it is indistinguishable from Apple's shape.
const SQUIRCLE_EXPONENT = 4;

/**
 * Path data for the squircle body, centred on the canvas, sampled as a closed
 * polygon. Sampled densely enough that the curvature stays smooth at 1024px.
 */
function squirclePath() {
    const r = BODY / 2;
    const cx = CANVAS / 2;
    const cy = CANVAS / 2;
    const steps = 240;
    const points = [];
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        // |x/r|^n + |y/r|^n = r^n  →  parametric form of the superellipse.
        const x = cx + r * Math.pow(Math.abs(Math.cos(t)), 2 / SQUIRCLE_EXPONENT) * Math.sign(Math.cos(t));
        const y = cy + r * Math.pow(Math.abs(Math.sin(t)), 2 / SQUIRCLE_EXPONENT) * Math.sign(Math.sin(t));
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return `M${points.join('L')}Z`;
}

// The tile itself: a vertical gradient in the app's dark theme plus a hairline
// light edge, so it reads as a tile against any wallpaper.
function tileSvg(topColor, bottomColor) {
    const body = squirclePath();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${topColor}"/>
      <stop offset="1" stop-color="${bottomColor}"/>
    </linearGradient>
  </defs>
  <path d="${body}" fill="url(#tile)"/>
  <path d="${body}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2"/>
</svg>`;
}

// Soft halo behind the bear, clipped to the tile, so "glowing" still reads.
function glowSvg(color, opacity, radius) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/>
      <stop offset="0.65" stop-color="${color}" stop-opacity="${opacity * 0.35}"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="tileclip"><path d="${squirclePath()}"/></clipPath>
  </defs>
  <g clip-path="url(#tileclip)">
    <circle cx="${CANVAS / 2}" cy="${CANVAS / 2}" r="${radius}" fill="url(#glow)"/>
  </g>
</svg>`;
}

/** The look the app ships: near-black tile, warm halo, bear filling ~76% of the tile. */
export const DEFAULT_STYLE = {
    top: '#1f1f1f',
    bottom: '#0c0c0c',
    artFraction: 0.78,
    glow: { color: '#f6a623', opacity: 0.22, radius: 330 },
    verticalNudge: 0,
};

/**
 * Build the 1024x1024 macOS-grid master PNG from the source SVG.
 * `artFraction` is the artwork *width* relative to the tile body; the SVG keeps its
 * own aspect ratio. The bear's silhouette is ~98% of the viewBox, so 0.78 lands the
 * visible fur at ~76% of the tile — Chrome and Discord measure 75-82% in the same Dock.
 * `fitTo` must be `{mode:'width', value}`: resvg-js ignores `{mode:'contain', width,
 * height}` and silently renders the SVG at its intrinsic size, which is how the bear
 * ended up at 54% of the tile in the Dock while the numbers looked correct.
 */
export async function renderGridMaster(svgBuffer, {
    top = DEFAULT_STYLE.top,
    bottom = DEFAULT_STYLE.bottom,
    artFraction = DEFAULT_STYLE.artFraction,
    glow = DEFAULT_STYLE.glow,
    verticalNudge = DEFAULT_STYLE.verticalNudge,
} = {}) {
    const artWidth = Math.round(BODY * artFraction);
    const resvg = new Resvg(svgBuffer, { fitTo: { mode: 'width', value: artWidth } });
    const art = resvg.render().asPng();
    const artMeta = await sharp(art).metadata();

    const layers = [];
    if (glow) {
        layers.push({ input: Buffer.from(glowSvg(glow.color, glow.opacity, glow.radius)), position: { left: 0, top: 0 } });
    }
    layers.push({
        input: art,
        position: {
            left: Math.round((CANVAS - (artMeta.width ?? artWidth)) / 2),
            top: Math.round((CANVAS - (artMeta.height ?? artWidth)) / 2) + verticalNudge,
        },
    });

    return sharp(Buffer.from(tileSvg(top, bottom)))
        .composite(layers)
        .png()
        .toBuffer();
}
