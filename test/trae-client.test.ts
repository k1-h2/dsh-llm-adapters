import { describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseTraeClientStorage, readTraeClientLogin, traeClientDataDirs,
} from '../src/trae-client.ts'

const AES_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])
const AES_SALT = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
  'hex',
)

function sha512(value: Buffer): Buffer {
  return createHash('sha512').update(value).digest()
}

/** The client's own envelope, so the reader is tested against real bytes. */
function encode(payload: unknown): string {
  const keyMaterial = randomBytes(32)
  const derived = sha512(Buffer.concat([sha512(keyMaterial), AES_SALT]))
  const cipher = createCipheriv(
    'aes-128-cbc',
    derived.subarray(0, 16),
    derived.subarray(16, 32),
  )
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const plain = Buffer.concat([sha512(body), body])
  return Buffer.concat([
    AES_MAGIC,
    keyMaterial,
    cipher.update(plain),
    cipher.final(),
  ]).toString('base64')
}

const DEVICE = '2715142696215459'
const EXPIRES_AT = Date.now() + 24 * 3600_000

function userInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'client-token',
    expiredAt: new Date(EXPIRES_AT).toISOString(),
    userId: '234644461881307',
    userRegion: { region: 'CN' },
    account: {
      username: '星喵',
      scope: 'marscode',
      storeRegion: 'CN',
      userTag: 'cn',
    },
    ...overrides,
  }
}

function storage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'iCubeAuthInfo://icube.cloudide': encode(userInfo()),
    [`iCubeAuthInfo://icube-dc:${DEVICE}`]: 'ignored',
    'telemetry.machineId': 'f'.repeat(64),
    ...overrides,
  }
}

describe('Trae client login state', () => {
  it('reads the token, account and device fingerprints from the client envelope', () => {
    const result = parseTraeClientStorage('cn', storage())
    expect(result.status).toMatchObject({
      available: true,
      signedIn: true,
      name: '星喵',
      userId: '234644461881307',
      expiresAt: EXPIRES_AT,
    })
    expect(result.state).toMatchObject({
      region: 'cn',
      token: 'client-token',
      deviceId: DEVICE,
      machineId: 'f'.repeat(64),
    })
    // The settings page only ever receives the status; the token stays server-side.
    expect(JSON.stringify(result.status)).not.toContain('client-token')
  })

  it('reports an expired client token instead of importing it', () => {
    const result = parseTraeClientStorage('cn', storage({
      'iCubeAuthInfo://icube.cloudide': encode(userInfo({
        expiredAt: new Date(Date.now() - 1_000).toISOString(),
      })),
    }))
    expect(result.state).toBeUndefined()
    expect(result.status).toMatchObject({ available: true, signedIn: false })
    expect(result.status.error).toContain('过期')
  })

  it('keeps the two regions apart', () => {
    const other = (region: string) => storage({
      'iCubeAuthInfo://icube.cloudide': encode(userInfo({
        userRegion: { region },
        account: { username: 'Other', scope: 'bytedance', storeRegion: region },
      })),
    })
    expect(parseTraeClientStorage('cn', other('US')).status).toMatchObject({
      signedIn: false,
    })
    expect(parseTraeClientStorage('cn', other('US')).status.error).toContain('国际版')
    expect(parseTraeClientStorage('global', other('CN')).status.error).toContain('国内版')
  })

  it('requires the 16-digit client device id the check-in route accepts', () => {
    const value = storage()
    delete value[`iCubeAuthInfo://icube-dc:${DEVICE}`]
    const result = parseTraeClientStorage('cn', value)
    expect(result.state).toBeUndefined()
    expect(result.status.error).toContain('设备号')
  })

  it('distinguishes a missing login from an unreadable one', () => {
    expect(parseTraeClientStorage('cn', {
      'telemetry.machineId': 'f'.repeat(64),
    }).status).toMatchObject({
      available: true,
      signedIn: false,
      error: expect.stringContaining('尚未登录'),
    })
    expect(parseTraeClientStorage('cn', {
      'iCubeAuthInfo://icube.cloudide': Buffer.from('not-an-envelope').toString('base64'),
    }).status.error).toContain('读取')
  })

  it('finds the CN and international client directories on each platform', () => {
    const win = traeClientDataDirs('cn', {
      platform: 'win32',
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      home: 'C:/Users/x',
    })
    expect(win).toContain(path.join('C:/Users/x/AppData/Roaming', 'Trae CN'))
    expect(traeClientDataDirs('global', {
      platform: 'win32',
      env: { APPDATA: 'C:/Users/x/AppData/Roaming' },
      home: 'C:/Users/x',
    })).toContain(path.join('C:/Users/x/AppData/Roaming', 'Trae'))

    expect(traeClientDataDirs('cn', {
      platform: 'darwin',
      env: {},
      home: '/Users/x',
    })).toContain(path.join('/Users/x', 'Library', 'Application Support', 'Trae CN'))
    expect(traeClientDataDirs('cn', {
      platform: 'linux',
      env: {},
      home: '/home/x',
    })).toContain(path.join('/home/x', '.config', 'Trae CN'))
  })

  it('honours the client directory overrides', () => {
    const dirs = traeClientDataDirs('cn', {
      platform: 'linux',
      env: { DSH_TRAE_CN_CLIENT_DIR: '/custom/cn', DSH_TRAE_CLIENT_DIR: '/custom/all' },
      home: '/home/x',
    })
    expect(dirs.slice(0, 2)).toEqual(['/custom/cn', '/custom/all'])
  })

  it('reads storage.json from the detected directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trae-client-'))
    mkdirSync(path.join(root, 'User', 'globalStorage'), { recursive: true })
    writeFileSync(
      path.join(root, 'User', 'globalStorage', 'storage.json'),
      JSON.stringify(storage()),
      'utf8',
    )
    expect(readTraeClientLogin('cn', {
      platform: 'win32',
      env: { DSH_TRAE_CLIENT_DIR: root },
      home: root,
    }).status).toMatchObject({ available: true, signedIn: true, name: '星喵' })
  })

  it('reports no client when neither the override nor the default path exists', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trae-client-empty-'))
    const result = readTraeClientLogin('cn', {
      platform: 'win32',
      env: {
        DSH_TRAE_CLIENT_DIR: root,
        APPDATA: path.join(root, 'appdata'),
      },
      home: root,
    })
    expect(result.status).toEqual({ available: false, signedIn: false })
  })
})
