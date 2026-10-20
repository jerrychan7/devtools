// Each `debugger` statement here logs a warning in shell mode; the other "debugger"s stay.
// Kept unformatted: the line breaks after `debugger` are the point.
const notAStatement = { debugger: 'debugger' };
// prettier-ignore
function classicHit(x) {
  const é = x; debugger
  (é)
  if (x) debugger; else throw new Error('else lost its if');
  if (x) debugger /*x*/; else throw new Error('else lost its if');
  if (x) debugger
  ; else throw new Error('else lost its if');
  return [é];
}
window.__debuggerResult = classicHit(notAStatement.debugger);
