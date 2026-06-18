import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');
const icnsOutput = resolve(__dirname, 'glowing-bear.icns');
const iconsetDir = resolve(__dirname, '.icns-temp.iconset');

if (!existsSync(svgInput)) {
    console.error('Error: glowing-bear.svg not found in static/');
    process.exit(1);
}

// macOS iconutil requires an iconset directory with these specific sizes
const iconsetSizes = [
    [16, 16],
    [16, 32],  // @2x
    [32, 32],
    [32, 64],  // @2x
    [64, 64],
    [64, 128], // @2x
    [128, 128],
    [128, 256],// @2x
    [256, 256],
    [256, 512],// @2x
    [512, 512],
    [512, 1024],// @2x (may be ignored by iconutil)
];

// Clean up any previous temp directory
if (existsSync(iconsetDir)) {
    rmSync(iconsetDir, { recursive: true, force: true });
}
mkdirSync(iconsetDir, { recursive: true });

console.log('Generating .icns from glowing-bear.svg...');

for (const [w, h] of iconsetSizes) {
    const name = w === h ? `icon_${w}x${w}.png` : `icon_${w}x${w}@2x.png`;
    const outputPath = resolve(iconsetDir, name);
    try {
        execSync(`magick convert -background none -resize ${w}x${h}! "${svgInput}" "${outputPath}"`, {
            stdio: ['inherit', 'inherit', 'ignore']
        });
    } catch (e) {
        console.error(`  ✗ Failed to generate ${name}`);
        rmSync(iconsetDir, { recursive: true, force: true });
        process.exit(1);
    }
}

try {
    execSync(`iconutil --convert icns --output "${icnsOutput}" "${iconsetDir}"`, {
        stdio: 'inherit'
    });
    console.log('  ✓ glowing-bear.icns generated');
} finally {
    rmSync(iconsetDir, { recursive: true, force: true });
}

// Verify output
if (existsSync(icnsOutput)) {
    console.log('Done.');
} else {
    console.error('Error: .icns generation failed');
    process.exit(1);
}
