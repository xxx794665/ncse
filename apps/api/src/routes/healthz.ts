import { Hono } from 'hono'
import type { HealthzResponse } from '@ncse/shared'

export const healthzRoute = new Hono().get('/healthz', (c) => {
  const body: HealthzResponse = {
    status: 'ok',
    service: 'ncse-api',
    time: new Date().toISOString(),
  }
  return c.json(body)
})
