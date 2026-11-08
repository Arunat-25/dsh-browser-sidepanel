/**
 * Mint the local GUI's browser-session cookie for automated probes.
 *
 * The Harness Web GUI authenticates same-origin HTTP with an HMAC-signed cookie
 * (`dsh-auth-<sha256(authority)>`). The signing secret is the profile credential
 * record `client-connection/browser-session` in $DSH_HOME/.credentials.yaml.
 * This helper reproduces that cookie so a probe or curl can reach the GUI and
 * plugin routes without a launch token.
 *
 * Usage:
 *   node tools/auth-cookie.mjs                       # print "Cookie: ..." header
 *   node tools/auth-cookie.mjs --origin http://127.0.0.1:3080
 *   node tools/auth-cookie.mjs --json                # {origin, cookie, name, value, expiresAt}
 */
import { createHmac, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_ORIGIN = 'http://127.0.0.1:3080'
const RECORD_KEY = 'client-connection/browser-session'
const MAX_AGE_DAYS = 30

function parseArgs(argv) {
  const args = { origin: DEFAULT_ORIGIN, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--origin') args.origin = argv[++i]
    else if (value === '--json') args.json = true
  }
  return args
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Pull the `secret` of the browser-session credential record out of the YAML store by indentation. */
function readSecret(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const file = join(home, '.credentials.yaml')
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex(line => line.trim() === `${RECORD_KEY}:`)
  if (start === -1) throw new Error(`${file}: no ${RECORD_KEY} record`)
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\S/u.test(line)) break
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(line)
    if (match) return match[1]
  }
  throw new Error(`${file}: ${RECORD_KEY} has no payload.secret`)
}

const { origin, json } = parseArgs(process.argv.slice(2))
const url = new URL(origin)
const authority = url.host
const secret = Buffer.from(base64urlToBuffer(readSecret()))
const issuedAt = Date.now()
const expiresAt = issuedAt + MAX_AGE_DAYS * 24 * 60 * 60 * 1000
const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const value = `v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}`
const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`

function base64urlToBuffer(text) {
  const padding = '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

if (json) {
  console.log(JSON.stringify({ origin, authority, name, value, expiresAt }, null, 2))
} else {
  console.log(`Cookie: ${name}=${value}`)
}