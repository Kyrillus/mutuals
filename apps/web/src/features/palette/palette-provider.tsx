/**
 * ⌘K, the `+` in the top bar, and what the palette's actions actually do.
 *
 * One provider around the whole shell rather than a palette per page, because §6.10's shortcut is a
 * property of the window: ⌘K has to work on the follow-ups page too, and a palette mounted inside a
 * route would unmount under its own navigation.
 *
 * The four create actions open the **same dialogs the pages open**, rendered here rather than
 * reimplemented: `AddRecordDialog`, `FollowUpDialog` and `InteractionDialog` all already take
 * `open` and `onOpenChange`, because each of them is opened from more than one place already. A
 * second "Add contact" dialog reachable only from ⌘K is the kind of duplicate that drifts for six
 * months and is then found by a user asking why one of them has a field the other does not.
 *
 * "New interaction" is the one that cannot be answered from here alone: an interaction belongs to a
 * contact (§6.5's Activities tab), so the dialog needs one before it can open. The palette opens it
 * with no contact fixed, and the dialog asks.
 */
import { useNavigate } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { FollowUpDialog } from '@/features/follow-ups/follow-up-dialog.tsx'
import { InteractionDialog } from '@/features/interactions/interaction-dialog.tsx'
import { QuickCaptureDialog } from '@/features/quick-capture/quick-capture-dialog.tsx'
import { AddRecordDialog } from '@/features/records/add-record-dialog.tsx'

import { CommandPalette, type PaletteAction } from './command-palette.tsx'

/** Which dialog the palette has opened, or `null`. One at a time, by construction. */
type OpenDialog =
  | { readonly kind: 'quick-capture' }
  | { readonly kind: 'record'; readonly objectType: 'contact' | 'organization' }
  | { readonly kind: 'follow-up' }
  | { readonly kind: 'interaction' }

interface PaletteApi {
  readonly openPalette: () => void
  readonly openQuickCapture: () => void
}

const PaletteContext = createContext<PaletteApi | null>(null)

export function usePalette(): PaletteApi {
  const api = useContext(PaletteContext)
  if (api === null) throw new Error('usePalette outside PaletteProvider')
  return api
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const navigate = useNavigate()

  const openPalette = useCallback(() => {
    setPaletteOpen(true)
  }, [])
  const openQuickCapture = useCallback(() => {
    setDialog({ kind: 'quick-capture' })
  }, [])

  const closeDialog = useCallback((next: boolean) => {
    if (!next) setDialog(null)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const onAction = useCallback(
    (action: PaletteAction) => {
      switch (action.kind) {
        case 'quick-capture':
          setDialog({ kind: 'quick-capture' })
          return
        case 'new-record':
          setDialog({ kind: 'record', objectType: action.objectType })
          return
        case 'new-follow-up':
          setDialog({ kind: 'follow-up' })
          return
        case 'new-interaction':
          setDialog({ kind: 'interaction' })
          return
        case 'navigate':
          // Already navigated by the palette itself, which owns the router for its own rows.
          return
      }
    },
    [navigate],
  )

  const api = useMemo<PaletteApi>(
    () => ({ openPalette, openQuickCapture }),
    [openPalette, openQuickCapture],
  )

  return (
    <PaletteContext.Provider value={api}>
      {children}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onAction={onAction} />

      <QuickCaptureDialog open={dialog?.kind === 'quick-capture'} onOpenChange={closeDialog} />
      {dialog?.kind === 'record' && (
        <AddRecordDialog
          objectType={dialog.objectType}
          label={dialog.objectType === 'contact' ? 'contact' : 'organization'}
          open
          onOpenChange={closeDialog}
        />
      )}
      <FollowUpDialog open={dialog?.kind === 'follow-up'} onOpenChange={closeDialog} />
      <InteractionDialog open={dialog?.kind === 'interaction'} onOpenChange={closeDialog} />
    </PaletteContext.Provider>
  )
}
