import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/app-shell/page.tsx'
import { useProfile } from '@/hooks/use-profile.ts'
import { Skeleton } from '@/ui/skeleton.tsx'

export const Route = createFileRoute('/settings/profile')({
  component: ProfilePage,
  staticData: { crumb: 'Profile' },
})

function ProfilePage() {
  const profile = useProfile()

  const rows: { label: string; value: string | null }[] = [
    { label: 'First name', value: profile.data?.firstName ?? null },
    { label: 'Last name', value: profile.data?.lastName ?? null },
    { label: 'Email', value: profile.data?.email ?? null },
    { label: 'Language', value: profile.data?.language ?? null },
    { label: 'Phone region', value: profile.data?.phoneRegion ?? null },
    { label: 'Time zone', value: profile.data?.timeZone ?? null },
  ]

  return (
    <div className="max-w-2xl">
      <PageHeader title="Profile" description="Who the app greets, and how it reads your data." />

      {profile.isError ? (
        <p className="text-destructive text-sm">{profile.error.message}</p>
      ) : (
        <dl className="border-border divide-border bg-card divide-y overflow-hidden rounded-lg border">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-4 px-4 py-3">
              <dt className="text-muted-foreground w-40 shrink-0 text-sm">{row.label}</dt>
              <dd className="min-w-0 flex-1 text-sm">
                {profile.isPending ? (
                  <Skeleton className="h-4 w-40" />
                ) : (
                  (row.value ?? <span className="text-muted-foreground">—</span>)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="text-muted-foreground mt-4 text-xs">
        Editing, and the disabled password section §6.6 asks for, arrive with the Settings forms.
        Authentication is out of scope for Phase 1.
      </p>
    </div>
  )
}
