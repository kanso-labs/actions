# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

The shared CI surface for the `kanso-labs` organization: composite actions under
`actions/`, reusable workflows under `.github/workflows/` with a leading
underscore. [`README.md`](README.md) documents what each one does and how to
call it — read it first, and keep it correct when you change behaviour, because
it is what consumers read.

**This file does not name the consumers, deliberately.** Which repository calls
what is a fact the caller owns and changes without telling anyone here, so a
roster in this file is stale the moment one adds or drops a call. Read it from
the calling side instead — the `uses:` lines under a consumer's
`.github/workflows/`, which is also the only place the pinned tag is visible.

Nothing here is used by one repository alone. A change that looks obviously
right in the shape one caller uses it can still be wrong for another, so check
every caller before changing an input's meaning or a default.

## Commands

| Task           | Command          | Notes                                                 |
| -------------- | ---------------- | ----------------------------------------------------- |
| Lint           | `npm run lint`   | Prettier check over the YAML, JSON and Markdown       |
| Format         | `npm run format` | Prettier write; run it before pushing                 |
| Lint workflows | `actionlint`     | Also runs as a step of `Lint` in CI                   |
| Test           | `npm test`       | `node --test` over `actions/**`; runs as `Test` in CI |

There is no `SessionStart` hook here, so `npm ci` is yours to run before
`npm run lint`. Neither command type-checks anything — see Verifying a change
for what CI does and does not cover.

## Conventions

Shared with the other `kanso-labs` repositories:

- **Keys in JSON and YAML are ordered by name.** Files whose order carries
  meaning are exempt: workflows, where step order is execution order;
  changelogs, which are chronological; and `package.json`, where the npm
  ecosystem expects `name` and `version` first.
- **A workflow's filename is the kebab-case of its `name:` field.** Reusable
  workflows, meaning those triggered only by `workflow_call`, take a leading
  underscore.
- **Job names and step names are imperative verb phrases.** Job ids, step ids,
  and matrix keys are exempt.
- **Actions are pinned to exact release tags**, `actions/checkout@v7.0.1`, never
  a moving major or `@main`. Renovate opens the bump pull requests.
- **Dependency versions are pinned exactly.** Every `dependencies`,
  `devDependencies`, and `optionalDependencies` entry is a bare version,
  `1.2.3`, never `^1.2.3`, `~1.2.3`, `>=1.2.3`, `*`, `1.x`, or an `||` union.
  Renovate opens those bumps too. `peerDependencies` are the deliberate
  exception: they state what the consumer's own installed copy must satisfy, so
  ranges are correct there and stay.
- **`.tool-versions` pins a fully-specified version on every line**,
  `nodejs 24.21.0`, never `nodejs 24` or `nodejs lts`.

That last one has more reach from here than it does anywhere else:
`actions/setup-node` defaults `node-version-file` to `.tool-versions`, here and
in every consumer, so that file is what a run actually resolves.

Formatting is not shared, and assuming it is will send you to a command that
does not exist. **Prettier formats the YAML, JSON and Markdown here**, and CI
checks it — run `npm run format` before pushing. The siblings do not agree with
each other or with this repository, and a roster of what each one runs belongs
in each one rather than here. Read the Commands section of whichever repository
you are actually in before reaching for a formatting command.

## Versioning

Consumers pin exact tags — `@v1.2.3`, never `@main` or `@v1`. Renovate opens the
bump pull requests.

That is what makes an error here survivable: it reaches one repository at a
time, in a pull request, rather than all four the moment it merges. Do not
"simplify" a consumer to `@main`.

release-please owns `version.txt` and `.release-please-manifest.json`. Nobody
edits either by hand.

Pull requests are squash-merged, with the pull request title as the commit
subject and an empty body. That title becomes the only commit on `main`, and
branch commit messages are discarded by the squash and never reach history.

That title is therefore the single input to the release: `feat` for a minor,
`fix`, `deps` and `ci` for a patch, `!` for a breaking change, anything else
releases nothing.

**Renovate commits are typed `deps:`, and that is what makes them release.**
release-please computes a patch bump for any commit that is not a `feat` or a
breaking change, but it only opens a release pull request when the notes it
generates are non-empty — a run whose every commit falls in a hidden changelog
section is skipped as "No user facing commits found". Renovate's default,
`chore(deps):`, lands in exactly such a section, so an upgrade never cut a
release of its own: it shipped only when a feature happened to land beside it,
and a run of nothing but upgrades published nothing at all.

