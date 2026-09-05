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

  // A fresh workspace has a profile row whose names are empty strings, not nulls — and an empty
  // string renders as nothing at all, which reads as a broken page rather than as a blank field.
  const filled = (value: string | null | undefined): string | null =>
    value === undefined || value === null || value.trim() === '' ? null : value

  const rows: { label: string; value: string | null }[] = [
    { label: 'First name', value: filled(profile.data?.firstName) },
    { label: 'Last name', value: filled(profile.data?.lastName) },
    { label: 'Email', value: filled(profile.data?.email) },
    { label: 'Language', value: filled(profile.data?.language) },
    { label: 'Phone region', value: filled(profile.data?.phoneRegion) },
    { label: 'Time zone', value: filled(profile.data?.timeZone) },
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
