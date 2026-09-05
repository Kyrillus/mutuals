import { useEffect, useRef } from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * The row-selection checkbox.
 *
 * A native `<input type="checkbox">` rather than a Radix primitive: it is the one control that is
 * rendered forty times per screen inside a virtualised body, `indeterminate` is a DOM property
 * that no attribute can express, and the browser's own keyboard and shift-click behaviour is
 * exactly the behaviour wanted. It lives beside the table rather than in `@/ui` because it is
 * sized for a 40px row, not for a form.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean
  indeterminate?: boolean
  onCheckedChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  label: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onCheckedChange}
      className={cn(
        'border-input text-primary accent-primary size-3.5 cursor-pointer rounded-[3px] border align-middle',
        'focus-visible:ring-ring/80 focus-visible:ring-[3px] focus-visible:outline-none',
        className,
      )}
    />
  )
}
