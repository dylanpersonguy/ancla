/**
 * The hashing the verifier runs, isolated from the page.
 *
 * This is the only security-relevant code in the web app, and it has to stay
 * byte-identical to packages/merkle/src/index.ts and to the leaf construction in
 * packages/canonicalize/src/snapshot.ts. If it drifts, every published proof stops
 * verifying while the page keeps saying it verified.
 *
 * It lives in its own module with no DOM references so a Node test can import it
 * directly and compare it against the Node implementation, rather than a test
 * re-typing the same code and proving only that two copies of a mistake agree.
 * See packages/delivery/test/verifier-parity.test.ts.
 */

export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export const bytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

export async function sha256(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

// RFC 6962: leaves and internal nodes are domain-separated with 0x00 / 0x01, so a
// leaf digest can never be replayed as an internal node.
export const leafHash = (s) => sha256(new Uint8Array([0]), new TextEncoder().encode(s));
export const nodeHash = (l, r) => sha256(new Uint8Array([1]), l, r);

/** The leaf preimage: table, NUL, record id, NUL, byte hash. */
export function leafPreimage(table, id, byteHash) {
  const NUL = String.fromCharCode(0);
  return table + NUL + id + NUL + byteHash;
}

/** Walk the audit path from the leaf up, returning the root it produces. */
export async function recompute(p) {
  let acc = await leafHash(leafPreimage(p.table, p.id, p.byteHash));
  for (const step of p.proof) {
    const sib = bytes(step.hash);
    acc = step.side === "left" ? await nodeHash(sib, acc) : await nodeHash(acc, sib);
  }
  return hex(acc);
}
