import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { devToolsPortOf, existingDevToolsPort } from '../src/trae-login.ts'

function profile(): string {
  return mkdtempSync(path.join(tmpdir(), 'trae-login-test-'))
}

describe('Trae login browser profiles', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })))
  })

  it('removes the port file a killed browser left behind', async () => {
    const directory = profile()
    // A killed browser leaves this file; the port no longer answers.
    writeFileSync(path.join(directory, 'DevToolsActivePort'), '1\n/devtools/browser/dead\n')
    expect(devToolsPortOf(directory)).toBe(1)
    // Reading it again made the next launch attach to a dead endpoint, time out
    // after 25 s and then close the window it had just opened.
    expect(await existingDevToolsPort(directory)).toBeUndefined()
    expect(() => readFileSync(path.join(directory, 'DevToolsActivePort'))).toThrow()
    rmSync(directory, { recursive: true, force: true })
  })

  it('reuses a browser that still answers on its port', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"Browser":"test"}')
    })
    servers.push(server)
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const directory = profile()
    writeFileSync(path.join(directory, 'DevToolsActivePort'), `${port}\n/devtools/browser/live\n`)
    expect(await existingDevToolsPort(directory)).toBe(port)
    expect(devToolsPortOf(directory)).toBe(port)
    rmSync(directory, { recursive: true, force: true })
  })

  it('ignores a malformed port file and clears it', async () => {
    const directory = profile()
    writeFileSync(path.join(directory, 'DevToolsActivePort'), 'not-a-port\n')
    expect(devToolsPortOf(directory)).toBeUndefined()
    expect(await existingDevToolsPort(directory)).toBeUndefined()
    expect(() => readFileSync(path.join(directory, 'DevToolsActivePort'))).toThrow()
    rmSync(directory, { recursive: true, force: true })
  })
})
