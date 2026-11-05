import assert from 'node:assert/strict'
import fs from 'node:fs'
import { describe, it } from 'node:test'

// Setting released issues back to Done in _release-please.yaml acts on a
// release pull request linking itself to issues that closed long before, which
// no pull request here can arrange, and writes to organization projects, which
// no pull request here may touch. These cases run the step's own script
// against a stand-in for github-script's github, context and core instead, so
// every branch of it runs on every pull request.
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
    (line, i) => i > start && /^\s+script: \|$/.test(line),
  )
  const indent = lines[run + 1].search(/\S/)
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

const AsyncFunction = (async () => {}).constructor
const script = new AsyncFunction(
  'github',
  'context',
  'core',
  stepScript('Set released issues back to Done'),
)

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

const pull = (number, issues, totalCount = issues.length) => ({
  closingIssuesReferences: { nodes: issues, totalCount },
  number,
})

const daily = project('Daily')
const released = pull(231, [
  issue(189, 'CLOSED', item('I_189', daily, 'In review')),
])

// Answers each label's read from the pulls listed under it, and records every
// write. A label or an item named in `fail` makes that call throw.
const runStep = async ({
  fail = [],
  pending = [],
  tagged = [released],
} = {}) => {
  const reads = []
  const writes = []
  const output = []
  const github = {
    graphql: async (query, variables) => {
      if (query.startsWith('mutation')) {
        writes.push(variables)
        if (fail.includes(variables.item)) throw new Error('canned refusal')
        return { updateProjectV2ItemFieldValue: { projectV2Item: {} } }
      }
      reads.push(variables)
      if (fail.includes(variables.label)) throw new Error('canned failure')
      const nodes =
        variables.label === 'autorelease: pending' ? pending : tagged
      return { repository: { pullRequests: { nodes } } }
    },
  }
  const context = { repo: { owner: 'kanso-labs', repo: 'example' } }
  const core = {
    info: (line) => output.push(line),
    warning: (line) => output.push(`::warning::${line}`),
  }
  await script(github, context, core)
  return { output: output.join('\n'), reads, writes }
}

describe('setting released issues back to Done', () => {
  it('sets a closed issue left at In review to Done, with its project’s own ids', async () => {
    const { output, writes } = await runStep()

    assert.match(output, /#231: set #189 back to Done on Daily\./)
    assert.deepEqual(writes, [
      {
        field: 'F_Daily',
        item: 'I_189',
        option: 'O_Daily_done',
        project: 'P_Daily',
      },
    ])
  })

  it('reads merged release pull requests under both labels, in the repository it runs in', async () => {
    const { reads } = await runStep()

    assert.deepEqual(reads, [
      { label: 'autorelease: pending', owner: 'kanso-labs', repo: 'example' },
      { label: 'autorelease: tagged', owner: 'kanso-labs', repo: 'example' },
    ])
  })

  it('sets an item that has no Status at all', async () => {
    const { writes } = await runStep({
      tagged: [pull(231, [issue(189, 'CLOSED', item('I_189', daily))])],
    })

    assert.equal(writes.length, 1)
  })

  it('sets the issue on every project it is on', async () => {
    const { output, writes } = await runStep({
      tagged: [
        pull(231, [
          issue(
            189,
            'CLOSED',
            item('I_daily', daily, 'In review'),
            item('I_ui', project('Kanso UI'), 'In progress'),
          ),
        ]),
      ],
    })

    assert.equal(writes.length, 2)
    assert.match(output, /set #189 back to Done on Kanso UI\./)
  })

  it('leaves open issues and items already Done alone', async () => {
    const { output, writes } = await runStep({
      tagged: [
        pull(231, [
          issue(189, 'OPEN', item('I_189', daily, 'In review')),
          issue(190, 'CLOSED', item('I_190', daily, 'Done')),
        ]),
      ],
    })

    assert.deepEqual(writes, [])
    assert.match(output, /#231: nothing to set back to Done\./)
  })

  it('leaves a project whose Status has no Done, or that has no Status', async () => {
    const { writes } = await runStep({
      tagged: [
        pull(231, [
          issue(
            189,
            'CLOSED',
            item('I_nodone', project('Other', { done: false }), 'In review'),
            item('I_nofield', project('Bare', { field: false })),
          ),
        ]),
      ],
    })

    assert.deepEqual(writes, [])
  })

  it('checks a pull request found under both labels once, oldest first', async () => {
    const { output } = await runStep({
      pending: [pull(232, [])],
      tagged: [pull(232, []), pull(230, []), released],
    })

    assert.deepEqual(
      output.split('\n').map((line) => line.split(':')[0]),
      ['#230', '#231', '#232'],
    )
  })

  it('says so when no release pull request has merged', async () => {
    const { output, writes } = await runStep({ tagged: [] })

    assert.equal(output, 'No merged release pull request to check.')
    assert.deepEqual(writes, [])
  })

  it('warns and moves on when one label cannot be read', async () => {
    const { output, writes } = await runStep({
      fail: ['autorelease: pending'],
    })

    assert.match(
      output,
      /::warning::Could not read the merged release pull requests labelled autorelease: pending: canned failure/,
    )
    assert.equal(writes.length, 1)
  })

  it('warns and moves to the next item when a write is refused', async () => {
    const { output, writes } = await runStep({
      fail: ['I_189'],
      tagged: [
        pull(231, [
          issue(189, 'CLOSED', item('I_189', daily, 'In review')),
          issue(190, 'CLOSED', item('I_190', daily, 'In review')),
        ]),
      ],
    })

    assert.match(
      output,
      /::warning::Could not set #189 back to Done on Daily: canned refusal/,
    )
    assert.match(output, /#231: set #190 back to Done on Daily\./)
    assert.equal(writes.length, 2)
  })

  it('warns when a pull request closes more issues than one page holds', async () => {
    const { output } = await runStep({
      tagged: [
        pull(
          231,
          [issue(189, 'CLOSED', item('I_189', daily, 'In review'))],
          140,
        ),
      ],
    })

    assert.match(output, /::warning::#231 closes 140 issues, more than the 1/)
    assert.match(output, /#231: set #189 back to Done on Daily\./)
  })
})

// The step runs only once its token was minted, and the one before it says
// why when it was not. Both are read off the workflow, since neither is a
// script a test can run.
describe('setting released issues back to Done, in the workflow', () => {
  const step = (name) => {
    const start = workflow.indexOf(`- name: ${name}\n`)
    assert.notEqual(start, -1, `no step named ${name}`)
    const next = workflow.indexOf('\n      - name: ', start + 1)
    return workflow.slice(start, next === -1 ? undefined : next)
  }

  it('runs only with the token minted for it', () => {
    const set = step('Set released issues back to Done')

    assert.match(set, /if: steps\.projects-token\.outputs\.token != ''/)
    assert.match(
      set,
      /github-token: \$\{\{ steps\.projects-token\.outputs\.token \}\}/,
    )
  })

  it('mints that token only outside a dry run, and never fails the run over it', () => {
    const mint = step('Mint a token for the organization projects')

    assert.match(mint, /if: env\.CLIENT_ID != '' && !inputs\.dry-run/)
    assert.match(mint, /continue-on-error: true/)
    assert.match(mint, /permission-organization-projects: write/)
  })

  it('warns when the token could not be minted', () => {
    const warn = step(
      'Warn that no token for the organization projects was minted',
    )

    assert.match(warn, /if: steps\.projects-token\.outcome == 'failure'/)
    assert.match(warn, /::warning::Could not mint a token/)
  })
})
