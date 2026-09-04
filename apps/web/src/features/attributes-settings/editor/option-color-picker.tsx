/**
 * The colour picker: eleven chips, shown as chips.
 *
 * ADR-056 closed the set at eleven names precisely so this could be a grid of swatches rather than
 * an eyedropper — a hex picked against a white background is unreadable on a dark one, and a chip
 * is the only place the colour is ever seen. Showing the option's own label inside each swatch
 * means the choice is made against the thing being decided, not against the word "violet".
 */
import { Check } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { useState } from 'react'

import { Chip } from '@/ui/chip.tsx'
import { CHIP_COLORS, type ChipColor } from '@/ui/chip-colors.ts'

export function OptionColorPicker({
  color,
  label,
  onChange,
}: {
  color: ChipColor
  label: string
  onChange: (next: ChipColor) => void
}) {
  const [open, setOpen] = useState(false)
  const preview = label.trim() === '' ? 'Aa' : label

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        className="focus-visible:ring-ring/50 shrink-0 rounded focus-visible:ring-[3px] focus-visible:outline-none"
        aria-label={`Colour for ${preview}: ${color}`}
      >
        <Chip color={color} className="max-w-28">
          {preview}
        </Chip>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="bg-popover z-50 w-56 rounded-md border p-2 shadow-md"
        >
          <div className="grid grid-cols-3 gap-1">
            {CHIP_COLORS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  onChange(candidate)
                  setOpen(false)
                }}
                className="hover:bg-accent focus-visible:ring-ring/50 flex items-center justify-center rounded p-1 focus-visible:ring-[3px] focus-visible:outline-none"
                aria-label={candidate}
              >
                <Chip color={candidate} className="w-full justify-center">
                  {candidate === color ? <Check className="size-3" aria-hidden /> : preview}
                </Chip>
              </button>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
