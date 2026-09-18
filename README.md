# github-actions

Shared GitHub Actions workflows and composite actions for the `kanso-labs`
organization.

Every repository here is public, so nothing needs to be configured for one of
them to consume these. A private consumer would need
`Settings → Actions → General → Access` opened up first.

## What is here

| Thing                                                                | Kind              | Solves                                                                        |
| -------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| [`lint-workflows`](lint-workflows)                                   | Composite action  | Running actionlint, pinned, in every repository that has workflows            |
| [`setup-node`](setup-node)                                           | Composite action  | The Node setup preamble repeated in every Node CI job                         |
| [`upstream-changelog`](upstream-changelog)                           | Composite action  | Getting an updated dependency's own release notes into a consumer's changelog |
| [`_publish-npm.yaml`](.github/workflows/_publish-npm.yaml)           | Reusable workflow | Publishing a package to npm and to GitHub Packages, after a release is cut    |
| [`_release-please.yaml`](.github/workflows/_release-please.yaml)     | Reusable workflow | Proposing releases, with a token whose pull requests run CI                   |
| [`_renovate-command.yaml`](.github/workflows/_renovate-command.yaml) | Reusable workflow | Answering `@renovate rebase` on a pull request, the way Dependabot does       |

## Consuming them

Pin an exact version. Renovate opens the bump pull requests, the same way it
does for every other action these repositories pin.

```yaml
- name: Set up Node
  uses: kanso-labs/actions/setup-node@v4.0.0
```

```yaml
concurrency:
  cancel-in-progress: false
  group: release-please

jobs:
  release-please:
    name: Propose releases
    uses: kanso-labs/actions/.github/workflows/_release-please.yaml@v4.0.0
    secrets:
      client-id: ${{ secrets.RELEASE_PLEASE_CLIENT_ID }}
      private-key: ${{ secrets.RELEASE_PLEASE_PRIVATE_KEY }}
```

That `concurrency` block is not optional — see below.

Tracking `@main` instead would mean a mistake here breaks CI in every consuming
repository at once, with no way to hold one back. That is the whole reason for
the tags.

## `setup-node`

Reads the Node version from `.tool-versions`, restores the npm cache, and runs
`npm ci`. Full inputs are in [its README](setup-node/README.md).

The npm cache comes from `actions/setup-node`'s own `cache: npm`, which is why
consumers do not need a separate `actions/cache` step for `~/.npm`. Any such
step left behind is doing nothing.

## `lint-workflows`

Runs actionlint over `.github/workflows`, at a pinned version. Full inputs are
in [its README](lint-workflows/README.md).

Put it in the job a ruleset already requires rather than in a job of its own. A
new job means a new check name, and a check name nothing requires can fail
without stopping anything — so a workflow linter added that way reports problems
to no one.

A repository silences a rule by committing `.github/actionlint.yaml`, which
actionlint discovers by itself.

One stale-list case is already handled here and needs nothing from consumers.
actionlint carries its own copy of the valid permission scopes, so a scope
GitHub has added since the pinned release reads as an error on a workflow that
is perfectly correct — `code-quality`, which `actions/upload-code-coverage`
requires. The action passes an `-ignore` for exactly that message, and retires
it when the pin moves.

## `upstream-changelog`

Rewrites a Renovate pull request body so that the release notes of the
dependency it updates reach the changelog release-please writes at merge time —
turning a release that says `update dependency nzbgetcom/nzbget to v26.3` into
one that lists what nzbget actually changed. Full inputs and the mechanism are
in [its README](upstream-changelog/README.md).

It is worth having wherever the dependency _is_ the product: a repository
packaging somebody else's application, where "what changed" means what changed
upstream. In a library it is noise, because a changelog full of Storybook's
release notes buries the library's own.

Two things a consumer has to do beyond calling it: give the `commit-type` a
section in `release-please-config.json`, and trigger on `edited` as well as
`opened` and `synchronize`, so that a Renovate rewrite of the body is followed
by a rewrite of ours.

## `_publish-npm.yaml`

