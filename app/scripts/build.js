// Builds "dist/Writing Desk.app" (Apple silicon by default; WD_ARCH=x64 for Intel).
// Usage: npm run build            then   ditto "dist/Writing Desk-darwin-arm64/Writing Desk.app" "/Applications/Writing Desk.app"
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const build = path.join(root, 'assets');
const icns = path.join(build, 'icon.icns');

function makeIcon() {
  const png = path.join(build, 'icon.png');
  if (!fs.existsSync(png)) execFileSync(require('electron'), [path.join(__dirname, 'icon.js')], { stdio: 'inherit' });
  const set = path.join(build, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);
  fs.rmSync(set, { recursive: true, force: true });
}

(async () => {
  if (!fs.existsSync(icns)) makeIcon();
  const { packager } = await import('@electron/packager');
  const arch = process.env.WD_ARCH || 'arm64';
  const [appPath] = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    overwrite: true,
    platform: 'darwin',
    arch,
    name: 'Writing Desk',
    executableName: 'Writing Desk',
    appBundleId: 'local.writingdesk',
    appCategoryType: 'public.app-category.productivity',
    icon: icns,
    asar: true,
    prune: true,
    darwinDarkModeSupport: true,
    ignore: [/^\/test($|\/)/, /^\/scripts($|\/)/, /^\/assets($|\/)/, /^\/dist($|\/)/],
    extendInfo: { NSHumanReadableCopyright: 'Local-only writing desk', LSMinimumSystemVersion: '12.0' },
  });
  const bundle = path.join(appPath, 'Writing Desk.app');
  // Ad-hoc signature so macOS runs it on this Mac (not notarized).
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  console.log(`Built ${bundle}`);
})().catch((e) => { console.error(e); process.exit(1); });
