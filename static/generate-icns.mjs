// Generate static/glowing-bear.icns for the Tauri macOS bundle.
//
// Delegates to the Tauri CLI's cross-platform icon generator (`tauri icon`),
// which produces a valid .icns on any OS — the previous implementation shelled
// out to macOS `iconutil` and could not run on Linux CI. The generator is
// invoked over the source SVG and its output lands in a temp directory; only
// the .icns is kept, because the PNG/ico set is generate-icons.mjs's job.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgInput = resolve(__dirname, 'glowing-bear.svg');
const icnsOutput = resolve(__dirname, 'glowing-bear.icns');
const tempDir = resolve(__dirname, '.tauri-icon-temp');

if (!existsSync(svgInput)) {
    console.error('Error: glowing-bear.svg not found in static/');
    process.exit(1);
}

// Early exit if .icns exists and the source SVG hasn't changed.
if (existsSync(icnsOutput) && statSync(svgInput).mtimeMs <= statSync(icnsOutput).mtimeMs) {
    console.log('.icns up to date, skipping generation.');
    process.exit(0);
}

try {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });

    console.log('Generating .icns from ' + svgInput + ' via `tauri icon`...');
    execSync(
        `npx tauri icon --fit contain "${svgInput}" --output "${tempDir}"`,
        { stdio: 'inherit' },
    );

    const generated = resolve(tempDir, 'icon.icns');
    if (!existsSync(generated)) {
        throw new Error('tauri icon did not produce glowing-bear.icns');
    }
    copyFileSync(generated, icnsOutput);
    const fileSize = statSync(icnsOutput).size;
    console.log(`  \u2713 glowing-bear.icns \u2014 ${(fileSize / 1024).toFixed(0)} KB`);
    console.log('Done.');
} catch (e) {
    console.error('\u2717 .icns generation failed: ' + e.message);
    process.exit(1);
} finally {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