Publishes a package once `_release-please.yaml` has cut a release — to npmjs.com
over trusted publishing, then to GitHub Packages. One call does both.

```yaml
publish:
  name: Publish to npm
  needs: release-please
  if: needs.release-please.outputs.release_created == 'true'
  permissions:
    contents: read
    id-token: write
    packages: write
  uses: kanso-labs/actions/.github/workflows/_publish-npm.yaml@v4.0.0
```

Compare `release_created` against the string. A bare truthiness test also passes
on `"false"`, which is what that output carries when release-please runs and
decides not to cut a release — so the package would be published on every merge.

### Two registries, two jobs, one order

`Publish to npm` runs first and `Publish to GitHub Packages` `needs:` it.

npmjs.com is the source of truth for what a version of a package is; GitHub
Packages carries a copy. The edge between the jobs is what keeps the copy from
getting ahead of the original: if the public publish fails, both registries stay
a version behind, and the next release — or a re-run of the failed job on its
own — catches them up together. Drop the edge and a failed `npm publish` leaves
GitHub Packages serving a version npmjs.com has never heard of, which is the one
state a version number cannot be reasoned about from.

The second job repeats the checkout, install and build rather than sharing the
first job's. The two differ in the single thing a job cannot parameterise — its
permissions — and the next section is why that difference has to be kept.

### The two halves authenticate differently

npmjs.com goes over trusted publishing, so no secret is passed for it at all.
`id-token: write` is what npm exchanges for a short-lived credential, and what
mints the provenance attestation alongside it.

GitHub Packages has no trusted publishing. It takes `GITHUB_TOKEN` with
`packages: write`, set as `NODE_AUTH_TOKEN` on the publish step alone rather
than on the job. Nothing attested comes out of that half: provenance is minted
during the OIDC exchange, so the tarball is attested at npmjs.com and only
mirrored here.

Each job declares its own scope and neither holds the other's, which is
load-bearing rather than tidy. npm decides whether to attempt an OIDC exchange
by looking for the variables `id-token: write` injects, and GitHub Packages has
no trusted publisher to exchange against — so a file-level block granting both
scopes would invite npm to try something that registry cannot answer, in the
publish half of a release that has already been tagged.

The caller grants all three together. It is checked against each job separately,
so a scope left out still fails the run at once with that scope named, rather
than being refused by a registry for a reason that reads as a registry problem.

**The first publish of a package to npmjs.com cannot use this.** npm configures
a trusted publisher on the package page, and the package has to exist before
there is a page to configure, so a new package is pushed by hand once and this
takes over afterwards. Both packages in this organization were bootstrapped that
way. GitHub Packages needs no equivalent: `GITHUB_TOKEN` creates the package on
first publish, and it arrives public.

### A new package on GitHub Packages arrives public, with nothing to flip

Worth stating because the opposite is widely reported, and this section said it
too until the first two releases proved otherwise.

Both packages were created by their first release through this workflow and both
came out `visibility=public` immediately, with no manual step:

```
$ gh api "/orgs/kanso-labs/packages?package_type=npm"
  <package>  visibility=public
  <package>  visibility=public
```

What makes that so is not isolated here, so do not over-generalize it. These are
public repositories, the packages are scoped to the organization that owns them,
and `publishConfig.access` is `public` in both manifests — which is what npm's
`--access` reads. A private repository, or a manifest without that key, is a
case this organization has no evidence about.

The check is still worth a glance after the first release that creates a package
somewhere new, because visibility is a package-level setting and nothing in the
run reports it. It is under the organization's **Packages** tab. Making a
package public is one-way if it ever does come out private — a public package
cannot be made private again.

### The GitHub Packages job installs from npmjs.com, deliberately

`Set up Node` in `Publish to GitHub Packages` names `registry-url` as the
_public_ registry, which reads like a copy-paste slip. It is not one.

