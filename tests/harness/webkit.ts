/**
 * Safari's version, for skips keyed on a WebKit defect: the OS fixes Safari's
 * version, so such a skip names the last version it was measured on, and a
 * later Safari runs the test again. No import: the browser tests load it too.
 */

type Version = readonly [number, number, number];

/** `Version/26.6.2 … Safari/` → [26, 6, 2]; undefined off Safari (Chrome's agent ends in `Safari/` too). */
export const safariVersionOf = (userAgent: string): Version | undefined => {
  if (/Chrome\/|Chromium\/|Firefox\//.test(userAgent)) return undefined;
  const match = /Version\/(\d+)\.(\d+)(?:\.(\d+))?.*Safari\//.exec(userAgent);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

const atMost = (v: Version, last: Version): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== (last[i] as number)) {
      return (v[i] as number) < (last[i] as number);
    }
  }
  return true;
};

/**
 * WebKit's `terminate()` lets a worker's WASM loop run to its end, its OPFS
 * handles held meanwhile (WebKit 328618; SAFARI-TERMINATE-WASM, 2026-10-22:
 * 26.6.2 and 27.0.1, and Technology Preview 255). 27.0.1 is the last stable
 * version measured.
 */
export const terminateRunsWasm = (userAgent: string): boolean => {
  const v = safariVersionOf(userAgent);
  return v !== undefined && atMost(v, [27, 0, 1]);
};

export const TERMINATE_RUNS_WASM =
  "Safari ≤ 27.0.1: terminate() lets a worker's WASM loop run to its end, holding its OPFS handles (WebKit 328618)";
