// Top-level declarations of a classic script are in the global lexical scope.
let externalLet = 1;
const {
  externalA,
  externalB: [externalC],
} = { externalA: 1, externalB: [2] };
class ExternalClass {}
var externalVar = ExternalClass;
{
  let externalBlock = externalLet + externalVar;
}
