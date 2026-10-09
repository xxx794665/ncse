import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置（T1-04）：纯 Node 测试（不走 workers 池）。
 * 夹具全部为合成虚构题目（同格式、假内容），不访问网络、不依赖真实题库。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
