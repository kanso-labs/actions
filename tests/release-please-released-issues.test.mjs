import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

// Setting released issues back to Done in _release-please.yaml acts on a
// release pull request linking itself to issues that closed long before, which
// no pull request here can arrange, and writes to organization projects, which
// no pull request here may touch. These cases run the step's own script
// against a stand-in gh instead, so every branch of it runs on every pull
// request.
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

const script = stepScript('Set released issues back to Done')

// A gh that answers from a scenario and records every call, leaving out the
// GraphQL document and the --jq filter, which are the step's own text. A pull
// request's closing issues come from pr-<number>.json, with the step's filter
// applied by the real jq; "fail" in that file, or a listed item, or a label in
// FAKE_FAIL makes that call fail.
const fakeGh = `#!/bin/bash
args=("$@")
filter=''
kind=''
logged=()
for ((i = 0; i < \${#args[@]}; i++)); do
  arg="\${args[$i]}"
  if [[ "$arg" == --jq ]]; then
    filter="\${args[$((i + 1))]}"
    i=$((i + 1))
    continue
  fi
  case "$arg" in
    query=mutation*) kind=mutation; logged+=('query=<mutation>') ;;
    query=*) kind=query; logged+=('query=<query>') ;;
    *) logged+=("$arg") ;;
  esac
done
echo "\${logged[*]}" >> "$FAKE_DIR/calls"
value() { printf '%s\\n' "\${logged[@]}" | sed -n "s/^$1=//p"; }
case "$*" in
  'pr list --label autorelease: pending'*)
    [[ "$FAKE_FAIL" == *pending* ]] && { echo 'gh: canned failure (HTTP 502)' >&2; exit 1; }
    printf '%s' "$FAKE_PENDING" ;;
  'pr list --label autorelease: tagged'*)
    [[ "$FAKE_FAIL" == *tagged* ]] && { echo 'gh: canned failure (HTTP 502)' >&2; exit 1; }
    printf '%s' "$FAKE_TAGGED" ;;
  'api graphql'*)
    if [[ "$kind" == mutation ]]; then
      [[ " $FAKE_FAIL " == *" $(value item) "* ]] && { echo 'gh: canned refusal' >&2; exit 1; }
      exit 0
    fi
    json="$(cat "$FAKE_DIR/pr-$(value number).json")"
    [[ "$json" == '"fail"' ]] && { echo 'gh: canned failure (HTTP 502)' >&2; exit 1; }
    jq -r "$filter" <<< "$json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`

// GraphQL ids never hold a space, though a project's title may.
const project = (title, { done = true, field = true } = {}) => {
  const key = title.replaceAll(' ', '')
  return {
    field: field
      ? {
          id: `F_${key}`,
          options: [
            { id: `O_${key}_backlog`, name: 'Backlog' },
            { id: `O_${key}_review`, name: 'In review' },
            ...(done ? [{ id: `O_${key}_done`, name: 'Done' }] : []),
          ],
        }
      : null,
    id: `P_${key}`,
    title,
  }
}

const item = (id, on, status) => ({
  id,
  project: on,
  status: status ? { name: status } : null,
})

const issue = (number, state, ...items) => ({
  number,
  projectItems: { nodes: items },
  state,
})

const closing = (issues, totalCount = issues.length) => ({
  data: {
    repository: {
      pullRequest: {
        closingIssuesReferences: { nodes: issues, totalCount },
      },
    },
  },
})

const daily = project('Daily')

const runStep = ({
  fail = '',
  pending = '',
  prs = {
    231: closing([issue(189, 'CLOSED', item('I_189', daily, 'In review'))]),
  },
  tagged = '231',
  token = 'a-token',
} = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-done-'))
  try {
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), fakeGh, { mode: 0o755 })
    for (const [number, answer] of Object.entries(prs))
      fs.writeFileSync(
        path.join(directory, `pr-${number}.json`),
        JSON.stringify(answer),
      )

    // bash -e, as GitHub runs a step whose shell is left unset.
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DIR: directory,
        FAKE_FAIL: fail,
        FAKE_PENDING: pending,
        FAKE_TAGGED: tagged,
        GH_REPO: 'kanso-labs/example',
        GH_TOKEN: token,
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

const writes = (calls) =>
  calls.filter((call) => call.includes('query=<mutation>'))
const reads = (calls) => calls.filter((call) => call.includes('query=<query>'))

