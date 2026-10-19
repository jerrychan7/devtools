// Entry of devtools-anywhere's probe.iife.js: the probe plus zero-config mounting.
//
//   <script src="…/devtools-anywhere/dist/probe.iife.js" data-frontend="…/chii_app.html"></script>
//
// As the first script in <head>, it captures from the very start. With `data-frontend`, it
// loads devtools-anywhere.iife.js (from `data-bundle`, by default next to this file) after
// the page has loaded and mounts <devtools-anywhere>. `data-open` opens DevTools right away;
// `data-sw` is passed on as the element's `sw` attribute (see shell mode).
import { installProbe, readShellConfig } from '@devtools-anywhere/cdp-server/probe';

const script = document.currentScript as HTMLScriptElement | null;
const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
if (script?.src) probe.ownUrls.add(script.src);

const frontend = script?.dataset['frontend'];
// In the shell's top window the probe has replaced the document with the shell already.
if (script && frontend && !(readShellConfig() && window === top)) {
  const bundle = new URL(script.dataset['bundle'] || 'devtools-anywhere.iife.js', script.src).href;
  const open = script.hasAttribute('data-open');
  probe.ownUrls.add(bundle);

  const mount = () => {
    const loader = document.createElement('script');
    loader.src = bundle;
    loader.onload = () => {
      if (document.querySelector('devtools-anywhere')) return;
      const element = document.createElement('devtools-anywhere');
      element.setAttribute('frontend', new URL(frontend, location.href).href);
      if (open) element.setAttribute('open', '');
      if (script.dataset['sw'] !== undefined) element.setAttribute('sw', script.dataset['sw']);
      document.body.appendChild(element);
    };
    document.head.appendChild(loader);
  };
  // Load the larger bundle only after the page itself has loaded.
  if (document.readyState === 'complete') mount();
  else addEventListener('load', mount, { once: true });
}
