/**
 * §6.5's Summary card.
 *
 * Three states, and the third is the one that matters: empty until generated, the summary once it
 * exists, and **the date it was written**. A summary of somebody you have met three times since is
 * not wrong, it is stale — and only the timestamp tells the reader which, which is why §6.5 asks
 * for it and why "Regenerate" sits next to it rather than in a menu.
 *
 * Generating costs money (ADR-070), so it is a button and never an effect. Nothing on this page
 * triggers a model call by being looked at.
 */
import { ContactSummarySchema, type ContactSummary } from '@mutuals/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Sparkles } from 'lucide-react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatDateTime } from '@/attributes/format.ts'
import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import { Button } from '@/ui/button.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

export function SummaryCard({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient()
  const { locale, timeZone } = useDisplay()

  const summary = useQuery({
    queryKey: qk.contactSummary(contactId),
    queryFn: ({ signal }) =>
      api.get(ContactSummarySchema, `/contacts/${contactId}/summary`, { signal }),
  })

  const generate = useMutation({
    mutationFn: () => api.post(ContactSummarySchema, `/contacts/${contactId}/summary`, {}),
    onSuccess: (next: ContactSummary) => {
      queryClient.setQueryData(qk.contactSummary(contactId), next)
    },
  })

  const text = summary.data?.summary ?? null
  const generatedAt = summary.data?.generatedAt ?? null

  return (
    <article className="rounded-lg border p-4">
      <header className="mb-1 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">Summary</h3>
        {text !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={generate.isPending}
            onClick={() => {
              generate.mutate()
            }}
          >
            <RefreshCw className={generate.isPending ? 'size-3 animate-spin' : 'size-3'} />
            Regenerate
          </Button>
        )}
      </header>

      {summary.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : text === null ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground text-sm">
            Two or three sentences on who this person is and what they need, written from their
            fields, their recent activity and their open follow-ups.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={generate.isPending}
            onClick={() => {
              generate.mutate()
            }}
          >
            {generate.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {generate.isPending ? 'Writing…' : 'Write a summary'}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm">{text}</p>
          {generatedAt !== null && (
            <p className="text-muted-foreground mt-2 text-xs">
              Written {formatDateTime(generatedAt, locale, timeZone)}
            </p>
          )}
        </>
      )}

      {generate.error !== null && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {generate.error.message}
        </p>
      )}
    </article>
  )
}
