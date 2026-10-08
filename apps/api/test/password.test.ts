import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'

/** 密码哈希纯函数单测（workerd 内真实 WebCrypto；集成行为见 auth.test.ts） */
describe('hashPassword / verifyPassword', () => {
  it('存储格式为 pbkdf2$<迭代>$<盐B64>$<哈希B64>，同口令两次哈希互异（随机盐）', async () => {
    const first = await hashPassword('password123')
    const second = await hashPassword('password123')
    expect(first).toMatch(/^pbkdf2\$100000\$/)
    expect(first.split('$')).toHaveLength(4)
    expect(first).not.toBe(second)
  })

  it('正确口令通过校验，错误口令不通过', async () => {
    const stored = await hashPassword('password123')
    expect(await verifyPassword('password123', stored)).toBe(true)
    expect(await verifyPassword('password124', stored)).toBe(false)
  })

  it('存储条目格式损坏时判定不匹配而非抛错（含迭代数非法、Base64 非法）', async () => {
    expect(await verifyPassword('password123', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('password123', 'pbkdf2$abc$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('password123', 'pbkdf2$0$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('password123', 'pbkdf2$100000$$$')).toBe(false)
  })
})
