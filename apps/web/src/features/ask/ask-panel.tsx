/**
 * §6.1's "Ask anything about your network…", and the answer under it.
 *
 * The part that matters is the "How I searched" section. §4.8 asks that the answer show *which
 * filter it ran* so the user can trust it or correct it, and this renders that filter with the same
 * `describeFilter` the filter bar's chips use — not a second, prettier description of it. So the
 * sentence under the answer is the sentence the chip would show, and the "Open as a table" link
 * lands on a page holding exactly that filter, where it can be edited like any other.
 *
 * That is also why it is worth having: an answer you can open, correct and save as a view is
 * useful, and an answer you can only read is a party trick.
 */
import type { AskResponse, FieldResolver, Filter } from '@mutuals/core'
import { Link } from '@tanstack/react-router'
import { ChevronDown, CornerDownLeft, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useDisplay } from '@/attributes/display-context.tsx'
import { formatCivilDate } from '@/attributes/format.ts'
import { useAttributeDefinitions } from '@/features/records/use-attribute-definitions.ts'
import { ApiError } from '@/lib/api.ts'
import { cn } from '@/lib/utils.ts'
import { recordFieldResolver } from '@/table/fields.ts'
import { describeFilter } from '@/table/filter-bar/sentence.ts'
import { Button } from '@/ui/button.tsx'
import { Chip } from '@/ui/chip.tsx'
import { Input } from '@/ui/input.tsx'
import { Skeleton } from '@/ui/skeleton.tsx'

import { useAsk } from './use-ask.ts'
import { useLlmStats } from './use-llm-stats.ts'

/** §6.1's own words. */
const PLACEHOLDER = 'Ask anything about your network…'

export function AskPanel() {
  const [question, setQuestion] = useState('')
  const ask = useAsk()
  const stats = useLlmStats()

  const disabledReason = stats.data?.enabled === false ? stats.data.disabledReason : null
  const answer = ask.data

  return (
    <div className="border-border bg-card rounded-lg border p-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = question.trim()
          if (trimmed === '' || ask.isPending) return
          ask.mutate({ question: trimmed })
        }}
      >
        <Sparkles className="text-muted-foreground size-4 shrink-0" />
        <Input
          aria-label="Ask the network"
          placeholder={PLACEHOLDER}
          value={question}
          disabled={disabledReason !== null}
          onChange={(event) => setQuestion(event.target.value)}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <Button
          type="submit"
          size="sm"
          disabled={question.trim() === '' || ask.isPending || disabledReason !== null}
        >
          {ask.isPending ? 'Asking…' : 'Ask'}
          <CornerDownLeft className="size-3.5" />
        </Button>
      </form>

      {disabledReason !== null && (
        <p className="text-muted-foreground mt-3 text-sm" role="status">
          {disabledReason}
        </p>
      )}

      {ask.isPending && <Skeleton className="mt-4 h-16 w-full" />}

      {ask.error !== null && !ask.isPending && (
        <AskError error={ask.error} onRetry={() => ask.mutate({ question: question.trim() })} />
      )}

      {answer !== undefined && !ask.isPending && ask.error === null && <Answer answer={answer} />}
    </div>
  )
}

/**
 * The four LLM failures read very differently to a person, so they are not one toast.
 *
 * A spent budget is not an error at all — it is the circuit breaker doing what it was set to do —
 * and offering "try again" there would be a lie. A 504 is the only one worth a retry button.
 */
function AskError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : 500
  const retryable = status === 504 || status >= 500

  return (
    <div className="border-border mt-4 rounded-md border border-dashed p-3" role="alert">
      <p className={cn('text-sm', status === 429 ? 'text-foreground' : 'text-destructive')}>
        {error.message}
      </p>
      {retryable && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

function Answer({ answer }: { answer: AskResponse }) {
  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="ask-answer">
      <p className="text-sm font-medium">{answer.answer}</p>

      {answer.matches.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {answer.matches.map((match) => (
            <li key={match.id}>
              <Link
                to={match.objectType === 'contact' ? '/contacts/$id' : '/organizations/$id'}
                params={{ id: match.id }}
                className="focus-visible:ring-ring rounded-full focus-visible:ring-2 focus-visible:outline-none"
              >
                <Chip color={null}>{match.displayName}</Chip>
              </Link>
            </li>
          ))}
          {answer.total > answer.matches.length && (
            <li className="text-muted-foreground self-center text-xs">
              +{(answer.total - answer.matches.length).toLocaleString('en-GB')} more
            </li>
          )}
        </ul>
      )}

      {answer.filter !== null && <HowISearched answer={answer} />}
    </div>
  )
}

/**
 * §6.1's collapsible "How I searched".
 *
 * Collapsed by default — the answer is what was asked for — but one click away, because a filter
 * nobody can see is a filter nobody can correct, and a wrong one is much easier to spot as
 * `City is Munich` than as a wrong list of names.
 */
function HowISearched({ answer }: { answer: AskResponse }) {
  const [open, setOpen] = useState(false)
  const definitions = useAttributeDefinitions(answer.objectType)
  const { locale } = useDisplay()

  const resolver: FieldResolver = useMemo(
    () => recordFieldResolver(answer.objectType, definitions.data ?? []),
    [answer.objectType, definitions.data],
  )

  const filter = answer.filter ?? []
  const sentences = filter.map((one: Filter) =>
    describeFilter(one, resolver.get(one.field), {
      formatDate: (civil) => formatCivilDate(civil, locale),
    }),
  )

  return (
    <div className="border-border border-t pt-2">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
        How I searched
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {sentences.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No filter — every {answer.objectType === 'contact' ? 'contact' : 'organization'}.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {sentences.map((sentence, index) => (
                <li
                  key={`${sentence.fieldLabel}-${String(index)}`}
                  className="border-border bg-muted/40 rounded-md border px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground">{sentence.fieldLabel}</span>{' '}
                  <span className="text-muted-foreground">{sentence.operator}</span>{' '}
                  <span className="font-medium">
                    {sentence.values.map((value) => value.text).join(sentence.separator)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            The whole point of answering with the ordinary filter model: this link opens the same
            query in the table, where it can be edited, extended and saved as a view (§6.6).
          */}
          <Link
            to={answer.objectType === 'contact' ? '/contacts' : '/organizations'}
            // The array, not a JSON string: the router stringifies structured search values, and
            // that is exactly ADR-032's `?filter=<JSON>` — the API's own query string.
            search={{ filter }}
            className="text-xs underline underline-offset-2"
          >
            Open as a table
          </Link>
        </div>
      )}
    </div>
  )
}
