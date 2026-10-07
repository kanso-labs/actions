import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

// The release merge in _release-please.yaml decides what happens to a day's
// release from a race nobody can start on demand: gh reading a merge state
// GitHub has not finished computing. These cases run the step's own script
// against a stand-in gh, so the retry is exercised on every pull request
// rather than only on the morning the race is lost.
//
// The script is cut out of the workflow by its step name rather than copied
// here, so what runs is what ships.
const workflow = fs.readFileSync(
  new URL('../.github/workflows/_release-please.yaml', import.meta.url),
  'utf8',
)

const stepScript = (name) => {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  assert.notEqual(start, -1, `no step named ${name}`)
  const run = lines.findIndex(
    (line, i) => i > start && /^\s+run: \|$/.test(line),
  )
  const indent = lines[run + 1].search(/\S/)
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

const script = stepScript('Enable auto-merge on the open release pull requests')

// A gh that answers from a scenario and records every call. pr merge and
// pr view each walk their own list of answers, one per call, and repeat the
// last one once the list runs out.
const fakeGh = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls"
next() {
  local list="$1" counter="$FAKE_DIR/$2"
  local n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$counter"
  local answers=($list)
  local i=$(( n <= \${#answers[@]} ? n - 1 : \${#answers[@]} - 1 ))
  echo "\${answers[$i]}"
}
case "$1 $2" in
  'pr list')
    if [[ "$*" == *headRefOid* ]]; then printf '%s' "$FAKE_PRS"; else printf '%s' "$FAKE_PRS" | cut -d' ' -f1; fi
    ;;
  'pr merge')
    if [[ "$(next "$FAKE_MERGES" merges)" == ok ]]; then exit 0; fi
    echo 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)' >&2
    exit 1
    ;;
  'pr view')
    state="$(next "$FAKE_STATES" views)"
    if [[ "$state" == fail ]]; then echo 'HTTP 502' >&2; exit 1; fi
    echo "$state"
    ;;
esac
`

const runStep = ({ merges, prs = '7 3c1f2a9', states = 'CLEAN' }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-'))
  try {
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 })
    // The step sleeps between reads; the cases do not need to.
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })

    // bash -e, as GitHub runs a step whose shell is left unset.
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DIR: directory,
        FAKE_MERGES: merges,
        FAKE_PRS: prs,
        FAKE_STATES: states,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    })
    const calls = fs.existsSync(path.join(directory, 'calls'))
      ? fs
          .readFileSync(path.join(directory, 'calls'), 'utf8')
          .trim()
          .split('\n')
      : []
    return {
      calls,
      output: result.stdout + result.stderr,
      status: result.status,
    }
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

const mergeCalls = (calls) =>
  calls.filter((call) => call.startsWith('pr merge'))
const viewCalls = (calls) => calls.filter((call) => call.startsWith('pr view'))

describe('the release merge', () => {
  it('merges at the second attempt once the state it read stale settles', () => {
    const { calls, output, status } = runStep({
      merges: 'refused ok',
      states: 'UNKNOWN CLEAN',
    })

    assert.equal(status, 0)
    assert.match(output, /#7 read 1: mergeStateStatus UNKNOWN/)
    assert.match(output, /#7 read 2: mergeStateStatus CLEAN/)
    assert.match(output, /Auto-merge enabled on #7 at the second attempt\./)
    assert.doesNotMatch(output, /::warning::/)
    assert.equal(mergeCalls(calls).length, 2)
  })

  it('pins both attempts to the head read after release-please ran', () => {
    const { calls } = runStep({ merges: 'refused ok', states: 'CLEAN' })

    assert.deepEqual(mergeCalls(calls), [
      'pr merge --auto --squash --match-head-commit 3c1f2a9 7',
      'pr merge --auto --squash --match-head-commit 3c1f2a9 7',
    ])
  })

  it('reads nothing more when the first attempt succeeds', () => {
    const { calls, output, status } = runStep({ merges: 'ok' })

    assert.equal(status, 0)
    assert.match(output, /Auto-merge enabled on #7\./)
    assert.equal(mergeCalls(calls).length, 1)
    assert.deepEqual(viewCalls(calls), [])
  })

  it('warns and passes when the second attempt is refused too', () => {
    const { output, status } = runStep({ merges: 'refused', states: 'CLEAN' })

    assert.equal(status, 0)
    assert.match(
      output,
      /::warning::Could not enable auto-merge on #7\. Merge it by hand\./,
    )
  })

  it('stops reading after ten reads of a state that never settles', () => {
    const { calls, output } = runStep({
      merges: 'refused ok',
      states: 'UNKNOWN',
    })

    assert.equal(viewCalls(calls).length, 10)
    assert.match(output, /#7 read 10: mergeStateStatus UNKNOWN/)
    assert.equal(mergeCalls(calls).length, 2)
  })

  it('logs a read that fails rather than ending the step', () => {
    const { output, status } = runStep({ merges: 'refused ok', states: 'fail' })

    assert.equal(status, 0)
    assert.match(output, /#7 read 1: mergeStateStatus unreadable/)
    assert.match(output, /Auto-merge enabled on #7 at the second attempt\./)
  })

  it('handles each open release pull request on its own', () => {
    const { calls, output } = runStep({
      merges: 'ok refused ok',
      prs: '7 3c1f2a9\n8 9e0d4b1',
      states: 'CLEAN',
    })

    assert.match(output, /Auto-merge enabled on #7\./)
    assert.match(output, /Auto-merge enabled on #8 at the second attempt\./)
    assert.deepEqual(mergeCalls(calls).slice(1), [
      'pr merge --auto --squash --match-head-commit 9e0d4b1 8',
      'pr merge --auto --squash --match-head-commit 9e0d4b1 8',
    ])
  })

  it('says so when there is nothing to merge', () => {
    const { calls, output, status } = runStep({ merges: 'ok', prs: '' })

    assert.equal(status, 0)
    assert.match(
      output,
      /No open release pull request to enable auto-merge on\./,
    )
    assert.deepEqual(mergeCalls(calls), [])
  })
})
