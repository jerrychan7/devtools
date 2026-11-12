// The page the emulation conformance tests act on (domains/emulation/*.conformance.test.ts): one fixture
// page with the sheet and the elements they emulate, shared by their files.
import { openPage, type Env, type EventName, type TestPage } from './conformance.ts';

export const EMULATION_STYLE = `
  @media (prefers-color-scheme: light) { #em { color: rgb(1, 0, 0) } }
  @media (prefers-color-scheme: dark) { #em { color: rgb(2, 0, 0) } }
  @media print { #em { background-color: rgb(0, 3, 0) } }
  @media not print { #em { outline-color: rgb(0, 4, 0) } }
  @media screen and (prefers-reduced-motion) { #em { border-left-color: rgb(0, 0, 5) } }
  @media (color-gamut: p3) { #em { border-right-color: rgb(0, 0, 6) } }
  @media (prefers-color-scheme: light) { #em:hover { text-decoration-color: rgb(7, 0, 0) } }
  #sa {
    padding-top: env(safe-area-inset-top, 7px);
    padding-left: env(safe-area-max-inset-left, calc(1px + 2px));
    margin: env(safe-area-inset-bottom) 0 0;
    --right: env(safe-area-inset-right, 9px);
    width: calc(10px + var(--right));
  }
`;

/** Opens the fixture page with its sheet and elements in place; `events` are recorded on both sides. */
export async function openEmulationPage(env: Env, events: EventName[]): Promise<TestPage> {
  const t = await openPage(env, events);
  await t.page.evaluate(style => {
    const s = document.createElement('style');
    s.textContent = style;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML('beforeend', '<div id="em">em</div><div id="sa">sa</div>');
  }, EMULATION_STYLE);
  return t;
}
