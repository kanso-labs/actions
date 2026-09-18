# `check-shared-docs`

Asserts a repository still agrees with the organization's shared documentation
in [`kanso-labs/.github`](https://github.com/kanso-labs/.github).

```yaml
- name: Check out repository
  uses: actions/checkout@v7.0.1

- name: Check the shared documentation
  uses: kanso-labs/github-actions/actions/check-shared-docs@v3.3.1
```

Checking out the caller is the caller's job, as it is for `setup-node` and
`lint-workflows`. The action fetches only the canonical copy, into
`.canonical-docs`.

## What it checks

**The conventions block in `AGENTS.md` matches `CONVENTIONS.md`.** Every
repository restates the shared bullets, because an agent handed one repository
reads its `AGENTS.md` and never sees `.github`. The duplication is the point;
the drift is what this catches.

The compared region is delimited by `<!-- shared-conventions:start -->` and
`<!-- shared-conventions:end -->`, in both files. Markers rather than a match on
the first and last bullet: markers survive a reordered or added bullet, and a
text match would fail in a way that reads like drift rather than like a broken
check.

**No community health file has been reintroduced.** GitHub serves
`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md` and the
issue templates as organization defaults to any repository that carries no copy
of its own — and **a local copy suppresses the default entirely rather than
merging with it**. That is the failure worth catching, because it is silent: the
repository looks fine and quietly stops using the shared text.

Both the repository root and `.github/` are checked, since either location wins.

**`LICENSE.md` is byte-identical to the organization's.** A licence is the one
file GitHub will not serve as a default, and rightly — it has to travel with the
code — so every repository carries the same bytes instead.

## Inputs

| Input           | Default | What it is                                                                                       |
| --------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `allow-local`   | `''`    | Community health files this repository overrides on purpose, space separated, as bare filenames. |
| `canonical-ref` | `main`  | Ref of `kanso-labs/.github` to compare against.                                                  |

**`allow-local` is how a deliberate override stops being indistinguishable from
an accident.** An override is sometimes right — `unplugin-style-dictionary`
keeps its own `.github/ISSUE_TEMPLATE/` because a report against that plugin is
unplaceable without the bundler, `style-dictionary` and Node versions, which the
generic form does not ask for. Name it here and record the reason in that
repository's `AGENTS.md`; anything not named fails.

```yaml
with:
  allow-local: ISSUE_TEMPLATE
```

**`canonical-ref` tracks `main` on purpose.** The canonical text has no
releases, and a stale pin would let the copies drift while the check stayed
green — which is the one outcome the action exists to prevent.

The cost is that editing `CONVENTIONS.md` turns every repository's `Lint` red
until its copy follows. That is the mechanism working, and it is why a change to
the shared set is six pull requests rather than one.

## Why the text is not read from here

`github-actions` is called by every other repository, so holding the canonical
text here would make one consumer the authority over its four peers. `.github`
is nobody's peer. The action lives here because anything a workflow `uses:`
lives here; only the data it reads sits elsewhere.
