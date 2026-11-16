// The ember: warm light drifting inside a sphere. It moves slowly at rest,
// swells with your voice, churns while Claude thinks and pulses as it speaks.
// One drawing for both themes; the theme only picks the body, the way the
// lights are blended in, and the edge shading.

const MOODS = {
  starting: { speed: 0.25, glow: 0.35 },
  idle: { speed: 0.3, glow: 0.55 },
  muted: { speed: 0.08, glow: 0.18 },
  listening: { speed: 0.7, glow: 0.9 },
  transcribing: { speed: 1.3, glow: 0.7 },
  thinking: { speed: 1.9, glow: 0.75 },
  speaking: { speed: 0.9, glow: 1 },
  error: { speed: 0.08, glow: 0.25 },
};

// The same lights in both themes: coral, saffron, magenta, a pale highlight.
const BLOBS = [
  { color: '242, 84, 91', a: 0.85, rx: 0.42, ry: 0.3, sx: 1.0, sy: 0.7, off: 0, scale: 0.95 },
  { color: '255, 182, 39', a: 0.8, rx: 0.34, ry: 0.4, sx: -0.8, sy: 1.1, off: 2.1, scale: 0.8 },
  { color: '224, 51, 138', a: 0.6, rx: 0.45, ry: 0.42, sx: 0.6, sy: -0.9, off: 4.4, scale: 0.85 },
  { color: '255, 236, 190', a: 0.7, rx: 0.2, ry: 0.22, sx: 1.4, sy: 1.2, off: 1.3, scale: 0.45, highlight: true },
];

export const ORB_THEMES = {
  // Coals: a dark body, lights added on top so they glow.
  dark: {
    body: ['#7a1f3d', '#4a1230', '#2a0b1f'],
    blend: 'lighter',
    highlightBlend: 'lighter',
    lightAlpha: 1,
    sheen: 'rgba(255, 255, 255, 0.10)',
    edge: 'rgba(20, 4, 14, 0.5)',
  },
  // A pale, warm cream body. Added light would wash out to white on it, so the
  // colours are multiplied into it instead, which keeps them saturated, and
  // the pale highlight is screened so it still reads as light.
  light: {
    body: ['#fff8ee', '#f8e8d4', '#ecd2b8'],
    blend: 'multiply',
    highlightBlend: 'screen',
    lightAlpha: 0.95,
    sheen: 'rgba(255, 255, 255, 0.35)',
    edge: 'rgba(140, 74, 72, 0.32)',
  },
};

export class Orb {
  constructor(canvas, { theme = 'dark' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mood = 'starting';
    this.level = 0;
    this.speed = 0.25;
    this.glow = 0.35;
    this.phase = Math.random() * 100;
    this.last = performance.now();
    this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.setTheme(theme);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  set(mood) {
    this.mood = MOODS[mood] ? mood : 'idle';
  }

  setTheme(theme) {
    this.theme = ORB_THEMES[theme] ? theme : 'dark';
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const target = MOODS[this.mood];
    this.speed += (target.speed - this.speed) * Math.min(1, dt * 4);
    this.glow += (target.glow - this.glow) * Math.min(1, dt * 4);
    if (!this.still) this.phase += dt * this.speed;
    this.draw(now / 1000);
    requestAnimationFrame(this.frame);
  }

  draw(seconds) {
    const { ctx, canvas } = this;
    const look = ORB_THEMES[this.theme];
    const size = canvas.width;
    const r = size / 2;
    const p = this.phase;
    const speaking = this.mood === 'speaking' && !this.still ? 0.5 + 0.5 * Math.sin(seconds * 7.5) : 0;
    const lift = Math.min(1, this.level * 1.6 + speaking * 0.35);

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();

    // The body of the sphere.
    const body = ctx.createRadialGradient(r * 0.8, r * 0.7, r * 0.1, r, r, r);
    body.addColorStop(0, look.body[0]);
    body.addColorStop(0.6, look.body[1]);
    body.addColorStop(1, look.body[2]);
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, size, size);

    // Drifting light.
    for (const b of BLOBS) {
      ctx.globalCompositeOperation = b.highlight ? look.highlightBlend : look.blend;
      const x = r + Math.cos(p * b.sx + b.off) * r * b.rx;
      const y = r + Math.sin(p * b.sy + b.off * 1.7) * r * b.ry;
      const radius = r * b.scale * (0.85 + lift * 0.45);
      const alpha = b.a * look.lightAlpha * (0.25 + this.glow * 0.75);
      const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, `rgba(${b.color}, ${alpha})`);
      light.addColorStop(1, `rgba(${b.color}, 0)`);
      ctx.fillStyle = light;
      ctx.fillRect(0, 0, size, size);
    }

    // A soft highlight and a darker edge give it roundness.
    ctx.globalCompositeOperation = 'source-over';
    const shade = ctx.createRadialGradient(r * 0.75, r * 0.6, r * 0.2, r, r, r);
    shade.addColorStop(0, look.sheen);
    shade.addColorStop(0.7, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, look.edge);
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }
}
