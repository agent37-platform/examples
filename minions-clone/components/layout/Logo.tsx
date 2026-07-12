/**
 * The Minions wordmark mark: two overlapping rounded squares, slightly rotated,
 * drawn in currentColor so it inherits the near-black foreground ink.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        className="text-foreground"
      >
        <rect
          x="5.5"
          y="5.5"
          width="13"
          height="13"
          rx="3.5"
          transform="rotate(-8 12 12)"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect
          x="9.5"
          y="9.5"
          width="13"
          height="13"
          rx="3.5"
          transform="rotate(8 16 16)"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    </span>
  );
}
