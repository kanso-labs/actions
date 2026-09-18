# `lint-workflows`

Runs [actionlint](https://github.com/rhysd/actionlint) over a repository's
workflows. It checks expression syntax, action inputs, permission scopes, and —
through shellcheck — the shell inside every `run:` block.

```yaml
- name: Check out repository
  uses: actions/checkout@v7.0.1

- name: Lint workflows
  uses: kanso-labs/github-actions/lint-workflows@v4.0.0
```

Checking out is the caller's job, the same way it is for
[`setup-node`](../setup-node). actionlint reads `.github/workflows` from the
working directory, so there has to be one already.

## Inputs

| Input     | Default  | Description               |
| --------- | -------- | ------------------------- |
| `version` | `1.7.12` | actionlint release to run |

`version` is pinned rather than tracking `latest`. An unpinned linter turns its
next new rule into a red build on whichever pull request happens to be open at
the time, which tells that author nothing about their own work. Renovate bumps
it, so the new rule arrives in a pull request of its own.

## Silencing a rule

Commit `.github/actionlint.yaml` in the consuming repository. actionlint
discovers it on its own, which is why no input here exposes it:

```yaml
paths:
  .github/workflows/deploy.yaml:
    ignore:
      - 'shellcheck reported issue in this script: SC2086'
```

Scope the suppression to the file that needs it rather than passing a global
`-ignore`, so the rule keeps running everywhere else.

## The built-in ignore

This action already passes one `-ignore` of its own, for
`unknown permission scope "code-quality"`. Consumers do not need to suppress
that themselves.

actionlint carries its own copy of the valid permission scopes, and the pinned
release predates `code-quality`, which `actions/upload-code-coverage` requires.
A workflow granting it is correct and the linter is stale. That is a fact about
the pin rather than about any one repository, so the correction lives here,
beside the pin, instead of in a `.github/actionlint.yaml` in every consumer that
uploads coverage.

It matches the scope name exactly, so a misspelt scope — `code-qualty` — still
fails.

It retires with the pin. When `version` is bumped to a release whose permission
table includes `code-quality`, the flag goes: check `rule_permissions.go` at
that tag, or lint a workflow granting the scope with that release and watch it
pass. Renovate puts that check in the body of the bump pull request.

## Where it runs

Put it in the job that already gates merges rather than in a job of its own. A
new job means a new check name, and a check name that no ruleset requires is
advisory: it can fail without stopping anything. Run it as a step of a job the
ruleset already requires.
