// Emulation of media features as a cross-origin iframe reports them: the iframe is out of process, and its own probe
// hooks its matchMedia, the emulation is sent to it through the probe's messages. The same-origin cases, and the
// change events, are in match-media.conformance.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env } from '../../../../test-support/conformance.ts';
import { chromeSide, oursSide, type Side as OopifSide } from '../../../../test-support/oopif/oopif-sides.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';

type Scheme = 'dark' | 'light';

const schemeEmulation = (scheme: Scheme): Protocol.Emulation.SetEmulatedMediaRequest => ({
  features: [{ name: 'prefers-color-scheme', value: scheme }],
});
/** Emulates nothing: the page's own media again. */
const NONE: Protocol.Emulation.SetEmulatedMediaRequest = {};

describe('a cross-origin iframe', () => {
  let oopif: Env | undefined;

  // Its own browser, with every site in a process of its own: the iframe is out of process.
  setUpAndTearDown(
    async () => {
      oopif = await launchOopif();
    },
    () => oopif?.close()
  );

  const FRAMES =
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))';
  const SCHEMES =
    "[matchMedia('(prefers-color-scheme: dark)').matches, matchMedia('(prefers-color-scheme: light)').matches]";

  /** Whether the page (or its iframe) matches each scheme now. */
  const schemes = async (side: OopifSide, inChild: boolean): Promise<boolean[]> =>
    (await side.run(SCHEMES, inChild)) as boolean[];

  /**
   * Opens one side, runs `act` on it and closes it. One side at a time: the other side's page, opened
   * later, would be the background tab, and a background tab gets no animation frames for FRAMES to wait on.
   */
  async function onSide<T>(start: () => Promise<OopifSide>, act: (side: OopifSide) => Promise<T>): Promise<T> {
    const side = await start();
    try {
      return await act(side);
    } finally {
      await side.close();
    }
  }

  // Bounded: a side that never answers would otherwise hang the run (RawCdp waits for replies without a timeout).
  test(
    'Emulation.setEmulatedMedia on the iframe target reaches its matchMedia, as in Chrome',
    { timeout: 120_000 },
    async () => {
      assert.ok(oopif);
      const cross: Env = oopif;
      const run = async (side: OopifSide, scheme: Scheme) => {
        const before = await schemes(side, true);
        const parentBefore = await schemes(side, false);
        // As the frontend does it: on the iframe's own target session.
        await side.send('Emulation.setEmulatedMedia', schemeEmulation(scheme), side.child);
        await side.run(FRAMES, true);
        const emulated = await schemes(side, true);
        // The parent page is not emulated by its iframe's target.
        const parent = await schemes(side, false);
        await side.send('Emulation.setEmulatedMedia', NONE, side.child);
        await side.run(FRAMES, true);
        return { before, parentBefore, emulated, parent, cleared: await schemes(side, true) };
      };
      // The scheme the page does not have by default, as in the other tests (see otherScheme).
      const chrome = await onSide(
        () => chromeSide(cross),
        async side => {
          const [darkNow] = await schemes(side, true);
          const scheme: Scheme = darkNow ? 'light' : 'dark';
          return { scheme, measured: await run(side, scheme) };
        }
      );
      const ours = await onSide(
        () => oursSide(cross),
        side => run(side, chrome.scheme)
      );
      const { scheme, measured } = chrome;
      assert.deepEqual(measured.emulated, [scheme === 'dark', scheme === 'light']);
      assert.deepEqual(measured.parent, measured.parentBefore);
      assert.deepEqual(measured.cleared, measured.before);
      assert.deepEqual(ours, measured);
    }
  );
});