Handed a GitHub Packages URL, `actions/setup-node` writes a **scoped** registry
line — `@kanso-labs:registry=https://npm.pkg.github.com/` — because that
registry serves exactly one scope. That line governs installs as much as
publishes. A consumer that devDepends on another `@kanso-labs` package, pinned
to a version that predates this job, would therefore run an `npm ci` that goes
looking for that version on a registry that will never carry it, 404, and
half-land the release: tagged, on npm, missing from the mirror.

So that job installs and builds against the public registry, then calls
`actions/setup-node` a second time to repoint npm once nothing is left to
resolve. The second call appends rather than replaces — the action drops only
lines beginning with the registry key it is about to write, and a scoped key
does not match the unscoped `registry=` line already in the file.

Writing that `.npmrc` line by hand instead would mean finding the file through
`NPM_CONFIG_USERCONFIG`, which is an internal of the action. Calling the action
twice asks the thing that owns the file to rewrite it.

### Adopting the GitHub Packages half takes two merges, not one

A caller granting fewer scopes than a called job requests fails the run
outright. So `packages: write` has to be on the caller **before** its pin moves
to a version of this repository that has the second job, not in the same change:

1. Merge `packages: write` into the consumer's publish job. Harmless while the
   pin is still on `v2.x` — a caller may grant more than a called workflow asks
   for, and the unused scope goes nowhere.
2. Let Renovate bump the pin. That merge is what turns the second job on.

Doing it the other way round breaks the publish half of whatever release lands
first.

### `ignore-scripts` defaults to true here

The composite action defaults it to `false` and this defaults it to `true`,
which is worth explaining rather than lining up.

`npm` runs `prepare` on publish as well as on install. A repository whose
`prepare` downloads Playwright's browsers therefore pays for that download twice
in each job — once installing, once as a step of the publish itself, where
failing to fetch a browser aborts a release that has already been tagged.
Nothing either package ships is produced by a lifecycle script; the build step
is the whole of it.

Set it to `false` only for a package with a native dependency to compile.

### Inputs

| Input                 | Default                      | Description                                          |
| --------------------- | ---------------------------- | ---------------------------------------------------- |
| `build-script`        | `build`                      | npm script producing what is published               |
| `dry-run`             | `false`                      | Publish with `--dry-run`, uploading nothing          |
| `github-registry-url` | `https://npm.pkg.github.com` | GitHub Packages registry the second job publishes to |
| `ignore-scripts`      | `true`                       | Pass `--ignore-scripts` to `npm ci` and publish      |
| `node-version-file`   | `.tool-versions`             | File the Node version is read from                   |
| `registry-url`        | `https://registry.npmjs.org` | Public registry to publish to, and to install from   |

Pass `build-script: ''` for a package with nothing to build; the step is then
skipped rather than running `npm run` with an empty argument.

There is no input for the GitHub Packages **scope**. That registry accepts only
the owning organization's, so it is always `github.repository_owner` — which,
inside a called workflow, is the caller's owner and not this repository's.

### It inlines the Node setup rather than calling `setup-node`

Deliberately, and it is the one duplication here that should stay.

A `./` reference inside a reusable workflow resolves against the checkout in the
workspace, and that checkout belongs to the caller — so it would look for the
composite in the consuming repository and not find it. GitHub documents `./` for
referencing a workflow in the same repository and says nothing either way about
an action referenced from inside a called workflow, which is not a thing to rest
on when every consumer publishes through here.

Naming the composite by tag would work and introduces a worse problem: it pins
this repository to a version of itself that does not exist until the release
carrying the change is cut.

What inlining gives up is the cache handling, and both jobs turn that off
regardless — each installs once and throws the runner away, so restoring the
cache costs more than the single install it would save.

### Verifying a change to it

`dry-run` runs everything including `npm publish --dry-run`, in both jobs, which
resolves the manifest and prints the file list without uploading. It cannot be
exercised in this repository: `package.json` here is `private: true`, and npm
refuses to publish — even a dry run — for a private package.

Canary it in a consumer instead, following the recipe in
[`AGENTS.md`](AGENTS.md). Pick carefully: a consumer with no `@kanso-labs`
dependency of its own will not exercise the scoped-registry trap above, and only
one that installs another `kanso-labs` package can.

