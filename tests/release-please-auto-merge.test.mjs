import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

// The release merge in _release-please.yaml decides from things no pull request
// here can arrange: a commit landing on the branch while a release pull request
// waits, a check still running, GitHub refusing a merge it is still settling.
// These cases run the step's own script against a stand-in gh instead, so every
// branch of it runs on every pull request.
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

const script = stepScript('Merge the open release pull requests')

// A gh that answers from a scenario and records every call. Each kind of call
// walks its own list of canned JSON, one per call, repeating the last; a
// --jq filter is applied with the real jq, so the step's own filters are what
// shape the answers. "fail" or "refused" in a list makes that call fail.
const fakeGh = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls"
args=("$@")
filter=''
for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[$i]}" == --jq ]] && filter="\${args[$((i + 1))]}"
done
answer() {
  local key="$1" counter="$FAKE_DIR/$1.count"
  local n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$counter"
  local json
  json="$(jq -c --argjson n "$n" '(if $n <= length then .[$n - 1] else .[-1] end)' "$FAKE_DIR/$key.json")"
  if [[ "$json" == '"fail"' ]]; then echo "gh: canned failure for $key (HTTP 502)" >&2; exit 1; fi
  if [[ "$json" == '"refused"' ]]; then echo 'gh: Pull Request is not mergeable (HTTP 405)' >&2; exit 1; fi
  if [[ -n "$filter" ]]; then jq -r "$filter" <<< "$json"; else echo "$json"; fi
}
case "$*" in
  'pr list'*) printf '%s' "$FAKE_PRS" ;;
  'api repos/'*'/contents/release-please-config.json'*) answer config ;;
  'pr view'*) answer rollup ;;
  'api repos/'*'/commits/'*) answer commit ;;
  'api repos/'*'/compare/'*) answer compare ;;
  'api -X PUT repos/'*'/merge'*) answer merge ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`

const base64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64')

// This repository's own layout: Renovate's deps visible, and ci visible too.
const config = {
  'changelog-sections': [
    { section: 'Features', type: 'feat' },
    { section: 'Bug Fixes', type: 'fix' },
    { section: 'Dependencies', type: 'deps' },
    { section: 'Continuous Integration', type: 'ci' },
    { hidden: true, section: 'Documentation', type: 'docs' },
    { hidden: true, section: 'Miscellaneous Chores', type: 'chore' },
  ],
  packages: { '.': { 'release-type': 'node' } },
}

const compareOf = (...messages) => ({
  commits: messages.map((message, i) => ({
    commit: { message },
    sha: `${String(i + 1).repeat(7)}${'0'.repeat(33)}`,
  })),
  total_commits: messages.length,
})

const merged = { merged: true, message: 'Pull Request successfully merged' }
const finished = [{ conclusion: 'SUCCESS', name: 'Test', status: 'COMPLETED' }]

const runStep = ({
  compare = [compareOf()],
  configs = [{ content: base64(config) }],
  merges = [merged],
  prs = '7 3c1f2a9 main',
  rollups = [{ statusCheckRollup: finished }],
} = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-merge-'))
  try {
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 })
    // The step sleeps between reads; the cases do not need to.
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })
    const canned = {
      commit: [{ parents: [{ sha: 'b4e7d01' }] }],
      compare,
      config: configs,
      merge: merges,
      rollup: rollups,
    }
    for (const [key, list] of Object.entries(canned))
      fs.writeFileSync(
        path.join(directory, `${key}.json`),
        JSON.stringify(list),
      )

    // bash -e, as GitHub runs a step whose shell is left unset.
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DIR: directory,
        FAKE_PRS: prs,
        GH_REPO: 'kanso-labs/example',
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
  calls.filter((call) => call.startsWith('api -X PUT'))
const viewCalls = (calls) => calls.filter((call) => call.startsWith('pr view'))
const mergesAfter = (...messages) =>
  mergeCalls(runStep({ compare: [compareOf(...messages)] }).calls).length

describe('the release merge', () => {
  it('merges, pinned to the head it read, when only hidden types landed', () => {
    const { calls, output, status } = runStep({
      compare: [compareOf('docs: a note', 'chore: tidy')],
    })

    assert.equal(status, 0)
    assert.match(output, /#7: Pull Request successfully merged/)
    assert.deepEqual(mergeCalls(calls), [
      'api -X PUT repos/kanso-labs/example/pulls/7/merge -f merge_method=squash -f sha=3c1f2a9 --jq .message',
    ])
  })

  it('compares from the commit the pull request was computed from', () => {
    const { calls } = runStep()

    assert.ok(
      calls.includes(
        'api repos/kanso-labs/example/commits/3c1f2a9 --jq .parents[0].sha',
      ),
    )
    assert.ok(
      calls.includes('api repos/kanso-labs/example/compare/b4e7d01...main'),
    )
  })

  it('leaves the merge when a commit its changelog would list landed', () => {
    const { calls, output, status } = runStep({
      compare: [compareOf('docs: a note', 'fix: something users see')],
    })

    assert.equal(status, 0)
    assert.match(output, /::notice::Not merging #7\./)
    assert.match(output, /2222222 fix: something users see/)
    assert.doesNotMatch(output, /docs: a note/)
    assert.deepEqual(mergeCalls(calls), [])
  })

  it('reads the visible types from the config, not a fixed list', () => {
    assert.equal(mergesAfter('ci: a workflow'), 0)
    assert.equal(mergesAfter('deps: an upgrade'), 0)
  })

  it("uses release-please's defaults when the config names no sections", () => {
    const configs = [{ content: base64({ packages: { '.': {} } }) }]
    const after = (message) =>
      mergeCalls(runStep({ compare: [compareOf(message)], configs }).calls)
        .length

    assert.equal(after('fix: x'), 0)
    assert.equal(after('deps: x'), 1)
    assert.equal(after('ci: x'), 1)
  })

  it('also uses the defaults when the config cannot be read', () => {
    const { calls } = runStep({
      compare: [compareOf('perf: x')],
      configs: ['fail'],
    })

    assert.deepEqual(mergeCalls(calls), [])
  })

  it('reads sections a package declares for itself', () => {
    const configs = [
      {
        content: base64({
          packages: {
            '.': { 'changelog-sections': [{ section: 'Tests', type: 'test' }] },
          },
        }),
      },
    ]
    const { calls } = runStep({ compare: [compareOf('test: x')], configs })

    assert.deepEqual(mergeCalls(calls), [])
  })

  it('leaves the merge for a breaking change of a hidden type', () => {
    assert.equal(mergesAfter('chore!: drop a default'), 0)
    assert.equal(
      mergesAfter('chore: tidy\n\nBREAKING CHANGE: drops a default'),
      0,
    )
  })

  it('merges past a breaking change of a type the changelog does not know', () => {
    assert.equal(mergesAfter('wip!: an experiment'), 1)
  })

  it('reads a nested header in a squashed body as a commit of its own', () => {
    const { calls, output } = runStep({
      compare: [compareOf('docs: a note\n\nfix: something squashed in')],
    })

    assert.deepEqual(mergeCalls(calls), [])
    assert.match(output, /1111111 fix: something squashed in/)
  })

  it('leaves the merge when more landed than GitHub returned', () => {
    const truncated = { ...compareOf('docs: a note'), total_commits: 300 }
    const { calls, output } = runStep({ compare: [truncated] })

    assert.deepEqual(mergeCalls(calls), [])
    assert.match(output, /300 commits landed, more than could be read/)
  })

  it('waits for the checks to finish before reading what landed', () => {
    const running = [{ conclusion: null, name: 'Test', status: 'IN_PROGRESS' }]
    const { calls } = runStep({
      rollups: [
        { statusCheckRollup: [] },
        { statusCheckRollup: running },
        { statusCheckRollup: finished },
      ],
    })

    assert.equal(viewCalls(calls).length, 3)
    assert.equal(mergeCalls(calls).length, 1)
  })

  it('waits on a pending commit status too', () => {
    const { calls } = runStep({
      rollups: [
        { statusCheckRollup: [{ context: 'legacy', state: 'PENDING' }] },
        { statusCheckRollup: [{ context: 'legacy', state: 'SUCCESS' }] },
      ],
    })

    assert.equal(viewCalls(calls).length, 2)
  })

  it('stops waiting after a minute with no checks at all', () => {
    const { calls } = runStep({ rollups: [{ statusCheckRollup: [] }] })

    assert.equal(viewCalls(calls).length, 4)
    assert.equal(mergeCalls(calls).length, 1)
  })

  it('leaves a failed check for the merge to refuse', () => {
    const failed = [
      { conclusion: 'FAILURE', name: 'Test', status: 'COMPLETED' },
    ]
    const { calls, output } = runStep({
      merges: ['refused'],
      rollups: [{ statusCheckRollup: failed }],
    })

    assert.equal(viewCalls(calls).length, 1)
    assert.equal(mergeCalls(calls).length, 3)
    assert.match(output, /::warning::Could not merge #7\. Merge it by hand\./)
  })

  it('retries a refused merge, and logs each refusal', () => {
    const { calls, output } = runStep({ merges: ['refused', merged] })

    assert.equal(mergeCalls(calls).length, 2)
    assert.match(
      output,
      /#7 merge attempt 1: gh: Pull Request is not mergeable \(HTTP 405\)/,
    )
    assert.match(output, /#7: Pull Request successfully merged/)
    assert.doesNotMatch(output, /::warning::/)
  })

  it('warns rather than merging when it cannot tell what landed', () => {
    const { calls, output, status } = runStep({ compare: ['fail'] })

    assert.equal(status, 0)
    assert.deepEqual(mergeCalls(calls), [])
    assert.match(
      output,
      /::warning::Could not list what landed on main since #7 was computed\./,
    )
  })

  it('handles each open release pull request on its own', () => {
    const { calls } = runStep({
      compare: [compareOf('fix: x'), compareOf('docs: y')],
      prs: '7 3c1f2a9 main\n8 9e0d4b1 main',
    })

    assert.deepEqual(mergeCalls(calls), [
      'api -X PUT repos/kanso-labs/example/pulls/8/merge -f merge_method=squash -f sha=9e0d4b1 --jq .message',
    ])
  })

  it('says so when there is nothing to merge', () => {
    const { calls, output, status } = runStep({ prs: '' })

    assert.equal(status, 0)
    assert.match(output, /No open release pull request to merge\./)
    assert.deepEqual(mergeCalls(calls), [])
  })
})
