/* draw.js — Glyphs Phase 5 `draw` world (the turtle canvas).
   Registers as the 'draw' state with window.Glyphs.state.

   A turtle on a canvas. Every letter does something visual; the
   mappings are associative where possible, and any letter without a
   natural association still does something visible. The child never
   has to memorize anything — mashing produces drawings.

   ── THE KEY MAP ───────────────────────────────────────────────────
     a   arc        quarter-circle curving left (the gentle left turn)
     b   bigger     the turtle grows; past the biggest it pops back small
     c   circle     a circle traced beside the turtle; ends where it began
     d   dot        a filled dot right here
     e   egg        lays a small ellipse, then hops ahead of it
     f   fast       three quick dashes forward (a dashed sprint)
     g   grow trail the trail gets thicker (stamps a dot to show it);
                    past the thickest it snaps back thin
     h   home       hop to the center, face up, size + trail reset
     i   an i       a short stick with a dot floating above it
     j   jump       a long hop forward, no trail
     k   kite       a diamond ahead with a little zigzag tail behind
     l   line       step forward, drawing
     m   mountain   two sharp peaks
     n   arch       one rounded hump (the shape of an n)
     o   ring       a circle centered on the turtle (a big O around it)
     p   PALETTE    (reserved) the color picker overlay
     q   square     traced ahead; ends where it began
     r   right      turn right 45° (eight compass headings)
     s   spiral     winds outward; the turtle rides it to the end
     t   triangle   traced ahead; ends where it began
     u   u-turn     a half-circle that leaves the turtle facing back
     v   vee        two whiskers splayed forward (a V from the nose)
     w   wave       one smooth sine wave forward
     x   CLEAR      (reserved) wipes the canvas; the turtle stays put
     y   branch     a trunk that forks into two twigs; the turtle climbs
                    a random one — mashing y grows a wandering tree
     z   zigzag     four sharp strokes forward
     R   Shift+R    rainbow mode on/off — hue cycles as the turtle moves
     spc scoot      forward without drawing (the classic pen-up step)
     1–2            that many rays out from the turtle
     3–9            a polygon with that many sides (3 = triangle, ...)
     0              a ten-ray starburst
     ←/→ turn       like a / r without drawing;  ↑ draws forward,
     ↓              draws backward (the turtle moonwalks)
     anything else  a tiny turtle pop + a near-silent click
   ──────────────────────────────────────────────────────────────────

   Color: starts phosphor green. A small square in the bottom-left
   shows the trail color (click it to open the palette too). `p` opens
   the palette overlay: ROYGBIV squares with their letters inside,
   plus a hidden tier — C cyan, M magenta, W white — that works but
   isn't shown. Press a color's letter → palette closes, indicator
   changes, trail uses the color. Any other key just closes the
   palette (absorbed, never punished). Shift+R toggles rainbow mode;
   the indicator becomes an animated gradient while it's on.

   The turtle itself stays bright phosphor green (it's the machine's
   creature); the trail is softer — lower alpha, small glow — so the
   turtle always stands out.

   No word handling: inside draw, letters are letters. This module
   never touches window.Glyphs.audio or any speech of any kind. The
   small sound effects are synthesized here with the Web Audio API;
   pitch follows the action (bigger shape → lower note).

   ESC is handled by the router (state.js) — never here. Exit cancels
   rAF and listeners-in-flight but KEEPS the drawing, so it's still on
   the canvas if the child comes back during the same session. Nothing
   persists to disk.
*/

