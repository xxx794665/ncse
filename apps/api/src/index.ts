import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { isAllowedOrigin } from './cors'
import { healthzRoute } from './routes/healthz'

const app = new Hono()

// CORS 雏形：仅白名单 Origin（占位值见 src/cors.ts）放行跨域。
app.use(
  '*',
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : undefined),
    allowHeaders: ['Authorization', 'Content-Type'],
  }),
)

app.route('/', healthzRoute)

export default app
