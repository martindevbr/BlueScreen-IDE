/* BlueScreen: bs.capture — captura de tela, janela e som do computador para plugins, sem a janela "Escolha o que
   compartilhar" do navegador. Por baixo é a captura nativa do núcleo (src/capture.rs: rota capture/sources e o
   WebSocket /api/capture/ws); aqui ela vira MediaStream, para o plugin usar como usaria o getDisplayMedia:
     const fontes = await bs.capture.sources();                 // { screens: [...], windows: [...] } com miniaturas
     const som = await bs.capture.audio();                      // som do computador: som.stream (MediaStream)
     const tela = await bs.capture.video(fontes.screens[0].id); // tela.stream, tela.width, tela.height
     new MediaRecorder(new MediaStream([...tela.stream.getTracks(), ...som.stream.getTracks()])).start();
     ...; som.stop(); tela.stop();
   Só no Windows e só pelo PC local (aberta de outro aparelho, bs.capture.available() responde false). */
(function (bs) {
let ok = null;
async function available() {
  if (ok === null) { try { ok = !!(await bs.api('capture/sources', { thumbs: '0' }, { quiet: true }))?.supported; } catch { ok = false; } }
  return ok;
}
async function sources(opts = {}) {
  const r = await bs.api('capture/sources', opts.thumbs === false ? { thumbs: '0' } : {}, { quiet: true });
  if (!r || !r.supported) throw new Error('Captura nativa indisponível (só no Windows, pelo PC local).');
  return { screens: r.screens || [], windows: r.windows || [] };
}
// abre o WebSocket e espera o formato ({audio: {rate, ch}} ou {video: {w, h}}) ou o erro
function socket(params) {
  return new Promise((done, fail) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/capture/ws?' + new URLSearchParams(params));
    ws.binaryType = 'arraybuffer';
    const t = setTimeout(() => { ws.close(); fail(new Error('a captura não respondeu')); }, 8000);
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.error) { clearTimeout(t); ws.close(); fail(new Error(m.error)); }
      else if (m.audio || m.video) { clearTimeout(t); ws.onmessage = null; done({ ws, info: m.audio || m.video }); }
    };
    ws.onerror = () => { clearTimeout(t); fail(new Error('a captura não abriu')); };
  });
}
// toca o PCM (float, 2 canais) num AudioWorklet; segura no máximo ~0,4 s de atraso
const WORKLET = `class P extends AudioWorkletProcessor {
  constructor() { super(); this.q = []; this.off = 0; this.len = 0;
    this.port.onmessage = (e) => { const a = new Float32Array(e.data); this.q.push(a); this.len += a.length;
      while (this.len > sampleRate * 0.8 && this.q.length > 1) { const x = this.q.shift(); this.len -= x.length - this.off; this.off = 0; } }; }
  process(_, outs) { const L = outs[0][0], R = outs[0][1] || L;
    for (let i = 0; i < L.length; i++) {
      if (!this.q.length) { L[i] = R[i] = 0; continue; }
      const a = this.q[0]; L[i] = a[this.off]; R[i] = a[this.off + 1]; this.off += 2; this.len -= 2;
      if (this.off >= a.length) { this.q.shift(); this.off = 0; } }
    return true; } }
registerProcessor('bs-loopback', P);`;
const ended = (track, fn) => { if (fn) track.addEventListener('ended', fn); };
/** Som do computador (o que sai do alto-falante padrão). opts.context: um AudioContext seu (o som entra nele e
 *  `node` é a fonte, para misturar com outras); sem ele, um próprio na taxa do som, fechado no stop(). */
async function audio(opts = {}) {
  const { ws, info } = await socket({ src: 'audio' });
  const own = !opts.context, ctx = opts.context || new AudioContext({ sampleRate: info.rate });
  try {
    await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET));
  } catch (e) { ws.close(); if (own) ctx.close(); throw e; }
  const node = new AudioWorkletNode(ctx, 'bs-loopback', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination(); node.connect(dest);
  ws.onmessage = (e) => { if (typeof e.data !== 'string') node.port.postMessage(e.data, [e.data]); };
  const track = dest.stream.getAudioTracks()[0];
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; ws.onclose = null; ws.close(); node.disconnect(); track.stop(); if (own) ctx.close().catch(() => {}); };
  ws.onclose = () => { if (!stopped) { track.stop(); track.dispatchEvent(new Event('ended')); } };
  ended(track, opts.onEnded);
  return { stream: dest.stream, node, context: ctx, rate: info.rate, stop };
}
/** Imagem de uma tela ("m0", "m1"...) ou janela ("w<número>") de sources(). opts: fps (15), max (largura máxima, 1920).
 *  O tamanho fica o do começo: uma janela que muda de tamanho entra com tarja. */
async function video(id, opts = {}) {
  const fps = opts.fps || 15;
  const { ws, info } = await socket({ src: id, fps, max: opts.max || 1920 });
  const W = info.w, H = info.h;
  const draw = (c, bmp) => {
    const k = Math.min(W / bmp.width, H / bmp.height), w = bmp.width * k, h = bmp.height * k;
    if (w < W || h < H) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    c.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  };
  let track, put;
  if (window.MediaStreamTrackGenerator && window.VideoFrame && window.OffscreenCanvas) {
    // não depende da página estar visível (o canvas comum para de gerar quadros com a IDE atrás de outra janela)
    const gen = new MediaStreamTrackGenerator({ kind: 'video' }), wr = gen.writable.getWriter();
    const oc = new OffscreenCanvas(W, H), c = oc.getContext('2d');
    track = gen;
    put = (bmp) => { draw(c, bmp); wr.write(new VideoFrame(oc, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {}); };
  } else {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    track = cv.captureStream(fps).getVideoTracks()[0];
    put = (bmp) => draw(c, bmp);
  }
  let busy = false, stopped = false;
  const stop = () => { if (stopped) return; stopped = true; ws.onclose = null; ws.close(); track.stop(); };
  const finish = () => { if (!stopped) { stopped = true; track.stop(); track.dispatchEvent(new Event('ended')); } };
  ws.onmessage = async (e) => {
    if (typeof e.data === 'string') { if (JSON.parse(e.data).gone) { ws.onclose = null; ws.close(); finish(); } return; }
    if (busy) return; // atrasou: pula o quadro
    busy = true;
    try { const bmp = await createImageBitmap(new Blob([e.data], { type: 'image/jpeg' })); put(bmp); bmp.close(); } catch { /* quadro ruim */ }
    busy = false;
  };
  ws.onclose = finish;
  ended(track, opts.onEnded);
  return { stream: new MediaStream([track]), width: W, height: H, stop };
}
bs.capture = { available, sources, audio, video };
})(window.BS);
