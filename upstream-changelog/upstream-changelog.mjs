// Turns the release notes Renovate already put in a pull request body into
// nested conventional commits release-please will read at merge time.
//
// Reads the pull request body on stdin and writes the new body on stdout, or
// writes nothing at all when there is nothing to change. Everything here is
// pure text: the caller does the reading and the writing, so this file can be
// exercised against a saved body without touching GitHub.
//
// The shape it produces, appended to the body Renovate wrote:
//
//   BEGIN_COMMIT_OVERRIDE
//   fix: update dependency Sonarr/Sonarr to v4.0.20 (#123)
//
//   BEGIN_NESTED_COMMIT
//   upstream(v4.0.20): [Fixed: Basic auth for qBittorrent](https://…/pull/8747)
//   END_NESTED_COMMIT
//   END_COMMIT_OVERRIDE
//
// release-please replaces the whole commit message with what sits between
// BEGIN_COMMIT_OVERRIDE and END_COMMIT_OVERRIDE, then parses each nested block
// as a commit of its own. That is why the first line repeats the pull request
// title: the override replaces the message rather than adding to it, so a
// block that omitted the title would drop the bump's own changelog entry and
// the release with it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// GitHub refuses a longer body. Renovate truncates its own to 58000, which is
// where the headroom to append into comes from — but a body that arrived from
// somewhere else, or a Renovate that raises its limit, must not push the
// result past what the API accepts.
export const MAX_BODY_LENGTH = 65536

// Kept clear of the cap so that a rounding error somewhere else in the chain
// costs a truncated changelog rather than a failed edit.
const BODY_SAFETY_MARGIN = 512

// Below this there is no room for a useful list, and a block holding one line
// and an apology is worse than leaving the body alone.
const MIN_OVERRIDE_LENGTH = 400

// An upstream line longer than this is a paragraph rather than a change, and
// it crowds out the lines after it.
const MAX_LINE_LENGTH = 200

// Ours, so that a second run can find what the first one wrote and replace it
// rather than appending a second copy.
const MARKER = '<!-- upstream-changelog -->'

// Renovate's `hashBody` truncates at this marker before comparing the body it
// would write against the one that is there, so anything after it is invisible
// to that comparison and Renovate leaves the pull request alone. Reviewable
// put the marker there first and Renovate honours it for Reviewable's sake;
// borrowing it is the only seam Renovate offers for "ignore the rest".
//
// Without it every Renovate run that recomputed this body — a dashboard edit,
// a table change, anything — would see a difference it did not write, rewrite
// the body wholesale, and drop the override on the floor. The caller's
// `edited` trigger would put it back, but between the two lies a window in
// which an automerge lands a commit with no override at all.
const RENOVATE_BODY_IGNORE_MARKER = '<!-- Reviewable:start -->'

// Renovate writes this into every pull request it opens, beside the rebase
// checkbox. It is the one part of the body that says "Renovate wrote this"
// rather than describing the update, which makes it the gate: a hand-written
// pull request that happens to carry a Release Notes heading is not one of
// these. `_renovate-command.yaml` reads the same marker for the same reason.
const RENOVATE_MARKER = '<!-- rebase-check -->'

// Renovate rewrites github.com links through this host so that opening one
// from a pull request does not register a cross-reference on the upstream
// issue. A changelog is not a pull request and has no such side effect, and
// the redirector is an implementation detail of Renovate's that should not
// outlive it in a file users read.
const REDIRECT_HOST = 'redirect.github.com'

// A zero-width space Renovate puts inside every issue reference, for the same
// cross-reference reason. Left in, release-please's HTML escaping turns
// `#&#8203;872` into `#&[#8203](…/issues/8203);872` — a broken link to an
// issue in the wrong repository.
const ZERO_WIDTH_ENTITY = /&#8203;/g

