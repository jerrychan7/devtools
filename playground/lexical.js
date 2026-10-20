/* oxlint-disable no-unused-vars -- the bindings are for the console to find. */
// Top-level bindings of a classic script. `var` and function declarations become properties
// of window; let, const and class live in the global lexical scope: reachable by name from
// every script and the console, but not on window.
var lexicalVar = 'on window';
function lexicalFunction() {
  return 'on window';
}
let lexicalLet = 'not on window';
const lexicalConst = { count: 1 };
class LexicalClass {}
