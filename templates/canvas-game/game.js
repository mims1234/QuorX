// Canvas game plumbing only: a delta-time loop, title / play / pause / game-over states, keyboard + mouse +
// touch input, WebAudio sound, particles and screen shake. There is NO gameplay here on purpose:
// design your own game and write it in the three hooks below (newGame, update, draw), or replace the file.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const DPR = Math.min(2, devicePixelRatio || 1);
let W = 0, H = 0; // size in CSS pixels; draw in these units
function resize() { W = innerWidth; H = innerHeight; canvas.width = W * DPR; canvas.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); }
addEventListener('resize', resize); resize();

// ---------- input ----------
const keys = new Set();            // keys held down (lower case: 'a', 'arrowleft', ' ')
const pressed = new Set();         // keys pressed this frame
const pointer = { x: 0, y: 0, down: false, clicked: false };
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (!keys.has(k)) pressed.add(k);
  keys.add(k);
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if ((k === ' ' || k === 'enter') && state !== 'playing' && state !== 'paused') start();
  if (k === 'p' || k === 'escape') togglePause();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
const at = (e) => { pointer.x = e.clientX; pointer.y = e.clientY; };
canvas.addEventListener('pointerdown', (e) => { at(e); pointer.down = true; pointer.clicked = true; if (state === 'title' || state === 'over') start(); });
addEventListener('pointermove', at);
addEventListener('pointerup', () => { pointer.down = false; });

// ---------- sound (no audio files needed) ----------
let audio;
function tone(freq = 440, ms = 90, type = 'square', vol = 0.05, slideTo = null) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + ms / 1000);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + ms / 1000);
  } catch { /* no audio */ }
}

// ---------- polish helpers ----------
let particles = [], shake = 0;
function burst(x, y, color = '#fff', n = 16, speed = 220) {
  for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random()); particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4 + Math.random() * 0.5, color }); }
}
function addShake(amount = 8) { shake = Math.max(shake, amount); }
function stepParticles(dt) { for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt; } particles = particles.filter((p) => p.life > 0); }
function drawParticles() { for (const p of particles) { ctx.globalAlpha = Math.min(1, p.life * 2); ctx.fillStyle = p.color; ctx.fillRect(p.x - 2, p.y - 2, 4, 4); } ctx.globalAlpha = 1; }
function text(t, x, y, size, align = 'center', color = '#e8eeea', weight = 600) { ctx.fillStyle = color; ctx.font = `${weight} ${size}px system-ui, sans-serif`; ctx.textAlign = align; ctx.fillText(t, x, y); }

// ---------- states ----------
let state = 'title'; // title → playing ⇄ paused → over → playing
let best = 0; try { best = Number(localStorage.getItem('best') || 0); } catch { /* storage blocked */ }
let game = null;     // everything about one run of your game lives here
function start() { game = newGame(); particles = []; state = 'playing'; tone(520, 120, 'triangle', 0.05, 880); }
function gameOver(score = 0) { state = 'over'; best = Math.max(best, score); try { localStorage.setItem('best', best); } catch { /* storage blocked */ } tone(300, 400, 'sawtooth', 0.04, 80); addShake(10); }
function togglePause() { if (state === 'playing') state = 'paused'; else if (state === 'paused') state = 'playing'; }
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') state = 'paused'; });

// ================= YOUR GAME: replace these three hooks =================
const TITLE = 'Your game';
const CONTROLS = 'Describe the controls here · Space or tap to start · P to pause';
function newGame() { return { score: 0 }; }               // the state of a fresh run
function update(dt) { /* move things, handle input, score, call gameOver(game.score) */ }
function draw() { /* draw the world for the current game */ }
// ========================================================================

function frame(now) {
  const dt = Math.min(0.05, (now - (frame.last ?? now)) / 1000); frame.last = now;
  if (state === 'playing') update(dt);
  stepParticles(dt); shake = Math.max(0, shake - 40 * dt);
  ctx.save();
  if (shake) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  ctx.fillStyle = '#0b0f0d'; ctx.fillRect(-20, -20, W + 40, H + 40);
  if (game) draw();
  drawParticles();
  ctx.restore();
  if (state === 'title') { text(TITLE, W / 2, H / 2 - 24, 40, 'center', '#e8eeea', 800); text(CONTROLS, W / 2, H / 2 + 18, 15, 'center', '#94a39b', 500); }
  if (state === 'paused') text('Paused · press P', W / 2, H / 2, 28);
  if (state === 'over') { text('Game over', W / 2, H / 2 - 20, 38, 'center', '#e5484d', 800); text(`Best ${best} · Space or tap to play again`, W / 2, H / 2 + 22, 15, 'center', '#94a39b', 500); }
  pressed.clear(); pointer.clicked = false;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
