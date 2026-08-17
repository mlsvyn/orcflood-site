/* Hero tide — GPU crowd.
 *
 * WHAT: tens of thousands of instanced orc sprites flowing right-to-left along
 * a flow field into the gold defended line, where they die. One draw call for
 * the whole tide; every orc's position, size, colour and death are computed in
 * the vertex shader from a single time uniform, so the CPU never touches a
 * particle. Renderer: OGL 1.0.11, vendored in js/vendor/ogl (Unlicense).
 *
 * FALLBACK CHAIN (see also the inline stamp script + [data-hero] rules in css):
 *   1. prefers-reduced-motion / saveData / no JS  -> static poster <img>
 *      (decided synchronously in <head>, before this module is even fetched,
 *       so a reduced-motion visitor never allocates a context or a buffer)
 *   2. no WebGL, or WebGL lost twice             -> Canvas2D tide (js/horde.js)
 *   3. otherwise                                 -> this GPU tide
 *
 * LOOP DISCIPLINE: one rAF driver for whichever renderer is live. It runs only
 * while the hero intersects the viewport AND the document is visible; resize is
 * debounced and skips all reallocation when only the height changed (mobile
 * URL-bar collapse fires resize mid-scroll).
 */
import { Renderer, Texture, Program, Geometry, Mesh, Transform } from './vendor/ogl/index.js';

/* ---------------------------------------------------------------- palette */
const rgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const GROUND = rgb('#0c0a10'); // --bg3
const BONE = rgb('#f2efe6');
const GOLD = rgb('#c49c48');
const ACC = rgb('#a6dc30');
/* Straight off the game's own sprite generator (tools/make_orc.py): orcs are
   muted olive with brown leather torsos and iron kit, NOT signal green. Signal
   green belongs to the gunlight at the line, which is what makes the line the
   focal point of the whole picture. */
const SKIN = rgb('#4a682e');
const SKIN_HI = rgb('#5e7c3a');
const SKIN_LOW = rgb('#385426');
const LEATHER = rgb('#583e22');
const IRON = rgb('#696c70');
const RIM = rgb('#10140a');
const BLOOD = rgb('#301612');
const DIRT = rgb('#7e4d10');  // grass-theme lane dirt
const ROCK = rgb('#6f7d0d');  // grass-theme rock
const FIRE = rgb('#ff8a12');  // ground-fire glow, the game's (3.5,2.0,0.1) HDR

/* Char/ice zones the tide has to flow around, as [fraction past the line,
   y, radius]. Ground the towers already worked over — they make the crowd
   part and re-merge instead of sheeting uniformly. */
const OBSTACLES = [
    [0.30, 0.29, 0.062],
    [0.60, 0.665, 0.075],
    [0.16, 0.885, 0.055],
];

const QUAD = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);

/* The line is manned by the game's own seven guns, in the site's roster order.
   These are real sprites shipped with the page (img/tower_*.png, 48x48 pixel
   art, barrel pointing +x) — the same art the arsenal section shows. */
const TOWERS = ['gunner', 'cannon', 'flamethrower', 'grenade_launcher', 'mortar', 'tesla_coil', 'laser'];

