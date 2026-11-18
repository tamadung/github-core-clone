# github-core-clone

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 22](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org/)
[![make.fun bounty](https://img.shields.io/badge/make.fun-github--core--clone--01-blue.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: git smart HTTP
(upload-pack v2 + receive-pack v0), REST v3, GraphQL v4 and MCP
(streamable HTTP), all served from its own in-memory store. No git
binary, no network, no UI.

Entry for the [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge").

## Run

```sh
node main.ts
```

The entry binds an ephemeral port, registers it with the env at
`MAKEFUN_ENV_URL`, and exits 0 once the env says done. Node 22.18+
strips the TypeScript types on its own; there is nothing to install.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the whole forge: HTTP server, git pack protocol, REST v3,
  GraphQL v4, MCP tools, and the store.

## Score

`feature + agent + perf` (0..1000): 120 conformance checks, the MCP
group again as the agent column, and four timed workloads (200 pushes,
50 concurrent shallow clones, 2,000 issue reads, 200 issue writes).

## License

MIT.
