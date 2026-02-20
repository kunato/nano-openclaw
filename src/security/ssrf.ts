/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs before fetching to prevent attacks where the agent
 * is tricked into making requests to internal services, localhost,
 * or private network addresses.
 */

const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "gopher:", "data:", "javascript:"]);

const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  /^127\./,                          // Loopback
  /^10\./,                           // Class A private
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // Class B private
  /^192\.168\./,                     // Class C private
  /^169\.254\./,                     // Link-local
  /^0\./,                            // "This" network
  // IPv6 patterns
  /^::1$/,                           // Loopback
  /^fe80:/i,                         // Link-local
  /^fc00:/i,                         // Unique local
  /^fd[0-9a-f]{2}:/i,                // Unique local
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",        // GCP metadata
  "169.254.169.254",                 // AWS/GCP/Azure metadata
  "metadata.azure.internal",         // Azure metadata
]);

export class SsrfBlockedError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`SSRF blocked: ${reason} (${url})`);
    this.name = "SsrfBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim();
  return PRIVATE_IP_RANGES.some((pattern) => pattern.test(trimmed));
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(lower);
}

export interface SsrfValidationOptions {
  /** Allow localhost for development (default: false) */
  allowLocalhost?: boolean;
  /** Allow private IP ranges (default: false) */
  allowPrivateIp?: boolean;
}

/**
 * Validate a URL for SSRF safety.
 * Throws SsrfBlockedError if the URL targets a blocked destination.
 */
export function validateUrlForSsrf(
  urlString: string,
  options: SsrfValidationOptions = {},
): URL {
  const { allowLocalhost = false, allowPrivateIp = false } = options;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new SsrfBlockedError(urlString, "Invalid URL format");
  }

  // Block dangerous protocols
  if (BLOCKED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(urlString, `Blocked protocol: ${url.protocol}`);
  }

  // Only allow http/https
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(urlString, `Unsupported protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();

  // Check blocked hostnames (cloud metadata endpoints, etc.)
  if (isBlockedHostname(hostname) && hostname !== "localhost") {
    throw new SsrfBlockedError(urlString, `Blocked hostname: ${hostname}`);
  }

  // Check localhost
  if (!allowLocalhost) {
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      throw new SsrfBlockedError(urlString, "Localhost access blocked");
    }
  }

  // Check private IP ranges
  if (!allowPrivateIp && isPrivateIp(hostname)) {
    throw new SsrfBlockedError(urlString, "Private IP access blocked");
  }

  return url;
}

/**
 * Wrapper for fetch that validates the URL for SSRF before making the request.
 */
export async function fetchWithSsrfGuard(
  urlString: string,
  init?: RequestInit,
  options: SsrfValidationOptions = {},
): Promise<Response> {
  const url = validateUrlForSsrf(urlString, options);
  return fetch(url.toString(), init);
}
