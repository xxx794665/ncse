import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'

/**
 * 密码哈希纯函数单测（workerd 内真实 WebCrypto；集成行为见 auth.test.ts）。
 * 口令为运行期随机生成（Web Crypto，test-only——运行结束即失效，非可用字面量；
 * T1-12 存量清理，与 api-helpers.TEST_PASSWORD 同一约定，本文件不引 worker 入口故局部生成）。
 */
const TEST_PASSWORD = `test-only-${crypto.randomUUID()}`

/** 错误口令：运行期派生，与正确口令必然不同 */
const WRONG_PASSWORD = `${TEST_PASSWORD}-wrong`

describe('hashPassword / verifyPassword', () => {
  it('存储格式为 pbkdf2$<迭代>$<盐B64>$<哈希B64>，同口令两次哈希互异（随机盐）', async () => {
    const first = await hashPassword(TEST_PASSWORD)
    const second = await hashPassword(TEST_PASSWORD)
    expect(first).toMatch(/^pbkdf2\$100000\$/)
    expect(first.split('$')).toHaveLength(4)
    expect(first).not.toBe(second)
  })

  it('正确口令通过校验，错误口令不通过', async () => {
    const stored = await hashPassword(TEST_PASSWORD)
    expect(await verifyPassword(TEST_PASSWORD, stored)).toBe(true)
    expect(await verifyPassword(WRONG_PASSWORD, stored)).toBe(false)
  })

  it('存储条目格式损坏时判定不匹配而非抛错（含迭代数非法、Base64 非法）', async () => {
    // 口令仅作校验输入载体，被测对象是损坏的存储条目（非法载荷向量，非凭据）
    expect(await verifyPassword(TEST_PASSWORD, 'not-a-hash')).toBe(false)
    expect(await verifyPassword(TEST_PASSWORD, 'pbkdf2$abc$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword(TEST_PASSWORD, 'pbkdf2$0$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword(TEST_PASSWORD, 'pbkdf2$100000$$$')).toBe(false)
  })
})
