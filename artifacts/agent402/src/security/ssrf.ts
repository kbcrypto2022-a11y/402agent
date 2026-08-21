/**
 * SSRF protection for the READ service.
 *
 * Blocks: non-http(s) schemes, localhost / *.localhost / *.internal names,
 * literal private/loopback/link-local/multicast IPs, and hostnames that
 * RESOLVE to such addresses. Redirects are followed manually with the same
 * validation applied to every hop.
 */

import dns from "node:dns/promises";
import dnsCb from "node:dns";
import net from "node:net";
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type Response,
} from "undici";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type SafeFetchFailureKind =
  | "dns"
  | "timeout"
  | "tls"
  | "blocked_redirect"
  | "unsupported_content_type"
  | "network";

export class SafeFetchError extends Error {
  readonly kind: SafeFetchFailureKind;

  constructor(kind: SafeFetchFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = "SafeFetchError";
    this.kind = kind;
    this.cause = cause;
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

/**
 * Parse an IPv6 literal into its full 16 bytes, handling `::` compression
 * and embedded dotted-quad IPv4 (e.g. `::127.0.0.1`). Returns null when the
 * literal is malformed.
 */
export function parseIPv6Bytes(ip: string): Uint8Array | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);

  // Embedded IPv4 tail → convert to two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4?.[1]) {
    const parts = v4[1].split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    addr =
      addr.slice(0, addr.length - v4[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const doubleColon = addr.indexOf("::");
  if (doubleColon !== addr.lastIndexOf("::")) return null; // at most one "::"
  let groups: string[];
  if (doubleColon >= 0) {
    const head = addr.slice(0, doubleColon).split(":").filter((g) => g !== "");
    const tail = addr.slice(doubleColon + 2).split(":").filter((g) => g !== "");
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = addr.split(":");
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function isPrivateIPv6(ip: string): boolean {
  const b = parseIPv6Bytes(ip);
  if (!b) return true; // unparseable literal — treat as unsafe
  const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
  const embeddedV4 = (offset: number) =>
    isPrivateIPv4(`${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`);

  // ::/96 — unspecified, loopback (::1), and IPv4-compatible (::a.b.c.d,
  // ::7f00:1). All of these can smuggle loopback/private targets.
  if (zeroPrefix(12)) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    if (v4 === "0.0.0.0" || v4 === "0.0.0.1") return true; // :: and ::1
    return isPrivateIPv4(v4);
  }
  // ::ffff:0:0/96 — IPv4-mapped.
  if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return embeddedV4(12);
  // 64:ff9b::/96 — NAT64.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return embeddedV4(12);
  }
  // 2002::/16 — 6to4 with embedded IPv4.
  if (b[0] === 0x20 && b[1] === 0x02) return embeddedV4(2);
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all — treat as unsafe when used as one
}

/**
 * Validate a URL for external fetching. Throws UnsafeUrlError on anything
 * that could reach internal networks. Returns the parsed URL.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`URL scheme not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new UnsafeUrlError("Host not allowed");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError("IP address not allowed");
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new SafeFetchError("dns", "Host could not be resolved", err);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("dns", "Host could not be resolved");
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new UnsafeUrlError("Host resolves to a private address");
    }
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

type LookupOptions = {
  all?: boolean;
};

type BaseResolver = (
  hostname: string,
  cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void,
) => void;

const defaultResolver: BaseResolver = (hostname, cb) => {
  dnsCb.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    cb(err, (addrs as { address: string; family: number }[]) ?? []);
  });
};

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return errorChain(error).some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "code" in item &&
      codes.includes(String((item as { code?: unknown }).code)),
  );
}

function classifyFetchError(error: unknown): SafeFetchError {
  const chain = errorChain(error);
  if (
    chain.some(
      (item) =>
        item instanceof Error &&
        (item.name === "TimeoutError" || item.name === "AbortError"),
    ) ||
    hasErrorCode(error, ["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"])
  ) {
    return new SafeFetchError("timeout", "Public source request timed out", error);
  }
  if (
    hasErrorCode(error, [
      "ENOTFOUND",
      "EAI_AGAIN",
      "EAI_FAIL",
      "EAI_NODATA",
      "ENETUNREACH",
    ])
  ) {
    return new SafeFetchError("dns", "Public source DNS resolution failed", error);
  }
  if (
    hasErrorCode(error, [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]) ||
    chain.some((item) => item instanceof Error && item.name === "TLSError")
  ) {
    return new SafeFetchError("tls", "Public source TLS negotiation failed", error);
  }
  return new SafeFetchError("network", "Public source request failed", error);
}

/**
 * DNS-rebinding protection: a lookup function that validates every resolved
 * address at CONNECTION time (not just at pre-validation time) and fails the
 * connection if any resolved address is private. Because the socket connects
 * to the exact address this lookup returns, a hostname cannot resolve
 * publicly during validation and privately for the actual request.
 */
export function createValidatingLookup(resolver: BaseResolver = defaultResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const returnAll = options?.all === true;

    // Literal IPs skip DNS but must still be validated here (redirect hops
    // construct new connections through this same connector).
    if (net.isIP(hostname)) {
      if (isPrivateIp(hostname)) {
        callback(new UnsafeUrlError("IP address not allowed"), "", 4);
      } else {
        const family = net.isIP(hostname);
        callback(
          null,
          returnAll ? [{ address: hostname, family }] : hostname,
          returnAll ? undefined : family,
        );
      }
      return;
    }
    resolver(hostname, (err, addrs) => {
      if (err) return callback(err, "", 4);
      if (!addrs || addrs.length === 0) {
        return callback(new UnsafeUrlError("Host could not be resolved"), "", 4);
      }
      const bad = addrs.find((a) => isPrivateIp(a.address));
      if (bad) {
        return callback(
          new UnsafeUrlError("Host resolves to a private address"),
          "",
          4,
        );
      }
      const first = addrs[0]!;
      callback(
        null,
        returnAll ? addrs : first.address,
        returnAll ? undefined : first.family,
      );
    });
  };
}

/** Shared dispatcher that pins connections to validated resolved addresses. */
let pinnedDispatcher: Dispatcher | null = null;
export function getPinnedDispatcher(): Dispatcher {
  if (!pinnedDispatcher) {
    pinnedDispatcher = new Agent({
      connect: { lookup: createValidatingLookup() },
    });
  }
  return pinnedDispatcher;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

/**
 * Fetch a public URL with SSRF validation on every redirect hop, a size cap,
 * and a timeout. Text content only.
 */
export async function safeFetchText(
  rawUrl: string,
  opts: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    /** Test hook for exercising the same protected request path. */
    dispatcher?: Dispatcher;
  } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 3;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = await assertPublicHttpUrl(current);
    } catch (err) {
      if (hop > 0 && err instanceof UnsafeUrlError) {
        throw new SafeFetchError(
          "blocked_redirect",
          "Redirect target was rejected",
          err,
        );
      }
      throw err;
    }
    let res: Response;
    try {
      res = await undiciFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        // Use the installed Undici fetch with its matching dispatcher. Node's
        // built-in fetch uses a separate internal Undici version.
        dispatcher: opts.dispatcher ?? getPinnedDispatcher(),
        headers: {
          "User-Agent": "Agent402/0.1 (+https://agent402.example) content-reader",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
      });
    } catch (err) {
      // Undici wraps connector failures; surface our SSRF rejection directly.
      let cause: unknown = err;
      while (cause instanceof Error) {
        if (cause instanceof UnsafeUrlError) {
          throw new SafeFetchError(
            "dns",
            "Connection-time DNS validation rejected the source",
            err,
          );
        }
        cause = cause.cause;
      }
      throw classifyFetchError(err);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!loc) {
        throw new SafeFetchError(
          "blocked_redirect",
          "Redirect response did not include a location",
        );
      }
      current = new URL(loc, url).toString();
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (
      contentType &&
      !/text|html|xml|json/i.test(contentType)
    ) {
      res.body?.cancel().catch(() => {});
      throw new SafeFetchError(
        "unsupported_content_type",
        `Unsupported content type: ${contentType.split(";")[0]}`,
      );
    }
    // Stream with a hard byte cap.
    let body = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          body += decoder.decode(value.subarray(0, Math.max(0, maxBytes - (bytes - value.byteLength))));
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    }
    return { finalUrl: url.toString(), status: res.status, contentType, body };
  }
  throw new SafeFetchError("blocked_redirect", "Too many redirects");
}
