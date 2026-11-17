/** One package that is both the messenger plugin and the bundle that mounts it. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Session messenger package', () => {
  it('declares one parseable layer that mounts this package itself', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name: string
      private?: boolean
      icon?: string
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-tools': expect.stringMatching(/^\^0\.2\./),
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as {
      id?: string
      insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
    }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted).toEqual([{
      id: 'session-messenger',
      name: manifest.name,
      config: { maxMessageBytes: 65536, maxTargets: 50 },
    }])
  })
})
