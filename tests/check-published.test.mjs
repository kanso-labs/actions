import assert from 'node:assert/strict'
import fs from 'node:fs'
import { afterEach, describe, it } from 'node:test'

// _check-published.yaml compares the latest releases with the registries and
// keeps one issue open while any is missing. A tagged and unpublished release
// is the case it exists for, and no pull request here can arrange one, so these
// run the step's own script against a stand-in github, context and core, and a
// stand-in fetch for the registries.
//
// The script is cut out of the workflow by its step name rather than copied
// here, so what runs is what ships.
const workflow = fs.readFileSync(
  new URL('../.github/workflows/_check-published.yaml', import.meta.url),
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
  stepScript('Compare the releases with the registries'),
)

const title = 'Tagged releases are missing from the registry'
const bot = { login: 'github-actions[bot]' }
const hoursAgo = (hours) =>
  new Date(Date.now() - hours * 3600 * 1000).toISOString()

const release = (version, hours = 48, extra = {}) => ({
  created_at: hoursAgo(hours),
  draft: false,
  published_at: hoursAgo(hours),
  tag_name: `v${version}`,
  ...extra,
})

const npmjs = 'https://registry.npmjs.org'
const ghp = 'https://npm.pkg.github.com'
const origin = (url) => new URL(url).origin

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
})

// `registries` maps a registry URL to the versions of @kanso-labs/lib it
// carries, or to a number it answers with instead; any other package is a 404. `manifests` maps a tag to its package.json.
const runStep = async ({
  env = {},
  issues = [],
  manifests,
  registries = { [ghp]: ['1.0.0', '1.1.0'], [npmjs]: ['1.0.0', '1.1.0'] },
  releases = [release('1.1.0'), release('1.0.0', 72)],
} = {}) => {
  process.env = {
    ...process.env,
    CHECK_GITHUB_PACKAGES: 'true',
    CHECK_NPM: 'true',
    GITHUB_PACKAGES_TOKEN: 'token',
    GITHUB_REGISTRY_URL: ghp,
    GRACE_HOURS: '12',
    REGISTRY_URL: npmjs,
    RELEASES: '5',
    WORKFLOW: 'release-please.yaml',
    ...env,
  }
  const fetches = []
  globalThis.fetch = async (url, { headers }) => {
    fetches.push({ authorization: headers.authorization, url })
    const registry = Object.keys(registries).find(
      (base) => origin(url) === origin(base),
    )
    const answer = registries[registry]
    if (typeof answer === 'number') return { ok: false, status: answer }
    if (!answer || !url.endsWith('/@kanso-labs%2flib'))
      return { ok: false, status: 404 }
    return {
      json: async () => ({
        versions: Object.fromEntries(answer.map((v) => [v, {}])),
      }),
      ok: true,
      status: 200,
    }
  }

  const calls = []
  const output = []
  let failed
  const github = {
    paginate: async (method, params) => (await method(params)).data,
    rest: {
      issues: {
        create: async (params) => {
          calls.push(['create', params])
          return { data: { number: 99 } }
        },
        createComment: async (params) => calls.push(['comment', params]),
        listForRepo: async (params) => {
          calls.push(['list', params])
          return { data: issues }
        },
        update: async (params) => calls.push(['update', params]),
      },
      repos: {
        getContent: async ({ ref }) => {
          if (manifests?.[ref] instanceof Error) throw manifests[ref]
          const manifest = manifests?.[ref] ?? {
            name: '@kanso-labs/lib',
            version: ref.replace(/^v/, ''),
          }
          return {
            data: {
              content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
            },
          }
        },
        listReleases: async ({ per_page }) => ({
          data: releases.slice(0, per_page),
        }),
      },
    },
  }
  const context = {
    repo: { owner: 'kanso-labs', repo: 'example' },
    runId: 7,
    serverUrl: 'https://github.com',
  }
  const core = {
    info: (line) => output.push(line),
    setFailed: (line) => (failed = line),
    warning: (line) => output.push(`::warning::${line}`),
  }
  await script(github, context, core)
  return {
    calls: calls.filter(([kind]) => kind !== 'list'),
    failed,
    fetches,
    lists: calls.filter(([kind]) => kind === 'list'),
    output: output.join('\n'),
  }
}

