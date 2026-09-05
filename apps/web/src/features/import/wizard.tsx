/**
 * §6.8's wizard: the state machine, and the one place that knows what each step does next.
 *
 * The batch lives on the server (ADR-054), so this holds almost nothing: the current step, the
 * `File` the browser already has, and which tab of the Review grid is open. Everything else is read
 * from the query cache where the mutations put it, which is ADR-049's second home — a wizard is
 * exactly the kind of screen that grows a parallel copy of server state if nobody stops it.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ImportBatchDetail, ImportSource, ObjectType } from '@mutuals/core'

import { ApiError } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'
import { Button } from '@/ui/button.tsx'

import {
  commitImport,
  downloadCsv,
  getImportBatch,
  getImportErrorReport,
  replaceInImport,
  revertImportRow,
  updateImportMapping,
  updateImportRow,
  uploadImport,
} from './import-api.ts'
import { MappingStep } from './mapping-step.tsx'
import { ReviewStep, type ReviewTab } from './review-step.tsx'
import { SheetStep, DoneStep } from './sheet-and-done.tsx'
import { Stepper, type ImportStep } from './stepper.tsx'
import { UploadStep } from './upload-step.tsx'

export function ImportWizard({ initialObjectType }: { initialObjectType: ObjectType }) {
  const client = useQueryClient()

  const [step, setStep] = useState<ImportStep>('upload')
  const [objectType, setObjectType] = useState<ObjectType>(initialObjectType)
  const [source, setSource] = useState<ImportSource>('generic')
  const [batchId, setBatchId] = useState<string | null>(null)
  /** Kept so step 2 can re-post it: the server stages rows, not uploads. */
  const [file, setFile] = useState<File | null>(null)
  const [tab, setTab] = useState<ReviewTab>('all')
  const [uploadError, setUploadError] = useState<string | null>(null)

  const rowQuery = {
    onlyErrors: tab === 'errors',
    onlyDuplicates: tab === 'duplicates',
  }

  const detail = useQuery({
    queryKey: qk.importBatchRows(batchId ?? '', rowQuery),
    queryFn: ({ signal }) => getImportBatch(batchId as string, rowQuery, signal),
    enabled: batchId !== null,
    /**
     * Poll until the batch reaches a terminal state, once the user has committed.
     *
     * Not `status === 'importing'`, which is what this said first and which never polled at all:
     * `commitImportBatch` only *enqueues*, and its response is a job id rather than the batch — so
     * at the moment the wizard reaches the Done screen the cached status is still `reviewing`, the
     * predicate is false, and the result screen sits on zeroes for ever while the import quietly
     * succeeds behind it. Keying on the step is what actually covers the transition.
     *
     * §6.8 wants a progress bar, and the job advances `last_committed_row` per chunk (ADR-061), so
     * this reads the state machine that ADR already put there rather than inventing a channel.
     */
    refetchInterval: (query) => {
      if (step !== 'done') return false
      const status = query.state.data?.batch.status
      return status === 'completed' || status === 'failed' ? false : 400
    },
  })

  /** Everything a mutation returns is the whole batch, so one helper puts it back in the cache. */
  const put = (next: ImportBatchDetail): void => {
    client.setQueryData(qk.importBatchRows(next.batch.id, rowQuery), next)
    void client.invalidateQueries({ queryKey: qk.importBatch(next.batch.id) })
  }

  const failed = (error: unknown): void => {
    toast.error(error instanceof ApiError ? error.message : 'Something went wrong.')
  }

  const upload = useMutation({
    mutationFn: (input: { file: File; sheetName?: string }) =>
      uploadImport({
        file: input.file,
        objectType,
        source,
        ...(input.sheetName === undefined ? {} : { sheetName: input.sheetName }),
      }),
    onSuccess: (next) => {
      setUploadError(null)
      setBatchId(next.batch.id)
      client.setQueryData(qk.importBatchRows(next.batch.id, rowQuery), next)
      // Step 2 only exists for a workbook with a choice to make.
      setStep(next.batch.sheets.length > 1 ? 'sheet' : 'map')
    },
    onError: (error: unknown) => {
      setUploadError(error instanceof ApiError ? error.message : 'That file could not be read.')
    },
  })

  const mapping = useMutation({
    mutationFn: (patch: Parameters<typeof updateImportMapping>[1]) =>
      updateImportMapping(batchId as string, patch),
    onSuccess: put,
    onError: failed,
  })

  const editRow = useMutation({
    mutationFn: (input: { rowNumber: number; values: Record<string, string> }) =>
      updateImportRow(batchId as string, input.rowNumber, { values: input.values }),
    onSuccess: put,
    onError: failed,
  })

  const decide = useMutation({
    mutationFn: (input: { rowNumber: number; decision: string | null }) =>
      updateImportRow(batchId as string, input.rowNumber, { decision: input.decision }),
    onSuccess: put,
    onError: failed,
  })

  const revert = useMutation({
    mutationFn: (rowNumber: number) => revertImportRow(batchId as string, rowNumber),
    onSuccess: put,
    onError: failed,
  })

  const replace = useMutation({
    mutationFn: (input: { targetId: string; find: string; replace: string }) =>
      replaceInImport(batchId as string, input),
    onSuccess: async (result) => {
      toast.success(
        result.count === 0
          ? 'Nothing matched.'
          : `Replaced in ${String(result.count)} ${result.count === 1 ? 'row' : 'rows'}.`,
      )
      await client.invalidateQueries({ queryKey: qk.importBatch(batchId ?? '') })
    },
    onError: failed,
  })

  const commit = useMutation({
    mutationFn: (bulkDecision?: string) =>
      commitImport(batchId as string, bulkDecision === undefined ? {} : { bulkDecision }),
    onSuccess: async () => {
      setStep('done')
      await client.invalidateQueries({ queryKey: qk.importBatch(batchId ?? '') })
    },
    onError: failed,
  })

  const report = useMutation({
    mutationFn: () => getImportErrorReport(batchId as string),
    onSuccess: (result) => {
      downloadCsv(result.fileName, result.csv)
    },
    onError: failed,
  })

  const batch = detail.data?.batch
  const busy =
    upload.isPending ||
    mapping.isPending ||
    editRow.isPending ||
    decide.isPending ||
    revert.isPending ||
    commit.isPending

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="space-y-4">
        <h1 className="text-xl font-medium">Import {objectType}s</h1>
        <Stepper current={step} showSheet={(batch?.sheets.length ?? 0) > 1} />
      </div>

      {step === 'upload' ? (
        <UploadStep
          objectType={objectType}
          onObjectTypeChange={setObjectType}
          source={source}
          onSourceChange={setSource}
          busy={upload.isPending}
          error={uploadError}
          onFile={(chosen) => {
            setFile(chosen)
            upload.mutate({ file: chosen })
          }}
        />
      ) : null}

      {step === 'sheet' && batch !== undefined ? (
        <SheetStep
          batch={batch}
          busy={upload.isPending}
          onChoose={(sheetName) => {
            if (file !== null) upload.mutate({ file, sheetName })
          }}
        />
      ) : null}

      {step === 'map' && batch !== undefined ? (
        <MappingStep
          batch={batch}
          busy={busy}
          onChangeColumn={(index, targetId) => {
            mapping.mutate({ columns: { [String(index)]: targetId } })
          }}
          onChangeValueMap={(targetId, value, optionKey) => {
            const current = batch.valueMappings.find((one) => one.targetId === targetId)
            const next: Record<string, string> = {}
            for (const entry of current?.values ?? []) {
              if (entry.mappedTo !== null) next[entry.value] = entry.mappedTo
            }
            if (optionKey === null) delete next[value]
            else next[value] = optionKey
            mapping.mutate({ valueMap: { [targetId]: next } })
          }}
        />
      ) : null}

      {step === 'review' && batch !== undefined ? (
        <ReviewStep
          batch={batch}
          rows={detail.data?.rows ?? []}
          tab={tab}
          onTabChange={setTab}
          busy={busy}
          onEdit={(rowNumber, targetId, value) => {
            editRow.mutate({ rowNumber, values: { [targetId]: value } })
          }}
          onRevert={(rowNumber) => {
            revert.mutate(rowNumber)
          }}
          onDecide={(rowNumber, decision) => {
            decide.mutate({ rowNumber, decision })
          }}
          onBulkDecide={(decision) => {
            for (const row of detail.data?.rows ?? []) {
              if (row.duplicate !== null) decide.mutate({ rowNumber: row.rowNumber, decision })
            }
          }}
          onReplace={(input) => {
            replace.mutate(input)
          }}
        />
      ) : null}

      {step === 'done' && batch !== undefined ? (
        <DoneStep
          batch={batch}
          busy={report.isPending}
          onDownloadReport={() => {
            report.mutate()
          }}
        />
      ) : null}

      <Footer
        step={step}
        batch={batch}
        busy={busy}
        onBack={() => {
          setStep(step === 'review' ? 'map' : step === 'map' ? 'upload' : 'upload')
        }}
        onNext={() => {
          setStep(step === 'sheet' ? 'map' : 'review')
        }}
        onImport={() => {
          commit.mutate(undefined)
        }}
      />
    </div>
  )
}

function Footer({
  step,
  batch,
  busy,
  onBack,
  onNext,
  onImport,
}: {
  step: ImportStep
  batch: ImportBatchDetail['batch'] | undefined
  busy: boolean
  onBack: () => void
  onNext: () => void
  onImport: () => void
}) {
  if (step === 'upload' || step === 'done' || batch === undefined) return null

  const counts = batch.counts
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <Button variant="ghost" onClick={onBack} disabled={busy}>
        Back
      </Button>

      {step === 'review' ? (
        <div className="flex items-center gap-3">
          {/*
            §6.8: "the button says so". The skipped count is part of the label rather than a
            footnote, because it is the thing a person needs to notice before clicking.
          */}
          <Button onClick={onImport} disabled={busy || counts.willImport === 0}>
            Import {counts.willImport} {counts.willImport === 1 ? 'row' : 'rows'}
            {counts.willSkip > 0 ? ` (${String(counts.willSkip)} will be skipped)` : ''}
          </Button>
        </div>
      ) : (
        <Button onClick={onNext} disabled={busy}>
          {step === 'map' ? 'Confirm mapping' : 'Continue'}
        </Button>
      )}
    </div>
  )
}
