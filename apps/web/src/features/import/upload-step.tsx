/**
 * §6.8 step 1: what are you importing, what shape is it in, and the file.
 */
import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { presetsFor, type ImportSource, type ObjectType } from '@mutuals/core'

import { Button } from '@/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

export function UploadStep({
  objectType,
  onObjectTypeChange,
  source,
  onSourceChange,
  onFile,
  busy,
  error,
}: {
  objectType: ObjectType
  onObjectTypeChange: (next: ObjectType) => void
  source: ImportSource
  onSourceChange: (next: ImportSource) => void
  onFile: (file: File) => void
  busy: boolean
  error: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const presets = presetsFor(objectType)
  const chosen = presets.find((preset) => preset.id === source)
  // Only what can actually be read: vCard is in the dropdown, disabled, but offering `.vcf` in the
  // file picker would let someone choose one and meet a 415 for their trouble.
  const accept = [
    ...new Set(presets.filter((preset) => preset.available).flatMap((preset) => preset.extensions)),
  ].join(',')

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium">What are you importing?</span>
          <select
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={objectType}
            onChange={(event) => {
              onObjectTypeChange(event.target.value as ObjectType)
            }}
          >
            <option value="contact">Contacts</option>
            <option value="organization">Organizations</option>
          </select>
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium">Source format</span>
          <select
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={source}
            onChange={(event) => {
              onSourceChange(event.target.value as ImportSource)
            }}
          >
            {presets.map((preset) => (
              // ADR-096: vCard stays in the list, disabled, so the menu does not change shape the
              // day it lands and move the option people have already learnt.
              <option key={preset.id} value={preset.id} disabled={!preset.available}>
                {preset.label}
                {preset.available ? '' : ' — not yet'}
              </option>
            ))}
          </select>
          {chosen?.unavailableReason === undefined ? null : (
            <span className="text-muted-foreground text-xs">{chosen.unavailableReason}</span>
          )}
        </label>
      </div>

      <div
        className={cn(
          'rounded-lg border-2 border-dashed p-10 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => {
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file !== undefined) onFile(file)
        }}
      >
        <Upload className="text-muted-foreground mx-auto mb-3 size-8" aria-hidden />
        <p className="mb-4 text-sm">Drop a file here, or choose one.</p>

        {/*
          A real file input, labelled and reachable — not a div with a click handler. Playwright's
          `setInputFiles` needs one, a keyboard user needs one, and the visually-hidden-input pattern
          is what keeps the styled button and the accessible control the same element.
        */}
        <input
          ref={input}
          type="file"
          className="sr-only"
          id="import-file"
          accept={accept}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) onFile(file)
            // Cleared so choosing the same file twice fires again — which is exactly what happens
            // when someone fixes the file and re-picks it.
            event.target.value = ''
          }}
        />
        <label htmlFor="import-file">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              input.current?.click()
            }}
          >
            {busy ? 'Reading…' : 'Choose a file'}
          </Button>
        </label>

        <p className="text-muted-foreground mt-4 text-xs">
          {accept.replaceAll(',', ', ')} — up to 10,000 rows
        </p>
      </div>

      {error === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
