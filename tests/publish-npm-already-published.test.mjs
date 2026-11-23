import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

// _publish-npm.yaml asks each registry whether the version is already there,
// and publishes nothing when it is. That is what makes publishing a tag safe to
// repeat, and it needs a registry that already carries a version, which no pull
// request here can arrange. These run the step's own script against a local
// stand-in registry instead.
//
// The script is cut out of the workflow by its step name rather than copied
// here, so what runs is what ships — and both jobs carry a copy, which these
// hold equal.
const workflow = fs.readFileSync(
  new URL('../.github/workflows/_publish-npm.yaml', import.meta.url),
  'utf8',
)

const stepScripts = (name) => {
  const lines = workflow.split('\n')
  const scripts = []
  lines.forEach((line, start) => {
    if (line.trim() !== `- name: ${name}`) return
    const run = lines.findIndex(
      (candidate, i) => i > start && /^\s+run: \|$/.test(candidate),
    )
    const indent = lines[run + 1].search(/\S/)
    const body = []
    for (const next of lines.slice(run + 1)) {
      if (next.trim() !== '' && next.search(/\S/) < indent) break
      body.push(next.slice(indent))
    }
    scripts.push(body.join('\n'))
  })
  return scripts
}

const checks = stepScripts('Check whether this version is already published')

// Answers the package document for each name in `packages`, with `latest` as
// its latest dist-tag, 404 for any other, and whatever `status` says for a name
// listed there. Records each request's
// path and authorization header.
const registry = ({ latest = {}, packages = {}, status = {} } = {}) => {
  const requests = []
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1))
    requests.push({
      authorization: request.headers.authorization,
      cacheControl: request.headers['cache-control'],
      url: request.url,
    })
    if (status[name]) {
      response.writeHead(status[name]).end()
    } else if (packages[name]) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          'dist-tags': latest[name] ? { latest: latest[name] } : undefined,
          name,
          versions: packages[name],
        }),
      )
    } else {
      response.writeHead(404).end('{"error":"Not found"}')
    }
  })
  return { requests, server }
}

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  )

const runCheck = (cwd, env, version = '1.2.3') =>
  new Promise((resolve) => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: '@kanso-labs/lib', version }),
    )
    const output = path.join(cwd, 'output')
    fs.writeFileSync(output, '')
    const child = spawn('bash', ['-e', '-c', checks[0]], {
      cwd,
      env: { ...process.env, GITHUB_OUTPUT: output, ...env },
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stdout += chunk))
    child.on('close', (status) =>
      resolve({ output: fs.readFileSync(output, 'utf8'), status, stdout }),
    )
  })