## `_release-please.yaml`

Wraps `googleapis/release-please-action` with the things that were only ever
configured in one repository:

**An application token, when the caller supplies one.** Pull requests opened
with the default `GITHUB_TOKEN` do not start workflow runs. Their checks sit at
`action_required` until somebody approves them by hand, so a release stalls
there — and if the repository requires status checks to merge, auto-merge can
never fire, because the checks it is waiting for never report. Requests made
with a GitHub App token trigger checks like any other.

Both `client-id` and `private-key` are optional. Without them the run falls back
to `GITHUB_TOKEN`, warns in the job log, and still opens a correct release pull
request — it just has to be merged by a person. That fallback is what lets a
repository adopt this workflow before its secrets are in place.

**There is no `app-id` input.** Both workflows took one as a deprecated alias
through v1.x and dropped it in v2.0.0, which is what makes v2 a major. A caller
bumping to v2 has to rename the secret it passes; the value need not change,
since a GitHub App id and a client id are interchangeable where it lands — each
is accepted as the JWT issuer. Passing an app id under the `client-id` name
still works, so the rename can be done before the secret is.

**In fallback mode, auto-merge is disabled no matter what `auto-merge` is set
to.** Merging the release pull request is only half of a release: that merge
pushes the default branch, and the run it starts is what cuts the tag and the
GitHub release. A push made with `GITHUB_TOKEN` starts no run, so auto-merging
as it leaves the release half-applied: the version is bumped and the changelog
written, but nothing is tagged. The next push to the default branch, whenever
that happens and whatever it is for, cuts the tag late — so on a quiet
repository the released version spends an unbounded stretch being one that
nobody can pin. A person's merge starts the run immediately, so the fallback
leaves the merge to them.

A repository whose ruleset requires status checks cannot really use the fallback
at all: the release pull request never starts the checks it is required to pass,
so nobody without bypass can merge it. That is the real reason such a consumer
needs the application installed, rather than a stylistic one.

**Auto-merge on the release pull requests.** Enabled by default; pass
`auto-merge: false` to turn it off. Note that `--auto` only queues when
something is already blocking the pull request. With no required checks it
merges on the spot.

The step finds those pull requests by their `autorelease: pending` label rather
than by reading the action's `prs` output, and that difference is what lets a
caller batch its releases. `prs` carries only what the run created or updated:
when the release release-please computes has not changed, it logs
`remained the same`, drops that pull request, and then sets no `prs` output at
all rather than an empty array. A run that merely re-confirms a release pull
request already open therefore finds nothing there to merge, while the label is
on it either way.

### Permissions

The workflow deliberately declares no `permissions` block, because what the
caller needs depends on which token it uses:

| Caller supplies               | Needs at workflow level                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `client-id` and `private-key` | `contents: read` — the app token does the writing          |
| Neither                       | `contents: write`, `issues: write`, `pull-requests: write` |

A called workflow cannot request more than its caller granted, so declaring
write here would force the first kind to widen its `GITHUB_TOKEN` for no reason.

### The caller owns the concurrency group

Overlapping release-please runs race each other. Every release merge pushes the
default branch, every push starts a run, and two runs landing together try to
cut the same tags and strip the same labels — one then dies on the other's
half-finished work. `cancel-in-progress` stays off, because the last push must
still get a run or the release it carries is never proposed.

The guard is required, and it goes in the caller. GitHub documents `concurrency`
at the caller and says nothing either way about a group declared inside a called
workflow, and a guard that only matters during a rare race is the worst thing to
rest on undocumented behaviour: if it quietly did nothing, every consumer would
lose it at once and nobody would learn that until the race happened. In the
caller it is supported, it is visible in review, and forgetting it costs one
repository instead of all of them.

### Releasing once a day instead of once a merge

By default every merge to the default branch ends up releasing: the push run
opens or updates the release pull request and turns auto-merge on, so it merges
as soon as its checks pass, and the next merge opens another one. To batch a day
of merges into one release, keep the push trigger — it is what keeps the release
pull request's changelog and version current, and what makes pending work
visible all day — and turn auto-merge on only from a scheduled run:

