/* Hero tide — GPU crowd.
 *
 * WHAT: tens of thousands of instanced orc sprites flowing along a flow field
 * into the gold defended line, where they die against a ragged, breathing
 * pressure front. One draw call for the whole tide; every orc's position, size,
 * colour and death are computed in the vertex shader from a single time uniform,
 * so the CPU never touches a particle. Renderer: OGL 1.0.11, vendored in
 * js/vendor/ogl (Unlicense).
 *
 * TWO COMPOSITIONS, ONE SIMULATION. Every pass works in "battle space" (x along
 * the march, y across the front) and battle space is mapped onto the screen in
 * exactly one place — battleMap(), fed to the shaders as uOrigin/uAxisM/uAxisL.
 * Landscape gets the identity: the horde marches right-to-left into a vertical
 * line. Portrait (<= 900px, where css/site.css stacks the hero and shades it
 * top-to-bottom) gets a quarter turn: the line lies ACROSS the hero low down,
 * the guns stand along it, and the flood climbs into it from the bottom edge.
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
/* BATTLE SPACE -> SCREEN, the one place orientation is decided.
 *
 * Every pass below works in "battle space": b.x runs along the march (1.07 at
 * the far muster, uLineX at the defended line), b.y runs across it (0..1 of the
 * front's width, the lanes). Screen space is 0..1 of the hero box.
 *
 *   screen = uOrigin + b.x * uAxisM + b.y * uAxisL
 *
 * Landscape passes the identity, so the desktop picture is exactly what it was.
 * Portrait passes a 90-degree rotation: the line lies ACROSS the screen low
 * down, the horde climbs into it from the bottom edge. Nothing else in any pass
 * changes — that is the whole point of doing it here.
 *
 * uAspect is the ratio march-px : lateral-px, so anything that wants a round
 * shape (scorched zones, deflection) stays round in both orientations.
 * uMarchPx is device px per unit of b.x, for the passes that measure in px.
 * The fragment passes need the inverse: b.x = dot(uBx, vec3(screen, 1.0)).
 */
const BATTLE_GLSL = /* glsl */ `
uniform vec2  uOrigin;
uniform vec2  uAxisM;
uniform vec2  uAxisL;
uniform vec3  uBx;
uniform vec3  uBy;
uniform float uMarchPx;
uniform float uAimRot;   // 0 landscape, +PI/2 portrait: barrels turn to face the march
vec2 toScreen(vec2 b) { return uOrigin + b.x * uAxisM + b.y * uAxisL; }
vec2 toBattle(vec2 s) { vec3 h = vec3(s, 1.0); return vec2(dot(uBx, h), dot(uBy, h)); }
`;

