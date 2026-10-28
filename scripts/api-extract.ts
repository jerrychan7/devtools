// Rolls a package's type declarations (emitted by tsc into dist/types/) up into one file per
// entry point with API Extractor, and writes its API report (etc/<package>.api.md), so that only
// the public API is published and a change to it shows in review. Run from a package directory,
// after tsc: `node ../../scripts/api-extract.ts [config ...]` (default: api-extractor.json).
// dist/types/ is removed afterwards: nothing outside the rolled-up files is published.
//
// In CI (CI=true), or with `--check`, a report that no longer matches the API fails the build
// instead of being updated.
import { rmSync } from 'node:fs';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const args = process.argv.slice(2);
const check = args.includes('--check') || process.env['CI'] === 'true';
const configs = args.filter(arg => arg !== '--check');

let failed = false;
for (const config of configs.length ? configs : ['api-extractor.json']) {
  const result = Extractor.invoke(ExtractorConfig.loadFileAndPrepare(config), { localBuild: !check });
  if (!result.succeeded) {
    console.error(`api-extract: ${config}: ${result.errorCount} error(s), ${result.warningCount} warning(s)`);
    failed = true;
  }
}
if (failed) process.exit(1);
rmSync('dist/types', { recursive: true, force: true });
