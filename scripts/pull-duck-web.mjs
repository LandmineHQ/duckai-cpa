#!/usr/bin/env node
/**
 * Pull the currently deployed duck.ai web source into recon/duckai-web.
 *
 *   npm run recon:pull
 *   node scripts/pull-duck-web.mjs --proxy=http://127.0.0.1:10808
 *   node scripts/pull-duck-web.mjs --include-external
 *
 * recon/ is gitignored; this is a local comparison snapshot, not a vendored copy.
 */
import { parseArgs, printHelp, takeSnapshot } from './duck-web-snapshot.mjs';

const options = parseArgs();
if (options.help) {
  printHelp('pull-duck-web.mjs');
  process.exitCode = 0;
} else {
  try {
    console.log(`[recon] fetching ${options.baseUrl} ...`);
    const manifest = await takeSnapshot(options, { write: true });
    console.log('[recon] snapshot written');
    console.log(`  dir:      ${manifest.outDir}`);
    console.log(`  manifest: ${manifest.manifestPath}`);
    console.log(`  version:  ${manifest.version || '(not found)'}`);
    console.log(`  assets:   ${manifest.assets.length}${manifest.truncated ? ' (truncated)' : ''}`);
    console.log(`  bytes:    ${manifest.totalBytes}`);
    console.log(`  fetched:  ${manifest.fetchedAt}`);
    if (manifest.skippedExternal.length) {
      console.log(`  skipped external: ${manifest.skippedExternal.length} (use --include-external to fetch)`);
    }
  } catch (error) {
    console.error(`[recon] pull failed: ${error.message}`);
    process.exitCode = 1;
  }
}
