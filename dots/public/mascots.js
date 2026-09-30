// Original blob mascots, drawn as inline SVG so they take any accent color. Each is a body
// path in a 100x100 box plus where its eyes sit.
const MASCOTS = {
  dot: { label: 'Simple dot' },
  bean: {
    label: 'Bean',
    body: 'M34 16C58 6 88 18 88 50C88 78 70 92 48 92C24 92 10 76 12 54C13 40 20 22 34 16Z',
    eyes: [40, 50, 62],
  },
  puff: {
    label: 'Puff',
    body: 'M22 78C10 76 6 62 14 54C8 42 18 30 30 34C32 20 48 14 58 22C68 14 84 22 82 36C94 40 96 58 86 66C90 78 80 88 68 86C60 94 42 94 34 86C28 88 22 84 22 78Z',
    eyes: [38, 52, 64],
  },
  drop: {
    label: 'Drop',
    body: 'M50 6C60 26 86 42 86 64C86 82 70 94 50 94C30 94 14 82 14 64C14 42 40 26 50 6Z',
    eyes: [38, 58, 62],
  },
  pebble: {
    label: 'Pebble',
    body: 'M50 14C80 14 90 24 90 54C90 82 78 90 50 90C22 90 10 82 10 54C10 24 20 14 50 14Z',
    eyes: [36, 50, 64],
  },
  sprout: {
    label: 'Sprout',
    body: 'M50 24C74 24 90 42 90 62C90 82 72 92 50 92C28 92 10 82 10 62C10 42 26 24 50 24Z',
    extra: '<path d="M50 26C50 18 52 12 56 8" stroke="#3f7d32" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M55 10C62 2 76 4 78 10C70 16 60 16 55 10Z" fill="#6cc04a"/>',
    eyes: [38, 58, 62],
  },
};

const ACCENTS = ['#00b1ff', '#fa70ab', '#f5cf69', '#b6d80b', '#fb694a', '#a77bf3', '#b9bdcc'];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex, other, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(other);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`;
}

// Dark text on light accents (yellow, lime), white on the rest.
function inkOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1b1b1b' : '#ffffff';
}

let gradientSeq = 0;

function mascotSvg(shape, color, { size = 80, className = '' } = {}) {
  if (shape === 'dot') return `<svg class="mascot ${className}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><circle class="body" cx="50" cy="50" r="30" fill="none" stroke="${color}" stroke-width="19" /></svg>`;
  const m = MASCOTS[shape] || MASCOTS.bean;
  const id = `mg${gradientSeq++}`;
  const [left, eyeY, right] = m.eyes;
  const eye = (x) =>
    `<g class="eye" style="transform-origin:${x}px ${eyeY}px"><ellipse cx="${x}" cy="${eyeY}" rx="6.5" ry="8" fill="#fff"/><circle class="pupil" cx="${x + 1}" cy="${eyeY + 1.5}" r="3.6" fill="#1b1b1b"/></g>`;
  return `<svg class="mascot ${className}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <defs><radialGradient id="${id}" cx="35%" cy="28%" r="80%">
      <stop offset="0" stop-color="${mix(color, '#ffffff', 0.45)}"/>
      <stop offset="0.55" stop-color="${color}"/>
      <stop offset="1" stop-color="${mix(color, '#000000', 0.22)}"/>
    </radialGradient></defs>
    <g class="body">
      ${m.extra || ''}
      <path d="${m.body}" fill="url(#${id})"/>
      <ellipse cx="32" cy="32" rx="9" ry="5" fill="#fff" opacity="0.35" transform="rotate(-25 32 32)"/>
      <ellipse cx="${left - 4}" cy="${eyeY + 13}" rx="5" ry="3" fill="#ff7a9c" opacity="0.45"/>
      <ellipse cx="${right + 4}" cy="${eyeY + 13}" rx="5" ry="3" fill="#ff7a9c" opacity="0.45"/>
      ${eye(left)}${eye(right)}
      <path d="M${(left + right) / 2 - 5} ${eyeY + 12}Q${(left + right) / 2} ${eyeY + 17} ${(left + right) / 2 + 5} ${eyeY + 12}" stroke="#1b1b1b" stroke-width="2.4" stroke-linecap="round" fill="none"/>
    </g>
  </svg>`;
}