(function () {
  'use strict';

  /* ── Tuning ─────────────────────────────────────────────────────── */

  var STEP     = 54;     /* base forward step, px (scaled by turtle size) */
  var EDGE     = 26;     /* the turtle never leaves this margin           */
  var BOUNCE   = 16;     /* nudge back toward center on an edge hit       */
  var TURN     = 45;     /* degrees per r / arrow turn                    */
  var WIPE_MS  = 340;    /* the `x` clear sweep                           */
  var SIZES    = [1, 1.4, 1.9, 2.5];   /* b cycles through these, wraps   */
  var WIDTHS   = [2.5, 4, 6, 9];       /* g cycles through these, wraps   */
  var TRAIL_ALPHA = 0.8; /* trail is softer than the turtle               */
  var GLOW     = 5;      /* shadowBlur px — small; large is slow          */
  var HUE_RATE = 0.5;    /* rainbow: degrees of hue per px of trail       */

  /* ── Colors ─────────────────────────────────────────────────────── */

  var COLORS = {
    r: '#ff4444', o: '#ff9933', y: '#ffee33', g: '#33ff33',
    b: '#4488ff', i: '#7755ff', v: '#cc66ff',
    /* the hidden tier: live but not shown in the palette */
    c: '#33ffee', m: '#ff44cc', w: '#f5f5f5',
    /* phosphor: resolved live so it matches the current mode */
    phosphor: null,
  };
  var SHOWN = ['r', 'o', 'y', 'g', 'b', 'i', 'v'];
  var COLOR_ORDER = 'roygbivcmw';   /* index → the per-color select note */

  /* ── Synthesized sound effects (Web Audio, tiny and tasteful) ──── */

  var _actx = null;

  function audioCtx() {
    if (!_actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _actx = new AC();
    }
    if (_actx && _actx.state === 'suspended') _actx.resume();
    return _actx;
  }

  /* tone(type, f0, f1, peak, dur, delay) — one enveloped oscillator. */
  function tone(type, f0, f1, peak, dur, delay) {
    var c = audioCtx();
    if (!c) return;
    var t0 = c.currentTime + (delay || 0);
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /* Pitch follows the action: longer stroke → lower note. */
  function lenPitch(len) {
    return Math.max(130, 840 / (1 + len / 130));
  }

  /* A soft blip whose pitch tracks how much got drawn.             */
  function sfxDraw(len)  { var f = lenPitch(len);
                           tone('sine', f, f * 0.94, 0.07, 0.09); }
  /* Pen-up scoot/jump: a little up-chirp — nothing drawn, but felt. */
  function sfxHop()      { tone('sine', 300, 540, 0.05, 0.08); }
  /* Turning: a short dry tick.                                      */
  function sfxTurn()     { tone('square', 1150, null, 0.03, 0.02); }
  /* A dot: one bright pluck.                                        */
  function sfxDot()      { tone('triangle', 990, null, 0.06, 0.05); }
  /* Growing (b/g): pitch sinks with each level; wrap squeaks up.    */
  function sfxGrow(level){ tone('triangle', 360 - level * 70, null, 0.08, 0.10); }
  function sfxShrink()   { tone('sine', 420, 900, 0.07, 0.10); }
  /* Home: a small settling down-chirp.                              */
  function sfxHome()     { tone('sine', 620, 240, 0.07, 0.18); }
  /* Edge bounce: a rubbery boing.                                   */
  function sfxBoing()    { tone('triangle', 140, 260, 0.09, 0.12); }
  /* The clear wipe: a long sweep down.                              */
  function sfxWipe()     { tone('sawtooth', 700, 110, 0.07, 0.32); }
  /* Palette open (two notes up) / close (one note down).            */
  function sfxPalOpen()  { tone('sine', 523, null, 0.08, 0.08);
                           tone('sine', 784, null, 0.08, 0.10, 0.07); }
  function sfxPalClose() { tone('sine', 392, null, 0.06, 0.09); }
  /* Picking a color: a note that depends on which color.            */
  var NOTES = [523, 587, 659, 698, 784, 880, 988, 1047, 1175, 1319];
  function sfxColor(idx) { tone('sine', NOTES[idx % NOTES.length], null, 0.10, 0.16); }
  /* Rainbow toggling: a quick arpeggio (up = on, down = off).       */
  function sfxRainbow(on) {
    var seq = on ? [523, 659, 784] : [784, 659, 523];
    for (var i = 0; i < seq.length; i++) {
      tone('sine', seq[i], null, 0.07, 0.09, i * 0.06);
    }
  }
  /* Near-silent click — any other key (mashing absorbed, alive).    */
  function sfxClick()    { tone('square', 1800, null, 0.025, 0.015); }

  /* ── Module ─────────────────────────────────────────────────────── */

  window.Glyphs.register('draw', {
    init: function () {

      var drawEl = document.getElementById('draw');

      /* ── Inner DOM, built here (the container ships empty) ──── */

      /* The trail canvas: persistent — history is never redrawn.   */
      var canvas = document.createElement('canvas');
      canvas.className = 'draw-canvas';
      drawEl.appendChild(canvas);
      var ctx = null;

      /* The turtle: a DOM sprite riding above the canvas. The outer
         div owns position/heading/size; the inner span owns the
         little pop/bump animations so they never fight.            */
      var turtleEl = document.createElement('div');
      turtleEl.className = 'draw-turtle';
      var glyphEl = document.createElement('span');
      glyphEl.className = 'draw-turtle-glyph';
      glyphEl.textContent = '~(@)>';   /* tail, shell, head */
      turtleEl.appendChild(glyphEl);
      drawEl.appendChild(turtleEl);

      /* The color indicator: a small square, bottom-left corner.   */
      var swatchEl = document.createElement('div');
      swatchEl.className = 'draw-swatch';
      drawEl.appendChild(swatchEl);

      /* The palette overlay: ROYGBIV squares with letters inside.
         The hidden tier (c/m/w) has no squares but the keys work.  */
      var paletteEl = document.createElement('div');
      paletteEl.className = 'draw-palette';
      paletteEl.hidden = true;
      for (var p = 0; p < SHOWN.length; p++) {
        var sw = document.createElement('div');
        sw.className = 'draw-pal-swatch';
        sw.textContent = SHOWN[p].toUpperCase();
        sw.style.background = COLORS[SHOWN[p]];
        sw.style.boxShadow = '0 0 12px ' + COLORS[SHOWN[p]];
        sw.dataset.c = SHOWN[p];
        paletteEl.appendChild(sw);
      }
      drawEl.appendChild(paletteEl);

      /* ── Turtle + canvas state ───────────────────────────────── */

      var active   = false;
      var entered  = false;   /* first enter centers the turtle      */
      var px = 0, py = 0;     /* turtle position, css px              */
      var heading  = 0;       /* degrees; 0 = up, clockwise           */
      var sizeIdx  = 0;       /* index into SIZES                     */
      var widthIdx = 0;       /* index into WIDTHS                    */
      var colorKey = 'phosphor'; /* starts in the live phosphor color  */
      var rainbow  = false;
      var hue      = 110;     /* rainbow hue, advanced by distance    */
      var paletteOpen = false;
      var cw = 0, ch = 0;     /* canvas css size                      */
      var _raf     = 0;       /* the wipe animation (the only rAF)   */
      var wiping   = false;
      var wipeT0   = 0;
      var dragging = false;
      var dragX = 0, dragY = 0;
      var dragLen  = 0;       /* distance since the last drag blip    */

      function S() { return STEP * SIZES[sizeIdx]; }   /* scaled step */

      /* ── Canvas sizing (devicePixelRatio-aware, preserving) ──── */

      function sizeCanvas() {
        var W = window.innerWidth, H = window.innerHeight;
        if (ctx && W === cw && H === ch) return;
        var dpr = window.devicePixelRatio || 1;
        var old = null, oldW = cw, oldH = ch;
        if (ctx && cw && ch) {
          old = document.createElement('canvas');
          old.width = canvas.width;
          old.height = canvas.height;
          var octx = old.getContext('2d');
          if (octx) octx.drawImage(canvas, 0, 0);
        }
        canvas.width  = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          /* The drawing survives a resize (cropped/kept, not lost). */
          if (old) ctx.drawImage(old, 0, 0, oldW, oldH);
        }
        cw = W;
        ch = H;
      }

      /* ── Turtle placement & micro-animations ─────────────────── */

      function placeTurtle() {
        turtleEl.style.left = Math.round(px) + 'px';
        turtleEl.style.top  = Math.round(py) + 'px';
        /* Glyph points right at rest; heading 0 means up.          */
        turtleEl.style.transform =
          'translate(-50%, -50%) rotate(' + (heading - 90) + 'deg)' +
          ' scale(' + SIZES[sizeIdx] + ')';
      }

      /* pop('pop') on an action, pop('bump') on an edge squish.    */
      function pop(cls) {
        glyphEl.classList.remove('pop');
        glyphEl.classList.remove('bump');
        void glyphEl.offsetWidth;   /* restart the CSS animation */
        glyphEl.classList.add(cls);
      }

      /* Clamp into the margin; a hit bounces back with a squish.   */
      function clampBounce() {
        var hit = false;
        if (px < EDGE)      { px = EDGE + BOUNCE;      hit = true; }
        if (px > cw - EDGE) { px = cw - EDGE - BOUNCE; hit = true; }
        if (py < EDGE)      { py = EDGE + BOUNCE;      hit = true; }
        if (py > ch - EDGE) { py = ch - EDGE - BOUNCE; hit = true; }
        if (hit) { pop('bump'); sfxBoing(); }
        return hit;
      }

      /* ── Geometry: the turtle's local frame ──────────────────── */
      /* Local points are {f, l, pen}: f forward, l to the right,   */
      /* both relative to the turtle's position+heading at the      */
      /* START of the action. pen:false moves without drawing.      */

      function rad() { return heading * Math.PI / 180; }

      function toWorld(pt) {
        var r = rad();
        var fx = Math.sin(r), fy = -Math.cos(r);    /* forward      */
        var rx = Math.cos(r), ry =  Math.sin(r);    /* to the right */
        return { x: px + fx * pt.f + rx * pt.l,
                 y: py + fy * pt.f + ry * pt.l,
                 pen: pt.pen !== false };
      }

      function trailColor() {
        if (rainbow) return 'hsl(' + Math.round(hue) + ', 100%, 62%)';
        if (colorKey === 'phosphor') return window.Glyphs.palette.get('bright');
        return COLORS[colorKey];
      }

      /* tracePath(pts) — render a polyline of local points, advance
         the rainbow hue with drawn distance, and move the turtle to
         the last point. Solid color batches into ONE stroke (fast
         under mashing); rainbow strokes per segment so the hue can
         slide along the path. Returns the drawn length (for pitch). */
      function tracePath(pts) {
        if (!ctx || !pts.length) return 0;

        var world = [];
        for (var i = 0; i < pts.length; i++) world.push(toWorld(pts[i]));

        var drawn = 0;
        ctx.save();
        ctx.globalAlpha = TRAIL_ALPHA;
        ctx.lineWidth = WIDTHS[widthIdx];
        ctx.shadowBlur = GLOW;

        var lx = px, ly = py;
        if (rainbow) {
          for (var j = 0; j < world.length; j++) {
            var w = world[j];
            if (w.pen) {
              var len = Math.sqrt((w.x - lx) * (w.x - lx) + (w.y - ly) * (w.y - ly));
              var col = trailColor();
              ctx.strokeStyle = col;
              ctx.shadowColor = col;
              ctx.beginPath();
              ctx.moveTo(lx, ly);
              ctx.lineTo(w.x, w.y);
              ctx.stroke();
              hue = (hue + len * HUE_RATE) % 360;
              drawn += len;
            }
            lx = w.x; ly = w.y;
          }
        } else {
          var c = trailColor();
          ctx.strokeStyle = c;
          ctx.shadowColor = c;
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          for (var k = 0; k < world.length; k++) {
            var v = world[k];
            if (v.pen) {
              ctx.lineTo(v.x, v.y);
              drawn += Math.sqrt((v.x - lx) * (v.x - lx) + (v.y - ly) * (v.y - ly));
            } else {
              ctx.moveTo(v.x, v.y);
            }
            lx = v.x; ly = v.y;
          }
          ctx.stroke();
        }
        ctx.restore();

        px = lx;
        py = ly;
        return drawn;
      }

      /* One raw world-space segment — the mouse-drag pen.          */
      function traceSegment(x1, y1) {
        if (!ctx) { px = x1; py = y1; return; }
        var len = Math.sqrt((x1 - px) * (x1 - px) + (y1 - py) * (y1 - py));
        var col = trailColor();
        ctx.save();
        ctx.globalAlpha = TRAIL_ALPHA;
        ctx.lineWidth = WIDTHS[widthIdx];
        ctx.shadowBlur = GLOW;
        ctx.strokeStyle = col;
        ctx.shadowColor = col;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.restore();
        if (rainbow) hue = (hue + len * HUE_RATE) % 360;
        px = x1;
        py = y1;
      }

      /* A filled dot at the turtle.                                 */
      function stampDot(r) {
        if (!ctx) return;
        var col = trailColor();
        ctx.save();
        ctx.globalAlpha = TRAIL_ALPHA;
        ctx.shadowBlur = GLOW;
        ctx.shadowColor = col;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (rainbow) hue = (hue + 14) % 360;
      }

      /* After any movement/drawing: settle the turtle on screen.    */
      function settle() {
        clampBounce();
        placeTurtle();
      }

      function headingFrom(dx, dy) {
        return Math.atan2(dx, -dy) * 180 / Math.PI;
      }

      /* ── Shape builders (local points) ───────────────────────── */

      /* Sampled arc on a circle at local center (cf, cl): angle a0→a1
         where the local point is (cf + r·sin a, cl − r·cos a). Chosen
         so a circle centered at (0, −r) starts at the turtle (a=0)
         and initially moves forward.                                */
      function arcPts(cf, cl, r, a0, a1, n) {
        var pts = [];
        for (var i = 1; i <= n; i++) {
          var a = a0 + (a1 - a0) * (i / n);
          pts.push({ f: cf + r * Math.sin(a), l: cl - r * Math.cos(a) });
        }
        return pts;
      }

      /* ── Actions ─────────────────────────────────────────────── */

      function doArc() {                       /* a — quarter left  */
        var r = S();
        var len = tracePath(arcPts(0, -r, r, 0, Math.PI / 2, 12));
        heading -= 90;
        settle(); pop('pop'); sfxDraw(len);
      }

      function doBigger() {                    /* b — grow, wrap    */
        sizeIdx = (sizeIdx + 1) % SIZES.length;
        if (sizeIdx === 0) sfxShrink(); else sfxGrow(sizeIdx);
        placeTurtle(); pop('pop');
      }

      function doCircle() {                    /* c — beside, left  */
        var r = 0.55 * S();
        var len = tracePath(arcPts(0, -r, r, 0, Math.PI * 2, 28));
        settle(); pop('pop'); sfxDraw(len);
      }

      function doDot() {                       /* d — a dot here    */
        stampDot(3.5 * SIZES[sizeIdx] + WIDTHS[widthIdx] * 0.5);
        pop('pop'); sfxDot();
      }

      function doEgg() {                       /* e — lay, hop on   */
        var rf = 0.38 * S(), rl = 0.27 * S();
        var pts = [{ f: rf, l: 0, pen: false }];   /* hop to the tip */
        for (var i = 1; i <= 20; i++) {
          var a = Math.PI * 2 * (i / 20);
          pts.push({ f: rf * Math.cos(a), l: rl * Math.sin(a) });
        }
        pts.push({ f: 0.85 * S(), l: 0, pen: false });  /* step away */
        var len = tracePath(pts);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doDashes() {                    /* f — dashed sprint */
        var s = S();
        var len = tracePath([
          { f: 0.26 * s, l: 0 }, { f: 0.42 * s, l: 0, pen: false },
          { f: 0.68 * s, l: 0 }, { f: 0.84 * s, l: 0, pen: false },
          { f: 1.10 * s, l: 0 },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doGrowTrail() {                 /* g — trail width   */
        widthIdx = (widthIdx + 1) % WIDTHS.length;
        stampDot(WIDTHS[widthIdx] * 0.9);      /* show the new width */
        if (widthIdx === 0) sfxShrink(); else sfxGrow(widthIdx);
        pop('pop');
      }

      function doHome() {                      /* h — fresh start   */
        px = cw / 2;
        py = ch / 2;
        heading = 0;
        sizeIdx = 0;
        widthIdx = 0;
        placeTurtle(); pop('pop'); sfxHome();
      }

      function doLetterI() {                   /* i — stick + dot   */
        var s = S();
        var len = tracePath([
          { f: 0.55 * s, l: 0 },
          { f: 0.75 * s, l: 0, pen: false },
        ]);
        stampDot(2.5 * SIZES[sizeIdx] + WIDTHS[widthIdx] * 0.5);
        var hop = tracePath([{ f: 0.25 * s, l: 0, pen: false }]);
        settle(); pop('pop'); sfxDraw(len + hop);
      }

      function doJump() {                      /* j — long hop      */
        tracePath([{ f: 1.7 * S(), l: 0, pen: false }]);
        settle(); pop('pop'); sfxHop();
      }

      function doKite() {                      /* k — diamond+tail  */
        var s = S();
        var len = tracePath([
          { f: 0.8 * s, l: -0.45 * s },        /* the diamond       */
          { f: 1.6 * s, l: 0 },
          { f: 0.8 * s, l: 0.45 * s },
          { f: 0, l: 0 },
          { f: -0.25 * s, l:  0.15 * s },      /* the zigzag tail   */
          { f: -0.50 * s, l: -0.15 * s },
          { f: -0.75 * s, l:  0.15 * s },
          { f: 0, l: 0, pen: false },          /* back to the start */
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doLine() {                      /* l — step, drawing */
        var len = tracePath([{ f: S(), l: 0 }]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doMountain() {                  /* m — two peaks     */
        var s = S();
        var len = tracePath([
          { f: 0.35 * s, l: -0.55 * s },
          { f: 0.70 * s, l: 0 },
          { f: 1.05 * s, l: -0.55 * s },
          { f: 1.40 * s, l: 0 },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doArch() {                      /* n — one hump      */
        var s = S();
        var pts = [];
        for (var i = 1; i <= 14; i++) {
          var t = i / 14;
          pts.push({ f: 0.45 * s * (1 - Math.cos(Math.PI * t)),
                     l: -0.45 * s * Math.sin(Math.PI * t) });
        }
        var len = tracePath(pts);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doRing() {                      /* o — O around it   */
        var r = 0.8 * S();
        var pts = [{ f: 0, l: -r, pen: false }];     /* pen-up out   */
        pts = pts.concat(arcPts(0, 0, r, 0, Math.PI * 2, 28));
        pts.push({ f: 0, l: 0, pen: false });        /* pen-up home  */
        var len = tracePath(pts);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doSquare() {                    /* q — traced ahead  */
        var a = 0.85 * S();
        var len = tracePath([
          { f: a, l: 0 }, { f: a, l: a }, { f: 0, l: a }, { f: 0, l: 0 },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doRight() {                     /* r — turn right    */
        heading += TURN;
        placeTurtle(); pop('pop'); sfxTurn();
      }

      function doLeft() {                      /* ← arrow           */
        heading -= TURN;
        placeTurtle(); pop('pop'); sfxTurn();
      }

      function doSpiral() {                    /* s — ride it out   */
        var n = 44;
        var turns = 2.2;
        var rMax = 1.1 * S();
        var pts = [];
        for (var i = 1; i <= n; i++) {
          var a = turns * Math.PI * 2 * (i / n);
          var r = 2 + (rMax - 2) * (i / n);
          pts.push({ f: r * Math.sin(a), l: -r * Math.cos(a) });
        }
        /* Tangent at the outer end, BEFORE tracePath moves the frame. */
        var w2 = toWorld(pts[n - 1]);
        var w1 = toWorld(pts[n - 2]);
        var len = tracePath(pts);
        heading = headingFrom(w2.x - w1.x, w2.y - w1.y);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doTriangle() {                  /* t — traced ahead  */
        var a = 0.95 * S();
        var len = tracePath([
          { f: a, l: 0 },
          { f: a / 2, l: a * Math.sqrt(3) / 2 },
          { f: 0, l: 0 },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doUTurn() {                     /* u — half-circle   */
        var r = 0.5 * S();
        /* Around a center to the RIGHT: ends beside the start,
           facing back the way it came. A real letter U.            */
        var pts = [];
        for (var i = 1; i <= 14; i++) {
          var a = Math.PI * (i / 14);
          pts.push({ f: r * Math.sin(a), l: r - r * Math.cos(a) });
        }
        var len = tracePath(pts);
        heading += 180;
        settle(); pop('pop'); sfxDraw(len);
      }

      function doVee() {                       /* v — two whiskers  */
        var s = S();
        var len = tracePath([
          { f: 1.0 * s, l: -0.46 * s },
          { f: 0, l: 0, pen: false },
          { f: 1.0 * s, l: 0.46 * s },
          { f: 0, l: 0, pen: false },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doWave() {                      /* w — one sine      */
        var s = S();
        var pts = [];
        for (var i = 1; i <= 24; i++) {
          var t = i / 24;
          pts.push({ f: 1.5 * s * t, l: -0.3 * s * Math.sin(Math.PI * 2 * t) });
        }
        var len = tracePath(pts);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doBranch() {                    /* y — climb a twig  */
        var s = S();
        var side = Math.random() < 0.5 ? -1 : 1;
        var twigF = 0.55 * s * Math.cos(35 * Math.PI / 180);
        var twigL = 0.55 * s * Math.sin(35 * Math.PI / 180);
        var len = tracePath([
          { f: 0.7 * s, l: 0 },                         /* trunk    */
          { f: 0.7 * s + twigF, l: -twigL },            /* left twig */
          { f: 0.7 * s, l: 0, pen: false },
          { f: 0.7 * s + twigF, l: twigL },             /* right twig */
          /* end on the chosen twig's tip                            */
          { f: 0.7 * s + twigF, l: side * twigL, pen: false },
        ]);
        heading += side * 35;
        settle(); pop('pop'); sfxDraw(len);
      }

      function doZigzag() {                    /* z — four strokes  */
        var s = S();
        var len = tracePath([
          { f: 0.35 * s, l: -0.35 * s },
          { f: 0.70 * s, l:  0.35 * s },
          { f: 1.05 * s, l: -0.35 * s },
          { f: 1.40 * s, l: 0 },
        ]);
        settle(); pop('pop'); sfxDraw(len);
      }

      function doScoot() {                     /* space — pen up    */
        tracePath([{ f: 0.55 * S(), l: 0, pen: false }]);
        settle(); pop('pop'); sfxHop();
      }

      function doBack() {                      /* ↓ — moonwalk      */
        var len = tracePath([{ f: -0.8 * S(), l: 0 }]);
        settle(); pop('pop'); sfxDraw(len);
      }

      /* Digits: the number is a COUNT. 1–2 rays, 3–9 a polygon with
         that many sides, 0 a ten-ray starburst.                     */
      function doDigit(n) {
        var s = S();
        var len;
        if (n <= 2) {
          len = tracePath(rayPts(n === 0 ? 10 : n, 0.7 * s));
        } else {
          len = tracePath(polyPts(n, 0.7 * s));
        }
        settle(); pop('pop'); sfxDraw(len);
      }

      function rayPts(count, lenR) {
        var pts = [];
        for (var k = 0; k < count; k++) {
          var a = Math.PI * 2 * k / count;     /* a=0 → straight ahead */
          pts.push({ f: lenR * Math.cos(a), l: lenR * Math.sin(a) });
          pts.push({ f: 0, l: 0, pen: false });
        }
        return pts;
      }

      function polyPts(nSides, R) {
        /* Centered ahead so the first vertex is the turtle itself. */
        var pts = [];
        for (var k = 1; k <= nSides; k++) {
          var a = Math.PI + Math.PI * 2 * k / nSides;
          pts.push({ f: R + R * Math.cos(a), l: R * Math.sin(a) });
        }
        return pts;
      }

      /* Starburst shares rayPts: 0 → ten rays (handled in doDigit). */

      /* ── The clear wipe (`x`) ────────────────────────────────── */
      /* A bright edge sweeps left→right; the canvas clears behind
         it. The turtle stays put. Pressing x mid-wipe just clicks. */

      function startWipe() {
        if (!ctx) return;
        if (wiping) { sfxClick(); return; }
        wiping = true;
        wipeT0 = performance.now();
        sfxWipe();
        pop('pop');
        _raf = requestAnimationFrame(wipeStep);
      }

      function wipeStep(now) {
        _raf = 0;
        if (!active || !ctx) { wiping = false; return; }
        var t = Math.min((now - wipeT0) / WIPE_MS, 1);
        var x = cw * t;
        ctx.save();
        ctx.setTransform(window.devicePixelRatio || 1, 0, 0,
                         window.devicePixelRatio || 1, 0, 0);
        ctx.clearRect(0, 0, x, ch);
        if (t < 1) {
          /* The bright leading edge — erased by the next frame.    */
          var wipeCol = window.Glyphs.palette.get('bright');
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = wipeCol;
          ctx.shadowColor = wipeCol;
          ctx.shadowBlur = 8;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, ch);
          ctx.stroke();
          ctx.restore();
          _raf = requestAnimationFrame(wipeStep);
          return;
        }
        ctx.restore();
        wiping = false;
      }

      /* ── Color: palette, indicator, rainbow ──────────────────── */

      function updateSwatch() {
        if (rainbow) {
          swatchEl.classList.add('rainbow');
          swatchEl.style.background = '';
          swatchEl.style.boxShadow = '';
        } else {
          var swatchCol = colorKey === 'phosphor'
            ? window.Glyphs.palette.get('bright')
            : COLORS[colorKey];
          swatchEl.classList.remove('rainbow');
          swatchEl.style.background = swatchCol;
          swatchEl.style.boxShadow = '0 0 10px ' + swatchCol;
        }
      }

      function openPalette() {
        if (paletteOpen) { sfxClick(); return; }
        paletteOpen = true;
        paletteEl.hidden = false;
        sfxPalOpen();
      }

      function closePalette(silent) {
        paletteOpen = false;
        paletteEl.hidden = true;
        if (!silent) sfxPalClose();
      }

      function selectColor(k) {
        colorKey = k;
        rainbow = false;        /* a picked color ends rainbow mode */
        updateSwatch();
        closePalette(true);
        sfxColor(COLOR_ORDER.indexOf(k));
        pop('pop');
      }

      function toggleRainbow() {
        rainbow = !rainbow;
        updateSwatch();
        sfxRainbow(rainbow);
        pop('pop');
      }

      /* While the palette is open it owns the keyboard: a color
         letter picks (hidden c/m/w included); ANYTHING else just
         closes it — absorbed, never punished.                      */
      function paletteKey(e) {
        var k = (e.key && e.key.length === 1) ? e.key.toLowerCase() : '';
        if (COLORS[k]) { selectColor(k); return; }
        closePalette(false);
      }

      /* ── Input: keys ─────────────────────────────────────────── */

      var LETTERS = {
        a: doArc,      b: doBigger,   c: doCircle,  d: doDot,
        e: doEgg,      f: doDashes,   g: doGrowTrail, h: doHome,
        i: doLetterI,  j: doJump,     k: doKite,    l: doLine,
        m: doMountain, n: doArch,     o: doRing,    p: openPalette,
        q: doSquare,   r: doRight,    s: doSpiral,  t: doTriangle,
        u: doUTurn,    v: doVee,      w: doWave,    x: startWipe,
        y: doBranch,   z: doZigzag,
      };

      function onKey(e) {
        e.preventDefault();
        if (!active) return;

        if (paletteOpen) { paletteKey(e); return; }

        var k = e.key;

        /* Shift+R arrives as 'R' (state.js passes shift through). */
        if (k === 'R') { toggleRainbow(); return; }

        if (k === ' ') { doScoot(); return; }

        if (k && k.length === 1) {
          var lower = k.toLowerCase();
          if (LETTERS[lower]) { LETTERS[lower](); return; }
          if (lower >= '0' && lower <= '9') { doDigit(+lower); return; }
        }

        if (k === 'ArrowLeft')  { doLeft();  return; }
        if (k === 'ArrowRight') { doRight(); return; }
        if (k === 'ArrowUp')    { doLine();  return; }
        if (k === 'ArrowDown')  { doBack();  return; }

        /* Anything else: the machine noticed you, quietly.         */
        pop('pop');
        sfxClick();
      }

      /* ── Input: mouse ────────────────────────────────────────── */
      /* Click: the turtle hops there (no trail). Drag: the turtle
         follows the pointer drawing a trail, nose along the motion.
         Clicking near the bottom-left corner (the indicator, with a
         huge forgiving halo) opens the palette.                     */

      function onMouseDown(e) {
        if (!active) return;

        if (paletteOpen) {
          var t = e.target;
          if (t && t.dataset && t.dataset.c) selectColor(t.dataset.c);
          else closePalette(false);
          return;
        }

        /* The indicator's forgiving corner halo.                   */
        if (e.target === swatchEl ||
            (e.clientX <= 80 && e.clientY >= ch - 80)) {
          openPalette();
          return;
        }

        px = Math.min(Math.max(e.clientX, EDGE), cw - EDGE);
        py = Math.min(Math.max(e.clientY, EDGE), ch - EDGE);
        dragging = true;
        dragX = px;
        dragY = py;
        dragLen = 0;
        turtleEl.classList.add('no-glide');   /* snap during a drag */
        placeTurtle();
        pop('pop');
        sfxHop();
      }

      function onMouseMove(e) {
        if (!active || !dragging) return;
        var x = Math.min(Math.max(e.clientX, EDGE), cw - EDGE);
        var y = Math.min(Math.max(e.clientY, EDGE), ch - EDGE);
        var dx = x - dragX, dy = y - dragY;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < 3) return;                    /* batch tiny moves   */
        heading = headingFrom(dx, dy);        /* nose follows hand  */
        traceSegment(x, y);
        dragX = x;
        dragY = y;
        placeTurtle();
        dragLen += d;
        if (dragLen > 130) {                  /* occasional soft blip */
          dragLen = 0;
          sfxDraw(130);
        }
      }

      function endDrag() {
        if (!dragging) return;
        dragging = false;
        turtleEl.classList.remove('no-glide');
      }

      /* ── Resize (rare in kiosk fullscreen, handled anyway) ───── */

      function onResize() {
        if (!active) return;
        sizeCanvas();
        px = Math.min(Math.max(px, EDGE), cw - EDGE);
        py = Math.min(Math.max(py, EDGE), ch - EDGE);
        placeTurtle();
      }

      /* ── Register as the 'draw' state ────────────────────────── */

      window.Glyphs.state.registerWorld('draw', {
        enter: function () {
          active = true;
          sizeCanvas();
          if (!entered) {
            /* First visit ever: turtle at center, facing up.       */
            entered = true;
            px = cw / 2;
            py = ch / 2;
            heading = 0;
          } else {
            /* Re-entry: the drawing AND the turtle are as he left
               them (cheap delight) — just keep it on screen.       */
            px = Math.min(Math.max(px, EDGE), cw - EDGE);
            py = Math.min(Math.max(py, EDGE), ch - EDGE);
          }
          updateSwatch();
          placeTurtle();
          drawEl.hidden = false;
        },
        exit: function () {
          active = false;
          endDrag();
          if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
          if (wiping && ctx) {
            /* Mid-wipe exit: finish the clear instantly.           */
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            wiping = false;
          }
          closePalette(true);
          glyphEl.classList.remove('pop');
          glyphEl.classList.remove('bump');
          drawEl.hidden = true;
          /* The canvas is NOT cleared: the drawing survives until
             the app closes or the child presses x. Nothing is ever
             written to disk.                                       */
        },
        onKey: onKey,
      });

      drawEl.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', endDrag);
      window.addEventListener('resize', onResize);
    },
  });

}());
