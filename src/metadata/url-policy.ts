import { validateHttpUrl } from "../schema.ts";
import { fail } from "./types.ts";

function blockedIpv4(host: string): boolean {
  const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

/** Literal/name screening only. DNS rebinding protection belongs to the kernel/network. */
export function publicHttpUrl(value: unknown): URL {
  let url: URL;
  try {
    validateHttpUrl(value);
    url = new URL(value as string);
    validateHttpUrl(url.href); // Canonical expansion must still fit the future snapshot URL bound.
  } catch {
    return fail("invalid-url");
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    const first = parseInt(address.split(":")[0] || "0", 16);
    // Conservative global-unicast subset: exclude mapped/translation, special-use and tunnel literals.
    if (
      first < 0x2000 || first > 0x3fff || first === 0x2002
      || /^2001:(?:db8(?::|$)|0(?::|$)|:)/i.test(address) || /^3fff:[0-9a-f]{0,3}(?::|$)/i.test(address)
    ) {
      fail("blocked-target");
    }
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    // URL has already canonicalized short, integer, octal and hexadecimal IPv4 spellings.
    if (blockedIpv4(host)) fail("blocked-target");
  } else {
    if (
      !host.includes(".") || ["localhost.localdomain", "ip6-localhost", "ip6-loopback"].includes(host)
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test)$/.test(host)
      || /(?:^|\.)home\.arpa$/.test(host)
    ) {
      fail("blocked-target");
    }
    if (
      host.length > 253
      || host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    ) {
      fail("invalid-url");
    }
  }
  return url;
}

export function resolvePublicUrl(value: string, base: string): URL {
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex -- Reject raw controls before URL parsing can discard them.
  const invalidCharacters = /[\s\\\u0000-\u001f\u007f]/u.test(trimmed);
  if (
    !trimmed || trimmed.length > 2048 || invalidCharacters
    || (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed))
  ) {
    fail("invalid-url");
  }
  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return fail("invalid-url");
  }
  return publicHttpUrl(resolved.href);
}
