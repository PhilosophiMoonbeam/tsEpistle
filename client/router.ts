import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { wikiStore } from './store/index.ts'
import { loadingStart, loadingStop } from './helpers/root-ui-store'

const adminRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./components/admin/admin-dashboard.vue') },
  { path: '/general', component: () => import('./components/admin/admin-general.vue') },
  { path: '/locale', component: () => import('./components/admin/admin-locale.vue') },
  { path: '/navigation', component: () => import('./components/admin/admin-navigation.vue') },
  { path: '/pages', component: () => import('./components/admin/admin-pages.vue') },
  { path: '/pages/:id(\\d+)', component: () => import('./components/admin/admin-pages-edit.vue') },
  { path: '/pages/visualize', component: () => import('./components/admin/admin-pages-visualize.vue') },
  { path: '/tags', component: () => import('./components/admin/admin-tags.vue') },
  { path: '/theme', component: () => import('./components/admin/admin-theme.vue') },
  { path: '/groups', component: () => import('./components/admin/admin-groups.vue') },
  { path: '/groups/:id(\\d+)', component: () => import('./components/admin/admin-groups-edit.vue') },
  { path: '/users', component: () => import('./components/admin/admin-users.vue') },
  { path: '/users/:id(\\d+)', component: () => import('./components/admin/admin-users-edit.vue') },
  { path: '/analytics', component: () => import('./components/admin/admin-analytics.vue') },
  { path: '/auth', component: () => import('./components/admin/admin-auth.vue') },
  { path: '/comments', component: () => import('./components/admin/admin-comments.vue') },
  { path: '/rendering', component: () => import('./components/admin/admin-rendering.vue') },
  { path: '/editor', component: () => import('./components/admin/admin-editor.vue') },
  { path: '/extensions', component: () => import('./components/admin/admin-extensions.vue') },
  { path: '/logging', component: () => import('./components/admin/admin-logging.vue') },
  { path: '/search', component: () => import('./components/admin/admin-search.vue') },
  { path: '/agents', component: () => import('./components/admin/admin-agents.vue') },
  { path: '/storage', component: () => import('./components/admin/admin-storage.vue') },
  { path: '/api', component: () => import('./components/admin/admin-api.vue') },
  { path: '/mail', component: () => import('./components/admin/admin-mail.vue') },
  { path: '/security', component: () => import('./components/admin/admin-security.vue') },
  { path: '/ssl', component: () => import('./components/admin/admin-ssl.vue') },
  { path: '/system', component: () => import('./components/admin/admin-system.vue') },
  { path: '/utilities', component: () => import('./components/admin/admin-utilities.vue') },
  { path: '/webhooks', component: () => import('./components/admin/admin-webhooks.vue') },
  { path: '/dev-flags', component: () => import('./components/admin/admin-dev-flags.vue') }
]

const profileRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/profile' },
  { path: '/profile', component: () => import('./components/profile/profile.vue') },
  { path: '/pages', component: () => import('./components/profile/pages.vue') }
]

const isAdmin = window.location.pathname === '/a' || window.location.pathname.startsWith('/a/')
const isProfile = window.location.pathname === '/p' || window.location.pathname.startsWith('/p/')
const profileLoadingKey = 'profile'

export const router = createRouter({
  history: createWebHistory(isAdmin ? '/a' : isProfile ? '/p' : '/'),
  routes: isAdmin ? adminRoutes : isProfile ? profileRoutes : []
})

if (isProfile) {
  router.beforeEach(() => {
    loadingStart(wikiStore, profileLoadingKey)
  })
  router.afterEach(() => {
    loadingStop(wikiStore, profileLoadingKey)
  })
}
