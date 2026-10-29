// Generate static/glowing-bear.icns for the Tauri macOS bundle.
//
// Two decisions, both load-bearing:
//
// 1. The artwork is drawn onto Apple's macOS icon grid first — a squircle tile
//    of 824pt inset 100 inside a 1024 transparent canvas, in the app's dark
//    theme — by scripts/macos-icon.mjs. `static/glowing-bear.svg` is the bear
//    alone on nothing, and macOS 26 (Tahoe) and later render a bundled .icns
//    through their own icon compositor: artwork with no background of its own
//    is shrunk and mounted on a grey system plate. Feeding the SVG straight to
//    the generator therefore produces the grey-boxed icon; feeding it the grid
//    master produces the icon as authored. Dev has never shown that plate for a
//    related reason: with no bundle, Tauri embeds the .icns bytes in the dev
//    binary and sets NSApp.applicationIconImage, which draws the bitmap
//    unmasked. The tile makes the two paths the same artwork.
//
// 2. The .icns itself is still built by the Tauri CLI's cross-platform icon
//    generator, which produces a valid .icns on any OS — the previous
//    implementation shelled out to macOS `iconutil` and could not run on Linux
//    CI. Only the .icns is kept: the PNG/ico set is generate-icons.mjs's job.
//
// Set GB_ICNS_MASTER=/path/to.png to keep the 1024 grid master for inspection.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGridMaster } from '../scripts/macos-icon.mjs';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');
const icnsOutput = resolve(__dirname, 'glowing-bear.icns');
const tempDir = resolve(__dirname, '.tauri-icon-temp');

// The generator's own inputs. The grid geometry and tile colours live in
// scripts/macos-icon.mjs, so editing them has to invalidate the .icns too —
// otherwise a stale bundle keeps the old tile behind a changed bear.
const inputs = [svgInput, fileURLToPath(import.meta.url), resolve(__dirname, '..', 'scripts', 'macos-icon.mjs')];

if (!existsSync(svgInput)) {
    console.error('Error: glowing-bear.svg not found in static/');
    process.exit(1);
}

// Early exit if the .icns exists and is newer than every input.
function needsRegen() {
    if (!existsSync(icnsOutput)) return true;
    const generatedAt = statSync(icnsOutput).mtimeMs;
    return inputs.some((p) => existsSync(p) && statSync(p).mtimeMs > generatedAt);
}

// Check the .icns the generator just wrote, instead of trusting it. The largest
// PNG rep must carry the macOS grid: an opaque body ~824/1024 of the canvas,
// inset ~100, with the surrounding margin still transparent. A rep that comes
// back full-bleed (the bare SVG) or fully opaque (a flattened square) means the
// grey plate is back, so failing here beats shipping an icon the OS re-renders.
async function verifyGrid(icnsPath) {
    const buf = readFileSync(icnsPath);
    let largest = null;
    for (let off = 8; off + 8 <= buf.length;) {
        const data = buf.subarray(off + 8, off + buf.readUInt32BE(off + 4));
        if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            const width = data.readUInt32BE(16);
            if (!largest || width > largest.width) largest = { width, data };
        }
        off += buf.readUInt32BE(off + 4);
    }
    if (!largest) throw new Error('.icns carries no PNG rep to verify');

    const { data, info } = await sharp(largest.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let min = info.width;
    let max = -1;
    let transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 10) {
            const x = (i / 4) % info.width;
            if (x < min) min = x;
            if (x > max) max = x;
        } else {
            transparent++;
        }
    }
    const body = (max - min + 1) / info.width;
    if (body < 0.78 || body > 0.84) {
        throw new Error(`icon body is ${(body * 100).toFixed(1)}% of the ${info.width}px canvas, expected ~80.5% (Apple's 824pt grid)`);
    }
    if (transparent === 0) {
        throw new Error(`icon rep ${info.width}x${info.height} has no transparent margin; macOS needs the inset`);
    }
    console.log(`  \u2713 grid verified: body ${(body * 100).toFixed(1)}% of ${info.width}px, margin ${Math.round(min)}px, ${(100 * transparent) / (info.width * info.height) | 0}% transparent`);
}
if (!needsRegen()) {
    console.log('.icns up to date, skipping generation.');
    process.exit(0);
}

try {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });

    const masterPath = process.env.GB_ICNS_MASTER
        ? resolve(process.env.GB_ICNS_MASTER)
        : resolve(tempDir, 'macos-master.png');

    console.log('Rendering macOS icon-grid master (824pt tile on a 1024 canvas)...');
    writeFileSync(masterPath, await renderGridMaster(readFileSync(svgInput)));

    console.log('Generating .icns from ' + masterPath + ' via `tauri icon`...');
    execSync(`npx tauri icon --fit contain "${masterPath}" --output "${tempDir}"`, { stdio: 'inherit' });

    const generated = resolve(tempDir, 'icon.icns');
    if (!existsSync(generated)) {
        throw new Error('tauri icon did not produce glowing-bear.icns');
    }
    // Verify before publishing: a rep that lost the grid leaves the previous
    // .icns in place rather than shipping one the OS will grey-box.
    await verifyGrid(generated);
    copyFileSync(generated, icnsOutput);
    const fileSize = statSync(icnsOutput).size;
    console.log(`  \u2713 glowing-bear.icns \u2014 ${(fileSize / 1024).toFixed(0)} KB`);
    if (process.env.GB_ICNS_MASTER) console.log(`  \u2713 grid master kept at ${masterPath}`);
    console.log('Done.');
} catch (e) {
    console.error('\u2717 .icns generation failed: ' + e.message);
    process.exit(1);
} finally {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
