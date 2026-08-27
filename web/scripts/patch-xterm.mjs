// Patch xterm.js 6.0.0 requestMode enum minification bug.
//
// xterm.js 6.0.0 compiles a function-local TypeScript enum inside requestMode
// as `let r; (P=>{...})(r ||= {})`. When esbuild (vite's bundler) minifies this
// pattern it drops the `let r;` declaration and rewrites `r ||= {}` into
// `void 0 || (s = {})`, leaving `s` undeclared. In strict-mode ES modules this
// throws "ReferenceError: assignment to undeclared variable s" whenever an
// agent issues a terminal-mode query (DECRQM, e.g. opencode's first boot).
//
// Fix: initialize the enum variable explicitly (`let r = {}`) and pass it
// directly, which esbuild preserves correctly.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xtermPkg = require.resolve('@xterm/xterm/package.json', { paths: [require('node:path').resolve(process.cwd(), 'node_modules')] });
const mjsPath = xtermPkg.replace(/package\.json$/, 'lib/xterm.mjs');

const src = readFileSync(mjsPath, 'utf8');

const OPEN = 'requestMode(e,i){let r;(P=>(P[P.NOT_RECOGNIZED=0]';
const FIX1 = 'requestMode(e,i){let r={};(P=>(P[P.NOT_RECOGNIZED=0]';
const CLOSE = 'P[P.PERMANENTLY_RESET=4]="PERMANENTLY_RESET"))(r||={});let n=';
const FIX2 = 'P[P.PERMANENTLY_RESET=4]="PERMANENTLY_RESET"))(r);let n=';

let out = src;
if (out.includes(OPEN)) {
    out = out.replace(OPEN, FIX1);
} else if (out.includes(FIX1)) {
    // already patched
    console.log('patch-xterm: already patched');
    process.exit(0);
} else {
    console.log('patch-xterm: pattern not found, skipping');
    process.exit(0);
}

if (!out.includes(CLOSE)) {
    console.error('patch-xterm: closing pattern not found, aborting');
    process.exit(1);
}
out = out.replace(CLOSE, FIX2);

writeFileSync(mjsPath, out);
console.log('patch-xterm: patched', mjsPath);
