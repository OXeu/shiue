// Independently implements Anubis's SHA-256 / leading-zero-hex puzzle.
// No third-party script, WASM, persistent cookie or main-thread hashing.
let running = false;
self.onmessage = async ({ data }) => {
  if (running) return;
  running = true;
  try {
    const { challenge, difficulty } = data;
    if (!/^[a-f0-9]{64}$/.test(challenge) || !Number.isInteger(difficulty) || difficulty < 4 || difficulty > 6 || !self.crypto?.subtle) throw new Error();
    const encoder = new TextEncoder();
    const started = performance.now();
    let reported = started;
    for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce++) {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(challenge + nonce)));
      let valid = true;
      for (let digit = 0; digit < difficulty; digit++) {
        const value = digit % 2 === 0 ? bytes[digit >> 1] >>> 4 : bytes[digit >> 1] & 15;
        if (value !== 0) { valid = false; break; }
      }
      if (valid) { self.postMessage({ nonce: String(nonce) }); return; }
      if (nonce % 256 === 0) {
        const current = performance.now();
        if (current - started > 90000) throw new Error();
        if (current - reported >= 1000) {
          self.postMessage({ elapsed: Math.floor((current - started) / 1000) });
          reported = current;
        }
      }
    }
    throw new Error();
  } catch { self.postMessage({ error: true }); }
};