`.github/renovate.json` therefore sets `semanticCommits: enabled` and
`semanticCommitScope: null` at the top level, and `semanticCommitType: deps` in
a `packageRule` rather than beside them. `release-please-config.json` spells out
`changelog-sections` with `deps` visible under a `Dependencies` heading. The two
move together: that list replaces release-please's defaults wholesale, so a type
missing from it is invisible rather than merely unstyled, and `deps` with no
matching section would put the upgrades back where they started.

It matters more here than in a repository nothing consumes: consumers pin exact
tags, so an upgrade that cuts no release is one nobody can pin. See Traps for
why the type cannot be a top-level key.

`ci` is visible for a related reason. The workflows and composite actions here
are the thing consumers pin, so a `ci:` commit is usually a change to the
product rather than to the scaffolding around it, and hidden it shipped only
when something else happened to release beside it.

The type is coarser than the distinction it stands for, and that costs
something. `lint.yaml`, `test.yaml` and `release-please.yaml` are consumed by
nobody, so a `ci:` change to one of them cuts a release that says nothing to any
consumer — release-please keys on the commit type, never on the path. Use
`chore:` when a change really does touch only this repository's own scaffolding.

**Making a hidden type visible is safe only while no Renovate-managed file names
this repository.** A releasable type plus a self-reference is the release loop
described in Traps: Renovate bumps the reference, the bump releases, the release
moves what Renovate reads. Both halves have to be present, so check the first
before adding to the second. Renovate's `github-actions` manager reads
`.github/workflows/*.yaml` and `action.yaml`, and no markdown — the `uses:`
examples in the README files are documentation and are not bumped, which is why
they sit on four different old versions.

**Breaking means "a consumer must edit something to keep working"** — removing
an input, renaming an output, changing a default. Exact pins mean nothing breaks
at release time. It breaks when Renovate's bump lands somewhere that never read
the changelog, so the major is the only warning that arrives with the change.

## Verifying a change

`npm run lint` and actionlint cover syntax. Neither proves a workflow does what
it claims — most of what has gone wrong in CI here was valid YAML.

There is no `SessionStart` hook here, so `npm ci` is yours to run before
`npm run lint`. Run it under the Node version in `.tool-versions`, which is what
CI resolves; if `node --version` disagrees, prefix the command:
`mise exec node@24.21.0 -- npm ci`. An older npm rewrites the lockfile as it
installs, dropping platform entries a Linux runner needs.

**Two of the three composite actions have a live smoke test**, in
[`lint.yaml`](.github/workflows/lint.yaml): `check-formatting` calls
`./actions/setup-node` and `lint-workflows` calls `./actions/lint-workflows`, so
a change that breaks either fails on the pull request rather than in whichever
repository next bumps its pin. Those are the only jobs in this repository that
exercise them — keep them that way round, and do not "tidy" either into a plain
`actions/setup-node` or `raven-actions/actionlint` step.

A local `./` reference is safe there and is not safe inside a reusable workflow;
see the trap below before copying the pattern into one.

**`actions/upstream-changelog` has unit tests instead, and the difference is not
a preference.** A live run of it needs an open Renovate pull request carrying
release notes, which exists in a consumer and never here. `Run the unit tests`
in [`test.yaml`](.github/workflows/test.yaml) covers the parsing and the
rewriting against a body in Renovate's own layout, which is where every bug it
has had so far lived.

