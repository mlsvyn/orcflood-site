/* Hero horde tide: thousands of orc dots flow right-to-left against a thin
   defended line that fires tracers. Honest counter: #tide-n shows how many
   dots are alive on this page right now. Reduced motion => one still frame. */
(function () {
  var canvas = document.getElementById("horde");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DPR = Math.min(devicePixelRatio || 1, 2);
  var W = 0, H = 0, LINE_X = 0.52; // defended line, fraction of width

  var GREENS = ["#5f8412", "#729e1c", "#86b824", "#a6dc30"];
  var N = 0, orcs = null; // packed: x, y, speed, phase, hue, alive, size

  function resize() {
    var r = canvas.getBoundingClientRect();
    var mobile = r.width < 620;
    LINE_X = mobile ? 0.60 : 0.52;
    W = Math.max(1, Math.round(r.width * DPR));
    H = Math.max(1, Math.round(r.height * DPR));
    canvas.width = W; canvas.height = H;
    N = Math.round(Math.min(9000, (r.width * r.height) / (mobile ? 280 : 140)));
    orcs = new Float32Array(N * 7);
    for (var i = 0; i < N; i++) spawn(i, true);
  }

  function spawn(i, anywhere) {
    var o = i * 7;
    // three lanes of the tide, feathered like a real crowd (bell-curve y)
    var lane = Math.random();
    var yc = lane < 0.42 ? 0.30 : lane < 0.8 ? 0.62 : 0.86;
    var bell = (Math.random() + Math.random() - 1) * 0.5; // -0.5..0.5, peaked
    orcs[o] = anywhere ? W * (LINE_X + Math.random() * (1 - LINE_X)) : W * (1.02 + Math.random() * 0.08);
    orcs[o + 1] = H * (yc + bell * 0.34);
    orcs[o + 2] = (0.4 + Math.random() * 0.8) * DPR;   // speed px/frame
    orcs[o + 3] = Math.random() * 6.283;               // waddle phase
    orcs[o + 4] = (Math.random() * 4) | 0;             // color index
    orcs[o + 5] = 1;                                   // alive
    orcs[o + 6] = (1.5 + Math.random() * 1.5) * DPR;   // size: near/far depth
  }

  var tracers = []; // {y, age}
  var meter = document.getElementById("tide-n");
  var t = 0, alive = 0, meterTick = 0;
  var NNBSP = "\u202F"; // house numeral style: narrow no-break space groups

  function fmt(n) {
    return n.toLocaleString("en-US").replace(/,/g, NNBSP);
  }

  function frame() {
    t++;
    ctx.clearRect(0, 0, W, H);
    var lx = W * LINE_X;

    // ground char haze behind the line (the game's burnt field)
    var g = ctx.createLinearGradient(lx, 0, lx + W * 0.22, 0);
    g.addColorStop(0, "rgba(166,220,48,0.05)");
    g.addColorStop(1, "rgba(166,220,48,0)");
    ctx.fillStyle = g;
    ctx.fillRect(lx, 0, W * 0.22, H);

    alive = 0;
    for (var i = 0; i < N; i++) {
      var o = i * 7;
      if (orcs[o + 5] < 1) { // respawn dead after a beat
        if (Math.random() < 0.02) spawn(i, false);
        continue;
      }
      orcs[o] -= orcs[o + 2];
      var y = orcs[o + 1] + Math.sin(t * 0.09 + orcs[o + 3]) * 1.6 * DPR;
      // the line holds: orcs die in a shallow kill zone in front of it
      if (orcs[o] < lx + 14 * DPR) {
        orcs[o + 5] = 0;
        if (Math.random() < 0.05) tracers.push({ y: y, age: 0 });
        continue;
      }
      alive++;
      ctx.fillStyle = GREENS[orcs[o + 4]];
      var s = orcs[o + 6];
      ctx.fillRect(orcs[o], y, s, s);
    }

    // defended line: trench hairline + gold posts + muzzle flashes
    ctx.fillStyle = "rgba(196,156,72,0.4)";
    ctx.fillRect(lx - 1 * DPR, 0, 2 * DPR, H);
    for (var p = 0.12; p < 1; p += 0.11) {
      var py = H * p + Math.sin(p * 40) * 6 * DPR;
      ctx.fillStyle = "#c49c48";
      ctx.fillRect(lx - 3.5 * DPR, py - 5 * DPR, 7 * DPR, 10 * DPR);
      if ((t + ((p * 100) | 0)) % 20 < 4) { // muzzle flash, staggered
        ctx.fillStyle = "#f6f2e2";
        ctx.fillRect(lx + 4 * DPR, py - 2 * DPR, 9 * DPR, 4 * DPR);
      }
    }

    // tracers streak into the tide
    ctx.lineWidth = 1.5 * DPR;
    for (var k = tracers.length - 1; k >= 0; k--) {
      var tr = tracers[k];
      tr.age++;
      if (tr.age > 14) { tracers.splice(k, 1); continue; }
      var a = 1 - tr.age / 14;
      ctx.strokeStyle = "rgba(246,242,226," + (0.9 * a).toFixed(2) + ")";
      ctx.beginPath();
      ctx.moveTo(lx + 8 * DPR, tr.y);
      ctx.lineTo(lx + (30 + tr.age * 30) * DPR, tr.y + (Math.random() - 0.5) * 3);
      ctx.stroke();
    }

    if (meter && ++meterTick % 12 === 0) meter.textContent = fmt(alive);
  }

  function loop() { frame(); requestAnimationFrame(loop); }

  resize();
  addEventListener("resize", resize);
  if (reduced) {
    for (var w = 0; w < 90; w++) frame(); // settle, then hold one frame
    if (meter) meter.textContent = fmt(alive);
  } else {
    requestAnimationFrame(loop);
  }
})();
