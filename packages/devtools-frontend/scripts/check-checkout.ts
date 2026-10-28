// The pre-commit gate for the frontend (`node packages/devtools-frontend/scripts/check-checkout.ts`):
// fails if the devtools-frontend checkout has edits to upstream files that no patch holds. Such an
// edit is in no commit, so a build from a fresh checkout would lack it, unnoticed; the build
// itself stops on it too, but only when someone builds. Without a checkout there is nothing to
// check. On failure it says what to do, with the commands filled in.
import fs from 'node:fs';
import path from 'node:path';
import { editsWithoutPatch, failingPatches, hasCheckout, patchesByFile, pkg, read, repo, src } from './checkout.ts';

const rel = (file: string) => path.relative(repo, file);
/** The files a patch touches, or none if it cannot be read. */
const filesOf = (patch: string) => {
  try {
    return read('git', ['apply', '--numstat', patch])
      .split('\n')
      .map(line => line.split('\t')[2] ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
};
// Typed on the declaration, so that a call ends the control flow for the type checker.
const fail: (lines: string[]) => never = lines => {
  console.error(lines.join('\n'));
  process.exit(1);
};

if (hasCheckout()) {
  const edits = editsWithoutPatch();
  if (edits === null) {
    const head = read('git', ['rev-parse', 'HEAD']);
    const revision = fs.readFileSync(path.join(pkg, 'REVISION'), 'utf8').trim();
    const failing = failingPatches();
    fail([
      `The frontend patches do not apply to the devtools-frontend checkout (${src}).`,
      ...(head === revision
        ? [`The checkout is at REVISION (${revision}).`]
        : [`The checkout is at ${head}, not at REVISION (${revision}): the patches are written against REVISION.`]),
      ...(failing.length > 0
        ? ['Patches that do not apply to the checkout HEAD:', ...failing.map(patch => `  ${rel(patch)}`)]
        : []),
      '',
      'To fix it, either:',
      '  - put the checkout back at REVISION with the patches applied. This fetches, checks out REVISION',
      '    and discards every edit in the checkout, so first save any you want (git -C <checkout> diff):',
      '      node packages/devtools-frontend/scripts/build.ts',
      '  - or, if the patches are out of date (moving to a newer upstream), merge each into the checkout,',
      '    resolve the conflict markers, and regenerate it from the files it touches:',
      ...failing.flatMap(patch => [
        `      git -C ${src} apply --3way ${path.resolve(patch)}`,
        `      git -C ${src} diff HEAD -- ${filesOf(patch).join(' ') || '<its files>'} > ${rel(patch)}`,
      ]),
      ...(failing.length > 0
        ? []
        : [`      git -C ${src} apply --3way <patch>`, `      git -C ${src} diff HEAD -- <its files> > <patch>`]),
      'See DEV.md, "Working on the frontend".',
    ]);
  }
  if (edits.length > 0) {
    const byFile = patchesByFile();
    // Edits to files a patch already touches belong in that patch; the others in a new one.
    const regenerate = new Map<string, string[]>();
    const fresh: string[] = [];
    for (const file of edits) {
      const owner = byFile.get(file)?.[0];
      if (owner) regenerate.set(owner, [...(regenerate.get(owner) ?? []), file]);
      else fresh.push(file);
    }
    const commands: string[] = [];
    for (const [patch, files] of regenerate) {
      // A patch is regenerated from every file it touches, not only the edited ones.
      const all = [...byFile].filter(([, owners]) => owners.includes(patch)).map(([file]) => file);
      commands.push(
        `  - ${files.join(', ')}: already in ${rel(patch)}; regenerate it:`,
        `      git -C ${src} diff HEAD -- ${all.join(' ')} > ${rel(patch)}`
      );
    }
    if (fresh.length > 0) {
      commands.push(
        `  - ${fresh.join(', ')}: in no patch; write a new one, named after the change:`,
        `      git -C ${src} diff HEAD -- ${fresh.join(' ')} > packages/devtools-frontend/patches/<name>.patch`
      );
    }
    fail([
      `The devtools-frontend checkout (${src}) has edits to upstream files that no patch holds:`,
      ...edits.map(file => `  ${file}`),
      'A build from a fresh checkout would lack them. Write them into a patch, and stage it with this commit:',
      ...commands,
      'Or, if the edits are not wanted, discard them (this resets every upstream file to REVISION plus the patches):',
      '      node packages/devtools-frontend/scripts/build.ts --no-sync --reset',
      'See DEV.md, "Working on the frontend".',
    ]);
  }
}
