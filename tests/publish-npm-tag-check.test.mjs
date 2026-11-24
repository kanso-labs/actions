import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

// _publish-npm.yaml refuses to publish a commit other than the one the release
// was tagged at. The case it exists for needs a release cut by a later run
// than the merge commit's own, which nothing here can produce on a pull
// request, so these run the check's own script against a real remote instead.
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

const checks = stepScripts('Check this is the tagged commit')

// Isolated from whatever the machine's own git configuration says, so signing
// or a default branch name set there cannot change what these see.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
}
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()

const commitVersion = (work, version, message) => {
  fs.writeFileSync(
    path.join(work, 'package.json'),
    `${JSON.stringify({ name: 'lib', version }, null, 2)}\n`,
  )
  fs.writeFileSync(path.join(work, 'note.txt'), message)
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', message)
  return git(work, 'rev-parse', 'HEAD')
}

describe('the check before publishing', () => {
  let directory
  let clone
  let shallow
  const commits = {}

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-check-'))
    const origin = path.join(directory, 'origin.git')
    const work = path.join(directory, 'work')
    git(directory, 'init', '-q', '--bare', '-b', 'main', origin)
    git(directory, 'init', '-q', '-b', 'main', work)

    // The release commit, tagged the way release-please tags it, and under a
    // few other spellings a caller's tags can take.
    commits.release = commitVersion(
      work,
      '0.2.1',
      'chore(main): release lib 0.2.1',
    )
    git(work, 'tag', 'lib-v0.2.1')
    git(work, 'tag', 'v0.2.1')
    git(work, 'tag', '-a', '-m', 'annotated', 'annotated-v0.2.1')
    git(work, 'tag', 'lib-v0.2.2')

    // A commit after it, which is what a later run would check out.
    commits.later = commitVersion(work, '0.2.1', 'docs: a later commit')

    // A prerelease whose identifier carries a v of its own.
    commits.prerelease = commitVersion(
      work,
      '1.0.0-dev.1',
      'chore(main): release lib 1.0.0-dev.1',
    )
    git(work, 'tag', 'lib-v1.0.0-dev.1')

    // A release made by hand on a branch that never reached main.
    git(work, 'checkout', '-q', '-b', 'side')
    commits.side = commitVersion(work, '0.3.0', 'feat: never merged')
    git(work, 'tag', 'v0.3.0')
    git(work, 'checkout', '-q', 'main')

    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', 'main', 'side', '--tags')

    clone = path.join(directory, 'clone')
    git(directory, 'clone', '-q', origin, clone)

    // A checkout the way actions/checkout makes one: one commit deep, with
    // no tags and no other branch.
    shallow = path.join(directory, 'shallow')
    git(
      directory,
      'clone',
      '-q',
      '--depth=1',
      '--no-tags',
      `file://${origin}`,
      shallow,
    )
  })

  after(() => {
    fs.rmSync(directory, { force: true, recursive: true })
  })

  const check = (
    at,
    tagName,
    { cwd = clone, env = {}, script = checks[0] } = {},
  ) => {
    if (at) git(cwd, 'checkout', '-q', '--detach', at)
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...gitEnv,
        DEFAULT_BRANCH: 'main',
        DRY_RUN: 'false',
        REF_TYPE: 'tag',
        TAG_NAME: tagName,
        ...env,
      },
    })
    return { output: result.stdout + result.stderr, status: result.status }
  }

  it('is in both jobs, and the same in each', () => {
    assert.equal(checks.length, 2)
    assert.equal(checks[1], checks[0])
  })

  it('leaves no token on disk, in either job', () => {
    const checkouts = workflow
      .split(/\n(?=\s+- name: )/)
      .filter((step) => /uses: actions\/checkout@/.test(step))

    assert.equal(checkouts.length, 2)
    for (const step of checkouts)
      assert.match(step, /\n\s+persist-credentials: false\n/)
  })

  it('hands both copies the token through the same env', () => {
    const envs = workflow
      .split(/\n(?=\s+- name: )/)
      .filter((step) =>
        step.includes('- name: Check this is the tagged commit'),
      )
      .map((step) => step.slice(0, step.indexOf('run: |')))

    assert.equal(envs.length, 2)
    assert.equal(envs[1], envs[0])
    assert.match(envs[0], /GIT_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(envs[0], /SERVER_URL: \$\{\{ github\.server_url \}\}/)
  })

  it('hands git the token for its own shell, and masks it', () => {
    // A stand-in git ahead of the real one records the configuration each call
    // carries, since a local remote ignores http configuration altogether.
    const bin = fs.mkdtempSync(path.join(directory, 'bin-'))
    const log = path.join(bin, 'calls')
    const real = execFileSync('bash', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim()
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/usr/bin/env bash\nprintf '%s|%s\\n' "\${GIT_CONFIG_PARAMETERS-}" "\${GIT_TERMINAL_PROMPT-}" >> '${log}'\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    const { output, status } = check(commits.release, 'lib-v0.2.1', {
      env: {
        GIT_TOKEN: 'secret-token',
        PATH: `${bin}:${process.env.PATH}`,
        SERVER_URL: 'https://github.com',
      },
    })
    const credential = Buffer.from('x-access-token:secret-token').toString(
      'base64',
    )

    assert.equal(status, 0, output)
    assert.match(output, new RegExp(`::add-mask::${credential}`))
    assert.doesNotMatch(output, /secret-token/)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.ok(calls.length > 0)
    for (const call of calls)
      assert.equal(
        call,
        `'http.https://github.com/.extraheader=AUTHORIZATION: basic ${credential}'|0`,
      )
  })

  it('reaches git as configuration git itself reads', () => {
    const credential = Buffer.from('x-access-token:secret-token').toString(
      'base64',
    )
    const value = execFileSync(
      'git',
      ['config', '--get', 'http.https://github.com/.extraheader'],
      {
        encoding: 'utf8',
        env: {
          ...gitEnv,
          GIT_CONFIG_PARAMETERS: `'http.https://github.com/.extraheader=AUTHORIZATION: basic ${credential}'`,
        },
      },
    ).trim()

    assert.equal(value, `AUTHORIZATION: basic ${credential}`)
  })

  it('passes the commit the tag names', () => {
    const { output, status } = check(commits.release, 'lib-v0.2.1')

    assert.equal(status, 0)
    assert.match(
      output,
      new RegExp(
        `Publishing 0\\.2\\.1 from ${commits.release}, the commit lib-v0\\.2\\.1 names\\.`,
      ),
    )
  })

  it('refuses a later commit, and names both', () => {
    const { output, status } = check(commits.later, 'lib-v0.2.1')

    assert.equal(status, 1)
    assert.match(
      output,
      new RegExp(
        `::error::Refusing to publish: lib-v0\\.2\\.1 is at ${commits.release}, but this run checked out ${commits.later}\\.`,
      ),
    )
  })

  it('follows an annotated tag to its commit', () => {
    const { status } = check(commits.release, 'annotated-v0.2.1')

    assert.equal(status, 0)
  })

  it('reads a tag that carries no component', () => {
    const { status } = check(commits.release, 'v0.2.1')

    assert.equal(status, 0)
  })

  it('reads a prerelease whose identifier contains a v', () => {
    const { output, status } = check(commits.prerelease, 'lib-v1.0.0-dev.1')

    assert.equal(status, 0)
    assert.match(output, /Publishing 1\.0\.0-dev\.1 from /)
  })

  it('refuses a tag the remote does not have', () => {
    const { output, status } = check(commits.release, 'lib-v9.9.9')

    assert.equal(status, 1)
    assert.match(
      output,
      /::error::Refusing to publish: origin has no tag lib-v9\.9\.9\./,
    )
  })

  it('refuses a tag on a commit that is not on the default branch', () => {
    const { output, status } = check(commits.side, 'v0.3.0')

    assert.equal(status, 1)
    assert.match(
      output,
      new RegExp(
        `::error::Refusing to publish: v0\\.3\\.0 is at ${commits.side}, which is not on main\\.`,
      ),
    )
  })

  it('finds the default branch from a shallow checkout of the tag', () => {
    const { output, status } = check(null, 'lib-v1.0.0-dev.1', {
      cwd: shallow,
    })

    assert.equal(status, 0, output)
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'false')
  })

  it('reads the default branch from the remote when the event has none', () => {
    const { output, status } = check(commits.release, 'v0.2.1', {
      env: { DEFAULT_BRANCH: '' },
    })
    const side = check(commits.side, 'v0.3.0', { env: { DEFAULT_BRANCH: '' } })

    assert.equal(status, 0, output)
    assert.equal(side.status, 1)
    assert.match(side.output, /which is not on main\./)
  })

  it('checks a run with no tag against the tag its version would have', () => {
    const passes = check(commits.release, '', { env: { REF_TYPE: 'branch' } })
    const later = check(commits.later, '', { env: { REF_TYPE: 'branch' } })

    assert.equal(passes.status, 0, passes.output)
    assert.match(passes.output, /::warning::.*checks against v0\.2\.1/)
    assert.equal(later.status, 1)
    assert.match(
      later.output,
      new RegExp(
        `::error::Refusing to publish: v0\\.2\\.1 is at ${commits.release}, but this run checked out ${commits.later}\\.`,
      ),
    )
  })

  it('refuses a run with no tag on a commit off the default branch', () => {
    const { output, status } = check(commits.side, '', {
      env: { REF_TYPE: 'branch' },
    })

    assert.equal(status, 1)
    assert.match(output, /which is not on main\./)
  })

  it('lets a dry run go with no tag', () => {
    const { output, status } = check(commits.later, '', {
      env: { DRY_RUN: 'true', REF_TYPE: 'branch' },
    })

    assert.equal(status, 0)
    assert.match(output, /only a dry run may leave out/)
  })

  it('warns when a tag is published from a run on a branch', () => {
    const { output, status } = check(commits.release, 'v0.2.1', {
      env: { REF_TYPE: 'branch' },
    })

    assert.equal(status, 0)
    assert.match(
      output,
      /::warning::Publishing v0\.2\.1 from a run on a branch/,
    )
  })

  it('refuses when package.json disagrees with the tag', () => {
    const { output, status } = check(commits.release, 'lib-v0.2.2')

    assert.equal(status, 1)
    assert.match(
      output,
      /::error::Refusing to publish: lib-v0\.2\.2 names 0\.2\.2, but package\.json carries 0\.2\.1\./,
    )
  })
})
