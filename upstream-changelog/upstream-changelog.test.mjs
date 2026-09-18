import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildOverride,
  cleanLine,
  parseReleaseNotes,
  rewriteBody,
} from './upstream-changelog.mjs'

// Renovate's layout, trimmed to the parts this reads. The zero-width entities,
// the redirector host and the escaped underscores are all verbatim: they are
// what a real body carries, and each one of them broke something.
const body = [
  'This PR contains the following updates:',
  '',
  '### Release Notes',
  '',
  '<details>',
  '<summary>nzbgetcom/nzbget (nzbgetcom/nzbget)</summary>',
  '',
  '### [`v26.3`](https://redirect.github.com/nzbgetcom/nzbget/releases/tag/v26.3)',
  '',
  '[Compare Source](https://redirect.github.com/nzbgetcom/nzbget/compare/v26.2...v26.3)',
  '',
  "#### What's Changed",
  '',
  '> \\[!CAUTION]',
  '> **Version 26.3 drops legacy architectures**:',
  '',
  '- Features:',
  '  - Added support for extension i18n [#&#8203;872](https://redirect.github.com/nzbgetcom/nzbget/pull/872)',
  '  - Trust the CA from GIT\\_SSL\\_CAINFO [#&#8203;873](https://redirect.github.com/nzbgetcom/nzbget/pull/873)',
  '- Fixed a crash on startup by [@&#8203;someone](https://github.com/someone) in [#&#8203;845](https://redirect.github.com/nzbgetcom/nzbget/pull/845)',
  '',
  '#### New Contributors',
  '',
  '- [@&#8203;newcomer](https://github.com/newcomer) made their first contribution',
  '',
  '**Full Changelog**: https://redirect.github.com/nzbgetcom/nzbget/compare/v26.2...v26.3',
  '',
  '</details>',
  '',
  '---',
  '',
  '### Configuration',
  '',
  '📅 **Schedule**: At any time.',
  '',
  ' - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box',
  '',
].join('\n')

const rewrite = (overrides = {}) =>
  rewriteBody({
    body,
    commitType: 'upstream',
    number: '214',
    title: 'fix: update dependency nzbgetcom/nzbget to v26.3',
    titleType: 'fix',
    ...overrides,
  })

describe('parseReleaseNotes', () => {
  it('reads one entry per change, keyed by the version it shipped in', () => {
    assert.deepEqual(parseReleaseNotes(body), [
      {
        version: 'v26.3',
        url: 'https://github.com/nzbgetcom/nzbget/releases/tag/v26.3',
        lines: [
          '[Added support for extension i18n](https://github.com/nzbgetcom/nzbget/pull/872)',
          '[Trust the CA from GIT_SSL_CAINFO](https://github.com/nzbgetcom/nzbget/pull/873)',
          '[Fixed a crash on startup by someone](https://github.com/nzbgetcom/nzbget/pull/845)',
        ],
      },
    ])
  })

  it("ignores Renovate's own controls when they fall inside the slice", () => {
    const truncated = body.slice(0, body.indexOf('### Configuration'))
    const lines = parseReleaseNotes(
      `${truncated} - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n`,
    )[0].lines

    assert.ok(!lines.some((line) => line.includes('rebase')))
  })

  it('finds nothing in a body with no release notes', () => {
    assert.deepEqual(
      parseReleaseNotes('### Configuration\n\n- [ ] <!-- rebase-check -->'),
      [],
    )
  })
})

