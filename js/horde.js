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
    let lineX = 0.52, kill = 0.11, orcPx = 2.6;
    let tracers = [];
    let live = 0;

    function seed(i, anywhere) {
        const o = i * STRIDE;
        // three feathered lanes, bell-curved like a real column
        const lane = Math.random();
        const yc = lane < 0.42 ? 0.3 : lane < 0.8 ? 0.62 : 0.86;
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
            // Height-only change (mobile URL bar): the buffer is normalised, so
            // resizing the backing store is the whole job.
            if (!widthChanged) return;
            const mobile = cssW < 620;
            lineX = mobile ? 0.4 : 0.6;   // matches the GPU tide's layout
            kill = mobile ? 0.16 : 0.11;
            orcPx = mobile ? 2.2 : 2.6;
            N = Math.max(1200, Math.min(MAX, Math.round((cssW * cssH) / (mobile ? 190 : 150))));
        },

        frame(t, dt) {
            const step = Math.min(dt || 0.016, 0.05);
            const lx = W * lineX;
            ctx.clearRect(0, 0, W, H);

            // burnt field haze past the line
            const g = ctx.createLinearGradient(lx, 0, lx + W * 0.24, 0);
            g.addColorStop(0, 'rgba(166,220,48,0.06)');
            g.addColorStop(1, 'rgba(166,220,48,0)');
            ctx.fillStyle = g;
            ctx.fillRect(lx, 0, W * 0.24, H);

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
                const y = yn * H;
                // the line holds: they die in the kill zone in front of it
                if (x < lineX + kill * orcs[o + 7]) {
                    orcs[o + 5] = 0;
                    if (tracers.length < 60 && Math.random() < 0.04) tracers.push({ y: y, age: 0 });
                    continue;
                }
                live++;
                ctx.fillStyle = GREENS[orcs[o + 4]];
                const s = orcs[o + 6] * orcPx * DPR;
                ctx.fillRect(x * W, y, s * 0.7, s);
            }

            // defended line: trench hairline, gold posts, muzzle flashes
            ctx.fillStyle = 'rgba(196,156,72,0.42)';
            ctx.fillRect(lx - DPR, 0, 2 * DPR, H);
            const posts = Math.max(5, Math.min(11, Math.round(H / DPR / 96)));
            for (let k = 0; k < posts; k++) {
                const f = (k + 0.5) / posts;
                const py = H * (0.045 + f * 0.915) + H * 0.011 * Math.sin(k * 3.7);
                ctx.fillStyle = '#c49c48';
                ctx.fillRect(lx - 3.5 * DPR, py - 5 * DPR, 7 * DPR, 10 * DPR);
                if ((t * 2.1 + k * 0.37) % 1 < 0.12) {
                    ctx.fillStyle = '#f2efe6';
                    ctx.fillRect(lx + 4 * DPR, py - 2 * DPR, 10 * DPR, 4 * DPR);
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
                ctx.strokeStyle = 'rgba(242,239,230,' + (0.9 * a).toFixed(2) + ')';
                ctx.beginPath();
                ctx.moveTo(lx + 8 * DPR, tr.y);
                ctx.lineTo(lx + (30 + (1 - a) * 300) * DPR, tr.y + (Math.random() - 0.5) * 3);
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
