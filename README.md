# forge

A GitHub-compatible git forge in a single Node process, standard library
only — no dependencies, no git binary, no outside services.

## What it implements

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen) and v0, plus receive-pack v0 with
  fast-forward enforcement and report-status. Packfiles are written plain
  (no deltas); received packs resolve OFS and REF deltas.
- **REST API v3** under `/api/v3`: repositories, branches, commits, git
  refs, contents (create/update/delete with base64 blobs), labels, issues,
  issue comments, and pull requests with squash merge and conflict
  detection.
- **GraphQL API v4** at `/api/graphql`: viewer, repository, issue and pull
  request fields, node ids, `__type` introspection, and the createIssue,
  closeIssue, createPullRequest, mergePullRequest and addComment mutations.
- **MCP** at `/mcp`: Streamable HTTP, JSON-RPC 2.0, era `2026-07-28`
  (`server/discover`) with the legacy `initialize` handshake, and six
  tools (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request).

## Running

```sh
MAKEFUN_ENV_URL=<trial env url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port on 127.0.0.1, registers it with the
trial environment, serves until the environment reports done, then exits 0.

## Design notes

- All state is in memory. Nothing touches the wall clock or unseeded
  randomness: server-generated timestamps come from a fixed epoch plus a
  counter, so replayed trials produce byte-identical state exports.
- Object storage is content-addressed SHA-1, exactly like git: blobs,
  trees, commits and tags hash to the same ids git itself would produce,
  so pushed bytes round-trip byte-for-byte.
- The entrypoint is `main.ts`; `app.ts` wires the HTTP server, `store.ts`
  holds the object model and the repository/issue/pull-request store,
  `git.ts` holds the pkt-line and packfile codecs, `rest.ts` the REST
  surface, `graphql.ts` the GraphQL parser and executor, and `mcp.ts`
  the MCP tools.

## License

MIT — see `LICENSE`.