What no test here covers is release-please agreeing: that the block parses, that
the lines land under the right package, and that the bump stays a patch. That
needs release-please itself, and the recipe is in
[the action's README](actions/upstream-changelog/README.md). Run it when you
change what the block looks like, rather than trusting the unit tests, because
they assert the shape this repository decided on and not the shape
release-please accepts.

**The reusable workflow has one too, in dry-run.** `Dry run release-please` in
[`test.yaml`](.github/workflows/test.yaml) calls
`./.github/workflows/_release-please.yaml` with `dry-run: true`, so
release-please resolves the config, walks the commits and computes versions
while opening no pull request and cutting no release. It passes no secrets, so
it covers the `GITHUB_TOKEN` fallback and its warning as well. That path
reference is deliberate: the test has to run the version in the pull request,
which is the only version not yet released. `release-please.yaml` reaches the
same workflow the same way — see the trap below for why it stopped pinning a
tag.

**`_publish-npm.yaml` has no smoke test here, and cannot have one.** Its
`dry-run` input runs both jobs through `npm publish --dry-run`, which uploads
nothing — but `package.json` in this repository is `private: true`, and npm
refuses to publish a private package even as a dry run. Canary it in a consumer
with the recipe below, which is what `dry-run` exists to make safe.

**The smallest consumer does not exercise the whole of it.** A caller with no
`@kanso-labs` dependency cannot reach the scoped-registry trap below, whatever
registry the job points at — only one that installs another `kanso-labs` package
can, and that is also the heaviest install. So a change to how
`Publish to GitHub Packages` installs is exactly the case where canarying in the
smallest consumer proves the least. Read the trap and reason about it rather
than trusting a green run there.

What none of this covers is the application-token path, or anything that only
happens on a real push to a default branch. For a change touching those, canary
it by hand as well:

1. Push a branch here with the change.
2. On a branch in one consumer, flip its `uses:` ref to that branch.
3. Merge nothing — dispatch or push the consumer branch and read the run.
4. Delete both branches, then merge the real pull request.

Pick the consumer with one package, no application token, and nothing installed
depending on its releases. A bad canary run then costs a throwaway branch rather
than somebody's release.

`_renovate-command` has to be canaried wherever an open Renovate pull request is
always available to comment on. Two things about it differ from the recipe
above:

**The caller cannot be canaried from a branch.** `issue_comment` is a
repository-level event, so GitHub runs whatever version of the workflow file is
on the default branch and ignores every other copy. Step 2 above is impossible.
The caller has to be merged to `main` first, with its `uses:` ref pointed at the
branch here, and the pin moved to the released tag afterwards.

**A green run is not evidence.** The job exits 0 on an unrecognised command, on
an unauthorised author, and on a comment that turns out not to hold a command at
all — all deliberate, so that a stranger's typo does not put a red X on a pull
request. Read what the run logged and check the reaction that landed on the
comment, rather than its colour.

## Traps

**`semanticCommitType` sits in a `packageRule`, and that is the whole fix.** It
was a top-level key at first and did nothing at all. `config:recommended`
extends `:semanticPrefixFixDepsChoreOthers`, which sets the type through
`packageRules` — `matchPackageNames: ["*"]` to `chore`, plus a narrower
`dependencies` to `fix` — and `packageRules` beat top-level config. So Renovate
went on writing `chore:` while the setting sat there looking correct, and only
production dependencies released at all.

The rule this repository carries is therefore first in `packageRules`, where a
later rule can still override it for specific packages.

**A called workflow cannot request more permissions than its caller granted.**
Not a silent intersection — the run fails outright with a message naming the
scope. That is why `_release-please.yaml` declares no `permissions` block at
all: its callers do not need the same ones, because a caller supplying an
application token leaves `GITHUB_TOKEN` on `contents: read` while one falling
back to it needs three write scopes. Adding a block here would break the first
kind.

**Merging a release pull request is only half a release, and who merges it
decides whether the other half happens.** The merge pushes the default branch,
and the run that push starts is what cuts the tag and the GitHub release. A push
made with `GITHUB_TOKEN` starts no run, so auto-merging in the fallback path
leaves the release half-applied: the version is bumped and the changelog written
on the branch, but nothing is tagged and no GitHub release exists. That is why
the auto-merge step tests `env.CLIENT_ID != ''` as well as its own input.

It recovers on its own, which is what makes it easy to miss. The next push to
the default branch — any push, for any reason — starts a run that finds the
merged release pull request still labelled `autorelease: pending` and cuts the
tag then. On a quiet repository that is however long it takes somebody to push
something else, and until it happens the version in `version.txt` is one no
consumer can pin, because the tag it names does not exist. Both v1.0.1 and
v1.0.2 of this repository were released that way.

**`prs` carries only what a run wrote, and the auto-merge step must not read
it.** When release-please recomputes a release and gets the same answer it logs
`remained the same`, drops that pull request from what it returns, and the
action then sets no `prs` output at all rather than an empty array. That is the
ordinary case for a caller that proposes on every push and merges on a schedule:
the scheduled run finds yesterday's pull request already correct. Gating
auto-merge on `prs` there merges nothing, ever, and leaves no failing run to say
so. The step looks the pull requests up by their `autorelease: pending` label
instead — do not "simplify" it back to the output sitting directly above it.

That lookup passes `--state open`, which the trap above is the reason for: a
merged release pull request keeps the `autorelease: pending` label until a later
run tags it, so filtering by label alone would turn up one with nothing left to
merge.

`!inputs.dry-run` became load-bearing at the same time. It used to be backed up
by `prs` being empty whenever the pull request was skipped; a label lookup finds
the standing release pull request either way, so that condition is now the only
thing keeping a dry run from merging a real release.

**The concurrency guard lives in the caller, and that is deliberate.** Do not
move it into `_release-please.yaml` to save the repetition. GitHub documents
`concurrency` at the caller and says nothing either way about a group declared
in a called workflow, so moving it there would bet a guard that only matters
during a rare race on undocumented behaviour — and if it turned out to be a
no-op, all three consumers would lose it silently and simultaneously.

**The `secrets` context is not available to an `if:` condition.** Not at job
level and not at step level. Checking whether a secret was supplied means
copying it to a job-level `env` first and testing `env.X != ''`, which is what
`_release-please.yaml` does to decide whether to mint an application token.

**A skipped step's outputs are empty strings, not null.** That is load-bearing:
`steps.app-token.outputs.token || github.token` is the whole token fallback. It
works precisely because the skipped step yields `''`.

**A `./` reference inside a reusable workflow does not mean what it means in an
ordinary one.** In `lint.yaml`, `./actions/setup-node` resolves against this
repository and is the documented way to reference a sibling action. Inside a
workflow called through `workflow_call`, the same string resolves against the
checkout sitting in the workspace — and that checkout belongs to the _caller_,
so it would look for the action in the consuming repository and not find it.
GitHub documents `./` for referencing a workflow in the same repository and says
nothing either way about an action referenced from inside a called workflow.
That is why `_publish-npm.yaml` inlines `actions/setup-node@v7.0.0` and its
`npm ci` rather than calling the composite next door. Do not "de-duplicate" it.

Naming the composite by tag is the other obvious fix and is worse: it pins this
repository to a version of itself that does not exist until the release carrying
the change is cut.

**`_publish-npm.yaml` declares `permissions` and `_release-please.yaml` does
not, and the difference is not an inconsistency.** A called workflow may always
request less than its caller granted; requesting more fails the run. So a block
is safe exactly when every caller needs the same scopes. Publishing callers all
need the same three, so naming them turns a forgotten scope into an immediate
error instead of a registry-side refusal. Release callers do not agree with each
other — one supplying an application token leaves `GITHUB_TOKEN` on
`contents: read`, one falling back needs three write scopes — so any block there
would break one kind.

**`_publish-npm.yaml` declares those `permissions` per job rather than once for
the file, and that is not tidiness either.** `Publish to npm` holds
`id-token: write` and `Publish to GitHub Packages` holds `packages: write`, and
neither holds the other's. npm decides whether to attempt an OIDC exchange by
looking for the variables `id-token: write` injects; GitHub Packages has no
trusted publisher to exchange against. Granting both scopes to both jobs would
invite npm to try something that registry cannot answer, in the publish half of
a release that has already been tagged. Do not hoist the block back up to the
file, and do not collapse the two jobs into a matrix — `permissions` is a job
key, so a matrix would hand every leg the union.

**A GitHub Packages `registry-url` redirects installs, not just publishes.**
`actions/setup-node` writes a _scoped_ line for that registry —
`@kanso-labs:registry=https://npm.pkg.github.com/` — because it serves one scope
only, and npm reads that line when resolving dependencies as much as when
publishing. A consumer that depends on another `@kanso-labs` package therefore
runs an `npm ci` that goes looking for a version GitHub Packages does not have,
404s, and half-lands the release. That is why `Publish to GitHub Packages` sets
up Node against the _public_ registry, installs and builds, and only then calls
`actions/setup-node` a second time to repoint npm. Do not "simplify" it to one
setup step with the GitHub Packages URL.

The second call is safe to make because the action appends: it drops only lines
starting with the registry key it is about to write, and the scoped key does not
match the unscoped `registry=` line the first call left. Writing the line by
hand instead would mean locating the file through `NPM_CONFIG_USERCONFIG`, which
is an internal of the action rather than a documented interface.

**Hyphens are fine in `uses:` refs and property names.** `steps.app-token`,
`inputs.auto-merge` and `secrets.private-key` all parse as property access, not
subtraction. There is no need to rename anything to underscores.

**`npm ci` takes `--ignore-scripts` as a flag, not a value.** The two forms
cannot be collapsed into one interpolated command line, which is why the
composite action branches in shell instead of interpolating the flag.

**This repository's own `release-please.yaml` calls `./`, and pinning a tag
there is a release loop.** It pinned one until v3.0.1, which made this
repository a consumer of itself: Renovate bumps the pin, the bump lands as
`deps` and so cuts a patch release, the release moves the tag, and the next
Renovate run bumps it again — one release every three hours, each carrying
nothing but the bump of the one before it. Any self-reference reintroduces that,
so `./` here is the rule and not a shortcut.

What the tag bought was exercising the call shape consumers use, and that is
thinner than it sounds: `_release-please.yaml` references no sibling action or
workflow, only external pinned ones, so nothing in it resolves differently
between the two forms, and four consumers exercise the tag form continuously
anyway. What went with it is the lag — `main` now runs `main`, so a bad merge to
`_release-please.yaml` breaks releases here at once rather than waiting for a
bump to carry it in. Push the fix and the next run has it, or dispatch
`Release Please` by hand if nothing else is due to push.
