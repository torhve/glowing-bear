import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');
const icnsOutput = resolve(__dirname, 'glowing-bear.icns');
const iconsetDir = resolve(__dirname, '.icns-temp.iconset');

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

// Early exit if .icns exists and source SVG hasn't changed.
if (existsSync(icnsOutput) && svgMtime <= statSync(icnsOutput).mtimeMs) {
    console.log('.icns up to date, skipping generation.');
    process.exit(0);
}

const svgBuffer = readFileSync(svgInput);

// macOS iconutil requires an iconset directory with square PNGs:
//   icon_16x16.png        (16x16)
//   icon_16x16@2x.png     (32x32)   — retina
//   icon_32x32.png        (32x32)
//   icon_32x32@2x.png     (64x64)   — retina
//   icon_128x128.png      (128x128)
//   icon_128x128@2x.png   (256x256)  — retina
//   icon_256x256.png      (256x256)
//   icon_256x256@2x.png   (512x512)  — retina
//   icon_512x512.png      (512x512)
//   icon_512x512@2x.png   (1024x1024) — retina
const iconsetSizes = [
    [16, 16],
    [16, 32],   // @2x
    [32, 32],
    [32, 64],   // @2x
    [128, 128],
    [128, 256], // @2x
    [256, 256],
    [256, 512], // @2x
    [512, 512],
    [512, 1024],// @2x
];

if (existsSync(iconsetDir)) {
    rmSync(iconsetDir, { recursive: true, force: true });
}
mkdirSync(iconsetDir, { recursive: true });

console.log('Generating .icns from ' + svgInput + '...');

for (const [w, h] of iconsetSizes) {
    const size = h; // target pixel dimension (for @2x, this is 2x the base size)
    const name = w === h ? `icon_${w}x${w}.png` : `icon_${w}x${w}@2x.png`;
    const outputPath = resolve(iconsetDir, name);
    try {
        const resvg = new Resvg(svgBuffer, {
            fitTo: { mode: 'width', value: size },
        });
        let pngBuffer = resvg.render().asPng();

        // Pad to exact square with transparent background (SVG viewBox is 457x437)
        pngBuffer = await sharp(pngBuffer)
            .resize(size, size, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();

        writeFileSync(outputPath, pngBuffer);
        const fileSize = statSync(outputPath).size;
        console.log(`  \u2713 ${name} (${size}x${size}) \u2014 ${(fileSize / 1024).toFixed(0)} KB`);
    } catch (e) {
        console.error(`  \u2717 Failed to generate ${name}: ${e.message}`);
        rmSync(iconsetDir, { recursive: true, force: true });
        process.exit(1);
    }
}

try {
    execSync(`iconutil --convert icns --output "${icnsOutput}" "${iconsetDir}"`, {
        stdio: 'inherit',
    });
    const icnsSize = statSync(icnsOutput).size;
    console.log(`  \u2713 glowing-bear.icns \u2014 ${(icnsSize / 1024).toFixed(0)} KB`);
} catch (e) {
    console.error('  \u2717 iconutil failed');
    process.exit(1);
} finally {
    if (existsSync(iconsetDir)) {
        rmSync(iconsetDir, { recursive: true, force: true });
    }
}

if (existsSync(icnsOutput)) {
    console.log('Done.');
} else {
    console.error('Error: .icns generation failed');
    process.exit(1);
}
