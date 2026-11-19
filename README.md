[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Eganid/little-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Eganid/little-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A complete entry for [the contest](https://make.fun/bounty/github-core-clone-01): a GitHub-compatible
forge in a single TypeScript file (`app.ts`, Node standard library only — no dependencies, no `git`
binary, no network at run time), driven by the harness lifecycle in `main.ts`. All state is in
memory; the repository is mounted read-only in the trial and the forge writes nothing.

What `app.ts` implements, over one shared store so every surface sees the same objects:

- **Git smart HTTP** at `/<owner>/<repo>.git`: protocol v2 `ls-refs` and `fetch` (with shallow /
  deepen semantics and sideband-framed packfiles) selected by the `Git-Protocol` header, v0
  advertisements, and v0 `receive-pack` with `report-status`, per-ref fast-forward enforcement and
  partial application of mixed pushes. The git object model — blobs, trees, commits, annotated
  tags, SHA-1, zlib packfiles with delta resolution — is implemented in the file itself.
- **REST v3** under `/api/v3`: repositories (create/list with `Link` pagination, get, patch,
  delete), contents (create/update/delete as real git commits, with sha rules), branches, commits,
  git refs, labels, issues and comments, pull requests with file diffs and squash/merge merges
  (405 on conflicts). Every reply is JSON with an `X-GitHub-Request-Id`; errors carry a `message`.
- **GraphQL v4** at `/api/graphql`: a small executor for the documents `gh` and
  `github-mcp-server` send — viewer/repository/issue/pull-request fields, cursor-paginated issue
  connections, the create/close/merge/comment mutations, Relay-style opaque global ids, batching,
  and introspection for `Issue`, `PullRequest`, `Repository` and the `SearchType` enum.
- **MCP** at `/mcp`: JSON-RPC 2.0 over streamable HTTP speaking the 2026-07-28 revision
  (`server/discover`) with the legacy `initialize` handshake also answered; six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same store as REST.

Every surface but `/healthz` requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; repositories
belong to the token's login, and the same name under another owner is a 404. Timestamps come from
a deterministic source (`MAKEFUN_TRIAL_NOW` when provided, else a fixed base advanced by a
counter) and ids from counters, so a replay observes identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Kept exactly as shipped.
- `app.ts`: the whole forge (git object model, packfiles, REST, GraphQL, MCP, HTTP routing).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
