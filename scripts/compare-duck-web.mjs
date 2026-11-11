#!/usr/bin/env node
/**
 * Compare the live duck.ai web source with the local recon snapshot.
 *
 *   npm run recon:diff
 *   node scripts/compare-duck-web.mjs --json
 *
 * Exit 0 = identical, exit 1 = changed or baseline missing.
 * The snapshot is not modified; run `npm run recon:pull` to update it.
 */
import fs from 'node:fs/promises';
import { compareManifests, parseArgs, printHelp, takeSnapshot } from './duck-web-snapshot.mjs';

const options = parseArgs();
if (options.help) {
  printHelp('compare-duck-web.mjs');
  process.exitCode = 0;
} else {
  const baselinePath = options.manifest;
  let baseline = null;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  } catch {
    console.error(`[recon] baseline not found: ${baselinePath}`);
    console.error('[recon] run `npm run recon:pull` first');
    process.exitCode = 1;
  }

  if (baseline) {
    try {
      console.log(`[recon] fetching live ${options.baseUrl} ...`);
      const current = await takeSnapshot(options, { write: false });
      const diff = compareManifests(baseline, current);

      if (options.json) {
        console.log(JSON.stringify({ baseline: baselinePath, ...diff }, null, 2));
      } else {
        console.log(`baseline: ${baselinePath} (${diff.baselineFetchedAt || 'unknown'})`);
        console.log(`live:     ${diff.currentFetchedAt}`);
        console.log(`version:  ${diff.baselineVersion || '(none)'} -> ${diff.currentVersion || '(none)'}${diff.versionChanged ? '  CHANGED' : ''}`);
        console.log(`status:   ${diff.same ? 'SAME' : 'DIFFERENT'}`);

        if (!diff.same) {
          console.log('');
          console.log(`changed: ${diff.changed.length}`);
          for (const item of diff.changed.slice(0, 30)) {
            console.log(`  ~ ${item.url}`);
            console.log(`    ${item.previous?.sha256 || '(none)'} -> ${item.sha256 || '(none)'}`);
          }
          console.log(`added: ${diff.added.length}`);
          for (const item of diff.added.slice(0, 30)) console.log(`  + ${item.url}`);
          console.log(`removed: ${diff.removed.length}`);
          for (const item of diff.removed.slice(0, 30)) console.log(`  - ${item.url}`);
          console.log('');
          console.log('[recon] run `npm run recon:pull` to update the local snapshot');
        }
      }

      process.exitCode = diff.same ? 0 : 1;
    } catch (error) {
      console.error(`[recon] compare failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
