# `upstream-changelog`

Rewrites a Renovate pull request body so that the release notes of the
dependency it updates reach the changelog release-please writes at merge time.

Without it, a bump of the application a container runs says only this in the
changelog users read:

```markdown
### Bug Fixes

- update dependency nzbgetcom/nzbget to v26.3 (#214)
```

With it, the same release says what actually changed:

```markdown
### Bug Fixes

- update dependency nzbgetcom/nzbget to v26.3 (#214)

### Upstream changes

- **v26.3:**
  [Added support for extension i18n](https://github.com/nzbgetcom/nzbget/pull/872)
- **v26.3:**
  [Fixed RSS episode duplicate keys](https://github.com/nzbgetcom/nzbget/pull/868)
```

## Using it

```yaml
name: Upstream Changelog

on:
  pull_request:
    branches:
      - main
    types:
      - edited
      - opened
      - synchronize

permissions:
  contents: read
  pull-requests: write

jobs:
  upstream-changelog:
    name: Carry the upstream release notes
    runs-on: ubuntu-latest
    steps:
      - name: Carry the upstream release notes
        uses: kanso-labs/actions/upstream-changelog@v4.0.0
```

The consuming repository also has to give `commit-type` a section of its own in
`release-please-config.json`, or the lines are parsed and then hidden:

```json
{ "section": "Upstream changes", "type": "upstream" }
```

### Inputs

| Input          | Default                                   | Notes                                                                      |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| `commit-type`  | `upstream`                                | Conventional type given to each upstream change. Needs a changelog section |
| `pull-request` | `${{ github.event.pull_request.number }}` | Only resolves on a `pull_request` event                                    |
| `title-type`   | `fix`                                     | Only rewrites pull requests whose title carries this type                  |
| `token`        | `${{ github.token }}`                     | Needs `pull-requests: write`                                               |

## How it works

release-please reads the body of the merged pull request, not just the commit
message. Two undocumented markers in its parser make this possible, both in
[`src/commit.ts`](https://github.com/googleapis/release-please/blob/main/src/commit.ts):

- `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` in a merged pull request's
  **body** replaces the commit message release-please parses.
- `BEGIN_NESTED_COMMIT` … `END_NESTED_COMMIT` inside that message is parsed as a
  commit of its own, inheriting the original's SHA, pull request and files — so
  each one becomes a changelog line, attributed to the same application.

The body is where this has to go, and not the commit message. Every repository
here squash-merges with `squash_merge_commit_message: BLANK`, so the branch's
commit bodies are discarded and only the pull request title survives onto
`main`. Renovate's own `fetchChangeLogs: branch` and `commitBody` would write a
commit body that nothing ever reads.

The override repeats the pull request title as its first line, because it
_replaces_ the message rather than adding to it. An override that omitted the
title would drop the bump's own changelog entry, and with it the release.

### Why the lines look the way they do

A nested commit contributes its **subject** to the changelog and nothing else,
so each upstream change has to survive as one line. That decides most of this:

- **Each line is scoped with the version it shipped in.** release-please sorts a
  section by scope and then by subject, so the scope both groups a bump that
  crosses several upstream releases and labels each line in the output.
- **Issue references are removed.** conventional-changelog-writer rewrites
  anything shaped like `#872` into a link to the _consuming_ repository, so an
  upstream reference would point at whatever issue 872 happens to be there. The
  line links to the pull request it cited instead.
- **The whole line becomes that link.** A mention or a reference left inside
  markdown link text nests a second link in the first and renders as neither, so
  mentions lose their `@` and keep the credit.
- **Renovate's `redirect.github.com` and its zero-width entities are undone.**
  Both exist to keep a pull request body from cross-referencing upstream, which
  a changelog has no reason to inherit — and left in, the entity renders as a
  broken link after release-please escapes it.
- **Contributor sections, `Full Changelog` lines and list headings are
  dropped.** None of them is a change.

### Two things stop it fighting Renovate

**The override goes after a `<!-- Reviewable:start -->` marker.** Renovate
hashes a pull request body before deciding whether to rewrite it, and `hashBody`
truncates at that marker — so everything after it is invisible to that
comparison and Renovate leaves the pull request alone. Without it, the next
Renovate run would see a body it did not write, replace it wholesale, and drop
the override.

**A second run replaces what the first one wrote.** The block is found by its
own marker and removed before anything is measured, so a rerun produces the same
body rather than a second copy, and the `edited` trigger cannot loop.

## Verifying a change to it

`npm test` runs the unit tests, which cover the parsing and the rewriting
against a body in Renovate's own layout. What they do not cover is
release-please agreeing: that the block parses, that the lines land under the
right application, and that the bump stays a patch.

To check that, install the release-please version the release workflow pins and
feed it a real body:

```bash
npm install release-please@17.6.0
gh pr view 214 --repo kanso-labs/home-assistant-applications --json body,title
```

Then call `parseConventionalCommits` on a commit whose `pullRequest.body` is the
rewritten body, and `DefaultChangelogNotes.buildNotes` on what comes back.
