// Decorative only: the server freezes the pair's order without identifying
// which token is correct. Both mice smile and point back toward their option.
export function JerryTempter({ angel }: { angel: boolean }) {
  const fur = angel ? '#78a9d0' : '#e53935';
  return (
    <span
      className={`tempter tempter-hang ${angel ? 'tempter-blue' : 'tempter-red'}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 88 100" width="62" height="70" focusable="false">
        {angel ? (
          <>
            <path
              d="M43 60 Q22 43 24 66 Q25 76 42 74 M57 60 Q79 43 76 66 Q75 76 59 74"
              fill="#d5e6e9"
            />
            <ellipse
              cx="49"
              cy="8"
              rx="17"
              ry="5"
              fill="none"
              stroke="#e4c883"
              strokeWidth="3"
            />
          </>
        ) : (
          <>
            <path
              d="M57 80 Q84 96 77 61 M77 61 l-7 8 M77 61 l7 8"
              fill="none"
              stroke={fur}
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="M34 25 Q23 9 34 11 L44 27 M55 26 L65 10 Q75 14 65 30"
              fill="#e6b799"
            />
          </>
        )}
        <path
          d="M46 69 Q22 84 35 89"
          fill="none"
          stroke={fur}
          strokeWidth="3"
          strokeLinecap="round"
        />
        <ellipse cx="50" cy="72" rx="15" ry="20" fill={fur} />
        <ellipse cx="48" cy="74" rx="9" ry="14" fill="#efd4ab" />
        <path
          d="M40 86 Q26 91 33 95 L45 95 L47 85 M54 86 L54 95 L67 95 Q74 90 61 87"
          fill={fur}
        />
        <circle cx="29" cy="32" r="16" fill={fur} />
        <circle cx="69" cy="32" r="16" fill={fur} />
        <circle cx="29" cy="32" r="11" fill="#e8b6a6" />
        <circle cx="69" cy="32" r="11" fill="#e8b6a6" />
        <path
          d="M32 35 Q48 19 65 36 L66 48 Q66 65 48 66 Q29 63 31 47 Z"
          fill={fur}
        />
        <ellipse cx="42" cy="43" rx="6" ry="9" fill="#fff0d5" />
        <ellipse cx="56" cy="43" rx="6" ry="9" fill="#fff0d5" />
        <ellipse cx="40" cy="44" rx="2.5" ry="4" fill="#25302e" />
        <ellipse cx="54" cy="44" rx="2.5" ry="4" fill="#25302e" />
        <ellipse cx="48" cy="55" rx="15" ry="9" fill="#efd4ab" />
        <ellipse cx="46" cy="49" rx="5" ry="3" fill="#25302e" />
        <path
          d="M39 56 Q48 65 58 54"
          fill="none"
          stroke="#574138"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M32 51 L22 48 M32 56 L20 57 M62 51 L74 48 M62 55 L75 57"
          stroke="#574138"
          strokeWidth="1"
        />
        {/* One hand grips the edge; the other points toward the answer. */}
        <path
          d="M61 68 Q73 58 69 48 M39 68 Q24 68 18 53"
          fill="none"
          stroke={fur}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d="M22 55 L17 48 L5 48 Q1 46 5 44 L20 44 Q27 46 25 52 Z"
          fill="#efd4ab"
        />
        <path
          d="M65 48 L65 42 Q65 39 68 41 L69 44 L70 40 Q73 38 74 42 L75 47 Q74 54 68 52 Z"
          fill="#efd4ab"
        />
      </svg>
    </span>
  );
}
