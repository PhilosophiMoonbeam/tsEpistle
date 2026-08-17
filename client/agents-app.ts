import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { z } from 'zod'

import AgentShell from './components/agents/agent-shell.vue'

const AgentBootstrapSchema = z.object({
  csrfToken: z.string().min(32).max(128),
  isAdmin: z.boolean(),
  userId: z.number().int().positive()
}).strict()

const root = document.querySelector<HTMLElement>('#agent-root')
if (!root) throw new Error('Agent application root is unavailable')

const bootstrap = AgentBootstrapSchema.parse(JSON.parse(root.dataset.bootstrap ?? ''))

const app = createApp(AgentShell, { bootstrap })
app.use(createPinia())
app.use(createVuetify({ components, directives }))
app.mount(root)