describe('the check for an already published version', () => {
  let directory
  let stand

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-check-'))
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: '@kanso-labs/lib', version: '1.2.3' }),
    )
  })

  after(() => {
    stand?.server.close()
    fs.rmSync(directory, { force: true, recursive: true })
  })

  const serve = async (options) => {
    stand?.server.close()
    stand = registry(options)
    return listen(stand.server)
  }

  it('is carried by both jobs, identically', () => {
    assert.equal(checks.length, 2)
    assert.equal(checks[0], checks[1])
  })

  it('says published when the registry carries the version', async () => {
    const url = await serve({
      packages: { '@kanso-labs/lib': { '1.2.2': {}, '1.2.3': {} } },
    })
    const { output, status, stdout } = await runCheck(directory, {
      REGISTRY_TOKEN: '',
      REGISTRY_URL: url,
    })
    assert.equal(status, 0)
    assert.equal(output, 'dist-tag=latest\npublished=true\n')
    assert.match(stdout, /::notice::@kanso-labs\/lib@1\.2\.3 is already on/)
  })

  it('says not published when the registry carries other versions only', async () => {
    const url = await serve({
      packages: { '@kanso-labs/lib': { '1.2.2': {} } },
    })
    const { output, status } = await runCheck(directory, {
      REGISTRY_TOKEN: '',
      REGISTRY_URL: url,
    })
    assert.equal(status, 0)
    assert.equal(output, 'dist-tag=latest\npublished=false\n')
  })

  it('says not published when the package does not exist yet', async () => {
    const url = await serve()
    const { output, status } = await runCheck(directory, {
      REGISTRY_TOKEN: '',
      REGISTRY_URL: `${url}/`,
    })
    assert.equal(status, 0)
    assert.equal(output, 'dist-tag=latest\npublished=false\n')
  })

  it('asks for the scoped name with its slash escaped', async () => {
    const url = await serve()
    await runCheck(directory, { REGISTRY_TOKEN: '', REGISTRY_URL: url })
    assert.deepEqual(
      stand.requests.map(({ url }) => url),
      ['/@kanso-labs%2flib'],
    )
  })

  it('sends the token only when there is one', async () => {
    const url = await serve()
    await runCheck(directory, { REGISTRY_TOKEN: '', REGISTRY_URL: url })
    await runCheck(directory, { REGISTRY_TOKEN: 'secret', REGISTRY_URL: url })
    assert.deepEqual(
      stand.requests.map(({ authorization }) => authorization),
      [undefined, 'Bearer secret'],
    )
  })

  it('fails rather than guessing when the registry refuses', async () => {
    const url = await serve({ status: { '@kanso-labs/lib': 401 } })
    const { output, status, stdout } = await runCheck(directory, {
      REGISTRY_TOKEN: '',
      REGISTRY_URL: url,
    })
    assert.equal(status, 1)
    assert.equal(output, '')
    assert.match(stdout, /::error::.*HTTP 401/)
  })

  it('fails rather than guessing when the registry cannot be reached', async () => {
    const url = await serve()
    stand.server.close()
    const { output, status, stdout } = await runCheck(directory, {
      REGISTRY_TOKEN: '',
      REGISTRY_URL: url,
    })
    assert.equal(status, 1)
    assert.equal(output, '')
    assert.match(stdout, /::error::Could not ask/)
  })
  it('asks past any cache, since a stale document would publish twice', async () => {
    const url = await serve()
    await runCheck(directory, { REGISTRY_TOKEN: '', REGISTRY_URL: url })
    assert.equal(stand.requests[0].cacheControl, 'no-cache')
  })

  it('publishes a version older than latest under backport', async () => {
    const url = await serve({
      latest: { '@kanso-labs/lib': '1.10.0' },
      packages: { '@kanso-labs/lib': { '1.10.0': {} } },
    })
    const { output } = await runCheck(
      directory,
      { REGISTRY_TOKEN: '', REGISTRY_URL: url },
      '1.9.4',
    )
    assert.equal(output, 'dist-tag=backport\npublished=false\n')
  })

  it('publishes a version newer than latest under latest', async () => {
    const url = await serve({
      latest: { '@kanso-labs/lib': '1.9.4' },
      packages: { '@kanso-labs/lib': { '1.9.4': {} } },
    })
    const { output } = await runCheck(
      directory,
      { REGISTRY_TOKEN: '', REGISTRY_URL: url },
      '1.10.0',
    )
    assert.equal(output, 'dist-tag=latest\npublished=false\n')
  })

  it('finds a version with build metadata under the version npm keeps', async () => {
    const url = await serve({
      latest: { '@kanso-labs/lib': '1.2.3' },
      packages: { '@kanso-labs/lib': { '1.2.3': {} } },
    })
    const { output } = await runCheck(
      directory,
      { REGISTRY_TOKEN: '', REGISTRY_URL: url },
      '1.2.3+build.7',
    )
    assert.equal(output, 'dist-tag=latest\npublished=true\n')
  })

  it('gives a release latest over a prerelease of the same version', async () => {
    const url = await serve({
      latest: { '@kanso-labs/lib': '2.0.0-rc.1' },
      packages: { '@kanso-labs/lib': { '2.0.0-rc.1': {} } },
    })
    const { output } = await runCheck(
      directory,
      { REGISTRY_TOKEN: '', REGISTRY_URL: url },
      '2.0.0',
    )
    assert.equal(output, 'dist-tag=latest\npublished=false\n')
  })

  it('publishes a prerelease under next', async () => {
    const url = await serve({
      latest: { '@kanso-labs/lib': '1.9.4' },
      packages: { '@kanso-labs/lib': { '1.9.4': {} } },
    })
    const { output } = await runCheck(
      directory,
      { REGISTRY_TOKEN: '', REGISTRY_URL: url },
      '2.0.0-dev.1',
    )
    assert.equal(output, 'dist-tag=next\npublished=false\n')
  })
})

// Every step after the check is what it skips, in both jobs, and a dry run
// skips nothing, since it exists to exercise them. These hold the conditions
// the script's answer only matters through.
describe('the steps the check skips', () => {
  const jobs = workflow.split(/\n  publish-github-packages:\n/)
  const steps = (job) =>
    job
      .split(/\n      - name: /)
      .slice(1)
      .map((step) => {
        const [name, ...rest] = step.split('\n')
        const body = rest.join('\n')
        const ifLines = body.match(/^ {8}if:(.*(?:\n {10}\S.*)*)/m)
        return {
          condition: ifLines ? ifLines[1].replace(/\s+/g, ' ').trim() : '',
          name,
        }
      })

  for (const [index, job] of jobs.entries()) {
    const all = steps(job)
    const after = all.slice(
      all.findIndex(
        ({ name }) =>
          name === 'Check whether this version is already published',
      ) + 1,
    )

    it(`gates every later step in job ${index + 1}, except under dry-run`, () => {
      assert.ok(after.length >= 3)
      for (const { condition, name } of after)
        assert.match(
          condition,
          /inputs\.dry-run \|\| steps\.published\.outputs\.published != 'true'/,
          name,
        )
    })
  }

  it('lets GitHub Packages run alone only when npm is off', () => {
    const job = jobs[1].split('\n    steps:')[0]
    const condition = job
      .match(/\n    if:\n([\s\S]*?)\n    permissions:/)[1]
      .replace(/\s+/g, ' ')
    assert.match(condition, /!cancelled\(\)/)
    assert.match(
      condition,
      /needs\.publish\.result == 'success' \|\| \(!inputs\.npm && needs\.publish\.result == 'skipped'\)/,
    )
  })
})
