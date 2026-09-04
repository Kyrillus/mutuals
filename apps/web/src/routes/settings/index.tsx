import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * §6.6's nav has an Account section and an Objects section and no landing page between them, so
 * `/settings` is not a screen — it is the first entry of that nav. Redirecting rather than
 * rendering a third card list keeps one place to change what Settings opens on.
 */
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/profile' })
  },
})
