// Draws the taskbar icons with the bar's own orb (renderer/orb.js), at rest
// with its lights where they look best. Three of them, one per state:
//   idle   the orb alone, no glow
//   hear   a bright glow in the bar's listening colour (--hear-rgb, saffron)
//   speak  a bright glow in the bar's speaking colour (--speak-rgb, coral)
// The colours are read from renderer/style.css by scripts/make-icon.mjs and
// handed in through the page address, so they always match the bar.
// Each size is drawn large and stepped down, so the small ones stay round.
import { Orb } from '../../renderer/orb.js';

// 42 px is what the taskbar draws at 175% scaling (24 x 1.75); without it
// Windows shrinks the 48 px image. 20, 30 and 36 cover 125%, 125% (small
// icons excluded) and 150%.
const SIZES = [256, 64, 48, 42, 40, 36, 32, 30, 24, 20, 16];
const params = new URLSearchParams(location.search);
const VARIANTS = { idle: null, hear: params.get('hear'), speak: params.get('speak') };

// The orb fills the whole icon in every state (asked for: as big as the orb and
// its glow were together). The glow never shrinks it: it is a bright rim
// laid over the orb's own outer edge, an inner glow.
const ORB_SHARE = 1;
function stepDown(source, size) {
  let current = source;
  while (current.width / 2 >= size) {
    const half = document.createElement('canvas');
    half.width = half.height = current.width / 2;
    const ctx = half.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  if (current.width === size) return current;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, size, size);
  return out;
}

function drawIcon(size, glowRgb) {
  const big = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = big;
  const ctx = canvas.getContext('2d');
  const c = big / 2;
  const orbR = c * ORB_SHARE;

  // The orb itself, drawn by the bar's own code.
  const orbCanvas = document.createElement('canvas');
  orbCanvas.width = orbCanvas.height = Math.round(orbR * 2);
  const orb = new Orb(orbCanvas, { theme: 'dark' });
  orb.frame = () => {};
  orb.phase = 1.15;
  orb.glow = 0.8;
  orb.level = 0;
  orb.draw(0);
  ctx.drawImage(orbCanvas, c - orbR, c - orbR);

  if (glowRgb) {
    // Brightest at the very edge, fading inward over the orb. Wider in
    // proportion at small sizes, so it is still a clear line at 16 px.
    const band = size <= 16 ? 0.34 : size <= 24 ? 0.28 : size <= 48 ? 0.22 : 0.16;
    const glow = ctx.createRadialGradient(c, c, orbR * (1 - band), c, c, orbR);
    glow.addColorStop(0, `rgba(${glowRgb}, 0)`);
    glow.addColorStop(0.45, `rgba(${glowRgb}, 0.55)`);
    glow.addColorStop(0.8, `rgba(${glowRgb}, 0.95)`);
    glow.addColorStop(1, `rgba(${glowRgb}, 1)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c, c, orbR, 0, Math.PI * 2);
    ctx.fill();
  }
  return stepDown(canvas, size);
}

const images = {};
for (const [name, rgb] of Object.entries(VARIANTS)) {
  images[name] = {};
  for (const size of SIZES) images[name][size] = drawIcon(size, rgb).toDataURL('image/png');
}
window.iconImages = images;
