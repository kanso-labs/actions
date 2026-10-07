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

    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', 'main', '--tags')

    clone = path.join(directory, 'clone')
    git(directory, 'clone', '-q', origin, clone)
  })

  after(() => {
    fs.rmSync(directory, { force: true, recursive: true })
  })

  const check = (at, tagName, script = checks[0]) => {
    git(clone, 'checkout', '-q', '--detach', at)
    const result = spawnSync('bash', ['-e', '-c', script], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...gitEnv, TAG_NAME: tagName },
    })
    return { output: result.stdout + result.stderr, status: result.status }
  }

  it('is in both jobs, and the same in each', () => {
    assert.equal(checks.length, 2)
    assert.equal(checks[1], checks[0])
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

  it('refuses when package.json disagrees with the tag', () => {
    const { output, status } = check(commits.release, 'lib-v0.2.2')

    assert.equal(status, 1)
    assert.match(
      output,
      /::error::Refusing to publish: lib-v0\.2\.2 names 0\.2\.2, but package\.json carries 0\.2\.1\./,
    )
  })
})
