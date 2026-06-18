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

const svgBuffer = readFileSync(svgInput);

// macOS iconutil requires square PNGs in an iconset directory
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
    const size = h;
    const name = (w === h)
        ? 'icon_' + w + 'x' + w + '.png'
        : 'icon_' + w + 'x' + w + '@2x.png';
    const outputPath = resolve(iconsetDir, name);
    try {
        const resvg = new Resvg(svgBuffer, {
            fitTo: { mode: 'width', value: size },
        });
        let pngBuffer = resvg.render().asPng();

        pngBuffer = await sharp(pngBuffer)
            .resize(size, size, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();

        writeFileSync(outputPath, pngBuffer);
        const fileSize = statSync(outputPath).size;
        console.log('  OK ' + name + ' (' + size + 'x' + size + ') ' + (fileSize / 1024).toFixed(0) + ' KB');
    } catch (e) {
        console.error('  FAIL ' + name + ': ' + e.message);
        rmSync(iconsetDir, { recursive: true, force: true });
        process.exit(1);
    }
}

try {
    execSync('iconutil --convert icns --output "' + icnsOutput + '" "' + iconsetDir + '"', {
        stdio: 'inherit',
    });
    const icnsSize = statSync(icnsOutput).size;
    console.log('  OK glowing-bear.icns ' + (icnsSize / 1024).toFixed(0) + ' KB');
} catch (e) {
    console.error('  FAIL iconutil');
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