```yaml
on:
  push:
    branches:
      - main
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:

jobs:
  release-please:
    name: Propose releases
    uses: kanso-labs/actions/.github/workflows/_release-please.yaml@v4.0.0
    with:
      auto-merge: ${{ github.event_name == 'schedule' }}
    secrets:
      client-id: ${{ secrets.RELEASE_PLEASE_CLIENT_ID }}
      private-key: ${{ secrets.RELEASE_PLEASE_PRIVATE_KEY }}
```

Evaluate `github.event_name` in the caller rather than asking this workflow to
infer it. The caller is where the event is unambiguous, and it leaves
`auto-merge` a mechanical input that does what its name says instead of a
release policy the shared workflow imposes on every consumer at once.

`workflow_dispatch` proposes without merging under that expression, which is
usually what you want: it is the lever for re-proposing a stuck release pull
request, not a release-now button. To release before the next scheduled run,
enable auto-merge on the pull request by hand.

Two things about scheduled workflows are worth knowing before relying on one.
GitHub queues them hardest on the hour and may start one several minutes late,
which for a daily release costs nothing. And it disables a schedule outright
after 60 days without repository activity — a silent stop to releasing is the
shape that failure takes.

This needs v3.2.0 or later. Before it, auto-merge read the `prs` output above,
and a scheduled run that re-confirmed an unchanged release pull request merged
nothing.

### `dry-run`

Runs release-please without opening a pull request or cutting a release. It
exists so this workflow can be tested on a pull request, and
`Dry run release-please` in `test.yaml` is its only caller. A repository
releasing for real has no reason to set it.

### Outputs

`release_created`, `releases_created`, `paths_released`, `prs`, `tag_name` and
`version`, passed straight through from the action. `prs` is empty on any run
that wrote no release pull request, a run that found one already correct
included — read the auto-merge note above before building on it. A caller that
publishes on release reads `release_created`:

```yaml
publish:
  needs: release-please
  if: needs.release-please.outputs.release_created == 'true'
```

## `_renovate-command.yaml`

Renovate has no comment commands. Asking it to redo a pull request means ticking
a checkbox in the body and then waiting for its next scheduled run, which in
this organization is up to three hours away. This workflow closes both halves of
that gap, so `@renovate rebase` behaves the way `@dependabot rebase` does.

```yaml
on:
  issue_comment:
    types:
      - created

concurrency:
  cancel-in-progress: false
  group: renovate-command-${{ github.event.issue.number }}

permissions: {}

jobs:
  renovate-command:
    name: Run the command
    uses: kanso-labs/actions/.github/workflows/_renovate-command.yaml@v4.0.0
    secrets:
      client-id: ${{ secrets.RENOVATE_CLIENT_ID }}
      private-key: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}
```

| Comment                                                     | Effect                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `@renovate rebase`, `@renovate retry`, `@renovate recreate` | Ticks the pull request's rebase checkbox, then dispatches the runner |
| `@renovate run`                                             | Dispatches the runner without touching the pull request              |

The three pull request commands are one command under three names, because which
name is right depends on what Renovate decides to do with the branch, and nobody
asking for it knows that yet. Renovate's own checkbox says "rebase/retry", and
it recreates the branch when the rebase is not enough.

The bot reacts as it goes: 👀 accepted, 🚀 dispatched, 😕 refused. A refusal is
never a failed run, so somebody's typo does not put a red X on the pull request.

### It ticks the box rather than replacing it

There is no API for "rebase this Renovate branch", and the workflow does not try
to rebase anything itself. It edits the pull request body, turning
`- [ ] <!-- rebase-check -->` into `- [x] <!-- rebase-check -->` — byte for byte
what GitHub records when a person clicks that checkbox — and then dispatches the
runner so Renovate reads it now instead of in three hours.

Everything that decides what "rebase" means stays inside Renovate. That is the
point: the workflow adds a way to ask, not a second implementation of the
answer.