/* ------------------------------------------------------------------ shaders */
const TIDE_VERT = /* glsl */ `
precision highp float;

attribute vec2 position;  // unit quad, -0.5..0.5
attribute vec4 seed;      // x life offset, y revolutions/sec, z lane y, w phase
attribute vec4 trait;     // x depth, y colour mix, z death bias, w dead fraction

uniform float uTime;
uniform vec2  uRes;       // drawing buffer, device px
uniform float uPx;        // device px per css px
uniform float uAspect;
uniform float uLineX;
uniform float uKill;
uniform float uOrcPx;
uniform float uDark;   // how dark the unlit end of the field is
uniform vec3  uObs0;
uniform vec3  uObs1;
uniform vec3  uObs2;
uniform vec3  uSkin;
uniform vec3  uSkinHi;
uniform vec3  uSkinLow;
uniform vec3  uAcc;
uniform vec3  uGold;

varying vec2  vUv;
varying vec4  vTint;
varying float vDead;
varying float vLit;

// Push away from a scorched zone as the orc passes it, then relax downstream:
// the tide splits and closes again.
float deflect(vec3 o, float x, float y0) {
    float a    = (x - o.x) * uAspect / o.z;
    float dy   = (y0 - o.y) / o.z;
    float near = exp(-dy * dy * 0.85);
    float ramp = smoothstep(1.7, -0.4, a) * (1.0 - 0.55 * smoothstep(-0.6, -2.8, a));
    return sign(dy + 0.0001) * o.z * 0.34 * near * ramp;
}

void main() {
    float p    = fract(seed.x + uTime * seed.y);
    float df   = trait.w;
    float live = 1.0 - df;
    float m    = min(p / live, 1.0);              // march progress 0..1
    float dead = max(0.0, (p - live) / df);       // 0 while alive, then 0..1

    // Decelerate into the line: the mass piles up instead of sheeting through.
    float e = 1.0 - pow(1.0 - m, 1.38);
    // Contact line undulates in y and time, so the front is ragged, not a cliff.
    float front = uLineX + uKill * trait.z
                + 0.008 * (1.0 + sin(seed.z * 11.0 + uTime * 0.45))
                + 0.004 * (1.0 + sin(seed.z * 27.0 - uTime * 0.7));
    float x = mix(1.07, front, e);

    float y = seed.z;
    // Flow field, sampled at the orc's own position: neighbours get the same
    // push, so a column stays a column and snakes as one body.
    y += 0.042 * sin(x * 4.1 - uTime * 0.30 + seed.z * 8.0);
    y += 0.020 * sin(x * 9.7 + uTime * 0.52 + seed.z * 3.0);
    float press = smoothstep(0.25, 1.0, m);
    y += press * 0.020 * sin(seed.w * 2.7 + seed.x * 9.1);   // fan out on the line
    y += 0.0018 * sin(uTime * 7.5 + seed.w * 6.283);         // waddle
    y += deflect(uObs0, x, seed.z) + deflect(uObs1, x, seed.z) + deflect(uObs2, x, seed.z);

    // The game draws each orc at 3.6x its collision radius, so sprites overlap
    // heavily and the crowd reads as a carpet of bodies. Reproduce that overlap
    // or a hero full of small sprites reads as confetti.
    float depth = 0.62 + trait.x * 0.76;
    float size  = max(2.0, floor(uOrcPx * uPx * depth + 0.5));
    size *= smoothstep(0.34, 0.02, dead);   // a kill collapses, it does not bloom

    float alpha = smoothstep(0.36, 0.05, dead);

    // Per-body warm/cool jitter — the game's own trick, h = fract(id * phi)
    float h = fract(seed.w * 0.61803399 * 13.0);
    vec3 col = mix(uSkinLow, uSkin, smoothstep(0.0, 0.6, trait.y));
    col = mix(col, uSkinHi, smoothstep(0.55, 1.0, trait.y));
    col *= vec3(1.0 + 0.14 * (h - 0.5), 1.0, 1.0 - 0.14 * (h - 0.5));
    col *= 0.86 + 0.14 * depth;

    // Gunlight: the tide pours in out of the dark and is only lit at the line.
    float lit = smoothstep(1.02, uLineX + 0.02, x);
    col *= uDark + (1.0 - uDark) * lit;
    col = mix(col, uAcc, lit * lit * 0.30);
    col = mix(col, uGold, press * press * 0.10);

    vec2 c  = vec2(x * uRes.x, y * uRes.y);
    vec2 px = c + position * vec2(size * 0.78, size);

    gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
    vUv   = position + 0.5;
    vTint = vec4(col, alpha);
    vDead = dead;
    vLit  = lit;
}`;

/* One orc, drawn from the quad's uv — no texture, no image asset. Three parts
   in the game's own colours: skin head, leather torso, iron kit; plus the
   0.55-alpha silhouette shadow the game gives every body, which is what stops
   a field of small sprites reading as confetti. */
const TIDE_FRAG = /* glsl */ `
precision mediump float;
varying vec2  vUv;
varying vec4  vTint;
varying float vDead;
varying float vLit;
uniform vec3  uLeather;
uniform vec3  uIron;
uniform vec3  uRim;
uniform vec3  uBone;

float silhouette(vec2 u, out float vest, out float iron) {
    float ax = abs(u.x - 0.5);
    float body = step(ax, 0.36) * step(0.30, u.y) * step(u.y, 1.0);   // skin
    float head = step(ax, 0.26) * step(0.08, u.y) * step(u.y, 0.34);
    vest = step(ax, 0.30) * step(0.52, u.y) * step(u.y, 0.80);        // leather
    iron = step(0.34, ax) * step(ax, 0.47) * step(0.16, u.y) * step(u.y, 0.42);
    return clamp(body + head + iron, 0.0, 1.0);
}

void main() {
    float vest, iron, sv, si;
    float mask  = silhouette(vUv, vest, iron);
    // one dark pixel of outline, the way the game's atlas is drawn
    float inner = silhouette((vUv - 0.5) * 1.55 + 0.5, sv, si);
    // the light is at the line, so a body throws its shadow back and down
    float smask = silhouette(vUv + vec2(0.16, -0.13), sv, si) * (1.0 - mask);

    vec3 col = vTint.rgb;
    col = mix(col, uLeather * (0.85 + 0.4 * vLit), vest);
    col = mix(col, uIron * (0.5 + 0.5 * vLit), iron);
    col = mix(uRim, col, inner);                    // rim darkens the outline

    // Hit: a white tick that snaps to dark red — the game's 400 ms curve, but
    // brief enough that a wall of kills does not turn the line into confetti.
    float df = clamp(vDead / 0.35, 0.0, 1.0);
    vec3 hit = mix(uBone, vec3(0.30, 0.03, 0.02), clamp(df * 3.0, 0.0, 1.0));
    col = mix(col, hit, step(0.0005, vDead) * (1.0 - 0.45 * df));

    float a = max(mask, smask * 0.5) * vTint.a;
    gl_FragColor = vec4(mix(uRim, col, mask), a);
}`;

