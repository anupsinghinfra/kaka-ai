interface StatusBadgeProps {
  status: string
}

/** active = green, paused = dim, unknown = gray; other statuses render gold. */
export function StatusBadge({ status }: StatusBadgeProps) {
  const tone =
    status === 'active'
      ? 'border-good/50 bg-good/10 text-good'
      : status === 'paused'
        ? 'border-edge bg-raised text-muted'
        : status === 'unknown'
          ? 'border-edge bg-raised text-faint'
          : 'border-gold/50 bg-gold/10 text-gold'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] ${tone}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  )
}
