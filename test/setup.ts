// The published provider-bridge bundle reaches `child_process` through a
// CommonJS require shim; give it one under vitest's ESM loader.
import { createRequire } from "node:module";

(globalThis as { require?: NodeRequire }).require ??= createRequire(import.meta.url);
