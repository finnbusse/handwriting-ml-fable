// App configuration. Loaded as a classic script by index.html and by sw.js
// (importScripts), so it must not use ES module syntax.
// No account name here: the account comes from the sign-in at runtime.
self.HW_CONFIG = Object.freeze({
  appName: 'handwriting-capture',
  version: '0.3.0',
  datasetRepo: 'handwriting-fable',        // dataset <user>/handwriting-fable (private)
  modelRepo: 'handwriting-fable-model',    // model <user>/handwriting-fable-model (private)
  hfBase: 'https://huggingface.co',
  promptsUrl: 'prompts/de-core.json',
  blockSize: 20,          // lines per block / session
  goalBlocks: 5,          // 5 blocks of 20 = the ~100-line goal; later blocks count as extra
  flushAt: 5,             // upload as soon as this many lines are waiting
  maxPerCommit: 25,       // at most this many lines per commit (SPEC 2.1)
});
