import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');

if (!existsSync(svgInput)) {
    console.error('Error: glowing-bear.svg not found in static/');
    process.exit(1);
}

const svgMtime = statSync(svgInput).mtimeMs;

// Check if a destination file needs regeneration.
// Regenerates if destination is missing or source is newer.
function needsRegen(destPath) {
    if (!existsSync(destPath)) return true;
    return svgMtime > statSync(destPath).mtimeMs;
}

// Check if any output depends on the source SVG and needs updating.
function anyPngNeedsRegen() {
    for (const [filename] of icons) {
        if (needsRegen(resolve(__dirname, filename))) return true;
    }
    if (needsRegen(resolve(__dirname, 'glowing_bear_128x128.ico'))) return true;
    // The manifest derives from this script (not the SVG); a missing file is
    // the only staleness it can have — content drift is handled by a
    // byte-compare at write time.
    if (!existsSync(resolve(__dirname, 'manifest.webmanifest'))) return true;
    return false;
}

const icons = [
    ['favicon.png', 32],
    ['apple-touch-icon.png', 180],
    ['glowing-bear.png', 256],
    ['glowing_bear_60x60.png', 60],
    ['glowing_bear_90x90.png', 90],
    ['glowing_bear_128x128.png', 128],
    ['glowing_bear_192x192.png', 192],
    ['glowing_bear_512x512.png', 512],
    ['glowing_bear_1024x1024.png', 1024],
];

// Early exit if no outputs need regeneration.
if (!anyPngNeedsRegen()) {
    console.log('Icons up to date, skipping generation.');
    process.exit(0);
}

const svgBuffer = readFileSync(svgInput);
console.log('Generating icons from ' + svgInput + '...');

for (const [filename, size] of icons) {
    const output = resolve(__dirname, filename);
    if (!needsRegen(output)) {
        console.log(`  ⊘ ${filename} (${size}x${size}) — up to date`);
        continue;
    }
    try {
        const resvg = new Resvg(svgBuffer, {
            fitTo: { mode: 'width', value: size },
        });
        const pngBuffer = resvg.render().asPng();

        // Pad to exact square with transparent background
        const squared = await sharp(pngBuffer)
            .resize(size, size, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();

        writeFileSync(output, squared);
        const fileSize = statSync(output).size;
        console.log(`  \u2713 ${filename} (${size}x${size}) \u2014 ${(fileSize / 1024).toFixed(0)} KB`);
    } catch (e) {
        console.error(`  \u2717 Failed to generate ${filename}: ${e.message}`);
        process.exit(1);
    }
}

// Generate .ico from 128x128 PNG (only if source PNG or .ico needs updating)
const png128Path = resolve(__dirname, 'glowing_bear_128x128.png');
const icoPath = resolve(__dirname, 'glowing_bear_128x128.ico');
if (needsRegen(icoPath) || needsRegen(png128Path)) {
    try {
        execSync(
            `magick convert "${png128Path}" -depth 8 "${icoPath}"`,
            { stdio: ['inherit', 'inherit', 'ignore'] }
        );
        const icoSize = statSync(icoPath).size;
        console.log(`  \u2713 glowing_bear_128x128.ico \u2014 ${(icoSize / 1024).toFixed(0)} KB`);
    } catch (e) {
        console.error('  \u2717 Failed to generate .ico file');
        process.exit(1);
    }
} else {
    console.log('  ⊘ glowing_bear_128x128.ico — up to date');
}

// Regenerate manifest.webmanifest — the file app.html links as the web app
// manifest (the old script wrote webapp.manifest.json, which nothing read).
// The icon list mirrors the `icons` array above. Formatting matches the
// previously tracked file byte-for-byte, so an unchanged regeneration is a no-diff.
const manifest = {
    name: 'Glowing Bear',
    short_name: 'Glowing Bear',
    lang: 'en-US',
    description: 'A weechat-websocket frontend',
    theme_color: '#181818',
    background_color: '#0a0a0a',
    display: 'standalone',
    orientation: 'portrait-primary',
    scope: '.',
    start_url: '.',
    icons: [
        { src: 'favicon.png', sizes: '32x32', type: 'image/png' },
        { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
        { src: 'glowing_bear_60x60.png', sizes: '60x60', type: 'image/png' },
        { src: 'glowing_bear_90x90.png', sizes: '90x90', type: 'image/png' },
        { src: 'glowing_bear_128x128.png', sizes: '128x128', type: 'image/png' },
        { src: 'glowing_bear_192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'glowing_bear_512x512.png', sizes: '512x512', type: 'image/png' },
        { src: 'glowing_bear_1024x1024.png', sizes: '1024x1024', type: 'image/png' },
    ],
    prefer_related_applications: false,
    related_applications: [
        {
            platform: 'android',
            url: 'https://play.google.com/store/apps/details?id=com.glowing_bear',
        },
    ],
};

const manifestIconLines = manifest.icons
    .map((i) => `    { "src": "${i.src}", "sizes": "${i.sizes}", "type": "${i.type}" }`)
    .join(',\n');
const manifestJson = [
    '{',
    '  "name": "Glowing Bear",',
    '  "short_name": "Glowing Bear",',
    '  "lang": "en-US",',
    '  "description": "A weechat-websocket frontend",',
    '  "theme_color": "#181818",',
    '  "background_color": "#0a0a0a",',
    '  "display": "standalone",',
    '  "orientation": "portrait-primary",',
    '  "scope": ".",',
    '  "start_url": ".",',
    '  "icons": [',
    manifestIconLines,
    '  ],',
    '  "prefer_related_applications": false,',
    '  "related_applications": [',
    '    {',
    '      "platform": "android",',
    '      "url": "https://play.google.com/store/apps/details?id=com.glowing_bear"',
    '    }',
    '  ]',
    '}',
].join('\n');

const manifestPath = resolve(__dirname, 'manifest.webmanifest');
const currentManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
if (currentManifest === manifestJson + '\n') {
    console.log(`  \u2298 manifest.webmanifest \u2014 up to date`);
} else {
    writeFileSync(manifestPath, manifestJson + '\n');
    console.log(`  \u2713 manifest.webmanifest regenerated`);
}
console.log('Done.');
