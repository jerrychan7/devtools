// Release helpers for .github/workflows/release.yml (and for checking a release by hand).
//
//   node scripts/release.ts check <version>  every published package is at <version>, and both
//                                            changelogs have a section for it; prints the
//                                            packages' directories, one per line
//   node scripts/release.ts notes <version>  the GitHub release notes: that section of
//                                            CHANGELOG.md, then that of CHANGELOG.zh-CN.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOGS = ['CHANGELOG.md', 'CHANGELOG.zh-CN.md'];

const [command, version] = process.argv.slice(2);
if ((command !== 'check' && command !== 'notes') || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/release.ts check|notes <x.y.z>');
  process.exit(1);
}

/** The text under `## <version>` in a changelog, up to the next section, or null. */
function section(file: string): string | null {
  const lines = fs.readFileSync(path.join(repo, file), 'utf8').split('\n');
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

if (command === 'notes') {
  const notes = CHANGELOGS.map(section);
  if (notes.some(note => note === null)) throw new Error(`No ## ${version} in ${CHANGELOGS.join(' or ')}`);
  console.log(notes.join('\n\n---\n\n'));
} else {
  const problems: string[] = [];
  const published: string[] = [];
  for (const dir of fs.readdirSync(path.join(repo, 'packages')).sort()) {
    const file = path.join(repo, 'packages', dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const json: { name?: string; version?: string; private?: boolean } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json.private) continue;
    published.push(path.join('packages', dir));
    if (json.version !== version) problems.push(`${json.name} is at ${json.version}, not ${version}`);
  }
  for (const file of CHANGELOGS) {
    if (!section(file)) problems.push(`${file} has no section ## ${version}`);
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(published.join('\n'));
}