describe('setting released issues back to Done', () => {
  it('sets a closed issue left at In review to Done, with its project’s own ids', () => {
    const { calls, output, status } = runStep()

    assert.equal(status, 0)
    assert.match(output, /#231: set #189 back to Done on Daily\./)
    assert.deepEqual(writes(calls), [
      'api graphql -f query=<mutation> -f project=P_Daily -f item=I_189 -f field=F_Daily -f option=O_Daily_done --silent',
    ])
  })

  it('reads the pull request from the repository it runs in', () => {
    const { calls } = runStep()

    assert.deepEqual(reads(calls), [
      'api graphql -f query=<query> -f owner=kanso-labs -f name=example -F number=231',
    ])
  })

  it('sets an item that has no Status at all', () => {
    const { calls } = runStep({
      prs: { 231: closing([issue(189, 'CLOSED', item('I_189', daily))]) },
    })

    assert.equal(writes(calls).length, 1)
  })

  it('sets the issue on every project it is on', () => {
    const kansoUi = project('Kanso UI')
    const { calls, output } = runStep({
      prs: {
        231: closing([
          issue(
            189,
            'CLOSED',
            item('I_daily', daily, 'In review'),
            item('I_ui', kansoUi, 'In progress'),
          ),
        ]),
      },
    })

    assert.equal(writes(calls).length, 2)
    assert.match(output, /set #189 back to Done on Kanso UI\./)
  })

  it('leaves open issues and items already Done alone', () => {
    const { calls, output, status } = runStep({
      prs: {
        231: closing([
          issue(189, 'OPEN', item('I_189', daily, 'In review')),
          issue(190, 'CLOSED', item('I_190', daily, 'Done')),
        ]),
      },
    })

    assert.equal(status, 0)
    assert.deepEqual(writes(calls), [])
    assert.match(output, /#231: nothing to set back to Done\./)
  })

  it('leaves a project whose Status has no Done, or that has no Status', () => {
    const { calls } = runStep({
      prs: {
        231: closing([
          issue(
            189,
            'CLOSED',
            item('I_nodone', project('Other', { done: false }), 'In review'),
            item('I_nofield', project('Bare', { field: false })),
          ),
        ]),
      },
    })

    assert.deepEqual(writes(calls), [])
  })

  it('reads merged release pull requests under both labels, each once', () => {
    const { calls } = runStep({
      pending: '232\n',
      prs: {
        230: closing([]),
        231: closing([]),
        232: closing([]),
      },
      tagged: '231\n230\n232\n',
    })

    assert.ok(
      calls.includes(
        'pr list --label autorelease: pending --state merged --limit 5 --json number',
      ),
    )
    assert.ok(
      calls.includes(
        'pr list --label autorelease: tagged --state merged --limit 5 --json number',
      ),
    )
    assert.deepEqual(
      reads(calls).map((call) => call.split(' ').at(-1)),
      ['number=230', 'number=231', 'number=232'],
    )
  })

  it('says so when no release pull request has merged', () => {
    const { calls, output, status } = runStep({ tagged: '' })

    assert.equal(status, 0)
    assert.match(output, /No merged release pull request to check\./)
    assert.deepEqual(reads(calls), [])
  })

  it('warns and moves on when one label cannot be listed', () => {
    const { calls, output, status } = runStep({ fail: 'pending' })

    assert.equal(status, 0)
    assert.match(
      output,
      /::warning::Could not list the merged release pull requests labelled autorelease: pending\./,
    )
    assert.equal(writes(calls).length, 1)
  })

  it('warns and moves to the next pull request when one cannot be read', () => {
    const { calls, output, status } = runStep({
      prs: {
        230: 'fail',
        231: closing([issue(189, 'CLOSED', item('I_189', daily, 'In review'))]),
      },
      tagged: '230\n231',
    })

    assert.equal(status, 0)
    assert.match(output, /::warning::Could not read the issues #230 closed\./)
    assert.equal(writes(calls).length, 1)
  })

  it('warns and moves to the next item when a write is refused', () => {
    const { calls, output, status } = runStep({
      fail: 'I_189',
      prs: {
        231: closing([
          issue(189, 'CLOSED', item('I_189', daily, 'In review')),
          issue(190, 'CLOSED', item('I_190', daily, 'In review')),
        ]),
      },
    })

    assert.equal(status, 0)
    assert.match(
      output,
      /::warning::Could not set #189 back to Done on Daily\./,
    )
    assert.match(output, /#231: set #190 back to Done on Daily\./)
    assert.equal(writes(calls).length, 2)
  })

  it('warns when a pull request closes more issues than one page holds', () => {
    const { output, status } = runStep({
      prs: {
        231: closing(
          [issue(189, 'CLOSED', item('I_189', daily, 'In review'))],
          140,
        ),
      },
    })

    assert.equal(status, 0)
    assert.match(output, /::warning::#231 closes 140 issues, more than the 100/)
    assert.match(output, /#231: set #189 back to Done on Daily\./)
  })

  it('warns and calls nothing when no token could be minted', () => {
    const { calls, output, status } = runStep({ token: '' })

    assert.equal(status, 0)
    assert.match(
      output,
      /::warning::Could not mint a token for the organization projects/,
    )
    assert.deepEqual(calls, [])
  })
})

// A self-hosted runner may lack gh or jq, which GitHub's runners carry. These
// cases run the step with nothing on PATH but the stand-ins they name, each
// failing if it is called, and bash found before PATH is narrowed.
const bash = spawnSync('bash', ['-c', 'command -v bash'], {
  encoding: 'utf8',
}).stdout.trim()

const runWithOnly = (tools) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tools-'))
  try {
    for (const [tool, contents] of Object.entries(tools))
      fs.writeFileSync(path.join(directory, tool), contents, { mode: 0o755 })
    const result = spawnSync(bash, ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_REPO: 'kanso-labs/example',
        GH_TOKEN: 'a-token',
        PATH: directory,
      },
    })
    return { output: result.stdout + result.stderr, status: result.status }
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

const unused = '#!/bin/sh\necho "unexpected call: $0 $*" >&2\nexit 99\n'

describe('setting released issues back to Done on a runner without its tools', () => {
  it('warns and sets nothing when there is no gh', () => {
    const { output, status } = runWithOnly({ jq: unused })

    assert.equal(status, 0)
    assert.match(output, /::warning::This runner has no gh, so the issues/)
    assert.doesNotMatch(output, /command not found|unexpected call/)
  })

  it('warns and sets nothing when there is no jq', () => {
    const { output, status } = runWithOnly({ gh: unused })

    assert.equal(status, 0)
    assert.match(output, /::warning::This runner has no jq, so the issues/)
    assert.doesNotMatch(output, /command not found|unexpected call/)
  })
})
