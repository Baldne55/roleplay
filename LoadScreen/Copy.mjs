/**
 * Loading-screen "build" - just copies the static HTML + CSS + Assets folder
 * into the resource folder. No bundler, no transforms; the loading screen
 * runs in CEF before any NUI page can load and is intentionally tiny.
 */
import { mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const Here = dirname(fileURLToPath(import.meta.url));
const Dest = join(Here, '..', 'Production', 'Windows', 'resources', '[local]', 'roleplay', 'Dist', 'LoadScreen');

mkdirSync(Dest, { recursive: true });

let CopyCount = 0;

const TopLevelFiles = ['index.html', 'Style.css', 'Script.js'];
for (const Name of TopLevelFiles) {
  copyFileSync(join(Here, Name), join(Dest, Name));
  CopyCount += 1;
}

function CopyTree(SrcDir, DestDir) {
  if (!existsSync(SrcDir)) return;
  mkdirSync(DestDir, { recursive: true });
  for (const Entry of readdirSync(SrcDir)) {
    const SrcPath = join(SrcDir, Entry);
    const DestPath = join(DestDir, Entry);
    const Stats = statSync(SrcPath);
    if (Stats.isDirectory()) {
      CopyTree(SrcPath, DestPath);
    } else {
      copyFileSync(SrcPath, DestPath);
      CopyCount += 1;
    }
  }
}

CopyTree(join(Here, 'Assets'), join(Dest, 'Assets'));

console.log(`[LoadScreen] copied ${CopyCount} file(s) to ${relative(join(Here, '..'), Dest)}`);
