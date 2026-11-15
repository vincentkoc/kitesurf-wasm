// workerd marks every new isolate under moderate memory pressure. V8 responds by
// flushing Liftoff code process-wide, including code shared with live page workers.
// Retain baseline code until its module dies; leave JS/Wasm GC and isolation intact.
export const browserV8Flags = Object.freeze(['--no-flush-liftoff-code']);
