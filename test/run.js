// FauxTCI test runner: `node test/run.js` (what `npm test` runs) runs every
// test/*.test.js and the browser smoke test through node:test's run() with
// the TAP reporter, and exits non-zero when any test fails.
//
// WHY A RUNNER: Node 22 reads the argument of `node --test` as a glob
// pattern, so `node --test test/` fails with MODULE_NOT_FOUND, and the quoting
// that keeps 'test/*.js' from the shell differs between sh and cmd.exe.  A
// runner names the files itself, so `npm test` needs no glob at all.  Running
// `node --test "test/*.js"` directly runs the same files.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

import { run } from "node:test";
import { tap } from "node:test/reporters";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `node --test "test/*.js"` matches this file too and runs it as a test file
// in a child process (Node marks those with NODE_TEST_CONTEXT); starting the
// suite again from inside it would run everything twice, so then it does
// nothing and counts as one empty, passing file.
if (!process.env.NODE_TEST_CONTEXT) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const names = (await readdir(here))
    .filter((name) => name.endsWith(".test.js") || name === "smoke.playwright.js")
    .sort();
  const files = names.map((name) => path.join(here, name));

  const stream = run({ files, concurrency: true });
  stream.on("test:fail", () => { process.exitCode = 1; });
  stream.compose(tap).pipe(process.stdout);
}
