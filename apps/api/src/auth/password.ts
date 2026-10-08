/**
 * 密码哈希（T1-03 定稿）：WebCrypto PBKDF2-SHA256，100000 迭代 + 16 字节随机盐 + 32 字节派生键。
 * 存储格式 `pbkdf2$<iterations>$<saltB64>$<hashB64>`：自描述格式，将来提高迭代次数
 * 时可按既有条目的实际参数校验，平滑升级，无需一次性重置全部口令。
 * 选 PBKDF2 而非 bcrypt/scrypt/argon2：Workers 运行时仅内置 WebCrypto，零新增依赖。
 */

/** PBKDF2 迭代次数（OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议下界；调大仅增加注册/登录耗时） */
const ITERATIONS = 100_000
/** 盐长度（字节） */
const SALT_BYTES = 16
/** 派生键长度（字节） */
const KEY_BYTES = 32

/** 迭代数上界：verifyPassword 按存储条目里的迭代数计算，防止脏数据用天文数字放大计算量 */
const MAX_ITERATIONS = 10_000_000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 派生 32 字节键（Base64 存储；salt/迭代数来自调用方，即存储条目或新随机盐） */
async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/** 常量时间比较：按位累积异或后统一判定，不因提前返回泄露匹配前缀。
 *  长度不等时直接 false 可接受：派生键长度固定 32 字节，并非秘密。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}

/** 哈希明文口令，产出 `pbkdf2$<iterations>$<saltB64>$<hashB64>` 存储格式 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const key = await deriveKey(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(key)}`
}

/**
 * 校验明文口令是否与存储哈希匹配。
 * 存储格式损坏（字段数/迭代数/盐或哈希 Base64 非法）一律返回 false 而非抛错：
 * 这不是可恢复的调用方错误，判定「不匹配」即可（错误匹配不可能发生），由登录路径统一回 401。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return false
  }
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > MAX_ITERATIONS) {
    return false
  }
  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = fromBase64(parts[2])
    expected = fromBase64(parts[3])
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) {
    return false
  }
  const actual = await deriveKey(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}