// Renovate escapes markdown so that a release body cannot break the layout of
// the pull request it is quoted in. A changelog quotes it again rather than
// rendering it, so the escapes would ship as backslashes: `GIT\_SSL\_CAINFO`.
const MARKDOWN_ESCAPE = /\\([_*[\]`~#])/g

// release-please hands every nested subject to conventional-changelog-writer,
// which rewrites anything shaped like an issue reference into a link to *this*
// repository. An upstream `#872` therefore points at whatever #872 happens to
// be here. There is no way to opt a subject out, so the references have to go
// — the link built from the URL beside them says the same thing correctly.
const ISSUE_REFERENCE = /(?:\(\s*#\d+\s*\)|#\d+)/g

// The abbreviated commit the line already links to, left over once the link
// around it is flattened.
const TRAILING_HASH = /[\s(]+\b[0-9a-f]{7,40}\b\)?\s*[).]?\s*$/

// The markers release-please splits on. An upstream project whose release
// notes mention them would otherwise close our block early and take the rest
// of the list with it.
const RELEASE_PLEASE_MARKERS = /(BEGIN|END)_(NESTED_COMMIT|COMMIT_OVERRIDE)/g

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g
const BARE_URL = /https?:\/\/\S+/g

// A bare URL runs to the next space, so it takes whatever punctuation closed
// the sentence around it. Left on, it defeats the profile check below and
// ships a link with a stray bracket in it.
const URL_TRAILING_PUNCTUATION = /[).,;:\]]+$/

// `* Fix the thing by @someone in https://github.com/o/r/pull/12`, which is
// how GitHub's generated notes attribute a change. The URL is worth keeping
// and the rest of the suffix is not. The name can carry Renovate's escaping,
// because a bot's login is `renovate[bot]`.
const GENERATED_ATTRIBUTION =
  /\s+by\s+@?[\w\-\\[\]]+\s+in\s+(https?:\/\/\S+)\s*$/

// A link to a person rather than to a change. Renovate turns every mention in
// a release body into one of these, and it is usually the last link on the
// line — so choosing the last link without this would point half the entries
// at whoever is being thanked.
const PROFILE_URL = /^https?:\/\/github\.com\/[\w-]+\/?$/

// What the line is actually about, best first. A change that cites both the
// pull request that made it and the commit that carried it should link the
// pull request, where the discussion is.
const URL_PREFERENCE = [
  /\/pull\//,
  /\/issues\//,
  /\/commit\//,
  /\/releases\//,
  /\/compare\//,
]

const VERSION_HEADING = /^#{1,4}\s+\[`?v?([^`\]]+?)`?\]\(([^)\s]+)\)/
const SUBSECTION_HEADING = /^#{1,6}\s+(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/

// Lines under one of these headings describe the upstream project's own
// contributors rather than what changed, and read as noise in a changelog
// about an application.
const IGNORED_SUBSECTION = /^(new contributors|contributors|credits)\b/i

/**
 * Slices the part of a Renovate body that holds release notes.
 *
 * Renovate lays them out as one `<details>` block per dependency, each holding
 * a `### [`v1.2.3`](url)` heading per version being crossed, and follows the
 * last one with its own `### Configuration` section. Bounding the search at
 * that section keeps a stray `---` inside somebody's release notes from
 * ending the scan early.
 */
export function sliceReleaseNotes(body) {
  const start = body.indexOf('### Release Notes')
  if (start === -1) {
    return ''
  }

  const end = body.indexOf('### Configuration', start)
  return end === -1 ? body.slice(start) : body.slice(start, end)
}

/**
 * Drops Renovate's redirector, which is a detail of how a pull request body
 * avoids cross-referencing upstream and has no business outliving it.
 */
export function normalizeHost(text) {
  return text.split(REDIRECT_HOST).join('github.com')
}

/**
 * Normalizes one URL. Only ever called on a URL — running it over a whole line
 * would eat the bracket closing the last markdown link on it.
 */
export function normalizeUrl(url) {
  return normalizeHost(url).replace(URL_TRAILING_PUNCTUATION, '')
}

/**
 * Picks the URL a line should link to, or null when it cites nothing.
 */
function chooseUrl(line) {
  const attributed = GENERATED_ATTRIBUTION.exec(line)
  if (attributed) {
    return normalizeUrl(attributed[1])
  }

  const candidates = [...line.matchAll(MARKDOWN_LINK)]
    .map((match) => normalizeUrl(match[2]))
    .concat((line.match(BARE_URL) ?? []).map(normalizeUrl))
    .filter((url) => !PROFILE_URL.test(url))

  for (const preference of URL_PREFERENCE) {
    const preferred = candidates.find((url) => preference.test(url))
    if (preferred) {
      return preferred
    }
  }

  return candidates.at(-1) ?? null
}

/**
 * Rewrites one list item into a single-line conventional commit subject, or
 * returns null when the line is not a change.
 */
export function cleanLine(text) {
  let line = normalizeHost(text.replace(ZERO_WIDTH_ENTITY, '')).replace(
    MARKDOWN_ESCAPE,
    '$1',
  )

  // Taken before the links are flattened, because flattening loses it.
  const url = chooseUrl(line)

  line = line.replace(GENERATED_ATTRIBUTION, '')
  line = line.replace(MARKDOWN_LINK, '$1')
  line = line.replace(BARE_URL, '')
  line = line.replace(ISSUE_REFERENCE, '')
  line = line.replace(RELEASE_PLEASE_MARKERS, '')

  // A mention inside markdown link text nests a second link in the first and
  // renders as neither, and the whole line becomes a link below whenever
  // there is a URL to point it at. Dropping the sigil keeps the credit.
  line = line.replace(/(^|[\s(])@([\w-]+)/g, '$1$2')

  line = line.replace(/\s+/g, ' ').trim()
  line = line.replace(TRAILING_HASH, '')

  // Whatever the removals above left behind: an empty code span where an
  // issue reference was quoted, a pair of parentheses around nothing, a
  // dangling connective from an attribution that lost its subject.
  line = line.replace(/``+/g, '').replace(/\(\s*[,;]?\s*\)/g, '')
  line = line.replace(/\(\s*[,;]\s*/g, '(')
  // Only where the punctuation ends a word. `added .clang-tidy` is a
  // filename rather than a space that wants closing up.
  line = line
    .replace(/\s+(?=[.,;:](?:\s|$)|\))/g, '')
    .replace(/\s+\b(?:by|in|and|thanks)\s*$/i, '')
  line = line
    .replace(/^[-–—:,\s]+/, '')
    .replace(/[\s,(]+$/, '')
    .trim()

  // A heading that a list happens to be written as — `Features:`, `Bug
  // fixes:` — carries no change of its own, and its children are already in
  // the list as items in their own right.
  if (line.length < 3 || line.endsWith(':')) {
    return null
  }

  if (line.length > MAX_LINE_LENGTH) {
    line = `${line.slice(0, MAX_LINE_LENGTH - 1).trimEnd()}…`
  }

  // Square brackets left in the text would close the link early.
  return url ? `[${line.replace(/[[\]]/g, '')}](${url})` : line
}

/**
 * Reads a Renovate body into `{ version, url, lines }`, newest version first.
 */
export function parseReleaseNotes(body) {
  const versions = []
  let current = null
  let subsection = null

  for (const raw of sliceReleaseNotes(body).split('\n')) {
    const heading = VERSION_HEADING.exec(raw)
    if (heading) {
      current = {
        version: `v${heading[1]}`,
        url: normalizeUrl(heading[2]),
        lines: [],
      }
      versions.push(current)
      subsection = null
      continue
    }

    if (!current) {
      continue
    }

    const subheading = SUBSECTION_HEADING.exec(raw)
    if (subheading) {
      subsection = subheading[1]
      continue
    }

    // A quoted callout is commentary about the release rather than a change
    // in it, and an HTML block is a badge or an image that cannot survive
    // being flattened to one line.
    if (/^\s*[>|<]/.test(raw)) {
      continue
    }

    const item = LIST_ITEM.exec(raw)
    if (!item || (subsection && IGNORED_SUBSECTION.test(subsection))) {
      continue
    }

    // Renovate's own controls are list items too — the rebase checkbox most
    // of all. They are normally past the Configuration heading this stops at,
    // but a body truncated before that heading puts them in reach.
    if (
      /^\s*\*\*Full Changelog\*\*|^\s*\[Compare Source\]|<!--/.test(item[1])
    ) {
      continue
    }

    const line = cleanLine(item[1])
    if (line) {
      current.lines.push(line)
    }
  }

  return versions
}

/**
 * Builds the override block, trimmed to `budget` characters.
 *
 * Every nested subject is scoped with the version it came from. release-please
 * sorts a section by scope and then by subject, so the scope is what keeps a
 * bump crossing five upstream releases grouped by release rather than
 * interleaved alphabetically — and it labels each line in the rendered
 * changelog, which is the other half of what makes it readable.
 */
export function buildOverride({ budget, commitType, number, title, versions }) {
  const seen = new Set()
  const entries = []
  for (const { version, lines } of versions) {
    for (const line of lines) {
      if (!seen.has(line)) {
        seen.add(line)
        entries.push({ version, line })
      }
    }
  }

  if (entries.length === 0) {
    return null
  }

  const header = `${title} (#${number})`
  const nest = (scope, subject) =>
    `BEGIN_NESTED_COMMIT\n${commitType}(${scope}): ${subject}\nEND_NESTED_COMMIT`
  const wrap = (blocks) =>
    `BEGIN_COMMIT_OVERRIDE\n${header}\n\n${blocks.join('\n')}\nEND_COMMIT_OVERRIDE`

  let kept = entries
  let block = wrap(kept.map(({ version, line }) => nest(version, line)))
  if (block.length <= budget) {
    return block
  }

  // The pointer replaces what was dropped rather than sitting silently beside
  // it, so a truncated list says it is truncated and where the rest is.
  const newest = versions[0]
  while (kept.length > 0) {
    kept = kept.slice(0, -1)
    const pointer = nest(
      newest.version,
      `… ${entries.length - kept.length} further changes are in the upstream release notes: ${newest.url}`,
    )
    block = wrap([
      ...kept.map(({ version, line }) => nest(version, line)),
      pointer,
    ])
    if (block.length <= budget) {
      return block
    }
  }

  return null
}

/**
 * Returns the body with the override appended, or null when nothing changes.
 */
export function rewriteBody({ body, commitType, number, title, titleType }) {
  if (!body.includes(RENOVATE_MARKER)) {
    return { body: null, reason: 'not a Renovate pull request' }
  }

  if (
    !title.startsWith(`${titleType}:`) &&
    !title.startsWith(`${titleType}(`)
  ) {
    return { body: null, reason: `the title is not a ${titleType} commit` }
  }

  // Whatever a previous run appended goes before anything is measured, so the
  // budget is computed against the body Renovate actually wrote and a rerun
  // produces the same result as a first run.
  const marker = `${RENOVATE_BODY_IGNORE_MARKER}\n${MARKER}\n`
  const existing = body.indexOf(marker)
  const original = (existing === -1 ? body : body.slice(0, existing)).trimEnd()

  const budget =
    MAX_BODY_LENGTH - BODY_SAFETY_MARGIN - original.length - marker.length - 2
  if (budget < MIN_OVERRIDE_LENGTH) {
    return { body: null, reason: 'the body leaves no room for an override' }
  }

  const versions = parseReleaseNotes(original)
  const override = buildOverride({
    budget,
    commitType,
    number,
    title,
    versions,
  })
  if (!override) {
    return { body: null, reason: 'no upstream changes were found in the body' }
  }

  const rewritten = `${original}\n\n${marker}${override}`
  return rewritten === body
    ? { body: null, reason: 'the body already carries these upstream changes' }
    : { body: rewritten, reason: null }
}

// Only when run as a command, so that the tests can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { body, reason } = rewriteBody({
    body: readFileSync(0, 'utf8'),
    commitType: process.env.COMMIT_TYPE ?? 'upstream',
    number: process.env.PR_NUMBER ?? '0',
    title: process.env.PR_TITLE ?? '',
    titleType: process.env.TITLE_TYPE ?? 'fix',
  })

  if (body) {
    process.stdout.write(body)
  } else {
    process.stderr.write(`${reason}\n`)
  }
}
