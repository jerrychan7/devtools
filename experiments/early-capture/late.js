// Shared tail of both variants: body-phase logs, then a late log after the tool is up.
console.log('[body] end of body');
document.addEventListener('DOMContentLoaded', function () {
  console.log('[body] DOMContentLoaded');
});
window.__afterAttach = function () {
  setTimeout(function () {
    console.log('[late] after attach', { late: true });
    fetch('/api/echo?n=fetch-late');
  }, 3000);
};
