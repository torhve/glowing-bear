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

const svgBuffer = readFileSync(svgInput);

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

console.log('Generating icons from ' + svgInput + '...');

for (const [filename, size] of icons) {
    const output = resolve(__dirname, filename);
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

// Generate .ico from 128x128 PNG
try {
    execSync(
        `magick convert "${resolve(__dirname, 'glowing_bear_128x128.png')}" -depth 8 "${resolve(__dirname, 'glowing_bear_128x128.ico')}"`,
        { stdio: ['inherit', 'inherit', 'ignore'] }
    );
    const icoSize = statSync(resolve(__dirname, 'glowing_bear_128x128.ico')).size;
    console.log(`  \u2713 glowing_bear_128x128.ico \u2014 ${(icoSize / 1024).toFixed(0)} KB`);
} catch (e) {
    console.error('  \u2717 Failed to generate .ico file');
    process.exit(1);
}

// Regenerate webapp.manifest.json
const manifest = {
    lang: 'en-US',
    name: 'Glowing Bear',
    short_name: 'Glowing Bear',
    icons: [
        { src: '/favicon.png', sizes: '32x32', type: 'image/png' },
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
        { src: '/glowing_bear_60x60.png', sizes: '60x60', type: 'image/png' },
        { src: '/glowing_bear_90x90.png', sizes: '90x90', type: 'image/png' },
        { src: '/glowing_bear_128x128.png', sizes: '128x128', type: 'image/png' },
        { src: '/glowing_bear_192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/glowing_bear_512x512.png', sizes: '512x512', type: 'image/png' },
        { src: '/glowing_bear_1024x1024.png', sizes: '1024x1024', type: 'image/png' },
    ],
    splash_screens: [
        { src: '/glowing_bear_512x512.png', sizes: '512x512' },
    ],
    scope: '/',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    theme_color: '#0a0a0a',
    background_color: '#0a0a0a',
    prefer_related_applications: false,
    chrome_related_applications: [
        { platform: 'web' },
        {
            platform: 'android',
            location: 'https://play.google.com/store/apps/details?id=com.glowing_bear',
        },
    ],
};

writeFileSync(resolve(__dirname, 'webapp.manifest.json'), JSON.stringify(manifest, null, 4) + '\n');
console.log(`  \u2713 webapp.manifest.json regenerated`);
console.log('Done.');
