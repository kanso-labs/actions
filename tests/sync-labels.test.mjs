import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

// _sync-labels.yaml writes to whichever repository calls it, so a live run on a
// pull request here would rewrite this repository's labels on every push. These
// cases run the step's own script against a stand-in gh and curl instead, with
// the real yq and jq doing the parsing, so every branch of it runs on every pull
// request without touching a label.
//
// The script is cut out of the workflow by its step name rather than copied
// here, so what runs is what ships.
const workflow = fs.readFileSync(
  new URL('../.github/workflows/_sync-labels.yaml', import.meta.url),
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

const script = stepScript('Sync the labels')

// Records every call, one per line, and answers a label list from the
// scenario. Any other kind of call fails, so a write the script was not meant
// to make shows up as a failure rather than passing quietly.
const fakeGh = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/calls"
case "$1 $2" in
  'label list') cat "$FAKE_DIR/existing.json" ;;
  'label create' | 'label edit' | 'label delete') ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`

// Copies the scenario's labels.yaml to wherever --output points, or fails the
// way curl --fail does on a 404.
const fakeCurl = `#!/bin/bash
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[$i]}" == --output ]] && out="\${args[$((i + 1))]}"
done
if [[ -n "$FAKE_CURL_FAIL" ]]; then
  echo 'curl: (22) The requested URL returned error: 404' >&2
  exit 22
fi
cp "$FAKE_DIR/source.yaml" "$out"
`

const labelsYaml = `labels:
  - color: 'ededed'
    description: A release pull request that has not been released yet
    name: 'autorelease: pending'
  - color: '0366d6'
    description: Pull requests that update a dependency file
    name: dependencies
  - color: '7057ff'
    description: Good for newcomers
    name: good first issue
  - color: '008672'
    description: Extra attention is needed
    name: help wanted
retired:
  - 'area:*'
  - bug
  - 'kind:*'
`

const existing = [
  {
    color: 'EDEDED',
    description: 'A release pull request that has not been released yet',
    name: 'autorelease: pending',
  },
  { color: '0366d6', description: 'Old words', name: 'dependencies' },
  {
    color: '008672',
    description: 'Extra attention is needed',
    name: 'Help Wanted',
  },
  { color: 'd73a4a', description: "Something isn't working", name: 'bug' },
  { color: 'ededed', description: '', name: 'kind:fix' },
  { color: 'ededed', description: '', name: 'area:docs' },
  { color: '168700', description: '', name: 'javascript' },
  { color: 'ededed', description: '', name: 'bugfix-needed' },
]

const runStep = ({
  curlFails = false,
  deleteRetired = false,
  labels = existing,
  yaml = labelsYaml,
} = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-labels-'))
  try {
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'curl'), fakeCurl, { mode: 0o755 })
    fs.writeFileSync(path.join(directory, 'source.yaml'), yaml)
    fs.writeFileSync(
      path.join(directory, 'existing.json'),
      JSON.stringify(labels),
    )
    const summary = path.join(directory, 'summary.md')

    // bash -e, as GitHub runs a step whose shell is left unset.
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DELETE_RETIRED: String(deleteRetired),
        FAKE_CURL_FAIL: curlFails ? '1' : '',
        FAKE_DIR: directory,
        GITHUB_STEP_SUMMARY: summary,
        LABELS_URL: 'https://example.invalid/labels.yaml',
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        REPO: 'kanso-labs/example',
        RUNNER_TEMP: directory,
      },
    })
    const read = (file) =>
      fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    return {
      calls: read(path.join(directory, 'calls'))
        .trim()
        .split('\n')
        .filter(Boolean),
      output: result.stdout + result.stderr,
      status: result.status,
      summary: read(summary),
    }
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

const writes = (calls) => calls.filter((call) => !call.startsWith('label list'))
const deletes = (calls) =>
  calls.filter((call) => call.startsWith('label delete'))

describe('the label sync', () => {
  it('creates a missing label and updates one whose words changed', () => {
    const { calls, status, summary } = runStep()

    assert.equal(status, 0)
    assert.ok(
      calls.includes(
        'label create good first issue --repo kanso-labs/example --color 7057ff --description Good for newcomers',
      ),
    )
    assert.ok(
      calls.includes(
        'label edit dependencies --repo kanso-labs/example --name dependencies --color 0366d6 --description Pull requests that update a dependency file',
      ),
    )
    assert.match(summary, /Created `good first issue`/)
    assert.match(summary, /Updated `dependencies`/)
  })

  it('leaves a label that already matches, whatever the colour case', () => {
    const { calls } = runStep()

    assert.ok(!writes(calls).some((call) => call.includes('autorelease')))
  })

  it('renames a label that differs only in case', () => {
    const { calls } = runStep()

    assert.ok(
      calls.includes(
        'label edit Help Wanted --repo kanso-labs/example --name help wanted --color 008672 --description Extra attention is needed',
      ),
    )
  })

  it('keeps retired labels and names them when delete-retired is off', () => {
    const { calls, output, status } = runStep()

    assert.equal(status, 0)
    assert.deepEqual(deletes(calls), [])
    assert.match(
      output,
      /::notice::delete-retired is off, so 3 retired labels stay: bug, kind:fix, area:docs/,
    )
  })

  it('deletes retired labels by name and by prefix when delete-retired is on', () => {
    const { calls, status } = runStep({ deleteRetired: true })

    assert.equal(status, 0)
    assert.deepEqual(deletes(calls), [
      'label delete bug --repo kanso-labs/example --yes',
      'label delete kind:fix --repo kanso-labs/example --yes',
      'label delete area:docs --repo kanso-labs/example --yes',
    ])
  })

  it('leaves a label in neither list alone', () => {
    const { calls } = runStep({ deleteRetired: true })

    assert.ok(!writes(calls).some((call) => call.includes('javascript')))
    assert.ok(!writes(calls).some((call) => call.includes('bugfix-needed')))
  })

  it('never retires a label the kept list names', () => {
    const yaml = labelsYaml.replace("  - 'area:*'", "  - 'area:*'\n  - 'dep*'")
    const { calls } = runStep({ deleteRetired: true, yaml })

    assert.ok(!deletes(calls).some((call) => call.includes('dependencies')))
  })

  it('stops before any write when labels.yaml cannot be downloaded', () => {
    const { calls, status } = runStep({ curlFails: true })

    assert.notEqual(status, 0)
    assert.deepEqual(calls, [])
  })

  it('stops before any write when a colour lost its leading zeros', () => {
    const yaml = labelsYaml.replace("color: '008672'", 'color: 008672')
    const { calls, output, status } = runStep({ yaml })

    assert.notEqual(status, 0)
    assert.match(output, /::error::/)
    assert.deepEqual(calls, [])
  })
})
