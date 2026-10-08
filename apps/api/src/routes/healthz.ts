import { Hono } from 'hono'
import type { HealthzResponse } from '@ncse/shared'
import type { Env } from '../types'

export const healthzRoute = new Hono<{ Bindings: Env }>().get('/healthz', (c) => {
  const body: HealthzResponse = {
    status: 'ok',
    service: 'ncse-api',
    time: new Date().toISOString(),
  }
  return c.json(body)
})
