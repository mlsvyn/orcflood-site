/* Canvas2D orc tide — the FALLBACK renderer.
 *
 * js/hero.js runs the GPU tide (tens of thousands of instanced sprites). This
 * file is what runs when there is no WebGL, or when the GL context dies twice:
 * the original hand-rolled particle tide, thousands of orc dots flowing
 * right-to-left into a gold defended line that fires back. hero.js imports it
 * lazily, so a visitor with working WebGL never downloads it.
 *
 * Same contract as the GPU tide, so the one rAF driver in hero.js can pause it
 * on scroll / tab-hide and resize it without reallocating:
 *   resize(cssW, cssH, widthChanged) · frame(t, dt) · alive() · destroy()
 *
 * Positions are normalised (0..1 of the hero box) and speeds are per second, so
 * a resize never touches the particle buffer and a frame rate change never
 * changes how fast the tide moves.
 */

const GREENS = ['#425c0d', '#5f8412', '#729e1c', '#86b824', '#a6dc30'];
const STRIDE = 8; // x, y, speed, phase, colour, alive, size, death bias

export function createCanvasTide(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('no 2d context');

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const MAX = 9000; // a fallback runs on the weak hardware: stay modest
    const orcs = new Float32Array(MAX * STRIDE);

    let W = 1, H = 1, N = 0;
    let lineX = 0.6, kill = 0.11, orcPx = 2.6;
    let tracers = [];
    let live = 0;
    /* Same composition split as the GPU tide (js/hero.js): landscape marches
       right-to-left into a vertical line, portrait turns the whole battle a
       quarter turn — the line lies across the screen low down and the flood
       climbs into it. Positions stay in battle space (x along the march, y
       across it) and only these two helpers know which way up we are. */
    let portrait = false, lineAt = 0.65, mScale = 1;
    const px = (x, y) => (portrait ? y : x) * W;
    const py = (x, y) => (portrait ? lineAt + (x - lineX) * mScale : y) * H;

    function seed(i, anywhere) {
        const o = i * STRIDE;
        // three feathered lanes across the front, bell-curved like a real column
        const lane = Math.random();
        const L = portrait ? [0.22, 0.5, 0.79] : [0.3, 0.62, 0.86];
        const yc = lane < 0.42 ? L[0] : lane < 0.8 ? L[1] : L[2];
        const bell = (Math.random() + Math.random() - 1) * 0.5;
        orcs[o] = anywhere ? lineX + Math.random() * (1.05 - lineX) : 1.02 + Math.random() * 0.08;
        orcs[o + 1] = Math.min(0.975, Math.max(0.025, yc + bell * 0.34));
        orcs[o + 2] = 0.024 + Math.random() * 0.05; // widths per second
        orcs[o + 3] = Math.random() * 6.283;
        orcs[o + 4] = (Math.random() * GREENS.length) | 0;
        orcs[o + 5] = 1;
        orcs[o + 6] = 0.75 + Math.random() * 0.75; // depth: near/far
        orcs[o + 7] = Math.random() < 0.2 ? Math.pow(Math.random(), 0.5) : Math.pow(Math.random(), 2.6);
    }
    for (let i = 0; i < MAX; i++) seed(i, true);

    return {
        kind: 'canvas2d',

        resize(cssW, cssH, widthChanged) {
            W = Math.max(1, Math.round(cssW * DPR));
            H = Math.max(1, Math.round(cssH * DPR));
            canvas.width = W;
            canvas.height = H;
            /* Where the line sits and how the march maps onto the screen is
               height-derived in portrait, so it is redone on any change. The
               orientation comes from the CSS's own query rather than a repeated
               number: cssW is the hero element's width and excludes the
               scrollbar, so comparing it to the breakpoint turned the battle
               ~15px before the copy stacked. */
            portrait = window.matchMedia('(max-width: 900px)').matches;
            lineAt = Math.min(0.72, Math.max(0.55, 1 - 228 / cssH));
            mScale = (1.05 - lineAt) / (1.07 - lineX);
            // Height-only change (mobile URL bar): the buffer is normalised, so
            // resizing the backing store is the rest of the job.
            if (!widthChanged) return;
            kill = portrait ? 0.070 : 0.048;  // matches the GPU tide's layout
            orcPx = portrait ? 3.2 : 2.6;
            N = Math.max(1200, Math.min(MAX, Math.round((cssW * cssH) / (portrait ? 95 : 150))));
        },

        frame(t, dt) {
            const step = Math.min(dt || 0.016, 0.05);
            ctx.clearRect(0, 0, W, H);
            // unit vector, in screen px, from the line INTO the tide
            const mx = portrait ? 0 : -1, my = portrait ? 1 : 0;

            // burnt field haze past the line
            const l0 = [px(lineX, 0.5), py(lineX, 0.5)];
            const far = 0.24 * (portrait ? H : W);
            const g = ctx.createLinearGradient(l0[0], l0[1], l0[0] - mx * far, l0[1] + my * far);
            g.addColorStop(0, 'rgba(166,220,48,0.06)');
            g.addColorStop(1, 'rgba(166,220,48,0)');
            ctx.fillStyle = g;
            if (portrait) ctx.fillRect(0, l0[1], W, far);
            else ctx.fillRect(l0[0], 0, far, H);

            live = 0;
            for (let i = 0; i < N; i++) {
                const o = i * STRIDE;
                if (orcs[o + 5] < 1) {
                    if (Math.random() < step * 2.2) seed(i, false); // respawn after a beat
                    continue;
                }
                orcs[o] -= orcs[o + 2] * step;
                const x = orcs[o];
                const yn = orcs[o + 1] + Math.sin(t * 5.4 + orcs[o + 3]) * 0.0022;
                /* The front is a field in the lateral axis and in time, not a
                   line: same idea as the GPU tide's holdField, so a pack of
                   neighbours shares one front and it breathes. */
                const hold = Math.max(0, 0.5 + 0.34 * Math.sin(yn * 16.0 + t * 0.3)
                                             + 0.2 * Math.sin(yn * 37.0 - t * 0.5) - 0.2);
                if (x < lineX + kill * (0.75 * hold + 0.45 * orcs[o + 7])) {
                    orcs[o + 5] = 0;
                    if (tracers.length < 60 && Math.random() < 0.04) tracers.push({ y: yn, age: 0 });
                    continue;
                }
                live++;
                ctx.fillStyle = GREENS[orcs[o + 4]];
                const s = orcs[o + 6] * orcPx * DPR;
                ctx.fillRect(px(x, yn), py(x, yn), s * 0.7, s);
            }

            // defended line: trench hairline, gold posts, muzzle flashes
            ctx.fillStyle = 'rgba(196,156,72,0.42)';
            if (portrait) ctx.fillRect(0, l0[1] - DPR, W, 2 * DPR);
            else ctx.fillRect(l0[0] - DPR, 0, 2 * DPR, H);
            const span = (portrait ? W : H) / DPR;
            const posts = Math.max(5, Math.min(11, Math.round(span / 96)));
            for (let k = 0; k < posts; k++) {
                const f = 0.09 + ((k + 0.5) / posts) * 0.82 + 0.011 * Math.sin(k * 3.7);
                const cx = px(lineX, f), cy = py(lineX, f);
                ctx.fillStyle = '#c49c48';
                // a post is 7x10 across the line, whichever way the line runs
                if (portrait) ctx.fillRect(cx - 5 * DPR, cy - 3.5 * DPR, 10 * DPR, 7 * DPR);
                else ctx.fillRect(cx - 3.5 * DPR, cy - 5 * DPR, 7 * DPR, 10 * DPR);
                if ((t * 2.1 + k * 0.37) % 1 < 0.12) {
                    ctx.fillStyle = '#f2efe6';
                    const fx = cx - mx * 4 * DPR, fy = cy + my * 4 * DPR;
                    if (portrait) ctx.fillRect(fx - 2 * DPR, fy, 4 * DPR, 10 * DPR);
                    else ctx.fillRect(fx, fy - 2 * DPR, 10 * DPR, 4 * DPR);
                }
            }

            // tracers streak out into the tide
            ctx.lineWidth = 1.5 * DPR;
            for (let k = tracers.length - 1; k >= 0; k--) {
                const tr = tracers[k];
                tr.age += step;
                if (tr.age > 0.24) {
                    tracers.splice(k, 1);
                    continue;
                }
                const a = 1 - tr.age / 0.24;
                const j = (Math.random() - 0.5) * 3;
                const bx = px(lineX, tr.y), by = py(lineX, tr.y);
                const len = (30 + (1 - a) * 300) * DPR;
                ctx.strokeStyle = 'rgba(242,239,230,' + (0.9 * a).toFixed(2) + ')';
                ctx.beginPath();
                ctx.moveTo(bx - mx * 8 * DPR + my * j, by + my * 8 * DPR - mx * j);
                ctx.lineTo(bx - mx * len + my * j, by + my * len - mx * j);
                ctx.stroke();
            }
        },

        /* Honest: the number of dots that are actually alive on this page. */
        alive() {
            return live;
        },

        destroy() {
            tracers = [];
            ctx.clearRect(0, 0, W, H);
        },
    };
}
