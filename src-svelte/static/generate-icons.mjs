import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');

if (!existsSync(svgInput)) {
    console.error('Error: glowing-bear.svg not found in static/');
    process.exit(1);
}

// Icon sizes: [output filename, width, height]
const icons = [
    ['favicon.png', 32, 32],
    ['apple-touch-icon.png', 180, 180],
    ['glowing-bear.png', 256, 256],
    ['glowing_bear_60x60.png', 60, 60],
    ['glowing_bear_90x90.png', 90, 90],
    ['glowing_bear_128x128.png', 128, 128],
    ['glowing_bear_192x192.png', 192, 192],
    ['glowing_bear_512x512.png', 512, 512],
];

console.log(`Generating icons from ${svgInput}...`);

for (const [filename, w, h] of icons) {
    const output = resolve(__dirname, filename);
    try {
        execSync(`magick convert -background none -resize ${w}x${h}! "${svgInput}" "${output}"`, {
            stdio: ['inherit', 'inherit', 'ignore']
        });
        console.log(`  ✓ ${filename} (${w}x${h})`);
    } catch (e) {
        console.error(`  ✗ Failed to generate ${filename}`);
        process.exit(1);
    }
}

// Generate .ico from 128x128 PNG
try {
    execSync(`magick convert "${resolve(__dirname, 'glowing_bear_128x128.png')}" "${resolve(__dirname, 'glowing_bear_128x128.ico')}"`, {
        stdio: ['inherit', 'inherit', 'ignore']
    });
    console.log('  ✓ glowing_bear_128x128.ico');
} catch (e) {
    console.error('  ✗ Failed to generate .ico file');
    process.exit(1);
}

// Regenerate webapp.manifest.json with corrected icon entries
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
    ],
    splash_screens: [
        { src: '/glowing_bear_512x512.png', sizes: '512x512' }
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
            location: 'https://play.google.com/store/apps/details?id=com.glowing_bear'
        }
    ]
};

writeFileSync(resolve(__dirname, 'webapp.manifest.json'), JSON.stringify(manifest, null, 4) + '\n');
console.log('  ✓ webapp.manifest.json regenerated');
console.log('Done.');
