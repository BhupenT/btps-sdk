/**
 * @license
 * Copyright (c) 2025 Bhupendra Tamang
 * Licensed under the Apache License, Version 2.0
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import { BTPErrorException } from '@core/error/index.js';
import { BTPArtifact, BTPDocType } from '@core/server/types.js';
import { BTPTrustReqDoc, BTPTrustResDoc } from '@core/trust/types.js';
import { BTPInvoiceDoc } from 'server/index.js';

export type EncryptionMode = 'none' | 'standardEncrypt' | '2faEncrypt';

export type EncryptionAlgorithmType = 'aes-256-cbc';

export type BTPEncryption = {
  algorithm: EncryptionAlgorithmType;
  encryptedKey: string;
  iv: string;
  type: EncryptionMode;
};

export type SignatureAlgorithmType = 'sha256';

export type BTPSignature = {
  algorithm: SignatureAlgorithmType;
  value: string;
  fingerprint: string;
};

export type PemKeys = {
  publicKey: string;
  privateKey: string;
};

export type BTPCryptoOptions = {
  signature?: {
    algorithm: SignatureAlgorithmType;
  };
  encryption?: {
    algorithm: EncryptionAlgorithmType;
    mode: EncryptionMode;
  };
};

export interface BTPCryptoArtifact<T = BTPDocType>
  extends Omit<BTPArtifact, 'version' | 'document'> {
  document: T | string;
}

export interface BTPCryptoResponse<T = BTPDocType> {
  payload?: BTPCryptoArtifact<T>;
  error?: BTPErrorException;
}

export type AllowedEncryptPayloads = BTPTrustReqDoc | BTPTrustResDoc | BTPInvoiceDoc;
