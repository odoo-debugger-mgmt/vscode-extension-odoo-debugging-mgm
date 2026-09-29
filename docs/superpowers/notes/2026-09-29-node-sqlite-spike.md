# Spike result: `node:sqlite` in the Extension Host

**For:** the agent working on
[2026-09-28-shared-data-store-design.md](../specs/2026-09-28-shared-data-store-design.md),
which asked for the ten-minute spike at the end of that document.
**Run:** 2026-09-29, Linux x64, in real Extension Hosts.

## Verdict

- **§4 does not stand on the current minimum engine.** VS Code 1.100.0 ships
  Node 20.19, which has no `node:sqlite`. It fails with `ERR_UNKNOWN_BUILTIN_MODULE`,
  and `--experimental-sqlite` is not a valid option on that runtime.
- **It works from VS Code 1.101.0 onward** (Electron 35.5.1, Node 22.15.1). That
  is the exact boundary: 1.101.0 is the first build that has it.
- On every build that loads it, the behaviour §4 relies on is correct: WAL
  works, `PRAGMA data_version` detects the other window's commits, and no update
  was lost between two hosts.

So the decision is the one step 4 anticipated: **raise `engines.vscode` to
`^1.101.0`**, or keep 1.100 and ship the JSON fallback (or refuse shared mode)
when the module is missing. My recommendation is to raise the engine. 1.101 is a
single release above today's floor, and a fallback store would double the
storage code for users on one old build.

## Answers to the three spike questions

| Question | Answer |
|---|---|
| Does `node:sqlite` load? | Not on 1.100.0. Yes on 1.101.0, 1.109.5 and 1.139.1 (tested in the Extension Host), and on 1.102.0, 1.103.1, 1.105.1, 1.106.0, 1.127.0, 1.137.0 and 1.137.0-insider (tested in each build's Node via `ELECTRON_RUN_AS_NODE`). |
| Does each window's `data_version` change when the other commits? | Yes. In every run it changed on all 20 of 20 polls while the other host was writing. A host's own commits never changed it: `before == after` in every run, as SQLite documents. |
| Is an `ExperimentalWarning` printed, and where? | On Node 22 builds (VS Code 1.101 to at least 1.109.5): yes, once per Extension Host process, on the first `require`. It arrives as a `process` `'warning'` event and is printed to the **Extension Host's stderr** as `(node:<pid>) ExperimentalWarning: SQLite is an experimental feature…`. It does not appear in the extension's output channel or any UI. On Node 24 builds (1.127.0 and later, including 1.139.1): no warning. The switch lies somewhere between 1.109.5 and 1.127.0; I did not narrow it further. |

## Measurements

Two Extension Hosts on one database file, in separate processes with separate
user-data dirs, standing in for two windows. They met at a barrier row in the
database, then each:

1. inserted a row every 250 ms, 20 times, polling `data_version`;
2. incremented one counter 500 times with the §4.1 pattern
   (`UPDATE … SET n = ?, rev = ? WHERE id = 1 AND rev = ?`, retried on
   `changes === 0`);
3. incremented it 500 more times as read-modify-write under `BEGIN IMMEDIATE`.

`busy_timeout` was 5000 ms.

| VS Code | Electron | Node | SQLite | Loads | `data_version` saw the other host | Final counter (expected 2000) | `rev` conflicts caught (A / B) | `SQLITE_BUSY` | Slowest write |
|---|---|---|---|---|---|---|---|---|---|
| 1.100.0 | 34.5.1 | 20.19.0 | n/a | **no** | n/a | n/a | n/a | n/a | n/a |
| 1.101.0 | 35.5.1 | 22.15.1 | 3.49.1 | yes | 20/20 | 2000 | 0 / 0 | 0 | 1 ms |
| 1.109.5 | 39.3.0 | 22.21.1 | 3.50.4 | yes | 20/20 | 2000 | 0 / 1 | 0 | 1 ms |
| 1.139.1 | 43.6.0 | 24.20.0 | 3.53.4 | yes | 20/20 | 2000 | 5 / 0 | 0 | 3 ms |

The contention was light: the increment loops take milliseconds, so the two
hosts overlapped only briefly. The non-zero conflict counts show the writes did
interleave and the `rev` guard caught it. This is evidence that the approach
works, not a stress test.

## Findings the design should absorb

1. **`DatabaseSync` is synchronous, and the Extension Host thread is shared by
   every extension.** While a write waits on `busy_timeout`, it blocks that
   thread, so a 5 s timeout can freeze every extension in the window for up to
   5 s. Suggest a short `busy_timeout` (a few hundred ms) with an async retry
   around it. The "locked longer than `busy_timeout`" row in *Failure modes*
   then becomes the retry-exhausted case.
2. **The TypeScript types need to be newer.** `@types/node` is `20.x`, which has
   no `node:sqlite`, so `import … from 'node:sqlite'` fails with TS2307.
   `@types/node` 22.x goes with an engine of `^1.101.0` (Node 22.15).
3. **Webpack needs no change.** Webpack 5.108 treats `node:sqlite` as an
   external by itself (`module.exports = require("node:sqlite")`), and the
   bundle runs.
4. **The module is still experimental on Node 22.** Keep to the smallest API
   surface: `DatabaseSync`, `exec`, `prepare`, and `run`/`get`/`all`, with
   settings passed as `PRAGMA`s rather than constructor options. That surface
   worked unchanged from Node 22.15 to 24.20. I did not check which constructor
   options exist on 22.15.

## Not covered

- **Remote extension hosts** (Remote-SSH, WSL, Dev Containers, Codespaces).
  There the extension runs on the VS Code Server's own bundled Node, not the
  desktop Electron, so availability must be checked separately. The store
  would also live on the remote machine.
- **Other VS Code-based editors** (Cursor, Windsurf, VSCodium). None is
  installed here, and they can ship an older Electron.
- **macOS and Windows.** `node:sqlite` is built into Node, so the same Node
  version should behave the same, but only Linux x64 was run.
- **Real-world contention.** Two windows saving the same project at the same
  moment, which §4.1's per-field re-apply is designed for.

## How it was run

Throwaway, not committed, as the spike asked. Instead of editing `activate()`
and pressing F5 twice, a separate minimal extension ran the same code as its
`extensionTestsPath`, through `@vscode/test-electron`. Two `runTests` calls
started at once with different `--user-data-dir`, so there were two Extension
Host processes, the same as two windows. Each host wrote its results to a JSON
file rather than the Odoo DevTools output channel. The builds ran under Xvfb and
came from `.vscode-test/`; 1.100.0, 1.101.0 and 1.102.0 were downloaded for this.
