# forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Riaking89/github-core-clone-01-ria/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Riaking89/github-core-clone-01-ria/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

My entry for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on [make.fun](https://make.fun/bounty/github-core-clone-01): **forge**, a standalone GitHub-compatible git forge in one Node 22 process, written from scratch with the standard library only.

## What it serves

- **Git smart HTTP** — `git clone` and `git push` over protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen, thin packs) and v0 (`upload-pack` / `receive-pack` with per-ref
  fast-forward checks and `report-status`). Real `git` clones, pushes, shallow-clones and
  non-fast-forward refusals all work against it. No git binary, no outside service.
- **REST v3** under `/api/v3` — repositories, branches, git refs, commits, contents
  (create/update/delete with stale-sha 409s), labels, issues + comments, pull requests
  with squash merge and 405 on conflicts, cursor pagination with `Link: rel="next"`.
- **GraphQL** at `/api/graphql` — `viewer`, `repository` (issues/pullRequests with cursor
  pagination, `node`, `__type` introspection) and the `createIssue` / `closeIssue` /
  `createPullRequest` / `mergePullRequest` / `addComment` mutations, with opaque global ids.
- **MCP** at `/mcp` — Streamable HTTP JSON-RPC 2.0, modern `server/discover`
  (2026-07-28) plus the legacy `initialize` handshake, and six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Running it

`main.ts` is the entrypoint: it binds an ephemeral port, registers the port with the
make.fun env (`POST $MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done`
until the trial ends and exits 0. It never binds 8080. The server itself is `app.ts`
(`createApp()`), one process, in-memory store, Node 22 standard library only.

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=shpat_... \
  node --experimental-strip-types main.ts
```

## Determinism

The store holds no wall-clock time: commit timestamps come from pushed objects,
server-made commits use a fixed epoch plus a per-repo counter, and ids / request ids /
`merged_at` derive from deterministic sequence counters. Two runs of the local
conformance suite against fresh servers produce byte-identical check outcomes
(120/120 in both runs; only wall-clock perf timings vary, as they do for any entry).

## Local verification

Against the kit's local runner (`sdk/run.ts`) on this machine:

| run | checks | score |
| --- | ------ | ----- |
| trial seed `6a09e667f3bcc909`, run A | 120/120 | 968 (feature 600 + agent 200 + perf 168) |
| same seed, fresh server, run B | 120/120 | 981 (feature 600 + agent 200 + perf 181) |

Perf points vary run to run with machine load (push ~39–40, clone ~40–42, read ~47–50,
write ~41–50 per run); the conformance checks are identical in both runs.

## Layout

- `main.ts` — entrypoint lifecycle (bind ephemeral port, register, poll done, exit 0).
- `app.ts` — the whole forge: git pack/pkt-line primitives, store, REST, GraphQL, MCP,
  git smart HTTP, and the HTTP server.
- `LICENSE` — MIT.
