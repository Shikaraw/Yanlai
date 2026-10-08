/**
 * Inline icon set (feather-style, 24x24 stroke grid).
 * Bundled locally rather than pulled from an icon package: ~40 tiny paths cost
 * less than a dependency and keep the offline build self-contained.
 */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

const S = ({ size = 18, children, ...rest }: P & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
)

export const Icon = {
  chat: (p: P) => (
    <S {...p}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </S>
  ),
  calendar: (p: P) => (
    <S {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </S>
  ),
  target: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" />
    </S>
  ),
  cards: (p: P) => (
    <S {...p}>
      <rect x="3" y="7" width="13" height="14" rx="2" />
      <path d="M8 3h10a2 2 0 0 1 2 2v12" />
    </S>
  ),
  layers: (p: P) => (
    <S {...p}>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </S>
  ),
  chart: (p: P) => (
    <S {...p}>
      <path d="M3 3v18h18" />
      <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
    </S>
  ),
  folder: (p: P) => (
    <S {...p}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </S>
  ),
  settings: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </S>
  ),
  info: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </S>
  ),
  plus: (p: P) => (
    <S {...p}>
      <path d="M12 5v14M5 12h14" />
    </S>
  ),
  send: (p: P) => (
    <S {...p}>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </S>
  ),
  stop: (p: P) => (
    <S {...p}>
      <rect x="6" y="6" width="12" height="12" rx="1.6" fill="currentColor" stroke="none" />
    </S>
  ),
  close: (p: P) => (
    <S {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </S>
  ),
  minimize: (p: P) => (
    <S {...p}>
      <path d="M5 12h14" />
    </S>
  ),
  maximize: (p: P) => (
    <S {...p}>
      <rect x="5" y="5" width="14" height="14" rx="1.6" />
    </S>
  ),
  restore: (p: P) => (
    <S {...p}>
      <rect x="7" y="4" width="13" height="13" rx="1.6" />
      <path d="M17 17v2.4A1.6 1.6 0 0 1 15.4 21H5.6A1.6 1.6 0 0 1 4 19.4V9.6A1.6 1.6 0 0 1 5.6 8H8" />
    </S>
  ),
  chevron: (p: P) => (
    <S {...p}>
      <path d="M9 18l6-6-6-6" />
    </S>
  ),
  chevronDown: (p: P) => (
    <S {...p}>
      <path d="M6 9l6 6 6-6" />
    </S>
  ),
  search: (p: P) => (
    <S {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </S>
  ),
  trash: (p: P) => (
    <S {...p}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </S>
  ),
  edit: (p: P) => (
    <S {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </S>
  ),
  copy: (p: P) => (
    <S {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </S>
  ),
  refresh: (p: P) => (
    <S {...p}>
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </S>
  ),
  volume: (p: P) => (
    <S {...p}>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </S>
  ),
  volumeOff: (p: P) => (
    <S {...p}>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="m22 9-6 6M16 9l6 6" />
    </S>
  ),
  pause: (p: P) => (
    <S {...p}>
      <path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" stroke="none" />
    </S>
  ),
  play: (p: P) => (
    <S {...p}>
      <path d="M6 3.5 20 12 6 20.5z" fill="currentColor" stroke="none" />
    </S>
  ),
  book: (p: P) => (
    <S {...p}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </S>
  ),
  bulb: (p: P) => (
    <S {...p}>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2z" />
    </S>
  ),
  shuffle: (p: P) => (
    <S {...p}>
      <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
    </S>
  ),
  scroll: (p: P) => (
    <S {...p}>
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2" />
    </S>
  ),
  tree: (p: P) => (
    <S {...p}>
      <path d="M12 3v6M12 9 7 13v3M12 9l5 4v3" />
      <circle cx="12" cy="3" r="1.6" />
      <circle cx="7" cy="16" r="1.6" />
      <circle cx="17" cy="16" r="1.6" />
    </S>
  ),
  pen: (p: P) => (
    <S {...p}>
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </S>
  ),
  quote: (p: P) => (
    <S {...p}>
      <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
      <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 .999 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
    </S>
  ),
  image: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </S>
  ),
  file: (p: P) => (
    <S {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </S>
  ),
  paperclip: (p: P) => (
    <S {...p}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </S>
  ),
  download: (p: P) => (
    <S {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </S>
  ),
  upload: (p: P) => (
    <S {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </S>
  ),
  check: (p: P) => (
    <S {...p}>
      <path d="M20 6 9 17l-5-5" />
    </S>
  ),
  x: (p: P) => (
    <S {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </S>
  ),
  alert: (p: P) => (
    <S {...p}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </S>
  ),
  sparkles: (p: P) => (
    <S {...p}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </S>
  ),
  brain: (p: P) => (
    <S {...p}>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z" />
    </S>
  ),
  clock: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </S>
  ),
  bell: (p: P) => (
    <S {...p}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </S>
  ),
  bellOff: (p: P) => (
    <S {...p}>
      <path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.9 17.9 0 0 1 18 8M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M2 2l20 20" />
    </S>
  ),
  filter: (p: P) => (
    <S {...p}>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </S>
  ),
  grid: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="14" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
    </S>
  ),
  list: (p: P) => (
    <S {...p}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </S>
  ),
  sidebar: (p: P) => (
    <S {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </S>
  ),
  key: (p: P) => (
    <S {...p}>
      <path d="M21 2 19 4M15.5 7.5 19 4l2 2-3.5 3.5M11 11a5 5 0 1 1-7 7 5 5 0 0 1 7-7zm0 0 3-3" />
      <circle cx="7.5" cy="16.5" r=".5" fill="currentColor" />
    </S>
  ),
  cpu: (p: P) => (
    <S {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </S>
  ),
  palette: (p: P) => (
    <S {...p}>
      <circle cx="13.5" cy="6.5" r=".8" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".8" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".8" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".8" fill="currentColor" />
      <path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2.5-2.5c0-.61-.23-1.17-.6-1.6a2.4 2.4 0 0 1 1.85-3.9H17a5 5 0 0 0 5-5 10 10 0 0 0-10-7z" />
    </S>
  ),
  database: (p: P) => (
    <S {...p}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </S>
  ),
  terminal: (p: P) => (
    <S {...p}>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </S>
  ),
  eye: (p: P) => (
    <S {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </S>
  ),
  external: (p: P) => (
    <S {...p}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
    </S>
  ),
  star: (p: P) => (
    <S {...p}>
      <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </S>
  ),
  pin: (p: P) => (
    <S {...p}>
      <path d="M12 17v5M9 10.76V6a3 3 0 0 1 6 0v4.76a2 2 0 0 0 .6 1.4l1.4 1.44A1 1 0 0 1 16.3 16H7.7a1 1 0 0 1-.7-1.7l1.4-1.44a2 2 0 0 0 .6-1.4z" />
    </S>
  ),
  zap: (p: P) => (
    <S {...p}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </S>
  ),
  trend: (p: P) => (
    <S {...p}>
      <path d="m22 7-8.5 8.5-5-5L2 17M16 7h6v6" />
    </S>
  ),
  filter2: (p: P) => (
    <S {...p}>
      <path d="M20 6H10M20 12h-8M20 18h-6M4 6v12M4 6h2M4 18h2" />
    </S>
  ),
  award: (p: P) => (
    <S {...p}>
      <circle cx="12" cy="8" r="6" />
      <path d="m8.2 13.4-1.4 7.3 5.2-2.6 5.2 2.6-1.4-7.3" />
    </S>
  ),
  fire: (p: P) => (
    <S {...p}>
      <path d="M12 2s4 5 4 9a4 4 0 1 1-8 0c0-2 1-3 1-3S7 10 7 13a5 5 0 0 0 10 0c0-4-5-11-5-11z" />
    </S>
  ),
}

export type IconName = keyof typeof Icon

/** Feature → icon mapping used by the composer strip and nav. */
export const FEATURE_ICON: Record<string, IconName> = {
  general: 'chat',
  explain: 'bulb',
  analogy: 'shuffle',
  exam: 'scroll',
  outline: 'tree',
  knowledge: 'layers',
  wronganalysis: 'target',
  plan: 'calendar',
  flashcards: 'cards',
  review: 'refresh',
  essay: 'pen',
  sentence: 'quote',
}