const FULL_VERT = /* glsl */ `
precision highp float;
attribute vec2 position;
varying vec2 vUv;
void main() {
    vUv = vec2(position.x + 0.5, 0.5 - position.y);
    gl_Position = vec4(position * 2.0, 0.0, 1.0);
}`;

/* The ground the tide crosses. The game's grass theme is brown dirt lanes
   (#7E4D10) between olive rock (#6F7D0D), corpses that never decay, and flame
   char that recovers over ten seconds — so the field carries: three dirt lanes
   under the three columns, a permanent corpse mat at the kill line, and the
   scorched zones the crowd has to flow around. Additive over the powder-black
   ground, at poster brightness. */
const FIELD_FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform float uTime;
uniform vec2  uRes;
uniform float uPx;
uniform float uAspect;
uniform float uLineX;
uniform vec3  uObs0;
uniform vec3  uObs1;
uniform vec3  uObs2;
uniform vec3  uAcc;
uniform vec3  uDirt;
uniform vec3  uRock;
uniform vec3  uBlood;
uniform vec3  uFire;

uniform vec3 uLanes;
float lane(float y, float c, float h) { return 1.0 - smoothstep(h * 0.45, h, abs(y - c)); }

vec3 scar(vec3 o) {
    vec2 d  = vec2((vUv.x - o.x) * uAspect, vUv.y - o.y) / o.z;
    float r = length(d);
    float inner = 1.0 - smoothstep(0.10, 1.20, r);
    float ember = 0.5 + 0.5 * sin(uTime * 2.3 + o.y * 37.0 + r * 9.0);
    // char is near-black; only the live fire glows, the way the game stamps it
    return uFire * inner * inner * (0.05 + 0.09 * ember) - vec3(0.012) * inner;
}