describe('checking every release is published', () => {
  it('passes and writes nothing when every release is on both registries', async () => {
    const { calls, failed } = await runStep()
    assert.equal(failed, undefined)
    assert.deepEqual(calls, [])
  })

  it('opens an issue and fails when a registry lacks a version', async () => {
    const { calls, failed } = await runStep({
      registries: { [ghp]: ['1.0.0'], [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.match(failed, /1 release version is missing .*v1\.1\.0/)
    assert.equal(calls.length, 1)
    const [kind, params] = calls[0]
    assert.equal(kind, 'create')
    assert.equal(params.title, title)
    assert.match(
      params.body,
      /`v1\.1\.0`: `@kanso-labs\/lib@1\.1\.0` is not on https:\/\/npm\.pkg\.github\.com/,
    )
    assert.match(
      params.body,
      /gh workflow run 'release-please\.yaml' --repo 'kanso-labs\/example' --ref 'v1\.1\.0'/,
    )
    assert.doesNotMatch(params.body, /is not on https:\/\/registry\.npmjs/)
  })

  it('updates the open issue rather than opening a second', async () => {
    const { calls, failed } = await runStep({
      issues: [
        { number: 3, pull_request: {}, title, user: bot },
        { number: 4, title, user: { login: 'stranger' } },
        { number: 5, title, user: bot },
      ],
      registries: { [ghp]: ['1.0.0', '1.1.0'], [npmjs]: ['1.1.0'] },
    })
    assert.ok(failed)
    assert.deepEqual(
      calls.map(([kind, { issue_number }]) => [kind, issue_number]),
      [['update', 5]],
    )
    assert.match(calls[0][1].body, /`v1\.0\.0`/)
  })

  it('closes the open issue once nothing is missing', async () => {
    const { calls, failed } = await runStep({
      issues: [{ number: 5, title, user: bot }],
    })
    assert.equal(failed, undefined)
    assert.deepEqual(
      calls.map(([kind, { issue_number, state }]) => [
        kind,
        issue_number,
        state,
      ]),
      [
        ['comment', 5, undefined],
        ['update', 5, 'closed'],
      ],
    )
  })

  it('leaves a release inside the grace period alone', async () => {
    const { calls, failed, output } = await runStep({
      registries: { [ghp]: ['1.0.0'], [npmjs]: ['1.0.0'] },
      releases: [release('1.1.0', 2), release('1.0.0', 72)],
    })
    assert.equal(failed, undefined)
    assert.deepEqual(calls, [])
    assert.match(output, /v1\.1\.0: released \d+ minutes ago/)
  })

  it('skips drafts', async () => {
    const { failed } = await runStep({
      registries: { [ghp]: ['1.0.0'], [npmjs]: ['1.0.0'] },
      releases: [release('1.1.0', 48, { draft: true }), release('1.0.0', 72)],
    })
    assert.equal(failed, undefined)
  })

  it('checks only the registries asked for', async () => {
    const { fetches, failed } = await runStep({
      env: { CHECK_NPM: 'false' },
      registries: { [ghp]: ['1.0.0', '1.1.0'] },
    })
    assert.equal(failed, undefined)
    assert.ok(fetches.every(({ url }) => origin(url) === origin(ghp)))
  })

  it('asks each registry once per package, with the token only for GitHub Packages', async () => {
    const { fetches } = await runStep()
    assert.deepEqual(fetches, [
      { authorization: undefined, url: `${npmjs}/@kanso-labs%2flib` },
      { authorization: 'Bearer token', url: `${ghp}/@kanso-labs%2flib` },
    ])
  })

  it('reads the name each tag was released under', async () => {
    const { calls } = await runStep({
      manifests: {
        'v1.0.0': { name: '@kanso-labs/old', version: '1.0.0' },
      },
      registries: { [ghp]: ['1.0.0', '1.1.0'], [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.match(calls[0][1].body, /`@kanso-labs\/old@1\.0\.0` is not on/)
  })

  it('treats a package the registry has never seen as missing', async () => {
    const { failed } = await runStep({
      registries: { [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.match(failed, /2 release versions are missing/)
  })

  it('fails without touching the issue when a registry refuses', async () => {
    const { calls, failed } = await runStep({
      registries: { [ghp]: 401, [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.match(failed, /HTTP 401/)
    assert.deepEqual(calls, [])
  })

  it('fails when asked to check no registry at all', async () => {
    const { failed } = await runStep({
      env: { CHECK_GITHUB_PACKAGES: 'false', CHECK_NPM: 'false' },
    })
    assert.match(failed, /nothing to check/)
  })
  it('opens its own issue beside a stranger’s with the same title', async () => {
    const { calls } = await runStep({
      issues: [{ number: 4, title, user: { login: 'stranger' } }],
      registries: { [ghp]: ['1.0.0'], [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.equal(calls[0][0], 'create')
  })

  it('names the workflow a caller says publishes', async () => {
    const { calls } = await runStep({
      env: { WORKFLOW: 'publish.yaml' },
      registries: { [ghp]: ['1.0.0'], [npmjs]: ['1.0.0', '1.1.0'] },
    })
    assert.match(calls[0][1].body, /gh workflow run 'publish\.yaml'/)
  })

  it('lists a tag whose package.json cannot be read, and checks the rest', async () => {
    const { calls, failed } = await runStep({
      manifests: { 'v1.1.0': new Error('Not Found') },
      registries: { [ghp]: ['1.1.0'], [npmjs]: ['1.1.0'] },
    })
    assert.match(failed, /1 could not be checked: v1\.1\.0/)
    assert.match(failed, /missing from a registry: v1\.0\.0\./)
    assert.match(calls[0][1].body, /- `v1\.1\.0`: Not Found/)
    assert.match(calls[0][1].body, /`v1\.0\.0`: `@kanso-labs\/lib@1\.0\.0`/)
  })

  it('skips a private manifest and a tag with no version', async () => {
    const { failed, fetches } = await runStep({
      manifests: {
        'v1.1.0': { name: '@kanso-labs/lib', private: true, version: '1.1.0' },
      },
      releases: [
        release('1.1.0'),
        { ...release('1.0.0'), tag_name: 'nightly$(touch x)' },
      ],
    })
    assert.equal(failed, undefined)
    assert.deepEqual(fetches, [])
  })

  it('checks no more than GitHub returns in one page', async () => {
    const asked = []
    const { failed } = await runStep({
      env: { RELEASES: '500' },
      releases: new Proxy([], {
        get: (target, key) =>
          key === 'slice'
            ? (start, end) => {
                asked.push(end)
                return []
              }
            : target[key],
      }),
    })
    assert.equal(failed, undefined)
    assert.deepEqual(asked, [100])
  })
  it('lists a manifest with no name rather than failing', async () => {
    const { calls, failed } = await runStep({
      manifests: { 'v1.1.0': { version: '1.1.0' } },
    })
    assert.match(failed, /1 could not be checked: v1\.1\.0/)
    assert.match(calls[0][1].body, /names no package and version/)
  })

  it('does not look for an unscoped package on GitHub Packages', async () => {
    const { failed, fetches } = await runStep({
      manifests: {
        'v1.0.0': { name: 'lib', version: '1.0.0' },
        'v1.1.0': { name: 'lib', version: '1.1.0' },
      },
      registries: {},
    })
    assert.ok(fetches.every(({ url }) => origin(url) === origin(npmjs)))
    assert.match(failed, /2 release versions are missing/)
  })
})
