# site-generator-speed-01

![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vinnvv/site-generator-speed-01/rank.svg)
![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vinnvv/site-generator-speed-01/reward.svg)

A faster drop-in for make.fun's own makefun-site 1.0.0, built for the
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty on [make.fun](https://make.fun).

`solve.js` exports `run(input)`, which returns exactly what makefun-site 1.0.0
returns for every input `{site, templates, files}`: the output tree, a JSON
object of every path it writes and that file's text, byte for byte.
`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## How it is faster

makefun-site 1.0.0 renders each Markdown file by building a token tree, then
walking that tree, and it walks each template node by node on every render.
This version skips both intermediate passes:

- the Markdown renderer is a single pass that writes HTML straight into the
  output, with no token objects, no per-line regular expressions, and one
  inline scan that handles code, emphasis, strong emphasis, links and escapes
  together;
- each template is compiled once per case into a plain function, with its
  variable lookups resolved at compile time and loop frames reused instead of
  rebuilt, so rendering is direct property reads instead of a tree walk;
- front matter is sliced out of the source instead of split and rejoined,
  slugs are cached per case, and the word count is folded into the Markdown
  pass instead of scanning the body a second time;
- escaping uses a precomputed table and a single fast path for text without
  specials, and the output JSON is written per string with the native
  stringifier instead of one big stringify call.

The entry is dependency free and pure JavaScript. The V8 flags are tuned for
the way the entry is scored: every graded run is a fresh process, so the
optimizing compiler's background CPU counts against the entry and never
amortizes, so `main.ts` runs with the optimizing compiler off and incremental
marking off.

## Verification

Every case of the practice set, and 30 freshly drawn cases from the kit
generator, produce byte identical output to makefun-site 1.0.0. The practice
set runs about 3.3x faster than the reference on this machine, and about 2x
faster in the fresh process CPU time the board measures.