void main() {
    float d = vUv.x - uLineX;
    float field = smoothstep(-0.03, 0.06, d);       // ground only beyond the line
    float L = max(max(lane(vUv.y, uLanes.x, 0.17), lane(vUv.y, uLanes.y, 0.18)), lane(vUv.y, uLanes.z, 0.15));
    float g = fract(sin(dot(floor(vUv * uRes / 7.0), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 c = mix(uRock * 0.042, uDirt * 0.075, L) * field * (0.7 + 0.6 * g);
    // corpses never decay in this game: the ground at the line is a mat of them
    float mat = (1.0 - smoothstep(0.0, 0.09, d)) * step(-0.004, d) * (0.35 + 0.65 * L);
    c += uBlood * mat * 0.85;
    c += uAcc * (1.0 - smoothstep(0.0, 0.20, abs(d - 0.03))) * 0.035;   // gunlight wash
    c += scar(uObs0) + scar(uObs1) + scar(uObs2);
    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}`;

/* The defended line itself, drawn OVER the tide: a muster-gold trench edge with
   its own shadow, so the crowd visibly stops at something solid. */
const TRENCH_FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform vec2  uRes;
uniform float uPx;
uniform float uLineX;
uniform vec3  uGold;
uniform vec3  uGround;
void main() {
    float d = (uLineX - vUv.x) * uRes.x;          // device px left of the line
    float shade = smoothstep(13.0 * uPx, 0.0, d) * step(0.0, d) * 0.55;
    float edge  = smoothstep(2.4 * uPx, 0.0, abs(d - 1.2 * uPx));
    float a = max(shade, edge * 0.92);
    if (a < 0.004) discard;
    vec3 c = mix(uGround, uGold, clamp(edge / max(a, 0.001), 0.0, 1.0));
    gl_FragColor = vec4(c, a);
}`;

/* ------------------------------------------------------------ emplacements */
/* The turrets are the GAME'S OWN sprites (img/tower_*.png, 48x48 pixel art,
   barrel pointing +x), stitched into one atlas on an offscreen canvas at boot
   and drawn as one instanced pass. Each emplacement carries its own aim angle
   and sweeps it slowly, the way a player-aimed turret tracks the tide.
   aTur = (y, atlas slot, aim base, phase) */
const TURRET_VERT = /* glsl */ `
precision highp float;
attribute vec2 position;
attribute vec4 tur;
uniform vec2  uRes;
uniform float uPx;
uniform float uLineX;
uniform float uTime;
uniform float uSlots;
uniform float uTurPx;
varying vec2  vUv;
void main() {
    float aim = tur.z + 0.16 * sin(uTime * 0.37 + tur.w * 6.283)
                      + 0.05 * sin(uTime * 1.10 + tur.w * 3.1);
    float s = uTurPx * uPx;
    vec2 q = position * s;
    vec2 r = vec2(q.x * cos(aim) - q.y * sin(aim), q.x * sin(aim) + q.y * cos(aim));
    vec2 p = vec2(uLineX * uRes.x, tur.x * uRes.y) + r;
    gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
    // atlas slot -> u range; v is straight through (texture uploaded unflipped)
    vUv = vec2((tur.y + position.x + 0.5) / uSlots, position.y + 0.5);
}`;

const TURRET_FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uAtlas;
void main() {
    vec4 t = texture2D(uAtlas, vUv);
    if (t.a < 0.02) discard;
    gl_FragColor = t;
}`;

/* What each gun actually throws, taken from the game's data/towers.json:
   fire rate in Hz, range and projectile radius in world units (a tower is 18
   world units wide, which is what turretPx maps to). Modes: 0 solid round,
   1 flame puff, 2 grenade, 3 laser beam, 4 tesla arc. Projectiles in the game
   are untextured soft discs, and bullets are pale yellow #FFFFBC — not tracer
   dashes, which is what this used to draw. */
const GUNS = {
    gunner: { rate: 3.0, range: 100, proj: 0.8, mode: 0 },
    cannon: { rate: 0.5, range: 200, proj: 2.0, mode: 0 },
    flamethrower: { rate: 12.0, range: 25, proj: 4.0, mode: 1 }, // 30/s in game
    grenade_launcher: { rate: 2.0, range: 110, proj: 1.0, mode: 2 },
    mortar: { rate: 0.4, range: 190, proj: 1.5, mode: 0 },
    tesla_coil: { rate: 0.75, range: 35, proj: 1.0, mode: 4 },
    laser: { rate: 0.5, range: 100, proj: 1.0, mode: 3 },
};
const BUL_SPEED = 200; // world units/s, data/towers.json bulletSpeed

/* One instanced pass covers every gun's output. Slots 0-2 of each turret carry
   rounds (or, for a beam weapon, slot 0 carries the beam); slot 3 is the muzzle
   flash — 16x4 world units for 0.08 s, the game's own fx_muzzle_flash timing.
   bulA = (y, aim base, phase, slot)   bulB = (rate, range px, proj px, mode) */
const BULLET_VERT = /* glsl */ `
precision highp float;
attribute vec2 position;
attribute vec4 bulA;
attribute vec4 bulB;
uniform vec2  uRes;
uniform float uPx;
uniform float uLineX;
uniform float uTime;
uniform float uMuzzle;
uniform float uSpeedPx;
varying float vHit;
varying vec2  vLocal;
varying float vMode;
varying float vAlpha;

float aimAt(float t, float phase) {
    return 0.16 * sin(t * 0.37 + phase * 6.283) + 0.05 * sin(t * 1.10 + phase * 3.1);
}

void main() {
    float rate = bulB.x, rng = bulB.y, proj = bulB.z, mode = bulB.w;
    float slot = bulA.w;
    float isBeam = step(2.5, mode);
    float isFlash = step(2.5, slot);

    // where this slot is in its own firing cycle
    float cyc = fract(uTime * rate + (slot / 3.0) * (1.0 - isFlash) + bulA.z);
    float ageS = cyc / rate;

    float flight = rng / uSpeedPx;                    // seconds, muzzle to reach
    float travel = clamp(ageS / flight, 0.0, 1.0);
    float aimT = uTime - travel * flight * (1.0 - isBeam);
    float aim = bulA.y + aimAt(aimT, bulA.z);
    vec2 dir = vec2(cos(aim), sin(aim));

    float dist, hx, hy, alpha;
    if (isFlash > 0.5) {
        // muzzle flash: a flame 16 wu long and 4 tall, alive for 0.08 s
        float k = uMuzzle / 26.0;                     // wu -> px for this layout
        dist = (uMuzzle + 8.0 * k) * uPx;
        hx = 8.0 * k * uPx;
        hy = 2.0 * k * uPx;
        alpha = step(ageS, 0.08) * (1.0 - ageS / 0.08);
        vHit = 0.0;
    } else if (isBeam > 0.5) {
        float life = mix(0.40, 0.18, step(3.5, mode));   // laser 0.4 s, tesla 0.18 s
        dist = uMuzzle * uPx + rng * 0.5;
        hx = rng * 0.5;
        hy = mix(2.2, 1.6, step(3.5, mode)) * uPx;
        alpha = step(ageS, life) * (1.0 - ageS / life) * (1.0 - step(0.5, slot));
        vHit = 0.0;
    } else {
        float hit = smoothstep(0.90, 1.0, travel);
        dist = uMuzzle * uPx + travel * rng;
        hx = proj * (1.0 + 0.35 * hit);
        hy = hx;
        alpha = step(ageS, flight);
        vHit = hit;
    }

    vec2 hs = vec2(hx, hy) * step(0.001, alpha);
    vec2 q = position * hs * 2.0;
    vec2 off = dir * dist + vec2(q.x * dir.x - q.y * dir.y, q.x * dir.y + q.y * dir.x);
    vec2 p = vec2(uLineX * uRes.x, bulA.x * uRes.y) + off;
    gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
    vLocal = position * 2.0;
    vMode = mix(mode, 5.0, isFlash);
    vAlpha = clamp(alpha, 0.0, 1.0);
}`;

const BULLET_FRAG = /* glsl */ `
precision mediump float;
varying float vHit;
varying vec2  vLocal;
varying float vMode;
varying float vAlpha;
uniform vec3  uBullet;
uniform vec3  uFlame;
uniform vec3  uGrenade;
uniform vec3  uLaser;
uniform vec3  uTesla;
uniform vec3  uFlashCore;
uniform vec3  uFlashTip;
uniform vec3  uBone;

void main() {
    float r = length(vLocal);
    float disc = 1.0 - smoothstep(0.6, 1.0, r);        // the game's soft disc
    float beam = (1.0 - smoothstep(0.35, 1.0, abs(vLocal.y)))
               * (1.0 - smoothstep(0.85, 1.0, abs(vLocal.x)));
    float flash = (1.0 - smoothstep(0.2, 1.0, abs(vLocal.y)))
                * (1.0 - smoothstep(0.1, 1.0, vLocal.x * 0.5 + 0.5));

    float isBeam = step(2.5, vMode) * (1.0 - step(4.5, vMode));
    float isFlash = step(4.5, vMode);
    float shape = mix(mix(disc, beam, isBeam), flash, isFlash);

    vec3 col = uBullet;
    col = mix(col, uFlame, step(0.5, vMode) * (1.0 - step(1.5, vMode)));
    col = mix(col, uGrenade, step(1.5, vMode) * (1.0 - step(2.5, vMode)));
    col = mix(col, uLaser, step(2.5, vMode) * (1.0 - step(3.5, vMode)));
    col = mix(col, uTesla, step(3.5, vMode) * (1.0 - step(4.5, vMode)));
    col = mix(col, mix(uFlashTip, uFlashCore, 1.0 - (vLocal.x * 0.5 + 0.5)), isFlash);
    col = mix(col, uBone, (1.0 - smoothstep(0.0, 0.45, r)) * (isBeam + isFlash) * 0.7);

    float a = shape * vAlpha;
    if (a < 0.015) discard;
    gl_FragColor = vec4(col, a);
}`;

/* ------------------------------------------------------------------ layout */
/* Density is per-area, so a phone and a desktop read as the same crowd. */
function layout(cssW, cssH) {
    const mobile = cssW < 620;
    const area = cssW * cssH;
    /* On a phone the copy sits over a top-to-bottom vignette rather than a
       left one (see the 620px block in css/site.css), so the line moves left
       and the tide gets most of the width instead of a 140px strip. */
    return {
        mobile: mobile,
        lineX: mobile ? 0.4 : 0.6,
        kill: mobile ? 0.16 : 0.11,
        orcPx: mobile ? 6.0 : 5.6,   // chunkier on a phone: it reads under the vignette
        turrets: Math.max(3, Math.min(7, Math.round(cssH / (mobile ? 190 : 148)))),
        turretPx: mobile ? 40 : 58,
        count: Math.max(6000, Math.min(mobile ? 26000 : 84000, Math.round(area / (mobile ? 14 : 17)))),
    };
}

/* --------------------------------------------------------------- GPU tide */
function createGpuTide(canvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new Renderer({
        canvas: canvas,
        dpr: dpr,
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
    });
    const gl = renderer.gl;
    renderer.gl.clearColor(GROUND[0], GROUND[1], GROUND[2], 1);

    const common = {
        uTime: { value: 0 },
        uRes: { value: [1, 1] },
        uPx: { value: dpr },
        uAspect: { value: 1 },
        uLineX: { value: 0.52 },
        uKill: { value: 0.11 },
        uObs0: { value: [0, 0, 1] },
        uObs1: { value: [0, 0, 1] },
        uObs2: { value: [0, 0, 1] },
    };
    const u = (extra) => Object.assign({}, common, extra);

    const scene = new Transform();
    const quad = () => new Geometry(gl, { position: { size: 2, data: QUAD } });

    const fieldProg = new Program(gl, { vertex: FULL_VERT, fragment: FIELD_FRAG, depthTest: false, cullFace: null, uniforms: u({ uAcc: { value: ACC }, uDirt: { value: DIRT }, uRock: { value: ROCK }, uBlood: { value: BLOOD }, uFire: { value: FIRE }, uLanes: { value: [0.28, 0.6, 0.87] } }) });
    fieldProg.setBlendFunc(gl.ONE, gl.ONE);
    new Mesh(gl, { geometry: quad(), program: fieldProg, frustumCulled: false }).setParent(scene);

    const tideProg = new Program(gl, {
        vertex: TIDE_VERT,
        fragment: TIDE_FRAG,
        depthTest: false,
        cullFace: null,
        transparent: true,
        uniforms: u({
            uOrcPx: { value: 4.4 },
            uDark: { value: 0.3 },
            uSkin: { value: SKIN },
            uSkinHi: { value: SKIN_HI },
            uSkinLow: { value: SKIN_LOW },
            uLeather: { value: LEATHER },
            uIron: { value: IRON },
            uRim: { value: RIM },
            uBone: { value: BONE },
            uGold: { value: GOLD },
            uAcc: { value: ACC },
        }),
    });
    /* Buffers are allocated ONCE, at a generous ceiling for this device, and
       every slot is seeded up front. Re-laying out the hero then only changes
       how many instances we ask for — a resize never reallocates anything, and
       there is no per-frame CPU work over the crowd at all. */
    const LANES = cssW < 620 ? [0.4, 0.62, 0.83] : [0.28, 0.6, 0.87];
    fieldProg.uniforms.uLanes.value = LANES;
    const MAX = Math.max(6000, Math.min(84000, Math.round((cssW * cssH * 1.6) / 13)));
    const seed = new Float32Array(MAX * 4);
    const trait = new Float32Array(MAX * 4);
    /* A horde does not arrive as an even scatter — it arrives in MOBS. Orcs are
       seeded in packs of ~48 that share a lane, a pace and a place in the queue,
       so each pack is a solid clot of bodies and the gaps between packs are
       real gaps. That single change is the difference between a crowd and a
       texture. One pack in six is loose, which gives the mass a ragged edge. */
    const PACK = 48;
    const hash = (n) => {
        const v = Math.sin(n * 127.1) * 43758.5453;
        return v - Math.floor(v);
    };
    for (let i = 0; i < MAX; i++) {
        const o = i * 4;
        const c = (i / PACK) | 0;
        const h1 = hash(c * 1.7), h2 = hash(c * 2.3 + 0.4), h3 = hash(c * 3.1 + 0.9);
        const h4 = hash(c * 4.7 + 0.2), h5 = hash(c * 5.3 + 0.6);
        const laneY = h1 < 0.42 ? LANES[0] : h1 < 0.8 ? LANES[1] : LANES[2];
        const loose = h5 < 0.17;
        const jx = loose ? 0.055 : 0.014;  // depth of the pack, in life fraction
        const jy = loose ? 0.038 : 0.011;  // width of the pack, in screen height
        const packY = laneY + (h2 - 0.5) * (loose ? 0.22 : 0.085);
        const packDepth = 0.15 + h4 * 0.85;
        seed[o] = (h3 + (Math.random() - 0.5) * jx + 1) % 1; // pack's place in the queue
        seed[o + 1] = 1 / (5.5 + (1 - packDepth) * 7.5 + h4 * 1.5); // pack's pace
        seed[o + 2] = Math.min(0.985, Math.max(0.015, packY + (Math.random() + Math.random() - 1) * jy));
        seed[o + 3] = Math.random() * 6.283;
        trait[o] = Math.min(1, Math.max(0, packDepth + (Math.random() - 0.5) * 0.18));
        trait[o + 1] = Math.pow(Math.random(), 2.4);
        // most die on the line; a picked-off minority thins out ahead of it
        trait[o + 2] = Math.random() < 0.18 ? Math.pow(Math.random(), 0.5) : Math.pow(Math.random(), 2.6);
        trait[o + 3] = 0.05 + Math.random() * 0.16;
    }
    const tideGeo = new Geometry(gl, {
        position: { size: 2, data: QUAD },
        seed: { size: 4, data: seed, instanced: 1 },
        trait: { size: 4, data: trait, instanced: 1 },
    });
    new Mesh(gl, { geometry: tideGeo, program: tideProg, frustumCulled: false }).setParent(scene);
    let N = MAX;

    const trenchProg = new Program(gl, { vertex: FULL_VERT, fragment: TRENCH_FRAG, depthTest: false, cullFace: null, transparent: true, uniforms: u({ uGold: { value: GOLD }, uGround: { value: GROUND } }) });
    new Mesh(gl, { geometry: quad(), program: trenchProg, frustumCulled: false }).setParent(scene);

    /* ---- emplacements: the game's own turret sprites, in one atlas ---- */
    const atlasTex = new Texture(gl, {
        magFilter: gl.NEAREST, // pixel art stays pixel art
        minFilter: gl.NEAREST,
        generateMipmaps: false,
        flipY: false,
        premultiplyAlpha: false,
    });

    const bulletProg = new Program(gl, {
        vertex: BULLET_VERT,
        fragment: BULLET_FRAG,
        depthTest: false,
        cullFace: null,
        uniforms: u({
            uMuzzle: { value: 26 },
            uSpeedPx: { value: 200 },
            uBullet: { value: rgb('#ffffbc') },
            uFlame: { value: rgb('#ffda59') },
            uGrenade: { value: rgb('#6ca061') },
            uLaser: { value: rgb('#ff5a5a') },
            uTesla: { value: rgb('#bcffff') },
            uFlashCore: { value: rgb('#fff4be') },
            uFlashTip: { value: rgb('#de7626') },
            uBone: { value: BONE },
        }),
    });
    // Gunfire is light: add it rather than paint over the crowd.
    bulletProg.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const turretProg = new Program(gl, { vertex: TURRET_VERT, fragment: TURRET_FRAG, depthTest: false, cullFace: null, transparent: true, uniforms: u({ uAtlas: { value: atlasTex }, uSlots: { value: TOWERS.length }, uTurPx: { value: 46 } }) });

    const TUR_MAX = 8;
    const BUL_SLOTS = 4; // 0-2 rounds (or a beam), 3 muzzle flash
    const turData = new Float32Array(TUR_MAX * 4);
    const bulA = new Float32Array(TUR_MAX * BUL_SLOTS * 4);
    const bulB = new Float32Array(TUR_MAX * BUL_SLOTS * 4);
    const bulletGeo = new Geometry(gl, {
        position: { size: 2, data: QUAD },
        bulA: { size: 4, data: bulA, instanced: 1 },
        bulB: { size: 4, data: bulB, instanced: 1 },
    });
    const turretGeo = new Geometry(gl, { position: { size: 2, data: QUAD }, tur: { size: 4, data: turData, instanced: 1 } });
    const bulletMesh = new Mesh(gl, { geometry: bulletGeo, program: bulletProg, frustumCulled: false });
    const turretMesh = new Mesh(gl, { geometry: turretGeo, program: turretProg, frustumCulled: false });
    bulletMesh.setParent(scene);
    turretMesh.setParent(scene);
    turretMesh.visible = false; // until the atlas is stitched
    bulletMesh.visible = false;

    /* Lay the line out irregularly: identical guns at identical spacing is the
       thing that reads as fake. Each emplacement gets its own gun, its own
       standing aim and its own firing phase. */
    function setTurrets(n, turretPx) {
        const pxPerWu = turretPx / 18; // a tower is 18 world units wide in game
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            const jog = Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5;
            const kind = (i * 3 + ((i * i) % 5)) % TOWERS.length;
            const gun = GUNS[TOWERS[kind]];
            turData[o] = 0.085 + ((i + 0.5) / n) * 0.83 + jog * 0.035; // y, irregular
            turData[o + 1] = kind;
            turData[o + 2] = jog * 0.34;                               // standing aim
            turData[o + 3] = (i * 0.373 + Math.sin(i * 7.1) * 0.21 + 1) % 1; // firing phase
            for (let k = 0; k < BUL_SLOTS; k++) {
                const b = (i * BUL_SLOTS + k) * 4;
                bulA[b] = turData[o];
                bulA[b + 1] = turData[o + 2];
                bulA[b + 2] = turData[o + 3];
                bulA[b + 3] = k;
                bulB[b] = gun.rate;
                bulB[b + 1] = gun.range * pxPerWu;
                bulB[b + 2] = gun.proj * pxPerWu;
                bulB[b + 3] = gun.mode;
            }
        }
        turretGeo.attributes.tur.needsUpdate = true;
        bulletGeo.attributes.bulA.needsUpdate = true;
        bulletGeo.attributes.bulB.needsUpdate = true;
        turretGeo.setInstancedCount(n);
        bulletGeo.setInstancedCount(n * BUL_SLOTS);
        bulletProg.uniforms.uMuzzle.value = turretPx * 0.46;
        bulletProg.uniforms.uSpeedPx.value = BUL_SPEED * pxPerWu;
    }

    /* Stitch img/tower_*.png into one strip on an offscreen canvas — no new
       binary asset, and one texture means one draw call for the whole line. */
    (function buildAtlas() {
        const S = 48;
        const sheet = document.createElement('canvas');
        sheet.width = S * TOWERS.length;
        sheet.height = S;
        const c2 = sheet.getContext('2d');
        if (!c2) return;
        let done = 0;
        TOWERS.forEach((name, i) => {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => {
                // The shipped sprites sit on a rounded UI plate. Clip to the
                // gun's own circular emplacement so it reads as a position on
                // the ground, not an icon pasted onto the battlefield.
                c2.save();
                c2.beginPath();
                c2.arc(i * S + S / 2, S / 2, S * 0.47, 0, Math.PI * 2);
                c2.clip();
                c2.drawImage(img, i * S, 0, S, S);
                c2.restore();
                if (++done !== TOWERS.length) return;
                atlasTex.image = sheet;
                atlasTex.needsUpdate = true;
                turretMesh.visible = true;
                bulletMesh.visible = true;
            };
            img.onerror = () => {
                done++; // a missing gun just leaves its slot empty
            };
            img.src = 'img/tower_' + name + '.png';
        });
    })();

    const progs = [fieldProg, tideProg, trenchProg, bulletProg, turretProg];

    return {
        kind: 'webgl',
        resize(cssW, cssH, widthChanged) {
            renderer.setSize(cssW, cssH);
            // setSize writes inline px onto the canvas; keep the CSS box fluid
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            const res = [Math.round(cssW * dpr), Math.round(cssH * dpr)];
            const cfg = layout(cssW, cssH);
            for (const p of progs) {
                p.uniforms.uRes.value = res;
                p.uniforms.uAspect.value = cssW / cssH;
            }
            turretProg.uniforms.uTurPx.value = cfg.turretPx;
            setTurrets(cfg.turrets, cfg.turretPx);
            // Height-only change (mobile URL bar collapsing mid-scroll): the
            // buffer, the crowd size, the line and the scorched zones are all
            // width-derived, so stop here.
            if (!widthChanged) return;
            for (const p of progs) {
                p.uniforms.uLineX.value = cfg.lineX;
                p.uniforms.uKill.value = cfg.kill;
                for (let i = 0; i < 3; i++) {
                    const [f, y, r] = OBSTACLES[i];
                    p.uniforms['uObs' + i].value = [cfg.lineX + f * (1 - cfg.lineX), y, r];
                }
            }
            tideProg.uniforms.uOrcPx.value = cfg.orcPx;
            // a phone's vignette sits on top of the whole hero, so lift the floor
            tideProg.uniforms.uDark.value = cfg.mobile ? 0.82 : 0.3;
            N = Math.min(MAX, cfg.count);
            tideGeo.setInstancedCount(N);
        },
        frame(t) {
            for (const p of progs) p.uniforms.uTime.value = t;
            renderer.render({ scene: scene, sort: false, frustumCull: false });
        },
        /* Honest: recomputes each orc's life phase with the exact expression the
           vertex shader uses, and counts the ones that have not been killed yet. */
        alive(t) {
            let n = 0;
            for (let i = 0; i < N; i++) {
                const o = i * 4;
                const p = (seed[o] + t * seed[o + 1]) % 1;
                if (p < 1 - trait[o + 3]) n++;
            }
            return n;
        },
        destroy() {
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        },
    };
}

/* ---------------------------------------------------------------- driver */
const NNBSP = ' ';
const fmt = (n) => n.toLocaleString('en-US').replace(/,/g, NNBSP);

(function boot() {
    const root = document.documentElement;
    const hero = document.querySelector('.hero');
    const meter = document.getElementById('tide-n');
    let canvas = document.getElementById('horde');
    if (!hero || !canvas) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const poster = () => {
        root.dataset.hero = 'poster';
    };
    // The <head> stamp already routed reduced-motion / saveData to the poster.
    // Nothing here allocates a context or a buffer on that path.
    if (root.dataset.hero !== 'live') return;

    let tide = null;
    let running = false;
    let raf = 0;
    let last = 0;
    let t = 0; // simulation clock: advances only while we actually render
    let meterAcc = 1;
    let inView = true;
    let lost = 0;
    let restoreTimer = 0;
    let cssW = 0, cssH = 0;

    function tick(now) {
        raf = requestAnimationFrame(tick);
        const dt = Math.min((now - last) / 1000, 0.05); // no jump after a pause
        last = now;
        t += dt;
        tide.frame(t, dt);
        meterAcc += dt;
        if (meter && meterAcc >= 0.4) {
            meterAcc = 0;
            meter.textContent = fmt(tide.alive(t));
        }
    }
    function start() {
        if (running || !tide) return;
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(tick);
    }
    function stop() {
        if (!running) return;
        running = false;
        cancelAnimationFrame(raf);
    }
    const sync = () => (inView && !document.hidden ? start() : stop());

    function measure() {
        const r = hero.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        const widthChanged = w !== cssW;
        cssW = w;
        cssH = h;
        return widthChanged;
    }

    /* Fix 3: debounced to 150 ms, a no-op when nothing actually changed, and a
       height-only change takes the cheap path inside the renderer. */
    let rt = 0;
    function onResize() {
        clearTimeout(rt);
        rt = setTimeout(() => {
            if (!tide) return;
            const r = hero.getBoundingClientRect();
            if (Math.round(r.width) === cssW && Math.round(r.height) === cssH) return;
            const widthChanged = measure();
            tide.resize(cssW, cssH, widthChanged);
            if (!running) tide.frame(t, 0); // keep a correct still frame while paused
        }, 150);
    }

    function install(next) {
        tide = next;
        measure();
        tide.resize(cssW, cssH, true);
        tide.frame(t, 0); // never leave the canvas blank, even if we start paused
        sync();
    }

    let falling = false;
    async function useCanvas2D() {
        if (falling) return;
        falling = true;
        stop();
        // A canvas that has held a WebGL context can never hand out a 2D one.
        if (tide && tide.kind === 'webgl') {
            const fresh = canvas.cloneNode(false);
            canvas.replaceWith(fresh);
            canvas = fresh;
        }
        tide = null;
        try {
            const mod = await import('./horde.js');
            install(mod.createCanvasTide(canvas));
        } catch (e) {
            poster(); // last resort: the real screenshot, which is always honest
        }
    }

    function hasWebGL() {
        try {
            const probe = document.createElement('canvas');
            const gl = probe.getContext('webgl2') || probe.getContext('webgl');
            if (!gl) return false;
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext(); // don't hold a context we won't use
            return true;
        } catch (e) {
            return false;
        }
    }

    function wireContextLoss() {
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // ask the browser for a restore
            stop();
            lost++;
            if (lost > 1) return void useCanvas2D(); // it keeps dying: give up on GL
            clearTimeout(restoreTimer);
            restoreTimer = setTimeout(() => {
                if (!running) useCanvas2D();
            }, 4000);
        });
        canvas.addEventListener('webglcontextrestored', () => {
            clearTimeout(restoreTimer);
            // Every GL object died with the context; build a fresh set.
            try {
                install(createGpuTide(canvas, cssW || 1, cssH || 1));
            } catch (e) {
                useCanvas2D();
            }
        });
    }

    measure();
    if (hasWebGL()) {
        try {
            install(createGpuTide(canvas, cssW, cssH));
            wireContextLoss();
        } catch (e) {
            tide = null;
        }
    }
    if (!tide) useCanvas2D();

    /* Fix 1: the loop exists only while the hero is on screen. */
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(
            (entries) => {
                inView = entries[entries.length - 1].isIntersecting;
                sync();
            },
            { threshold: 0 }
        ).observe(hero);
    }
    /* Fix 2: and only while the tab is actually being looked at. */
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('resize', onResize, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize, { passive: true });

    /* If the visitor turns reduced-motion on mid-visit, stop and show the still. */
    const onReduce = () => {
        if (!reduce.matches) return;
        stop();
        if (tide) tide.destroy();
        tide = null;
        poster();
    };
    if (reduce.addEventListener) reduce.addEventListener('change', onReduce);
})();