const TIDE_VERT = /* glsl */ `
precision highp float;

attribute vec2 position;  // unit quad, -0.5..0.5
attribute vec4 seed;      // x life offset, y revolutions/sec, z lane y, w phase
attribute vec4 trait;     // x depth, y colour mix, z front pressure, w dead fraction

uniform float uTime;
uniform vec2  uRes;       // drawing buffer, device px
uniform float uPx;        // device px per css px
uniform float uAspect;
uniform float uLineX;
uniform float uKill;
uniform float uOrcPx;
uniform float uFrontK; // front detail per lateral unit: 1 at a 900px front
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
` + BATTLE_GLSL + /* glsl */ `

// Push away from a scorched zone as the orc passes it, then relax downstream:
// the tide splits and closes again.
float deflect(vec3 o, float x, float y0) {
    float a    = (x - o.x) * uAspect / o.z;
    float dy   = (y0 - o.y) / o.z;
    float near = exp(-dy * dy * 0.85);
    float ramp = smoothstep(1.7, -0.4, a) * (1.0 - 0.55 * smoothstep(-0.6, -2.8, a));
    return sign(dy + 0.0001) * o.z * 0.34 * near * ramp;
}

/* HOW FAR THE LINE IS HOLDING THE HORDE OFF, at this point on the front.
   A field in the lateral axis and in time, NOT a per-body random: it is a
   function of position, so every neighbour reads the same value and a pack
   arrives as one body. Four octaves give pockets that reach the wall and
   stretches held a full kill-band out; the time terms drift the pattern
   sideways and pulse it, so the front breathes instead of standing still.
   uFrontK scales the octaves so a bulge is the same size IN PIXELS on any
   front: without it a phone's short front gets one lonely dome. */
float holdField(float y, float t) {
    float k = uFrontK;
    float h = 0.50 * sin(y *  6.9 * k + t * 0.21)
            + 0.28 * sin(y * 15.7 * k - t * 0.37 + 1.7)
            + 0.14 * sin(y * 33.0 * k + t * 0.61 + 4.1)
            + 0.08 * sin(y * 61.0 * k - t * 0.95 + 2.3);
    return smoothstep(-0.52, 0.60, h);
}

void main() {
    float p    = fract(seed.x + uTime * seed.y);
    float df   = trait.w;
    float live = 1.0 - df;
    float m    = min(p / live, 1.0);              // march progress 0..1
    float dead = max(0.0, (p - live) / df);       // 0 while alive, then 0..1

    // Decelerate into the line: the mass piles up instead of sheeting through.
    float e = 1.0 - pow(1.0 - m, 1.62);
    /* Where THIS body's march ends. Three terms, in order of scale:
         the front field   — the shape of the pressure front (coherent)
         the pack's press  — this mob's own share of it (coherent per pack)
         a per-body stack  — squared, so most bodies crowd the contact edge and
                             the rest pile back off it: depth, not a contour.
       hold is clamped to >= 0 and the whole offset is added, never subtracted,
       so the front CANNOT cross the trench however the terms land. */
    float jo   = fract(seed.w * 0.31830989 * 17.0);
    /* Weighted so the MEDIAN body is in contact and only a minority stand off.
       The first cut let the coherent term alone reach 1.0, and since it is a
       field the whole lane stood off together — a 160px band of empty ground
       between the guns and the horde, which read as the crowd being afraid of
       the line rather than pressing on it. */
    float hold = clamp(0.52 * holdField(seed.z, uTime)
                     + 0.30 * trait.z
                     + 0.26 * jo * jo - 0.20, 0.0, 1.0);
    float front = uLineX + uKill * hold;
    float x = mix(1.07, front, e);

    float y = seed.z;
    // Flow field, sampled at the orc's own position: neighbours get the same
    // push, so a column stays a column and snakes as one body.
    y += 0.042 * sin(x * 4.1 - uTime * 0.30 + seed.z * 8.0);
    y += 0.020 * sin(x * 9.7 + uTime * 0.52 + seed.z * 3.0);
    float press = smoothstep(0.25, 1.0, m);
    y += press * 0.020 * sin(seed.w * 2.7 + seed.x * 9.1);   // fan out on the line
    /* ...and slide ALONG the front, down the pressure gradient, so a pocket
       actually FILLS with bodies instead of merely reaching further. This is
       what makes the front read as a crowd under pressure rather than a
       wavy edge: mass gathers where the line is giving way. */
    float eps = 0.013 / uFrontK;
    y -= press * 0.030 * (holdField(seed.z + eps, uTime) - holdField(seed.z - eps, uTime));
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

    // Only the POSITION is mapped into screen space; the quad itself stays
    // screen-axis-aligned and sized in device px, so a body is never stretched
    // by the viewport's aspect and never lies on its side in portrait.
    vec2 c  = toScreen(vec2(x, y)) * uRes;
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
` + BATTLE_GLSL + /* glsl */ `

uniform vec3 uLanes;
float lane(float y, float c, float h) { return 1.0 - smoothstep(h * 0.45, h, abs(y - c)); }

vec3 scar(vec3 o, vec2 b) {
    vec2 d  = vec2((b.x - o.x) * uAspect, b.y - o.y) / o.z;
    float r = length(d);
    float inner = 1.0 - smoothstep(0.10, 1.20, r);
    float ember = 0.5 + 0.5 * sin(uTime * 2.3 + o.y * 37.0 + r * 9.0);
    // char is near-black; only the live fire glows, the way the game stamps it
    return uFire * inner * inner * (0.05 + 0.09 * ember) - vec3(0.012) * inner;
}

void main() {
    vec2 b = toBattle(vUv);
    float d = b.x - uLineX;
    float field = smoothstep(-0.03, 0.06, d);       // ground only beyond the line
    float L = max(max(lane(b.y, uLanes.x, 0.17), lane(b.y, uLanes.y, 0.18)), lane(b.y, uLanes.z, 0.15));
    float g = fract(sin(dot(floor(vUv * uRes / 7.0), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 c = mix(uRock * 0.042, uDirt * 0.075, L) * field * (0.7 + 0.6 * g);
    // corpses never decay in this game: the ground at the line is a mat of them
    float mat = (1.0 - smoothstep(0.0, 0.09, d)) * step(-0.004, d) * (0.35 + 0.65 * L);
    c += uBlood * mat * 0.85;
    c += uAcc * (1.0 - smoothstep(0.0, 0.20, abs(d - 0.03))) * 0.035;   // gunlight wash
    c += scar(uObs0, b) + scar(uObs1, b) + scar(uObs2, b);
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
` + BATTLE_GLSL + /* glsl */ `
void main() {
    // device px on the DEFENDED side of the line, measured along the march axis
    float d = (uLineX - toBattle(vUv).x) * uMarchPx;
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
` + BATTLE_GLSL + /* glsl */ `
void main() {
    float aim = uAimRot + tur.z + 0.16 * sin(uTime * 0.37 + tur.w * 6.283)
                                + 0.05 * sin(uTime * 1.10 + tur.w * 3.1);
    float s = uTurPx * uPx;
    vec2 q = position * s;
    vec2 r = vec2(q.x * cos(aim) - q.y * sin(aim), q.x * sin(aim) + q.y * cos(aim));
    // an emplacement stands ON the line, at its own place along it
    vec2 p = toScreen(vec2(uLineX, tur.x)) * uRes + r;
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
` + BATTLE_GLSL + /* glsl */ `

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
    float aim = uAimRot + bulA.y + aimAt(aimT, bulA.z);
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
    vec2 p = toScreen(vec2(uLineX, bulA.x)) * uRes + off;
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Density is per-area, so a phone and a desktop read as the same crowd.
   The battle geometry is identical in both orientations — same line at the same
   place in battle space, same kill band. What changes is only how battle space
   is laid onto the screen (see battleMap) and how big a body is drawn. */
/* The single source of truth for "is the hero stacked?" — the same query the
   stacking block in css/site.css uses, so the battle's orientation and the copy's
   layout can never disagree. */
const PORTRAIT_MQ = window.matchMedia('(max-width: 900px)');

function layout(cssW, cssH) {
    /* Once css/site.css stacks the hero into a column and shades it
       top-to-bottom: the layout says "copy up top, spectacle at the bottom".
       So the battle turns with it — the line lies ACROSS the screen and the
       flood rises into it from the bottom edge. */
    /* Ask the CSS the question instead of restating its number. cssW is the
       hero ELEMENT's width, which excludes the scrollbar, while the media query
       goes by the viewport — so comparing cssW to the number disagreed with the CSS
       across a ~15px band (at a 621px viewport the element is ~606: the JS
       turned the battle while the CSS kept the desktop copy, and the guns and
       crowd landed on top of the store buttons). matchMedia cannot drift. */
    const portrait = PORTRAIT_MQ.matches;
    const area = cssW * cssH;
    /* The band below the line is where the whole crowd lives, so give it a real
       height (~300 css px) and never let it eat more than the bottom 45%: above
       it is the copy, which has to stay readable. */
    const lineAt = portrait ? clamp(1 - 300 / cssH, 0.55, 0.68) : 0;
    // lateral extent of the front in css px: the width in portrait, the height otherwise
    const lat = portrait ? cssW : cssH;
    // keep a bulge in the front the same size in px whatever the front's length
    const frontK = clamp(900 / lat, 0.8, 3.2);
    return {
        portrait: portrait,
        lineX: 0.6,
        /* Depth of the kill band as a fraction of the march axis. Halved from
           the first cut: at a 1700px hero, 0.095 meant the front could stand
           161px off the guns, and a whole lane doing it at once left a dead
           band. ~80px is enough for a ragged edge with real pockets. */
        kill: portrait ? 0.070 : 0.048,
        lineAt: lineAt,
        /* Where the far muster (battle x = 1.07) lands. Just off the bottom edge
           in portrait, so bodies walk in from behind the meter panel rather than
           popping into existence mid-screen. */
        spawnAt: 1.05,
        orcPx: portrait ? 6.6 : 5.6,   // chunkier on a phone: it reads under the vignette
        frontK: frontK,
        dark: portrait ? 0.52 : 0.3,
        lanes: portrait ? [0.18, 0.5, 0.82] : [0.28, 0.6, 0.87],
        /* How wide a pack sits across its lane. On a phone the front is the
           whole width of the screen and the three columns have to merge into one
           mass across it — three thin ribbons with gaps between them reads as
           streams, not as a flood. */
        spread: portrait ? 1.95 : 1,
        turrets: clamp(Math.round(lat / (portrait ? 78 : 148)), 3, 7),
        turretPx: portrait ? 42 : 58,
        count: Math.max(6000, Math.min(portrait ? 30000 : 84000, Math.round(area / (portrait ? 13 : 17)))),
    };
}

/* Battle space -> screen, as plain numbers for the uniforms in BATTLE_GLSL.
   Landscape is the identity map, so the desktop composition is untouched.
   Portrait rotates a quarter turn: b.y becomes screen x (the front spans the
   full width), b.x becomes screen y (the march climbs the screen). */
function battleMap(cfg, resW, resH) {
    if (!cfg.portrait) {
        return {
            origin: [0, 0], axisM: [1, 0], axisL: [0, 1],
            bx: [1, 0, 0], by: [0, 1, 0],
            marchPx: resW, aspect: resW / resH, aimRot: 0,
        };
    }
    const s = (cfg.spawnAt - cfg.lineAt) / (1.07 - cfg.lineX); // screen y per unit march
    const oy = cfg.lineAt - cfg.lineX * s;
    return {
        origin: [0, oy], axisM: [0, s], axisL: [1, 0],
        bx: [0, 1 / s, -oy / s], by: [1, 0, 0],
        marchPx: s * resH, aspect: (s * resH) / resW,
        // the horde is DOWN-screen of the line here, so the barrels swing to it
        aimRot: Math.PI / 2,
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
        uLineX: { value: 0.6 },
        uKill: { value: 0.095 },
        // battle space -> screen; resize() fills these in (identity in landscape)
        uOrigin: { value: [0, 0] },
        uAxisM: { value: [1, 0] },
        uAxisL: { value: [0, 1] },
        uBx: { value: [1, 0, 0] },
        uBy: { value: [0, 1, 0] },
        uMarchPx: { value: 1 },
        uAimRot: { value: 0 },
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
            uFrontK: { value: 1 },
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
    /* Lanes are LATERAL positions, so they mean the same thing in both
       orientations — but the crowd buffer is seeded exactly once (a resize must
       never reallocate), so the lanes are fixed at boot from the boot layout.
       uLanes therefore tracks the SEEDED lanes for the life of the context, and
       a device that is rotated across the stacking breakpoint keeps the lane set it
       booted with; the values are close enough that nothing breaks. */
    const BOOT = layout(cssW, cssH);
    const LANES = BOOT.lanes;
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
        const h4 = hash(c * 4.7 + 0.2), h5 = hash(c * 5.3 + 0.6), h6 = hash(c * 6.1 + 0.35);
        const laneY = h1 < 0.42 ? LANES[0] : h1 < 0.8 ? LANES[1] : LANES[2];
        const loose = h5 < 0.17;
        const jx = loose ? 0.055 : 0.014;               // depth of the pack, in life fraction
        const jy = (loose ? 0.038 : 0.011) * BOOT.spread; // width of the pack, laterally
        const packY = laneY + (h2 - 0.5) * (loose ? 0.22 : 0.085) * BOOT.spread;
        const packDepth = 0.15 + h4 * 0.85;
        seed[o] = (h3 + (Math.random() - 0.5) * jx + 1) % 1; // pack's place in the queue
        seed[o + 1] = 1 / (5.5 + (1 - packDepth) * 7.5 + h4 * 1.5); // pack's pace
        seed[o + 2] = Math.min(0.985, Math.max(0.015, packY + (Math.random() + Math.random() - 1) * jy));
        seed[o + 3] = Math.random() * 6.283;
        trait[o] = Math.min(1, Math.max(0, packDepth + (Math.random() - 0.5) * 0.18));
        trait[o + 1] = Math.pow(Math.random(), 2.4);
        /* This body's share of how far it is held off the line (the vertex
           shader adds the front field and a per-body stack on top). It is a
           PACK value, not a per-orc one: a pack that punches deep punches deep
           together, which is what makes a pocket read as a pocket instead of
           noise. On top of it, one body in eight is a skirmisher picked off well
           short of the line, which gives the front depth of field. */
        trait[o + 2] = Math.min(1, h6 * 0.62 + (Math.random() < 0.12 ? 0.3 + Math.random() * 0.7 : 0));
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
    function setTurrets(n, turretPx, portrait) {
        const pxPerWu = turretPx / 18; // a tower is 18 world units wide in game
        /* Inset the end emplacements far enough that no gun is ever sliced by
           the edge of the hero: half a sprite plus the swing of its barrel. */
        const pad = portrait ? 0.11 : 0.085;
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            const jog = Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 4.1414) * 0.5;
            const kind = (i * 3 + ((i * i) % 5)) % TOWERS.length;
            const gun = GUNS[TOWERS[kind]];
            turData[o] = pad + ((i + 0.5) / n) * (1 - 2 * pad) + jog * (portrait ? 0.02 : 0.035);
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
            /* The ONE place orientation is decided. Every pass reads the same
               battle->screen map, so nothing below is orientation-aware. */
            const map = battleMap(cfg, res[0], res[1]);
            for (const p of progs) {
                p.uniforms.uRes.value = res;
                p.uniforms.uAspect.value = map.aspect;
                p.uniforms.uOrigin.value = map.origin;
                p.uniforms.uAxisM.value = map.axisM;
                p.uniforms.uAxisL.value = map.axisL;
                p.uniforms.uBx.value = map.bx;
                p.uniforms.uBy.value = map.by;
                p.uniforms.uMarchPx.value = map.marchPx;
                p.uniforms.uAimRot.value = map.aimRot;
            }
            turretProg.uniforms.uTurPx.value = cfg.turretPx;
            setTurrets(cfg.turrets, cfg.turretPx, cfg.portrait);
            /* Height-only change (mobile URL bar collapsing mid-scroll): the
               battle->screen map above IS height-derived in portrait, so it has
               already been redone; everything from here down — the buffer, the
               crowd size, the line, the scorched zones — is width-derived, so
               stop. Nothing is reallocated on either path. */
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
            tideProg.uniforms.uFrontK.value = cfg.frontK;
            // a phone's vignette sits on top of the whole hero, so lift the floor
            tideProg.uniforms.uDark.value = cfg.dark;
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

    /* Crossing the stack breakpoint turns the whole battle, so it has to take the
       expensive path even in the rare case where the element's width lands on the
       same rounded pixel (a scrollbar appearing as the copy reflows can do that).
       Tracked here rather than inferred from the width, which is exactly the
       assumption that put the JS and the CSS on different sides of the breakpoint. */
    let wasPortrait = PORTRAIT_MQ.matches;

    function measure() {
        const r = hero.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        const turned = PORTRAIT_MQ.matches !== wasPortrait;
        const widthChanged = w !== cssW || turned;
        wasPortrait = PORTRAIT_MQ.matches;
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
            if (Math.round(r.width) === cssW && Math.round(r.height) === cssH
                && PORTRAIT_MQ.matches === wasPortrait) return;
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
