# `setup-node`

Installs the Node version a repository pins, restores the npm cache, and
installs dependencies from the lockfile.

```yaml
- name: Check out repository
  uses: actions/checkout@v7.0.1

- name: Set up Node
  uses: kanso-labs/actions/setup-node@v4.0.0
```

Checking out is the caller's job. Jobs need different checkouts — Chromatic
needs the full history, a build needs none of it — and folding that in would
mean re-exposing every `actions/checkout` input through this one.

## Inputs

| Input               | Default          | Description                                                       |
| ------------------- | ---------------- | ----------------------------------------------------------------- |
| `cache`             | `true`           | Cache the npm download directory between runs                     |
| `ignore-scripts`    | `false`          | Pass `--ignore-scripts` to `npm ci`                               |
| `node-version-file` | `.tool-versions` | File the Node version is read from                                |
| `registry-url`      | —                | Registry to authenticate against, written to a job-level `.npmrc` |

### `ignore-scripts`

Set it to `true` for jobs that only need the dependency tree. A repository whose
`prepare` script downloads Playwright browsers pays for that download in every
job that installs, including lint and build jobs that never open a browser.

Leave it `false` wherever the scripts are the point — a test job that needs
those browsers, or any package with a native dependency to compile.

### `cache`

Caching is on by default and names the package manager explicitly, so it does
not depend on `package.json` declaring a `packageManager` field. Leaving that to
`actions/setup-node`'s auto-detection would silently cache nothing in a
repository without one.

Turn it off in publishing jobs, where the restore usually costs more than the
one install it saves.

### `registry-url`

Only publishing jobs need this. Setting it writes an `.npmrc` that reads
`NODE_AUTH_TOKEN` — which a job using npm trusted publishing over OIDC does not
need to set, as long as the job has `id-token: write`.
