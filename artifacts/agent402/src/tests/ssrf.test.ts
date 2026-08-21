import { describe, expect, it } from "vitest";
import { Agent } from "undici";
import {
  assertPublicHttpUrl,
  createValidatingLookup,
  isPrivateIp,
  parseIPv6Bytes,
  safeFetchText,
  SafeFetchError,
  UnsafeUrlError,
} from "../security/ssrf";

describe("SSRF protection", () => {
  const rejected = async (url: string) => {
    await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  };

  it("rejects localhost URLs", async () => {
    await rejected("http://localhost/admin");
    await rejected("http://localhost:5432/");
    await rejected("https://foo.localhost/x");
  });

  it("rejects loopback and private IPv4 addresses", async () => {
    await rejected("http://127.0.0.1/");
    await rejected("http://127.1.2.3:8080/x");
    await rejected("http://10.0.0.5/internal");
    await rejected("http://172.16.9.1/");
    await rejected("http://192.168.1.1/router");
    await rejected("http://169.254.169.254/latest/meta-data/"); // cloud metadata
    await rejected("http://0.0.0.0/");
    await rejected("http://100.64.0.1/"); // CGNAT
  });

  it("rejects private IPv6 addresses", async () => {
    await rejected("http://[::1]/");
    await rejected("http://[fe80::1]/");
    await rejected("http://[fd00::1]/");
    await rejected("http://[::ffff:127.0.0.1]/");
  });

  it("rejects IPv4-compatible/embedded IPv6 smuggling forms", async () => {
    await rejected("http://[::127.0.0.1]:8080/"); // IPv4-compatible, dotted
    await rejected("http://[::7f00:1]/"); // IPv4-compatible, hex (Node-normalized)
    await rejected("http://[::ffff:7f00:1]/"); // IPv4-mapped, hex
    await rejected("http://[::ffff:a9fe:a9fe]/"); // mapped 169.254.169.254
    await rejected("http://[64:ff9b::7f00:1]/"); // NAT64 loopback
    await rejected("http://[64:ff9b::127.0.0.1]/");
    await rejected("http://[2002:7f00:1::1]/"); // 6to4 with loopback
    await rejected("http://[2002:a9fe:a9fe::1]/"); // 6to4 with metadata IP
  });

  it("parses IPv6 literals into bytes correctly", () => {
    expect(parseIPv6Bytes("::1")?.[15]).toBe(1);
    expect(Array.from(parseIPv6Bytes("::127.0.0.1")!.slice(12))).toEqual([127, 0, 0, 1]);
    expect(Array.from(parseIPv6Bytes("::ffff:7f00:1")!.slice(12))).toEqual([127, 0, 0, 1]);
    expect(parseIPv6Bytes("not-an-ip")).toBeNull();
    expect(parseIPv6Bytes("1::2::3")).toBeNull();
    // Unparseable literals are treated as private (unsafe).
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::7f00:1")).toBe(true);
    expect(isPrivateIp("2607:f8b0::200e")).toBe(false); // public (Google)
  });

  it("rejects dangerous URL schemes", async () => {
    await rejected("file:///etc/passwd");
    await rejected("ftp://example.com/x");
    await rejected("gopher://example.com/x");
    await rejected("javascript:alert(1)");
  });

  it("rejects internal hostnames and embedded credentials", async () => {
    await rejected("http://metadata.google.internal/computeMetadata/v1/");
    await rejected("http://service.internal/x");
    await rejected("https://user:pass@example.com/");
  });

  it("private IP detection covers edge ranges", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("224.0.0.1")).toBe(true); // multicast
  });

  it("accepts well-formed public URLs", async () => {
    const url = await assertPublicHttpUrl("https://www.iana.org/domains/reserved");
    expect(url.hostname).toBe("www.iana.org");
  });

  it("fetches a stable public HTTPS page through the protected fetcher", async () => {
    const fetched = await safeFetchText("https://www.iana.org/domains/reserved");

    expect(fetched.status).toBe(200);
    expect(fetched.finalUrl).toBe("https://www.iana.org/domains/reserved");
    expect(fetched.contentType).toMatch(/html/i);
    expect(fetched.body).toContain("IANA-managed Reserved Domains");
  });

  it("classifies an unresolvable public host as an internal DNS failure", async () => {
    await expect(assertPublicHttpUrl("https://does-not-exist.invalid/")).rejects.toMatchObject(
      {
        name: "SafeFetchError",
        kind: "dns",
      } satisfies Partial<SafeFetchError>,
    );
  });

  it("classifies a connection-time DNS rebinding block as an internal DNS failure", async () => {
    const dispatcher = new Agent({
      connect: {
        lookup: createValidatingLookup((_h, cb) =>
          cb(null, [{ address: "127.0.0.1", family: 4 }]),
        ),
      },
    });
    try {
      await expect(
        safeFetchText("https://www.iana.org/domains/reserved", { dispatcher }),
      ).rejects.toMatchObject({
        name: "SafeFetchError",
        kind: "dns",
      } satisfies Partial<SafeFetchError>);
    } finally {
      await dispatcher.close();
    }
  });
});

describe("DNS-rebinding protection (connection-time address pinning)", () => {
  const lookupResult = (
    lookup: ReturnType<typeof createValidatingLookup>,
    hostname: string,
    options: { all?: boolean } = {},
  ) =>
    new Promise<{ err: Error | null; address: unknown; family: unknown }>((resolve) => {
      lookup(hostname, options, (err, address, family) =>
        resolve({ err: err as Error | null, address, family }),
      );
    });

  it("fails the connection when the host resolves to a private address", async () => {
    // Simulates rebinding: pre-validation may have seen a public IP, but at
    // connection time the resolver returns a private one.
    const lookup = createValidatingLookup((_h, cb) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    const { err } = await lookupResult(lookup, "rebinder.example.com");
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  it("fails when ANY resolved address is private (dual answers)", async () => {
    const lookup = createValidatingLookup((_h, cb) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    const { err } = await lookupResult(lookup, "mixed.example.com");
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  it("pins the connection to the validated public address", async () => {
    const lookup = createValidatingLookup((_h, cb) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }]),
    );
    const { err, address, family } = await lookupResult(lookup, "ok.example.com");
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  it("returns every validated address when the socket asks for all results", async () => {
    const lookup = createValidatingLookup((_h, cb) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    );
    const { err, address, family } = await lookupResult(lookup, "all.example.com", {
      all: true,
    });

    expect(err).toBeNull();
    expect(address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(family).toBeUndefined();
  });

  it("validates literal IP hosts at connection time too", async () => {
    const lookup = createValidatingLookup((_h, cb) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }]),
    );
    const priv = await lookupResult(lookup, "169.254.169.254");
    expect(priv.err).toBeInstanceOf(UnsafeUrlError);
    const pub = await lookupResult(lookup, "93.184.216.34");
    expect(pub.err).toBeNull();
    expect(pub.address).toBe("93.184.216.34");
  });
});
