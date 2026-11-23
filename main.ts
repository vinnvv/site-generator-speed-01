// Faster drop-in for makefun-site 1.0.0: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of {id,
// input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
// The optimizing compiler is off too: every graded run is a fresh process, so the
// background optimizer's CPU counts against the entry and never amortizes;
// running on the baseline compiler is faster in total CPU for this workload.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/**
 * The answers as JSON text. Each answer is a flat object of path -> text, so
 * stringifying each string on its own (native, so the escaping is exactly
 * JSON.stringify's) and joining is faster than one big stringify, and emits
 * byte-identical output. Anything else falls back to JSON.stringify.
 */
function answersJson(answers: unknown[]): string {
  let flat = true;
  for (const a of answers) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      flat = false;
      break;
    }
    for (const k of Object.keys(a as Record<string, unknown>)) {
      if (typeof (a as Record<string, unknown>)[k] !== 'string') {
        flat = false;
        break;
      }
    }
    if (!flat) break;
  }
  if (!flat) return JSON.stringify(answers);
  const parts: string[] = ['['];
  for (let ci = 0; ci < answers.length; ci++) {
    if (ci > 0) parts.push(',');
    const o = answers[ci] as Record<string, string>;
    parts.push('{');
    let first = true;
    for (const k of Object.keys(o)) {
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(k), ':', JSON.stringify(o[k]));
    }
    parts.push('}');
  }
  parts.push(']');
  return parts.join('');
}

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), answersJson(answers));