describe('cleanLine', () => {
  it('drops issue references, which would link to this repository', () => {
    assert.equal(cleanLine('Fixed the thing (#872)'), 'Fixed the thing')
  })

  it('links a change to what it cites rather than to whoever is thanked', () => {
    assert.equal(
      cleanLine(
        'Fixed the thing ([#872](https://github.com/o/r/pull/872)). Thanks [@someone](https://github.com/someone)',
      ),
      '[Fixed the thing. Thanks someone](https://github.com/o/r/pull/872)',
    )
  })

  it('prefers the pull request over the commit that carried it', () => {
    assert.equal(
      cleanLine(
        'Fixed it ([#8](https://github.com/o/r/issues/8)) ([abc1234](https://github.com/o/r/commit/abc1234))',
      ),
      '[Fixed it](https://github.com/o/r/issues/8)',
    )
  })

  it('leaves a line with nothing to link as plain text', () => {
    assert.equal(cleanLine('Bump Chromium'), 'Bump Chromium')
  })

  it('drops a list item that is only a heading for the items under it', () => {
    assert.equal(cleanLine('Features:'), null)
  })

  it('neutralizes the markers release-please splits on', () => {
    assert.equal(
      cleanLine(
        'Documented BEGIN_NESTED_COMMIT and END_COMMIT_OVERRIDE handling',
      ),
      'Documented and handling',
    )
  })
})

describe('rewriteBody', () => {
  it('appends an override carrying the title and one nested commit per change', () => {
    const { body: rewritten } = rewrite()

    assert.ok(rewritten.startsWith(body.trimEnd()))
    assert.match(
      rewritten,
      /BEGIN_COMMIT_OVERRIDE\nfix: update dependency nzbgetcom\/nzbget to v26\.3 \(#214\)\n/,
    )
    assert.equal(rewritten.match(/BEGIN_NESTED_COMMIT/g).length, 3)
    assert.match(
      rewritten,
      /upstream\(v26\.3\): \[Added support for extension i18n]\(https:\/\/github\.com\/nzbgetcom\/nzbget\/pull\/872\)/,
    )
  })

  it('hides the override from the comparison Renovate makes before rewriting a body', () => {
    const { body: rewritten } = rewrite()

    assert.ok(
      rewritten.indexOf('<!-- Reviewable:start -->') <
        rewritten.indexOf('BEGIN_COMMIT_OVERRIDE'),
    )
  })

  it('replaces what a previous run wrote rather than appending beside it', () => {
    const { body: once } = rewrite()
    const { body: twice, reason } = rewrite({ body: once })

    assert.equal(twice, null)
    assert.equal(reason, 'the body already carries these upstream changes')

    const { body: relabelled } = rewrite({ body: once, commitType: 'chore' })
    assert.equal(relabelled.match(/BEGIN_COMMIT_OVERRIDE/g).length, 1)
  })

  it('leaves a body that Renovate did not write alone', () => {
    const { body: rewritten, reason } = rewrite({
      body: body.replace('<!-- rebase-check -->', ''),
    })

    assert.equal(rewritten, null)
    assert.equal(reason, 'not a Renovate pull request')
  })

  it('leaves a pull request of another type alone', () => {
    const { body: rewritten, reason } = rewrite({
      title: 'deps: update dependency prettier to v3.9.6',
    })

    assert.equal(rewritten, null)
    assert.equal(reason, 'the title is not a fix commit')
  })

  it('accepts a scoped title of the right type', () => {
    assert.ok(
      rewrite({
        title: 'fix(deps): update dependency nzbgetcom/nzbget to v26.3',
      }).body,
    )
  })
})

describe('buildOverride', () => {
  const versions = [
    {
      version: 'v2.0.0',
      url: 'https://github.com/o/r/releases/tag/v2.0.0',
      lines: Array.from({ length: 40 }, (_, index) => `Change number ${index}`),
    },
  ]
  const build = (budget) =>
    buildOverride({
      budget,
      commitType: 'upstream',
      number: '1',
      title: 'fix: update r',
      versions,
    })

  it('says how many changes a budget dropped, and where to read them', () => {
    const trimmed = build(1200)

    assert.ok(trimmed.length <= 1200)
    assert.match(
      trimmed,
      /… \d+ further changes are in the upstream release notes: https:/,
    )
    assert.ok(trimmed.match(/BEGIN_NESTED_COMMIT/g).length < 40)
  })

  it('keeps every change when the budget allows it', () => {
    assert.equal(build(100_000).match(/BEGIN_NESTED_COMMIT/g).length, 40)
  })

  it('gives up rather than emitting a block that cannot fit', () => {
    assert.equal(build(10), null)
  })
})