It follows that the commands only work on pull requests Renovate opened. On
anything else the marker is absent and the run fails loudly, which is the honest
outcome — the alternative is a 👍 on a request nothing will ever act on.

### Both secrets are required

Unlike `_release-please.yaml`, there is no `GITHUB_TOKEN` fallback, because
`GITHUB_TOKEN` cannot dispatch a workflow in another repository under any
permissions. The app must be installed on the calling repository and on the
runner, and needs `actions: write` there — the permission nothing else in this
organization uses.

The caller grants no permissions at all. Every write goes through the app token,
so this workflow can and does declare `permissions: {}`, which is the opposite
of `_release-please.yaml` above and for a reason worth keeping straight: a
called workflow may always request _less_ than its caller granted. It is
requesting more that fails the run.

### Adopting it takes two merges, not one

`issue_comment` is a repository-level event. GitHub runs the copy of the
workflow that is on the default branch and ignores every other copy, so a caller
sitting on a branch does nothing no matter how many comments it gets — and
neither does a change to one.

A repository adopting this therefore merges the caller first and finds out
whether it works second. Point the `uses:` ref at a branch of this repository
for that first merge if the workflow itself is what is being tried out, then
move it to a tag.

### Who may run a command

The comment author must have `write` or `admin` on the repository the comment is
in. The check asks GitHub for the permission level rather than reading
`author_association`, which is free but reports `NONE` for a member whose
organization membership is private — silently ignoring the person most likely to
be using this.

The mention must also open a line. GitHub prefixes a quoted reply with `> `, so
quoting a command repeats it without running it.

## Releasing this repository

release-please owns `version.txt` and `.release-please-manifest.json`. Nobody
edits either by hand.

The type of the pull request title decides what happens, and because pull
requests are squash-merged, that title is the only commit that reaches `main`:

| Title type    | Effect        |
| ------------- | ------------- |
| `feat`        | Minor release |
| `fix`         | Patch release |
| `deps`        | Patch release |
| `ci`          | Patch release |
| anything else | No release    |

`deps` is not a Conventional Commits type. It exists because Renovate's default
type is `chore(deps)`, and `chore` is hidden in release-please's defaults —
release-please decides there are no user-facing commits and opens no release
pull request at all. So a run of nothing but dependency upgrades released
nothing, and an upgrade shipped only when a feature happened to land beside it.

Consumers pin exact tags, so an upgrade that cuts no release is one nobody can
pin. `.github/renovate.json` therefore sets `semanticCommitType: deps`, and
`release-please-config.json` gives that type a visible **Dependencies** section.
The section list there replaces release-please's defaults wholesale rather than
extending them, so dropping `feat` or `fix` from it would silently stop those
releases too.

`ci` is a Conventional Commits type, and it is visible here for the same reason
`deps` is. The workflows and composite actions in this repository are the thing
consumers pin, so a `ci:` commit is usually a change to the product rather than
to the scaffolding around it — and hidden, it shipped only when something else
happened to release beside it.

The type is coarser than the distinction it is standing in for. This
repository's own `lint.yaml`, `test.yaml` and `release-please.yaml` are consumed
by nobody, so a `ci:` change to one of them now cuts a release that says nothing
to any consumer. release-please keys on the commit type and not the path, so
that is the cost of the type being visible at all. Reach for `chore:` when a
change genuinely touches only this repository's own scaffolding.

A plain `chore:` still publishes nothing, which is the point: housekeeping
should not cut a release.

A release that changes how a consumer must call something is a breaking change,
and it needs `!` so the major moves. Consumers pin exact versions, so nothing
breaks the moment it is released — but a Renovate bump landing on a repository
that never read the changelog is the same failure a day later.

This repository's own `release-please.yaml` references `./` rather than pinning
a tag, which is the one place the advice above is inverted. A pin makes the
repository a consumer of itself: Renovate bumps it, the bump cuts a patch
release as any `deps` change does, the release moves the tag, and the next
Renovate run bumps it again — forever. Consumers have no such cycle, because a
release of this repository does not move any tag they pin.
