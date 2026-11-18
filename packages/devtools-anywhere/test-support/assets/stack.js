// Loaded by the stack trace conformance test: logs, then throws, from a script file.
console.error('stack.js logged');
setTimeout(function thrower() {
  throw new Error('stack.js thrown');
});
