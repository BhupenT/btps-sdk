/**
 * @license
 * Copyright (c) 2025 Bhupendra Tamang
 * Licensed under the Apache License, Version 2.0
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import dns from 'dns/promises';
import { ParsedIdentity } from './types.js';
import { BTP_PROTOCOL_VERSION, BTPS_NAME_SPACE, BTPTransporterArtifact } from 'server/index.js';

export * from './types.js';

export const parseIdentity = (identity: string): ParsedIdentity | null => {
  const [accountName, domainName] = identity.split('$');
  if (!accountName || !domainName) {
    return null;
  }

  return {
    accountName,
    domainName,
  };
};

export const isValidIdentity = (identity: string = '') => {
  const parsedIdentity = parseIdentity(identity);
  return !!parsedIdentity;
};

export function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\r?\n/g, '')
    .trim();
}

export function base64ToPem(base64: string): string {
  const lines = base64.match(/.{1,64}/g) || [];
  return ['-----BEGIN PUBLIC KEY-----', ...lines, '-----END PUBLIC KEY-----'].join('\n');
}

export const getHostAndSelector = async (
  identity: string,
): Promise<{ host: string; selector: string } | undefined> => {
  const parsedIdentity = parseIdentity(identity);
  if (!parsedIdentity) {
    return undefined;
  }

  const dnsName = `${BTPS_NAME_SPACE}.${parsedIdentity.domainName}`;

  try {
    const txtRecords = await dns.resolveTxt(dnsName);
    if (!txtRecords.length) {
      return undefined;
    }

    const flat = txtRecords.map((r) => r.join('')).join('');
    const parts = Object.fromEntries(
      flat
        .split(';')
        .map((s) =>
          s
            .trim()
            .split('=')
            .map((p) => p.trim()),
        )
        .filter((pair) => pair.length === 2),
    );
    if (parts['v'] !== BTP_PROTOCOL_VERSION) return undefined;
    if (!parts['u'] || !parts['s']) return undefined;
    return {
      host: parts['u'],
      selector: parts['s'],
    };
  } catch (error: unknown) {
    throw new Error(`DNS resolution failed for ${dnsName}: ${JSON.stringify(error)}`);
  }
};

export const getDnsIdentityParts = async (
  identity: string,
  selector: string,
  type?: 'key' | 'pem' | 'version',
) => {
  const typeMap = {
    key: 'k',
    version: 'v',
    pem: 'p',
  };

  const parsedIdentity = parseIdentity(identity);
  if (!parsedIdentity) {
    return undefined;
  }

  const { accountName, domainName } = parsedIdentity;

  const dnsName = `${selector}.${BTPS_NAME_SPACE}.${accountName}.${domainName}`;

  try {
    const txtRecords = await dns.resolveTxt(dnsName);
    if (!txtRecords.length) {
      return undefined;
    }

    const flat = txtRecords.map((r) => r.join('')).join('');

    const parts = Object.fromEntries(
      flat
        .split(';')
        .map((s) =>
          s
            .trim()
            .split('=')
            .map((p) => p.trim()),
        )
        .filter((pair) => pair.length === 2),
    );

    if (!type) {
      return {
        key: parts['k'],
        version: parts['v'],
        pem: base64ToPem(parts['p']),
      };
    }

    if (type === 'pem') {
      return base64ToPem(parts['p']);
    }

    return parts[typeMap[type]];
  } catch (error: unknown) {
    throw new Error(`DNS resolution failed for ${domainName}: ${JSON.stringify(error)}`);
  }
};

export const getBtpAddressParts = (input: string): URL | null => {
  try {
    const normalized = input.startsWith('btps://') ? input : `btps://${input}`;
    const parsed = new URL(normalized);
    return parsed;
  } catch {
    return null;
  }
};

export const resolvePublicKey = async (
  identity: string,
  selector: string,
): Promise<string | undefined> => {
  return await getDnsIdentityParts(identity, selector, 'pem');
};

export const isBtpsTransportArtifact = (artifact: unknown): artifact is BTPTransporterArtifact => {
  if (typeof artifact !== 'object' || artifact === null) {
    return false;
  }

  const maybe = artifact as Partial<BTPTransporterArtifact>;
  return typeof maybe.from === 'string' && typeof maybe.type === 'string' && !('agentId' in maybe);
};
