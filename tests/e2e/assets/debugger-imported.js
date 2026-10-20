// Loaded by a worker: not rewritten (the probe is not in workers). The debugger
// statement really runs: rewritten, it would call a _$dbg the worker lacks and throw.
try {
  debugger;
  self.__importedRan = true;
} catch {
  self.__importedRan = false;
}
