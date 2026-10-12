import { sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SwiftlaneError } from '../errors.ts';
import { log } from '../log.ts';
import type { ApiKey } from './key.ts';

const BASE_URL = 'https://api.appstoreconnect.apple.com';
// Apple rejects tokens that live longer than 20 minutes.
const TOKEN_LIFETIME_SECONDS = 19 * 60;
const MAX_ATTEMPTS = 4;

export type CertificateType =
  | 'DEVELOPMENT'
  | 'DISTRIBUTION'
  | 'IOS_DEVELOPMENT'
  | 'IOS_DISTRIBUTION'
  | 'MAC_APP_DEVELOPMENT'
  | (string & {});

export interface Certificate {
  id: string;
  name: string;
  displayName: string;
  certificateType: CertificateType;
  serialNumber: string;
  platform: string | undefined;
  expirationDate: Date;
  /** DER-encoded certificate. */
  content: Buffer;
}

interface CertificateResource {
  id: string;
  attributes: {
    name?: string;
    displayName?: string;
    certificateType?: string;
    serialNumber?: string;
    platform?: string;
    expirationDate?: string;
    certificateContent?: string;
  };
}

interface ApiErrorBody {
  errors?: { status?: string; code?: string; title?: string; detail?: string }[];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createToken(apiKey: ApiKey, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: apiKey.keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: apiKey.issuerId, iat: nowSeconds, exp: nowSeconds + TOKEN_LIFETIME_SECONDS, aud: 'appstoreconnect-v1' }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: apiKey.key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Names Apple gives to certificates created through the API rather than Xcode or the portal UI. */
export function isApiCreated(certificate: Certificate): boolean {
  return /created via api/i.test(certificate.name) || /created via api/i.test(certificate.displayName);
}

function toCertificate(resource: CertificateResource): Certificate {
  const { attributes } = resource;
  return {
    id: resource.id,
    name: attributes.name ?? '',
    displayName: attributes.displayName ?? '',
    certificateType: attributes.certificateType ?? '',
    serialNumber: attributes.serialNumber ?? '',
    platform: attributes.platform,
    expirationDate: new Date(attributes.expirationDate ?? 0),
    content: Buffer.from(attributes.certificateContent ?? '', 'base64'),
  };
}

export class AppStoreConnectApiError extends SwiftlaneError {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: ApiErrorBody | undefined, hint?: string) {
    const details = (body?.errors ?? [])
      .map((error) => [error.title, error.detail].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    super(`App Store Connect API ${method} ${path} failed with HTTP ${status}${details ? `: ${details}` : ''}`, { hint });
    this.name = 'AppStoreConnectApiError';
    this.status = status;
  }
}

function hintFor(status: number): string | undefined {
  if (status === 401) return 'Check the key identifier, issuer ID and private key; also make sure the key has not been revoked';
  if (status === 403)
    return 'The API key role is not allowed to do this; managing certificates needs an Admin key, or App Manager with access to Certificates, Identifiers & Profiles';
  if (status === 409)
    return 'If the team hit its certificate limit, revoke unused development certificates (swiftlane signing revoke --all)';
  return undefined;
}

export class AppStoreConnectClient {
  readonly #apiKey: ApiKey;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(apiKey: ApiKey, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  #authorization(): string {
    const now = Math.floor(Date.now() / 1000);
    if (!this.#token || this.#token.expiresAt - now < 60) {
      this.#token = { value: createToken(this.#apiKey, now), expiresAt: now + TOKEN_LIFETIME_SECONDS };
    }
    return `Bearer ${this.#token.value}`;
  }

  async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
    const displayPath = url.replace(BASE_URL, '');
    for (let attempt = 1; ; attempt++) {
      log.debug(`${method} ${displayPath}`);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Authorization: this.#authorization(),
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new SwiftlaneError(`App Store Connect API ${method} ${displayPath} failed: ${(error as Error).message}`, { cause: error });
        }
        log.warn(`App Store Connect request failed (${(error as Error).message}), retrying…`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after')) || 2 ** attempt;
        log.warn(`App Store Connect responded with HTTP ${response.status}, retrying in ${retryAfter}s…`);
        await sleep(retryAfter * 1000);
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        let parsed: ApiErrorBody | undefined;
        try {
          parsed = JSON.parse(text) as ApiErrorBody;
        } catch {
          parsed = undefined;
        }
        throw new AppStoreConnectApiError(method, displayPath, response.status, parsed, hintFor(response.status));
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  async listCertificates(certificateType?: CertificateType): Promise<Certificate[]> {
    const query = new URLSearchParams({ limit: '200' });
    if (certificateType) query.set('filter[certificateType]', certificateType);
    const certificates: Certificate[] = [];
    let next: string | undefined = `/v1/certificates?${query}`;
    while (next) {
      const page: { data: CertificateResource[]; links?: { next?: string } } = await this.request('GET', next);
      certificates.push(...page.data.map(toCertificate));
      next = page.links?.next;
    }
    return certificates;
  }

  async createCertificate(csrPem: string, certificateType: CertificateType): Promise<Certificate> {
    const csrContent = csrPem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s/g, '');
    const response: { data: CertificateResource } = await this.request('POST', '/v1/certificates', {
      data: { type: 'certificates', attributes: { csrContent, certificateType } },
    });
    return toCertificate(response.data);
  }

  async revokeCertificate(id: string): Promise<void> {
    await this.request('DELETE', `/v1/certificates/${encodeURIComponent(id)}`);
  }
}
