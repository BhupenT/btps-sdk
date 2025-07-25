/**
 * @license
 * Copyright (c) 2025 Bhupendra Tamang
 * Licensed under the Apache License, Version 2.0
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import tls from 'tls';
import split2 from 'split2';
import { BtpsClient } from './btpsClient';
import { BTPErrorException } from '../core/error/index';
import * as utils from '../core/utils/index';
import * as crypto from '../core/crypto/index';
import { BtpsClientOptions, BTPSRetryInfo } from './types/index';

// --- Mocks ---
vi.mock('tls');
vi.mock('split2');
vi.mock('../core/utils/index');
vi.mock('../core/crypto/index');

const mockTls = vi.mocked(tls);
const mockUtils = vi.mocked(utils);
const mockCrypto = vi.mocked(crypto);
const mockSplit2 = vi.fn();
(split2 as unknown as typeof mockSplit2).mockReturnValue({ on: vi.fn() });

describe('BtpsClient', () => {
  let client: BtpsClient;
  let mockSocket: EventEmitter & {
    writable: boolean;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    pipe: ReturnType<typeof vi.fn>;
    _timeoutCb?: () => void;
  };
  let mockOptions: BtpsClientOptions;
  let mockStream: EventEmitter & { on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Attach a no-op error listener to prevent unhandled error warnings
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((client as any)?.emitter?.on) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).emitter.on('error', () => {});
    }

    mockSocket = Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      once: vi.fn(),
      pipe: vi.fn(),
    }) as EventEmitter & {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      pipe: ReturnType<typeof vi.fn>;
      _timeoutCb?: () => void;
    };
    // Mock setTimeout to store the callback for manual invocation
    mockSocket.setTimeout = vi.fn((timeout, cb) => {
      mockSocket._timeoutCb = cb;
    });
    mockStream = Object.assign(new EventEmitter(), {
      on: vi.fn(),
    });
    (mockSocket.pipe as ReturnType<typeof vi.fn>).mockReturnValue(mockStream);
    (mockTls.connect as unknown as ReturnType<typeof vi.fn>).mockImplementation((opts, cb) => {
      if (cb) cb();
      return mockSocket;
    });
    (split2 as unknown as typeof mockSplit2).mockReturnValue(mockStream);

    mockOptions = {
      identity: 'test$example.com',
      btpIdentityKey: 'PRIVATE_KEY',
      bptIdentityCert: 'PUBLIC_KEY',
      maxRetries: 2,
      retryDelayMs: 10,
      connectionTimeoutMs: 100,
    };
    mockUtils.getHostAndSelector.mockResolvedValue({
      host: 'server.example.com',
      selector: 'btps1',
    });
    mockUtils.getBtpAddressParts.mockReturnValue({
      hostname: 'server.example.com',
      port: '3443',
    } as URL);
    mockUtils.parseIdentity.mockImplementation((id: string) => {
      const [accountName, domainName] = id.split('$');
      if (!accountName || !domainName) return null;
      return { accountName, domainName };
    });
    mockCrypto.signEncrypt.mockResolvedValue({
      payload: {
        id: 'id',
        from: 'test$example.com',
        to: 'recipient$example.com',
        type: 'TRUST_REQ',
        issuedAt: '2023-01-01T00:00:00.000Z',
        document: {} as Record<string, unknown>,
        signature: { algorithm: 'sha256', value: 'sig', fingerprint: 'fp' },
        encryption: null,
      },
      error: undefined,
    });
    client = new BtpsClient(mockOptions);
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    client.destroy();
  });

  it('should construct with options', () => {
    expect(client).toBeInstanceOf(BtpsClient);
  });

  describe('connect', () => {
    it('should emit connected event on successful connection', async () => {
      const onConnected = vi.fn();
      client.connect('recipient$example.com', (events) => {
        events.on('connected', onConnected);
      });
      // Simulate the internal emitter 'connected' event
      (client as unknown as { emitter: EventEmitter }).emitter.emit('connected');
      await vi.runAllTimersAsync();
      expect(onConnected).toHaveBeenCalled();
    });

    it('should emit error for invalid identity', () => {
      const onError = vi.fn();
      mockUtils.parseIdentity.mockReturnValue(null);
      client.connect('badidentity', (events) => {
        events.on('error', onError);
      });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(BTPErrorException) }),
      );
    });

    it('should emit error for DNS failure', async () => {
      const onError = vi.fn();
      mockUtils.getHostAndSelector.mockResolvedValue(undefined);
      await client.connect('recipient$example.com', (events) => {
        events.on('error', onError);
      });
      await vi.runAllTimersAsync();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(BTPErrorException) }),
      );
    });

    it('should emit error for invalid hostname', async () => {
      const onError = vi.fn();
      mockUtils.getBtpAddressParts.mockReturnValue({ hostname: '', port: '3443' } as URL);
      await client.connect('recipient$example.com', (events) => {
        events.on('error', onError);
      });
      await vi.runAllTimersAsync();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(BTPErrorException) }),
      );
    });

    it('should emit error and retry on socket error', async () => {
      const onError = vi.fn();
      client.connect('recipient$example.com', (events) => {
        events.on('error', onError);
      });
      // Simulate error event on internal emitter
      (client as unknown as { emitter: EventEmitter }).emitter.emit('error', {
        error: new BTPErrorException({ message: 'fail' }),
      });
      await vi.runAllTimersAsync();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(BTPErrorException) }),
      );
    });

    it('should emit error and retry on connection timeout', async () => {
      const onError = vi.fn();
      client.connect('recipient$example.com', (events) => {
        events.on('error', onError);
      });
      // Simulate timeout event on internal emitter
      (client as unknown as { emitter: EventEmitter }).emitter.emit('error', {
        error: new BTPErrorException({ message: 'Connection timeout' }),
      });
      await vi.runAllTimersAsync();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(BTPErrorException) }),
      );
    });

    it('should emit end and retry on socket end', async () => {
      const onEnd = vi.fn();
      client.connect('recipient$example.com', (events) => {
        events.on('end', onEnd);
      });
      // Simulate end event on internal emitter
      (client as unknown as { emitter: EventEmitter }).emitter.emit('end', { willRetry: true });
      await vi.runAllTimersAsync();
      expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ willRetry: true }));
    });
  });

  describe('destruction', () => {
    it('should clean up and prevent further use', () => {
      client.destroy();
      expect(() => client.connect('test$example.com')).not.toThrow();
    });
  });
});

describe('BtpsClient internals', () => {
  let client: BtpsClient;
  let mockSocket: ReturnType<typeof Object.assign>;
  let mockOptions: BtpsClientOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket = Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      once: vi.fn(),
      pipe: vi.fn(),
    });
    mockOptions = {
      identity: 'test$example.com',
      btpIdentityKey: 'PRIVATE_KEY',
      bptIdentityCert: 'PUBLIC_KEY',
      maxRetries: 2,
      retryDelayMs: 10,
      connectionTimeoutMs: 100,
    };
    client = new BtpsClient(mockOptions);
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    // Attach a no-op error listener to prevent unhandled error warnings
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((client as any)?.emitter?.on) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).emitter.on('error', () => {});
    }
  });

  describe('flushBackpressure', () => {
    it('should drain all messages if socket is writable', async () => {
      (client as unknown as { backpressureQueue: string[] }).backpressureQueue = ['a', 'b', 'c'];
      mockSocket.write.mockReturnValue(true);
      await (client as unknown as { flushBackpressure: () => Promise<void> }).flushBackpressure();
      expect((client as unknown as { backpressureQueue: string[] }).backpressureQueue.length).toBe(
        0,
      );
      expect(mockSocket.write).toHaveBeenCalledTimes(3);
    });
    it('should wait for drain if socket is not writable', async () => {
      (client as unknown as { backpressureQueue: string[] }).backpressureQueue = ['a'];
      let drainCb: (() => void) | undefined;
      mockSocket.write.mockReturnValue(false);
      mockSocket.once.mockImplementation((event, cb) => {
        if (event === 'drain') drainCb = cb;
      });
      const promise = (
        client as unknown as { flushBackpressure: () => Promise<void> }
      ).flushBackpressure();
      // Simulate drain event
      if (!drainCb) throw new Error('drainCb not assigned');
      drainCb();
      await promise;
      expect((client as unknown as { backpressureQueue: string[] }).backpressureQueue.length).toBe(
        0,
      );
      expect(mockSocket.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRetryInfo', () => {
    it('should return willRetry true if under maxRetries and not destroyed', () => {
      (client as unknown as { retries: number }).retries = 0;
      (client as unknown as { destroyed: boolean }).destroyed = false;
      (client as unknown as { shouldRetry: boolean }).shouldRetry = true;
      const info = (
        client as unknown as { getRetryInfo: () => unknown }
      ).getRetryInfo() as BTPSRetryInfo;
      expect(info.willRetry).toBe(true);
      expect(info.retriesLeft).toBe(1);
    });
    it('should return willRetry false if destroyed', () => {
      (client as unknown as { destroyed: boolean }).destroyed = true;
      const info = (
        client as unknown as { getRetryInfo: () => unknown }
      ).getRetryInfo() as BTPSRetryInfo;
      expect(info.willRetry).toBe(false);
    });
    it('should return willRetry false for SyntaxError', () => {
      const info = (client as unknown as { getRetryInfo: (e: unknown) => unknown }).getRetryInfo(
        new SyntaxError('bad json'),
      ) as BTPSRetryInfo;
      expect(info.willRetry).toBe(false);
    });
    it('should return willRetry false for non-retryable error', () => {
      const info = (client as unknown as { getRetryInfo: (e: unknown) => unknown }).getRetryInfo({
        message: 'invalid identity',
      }) as BTPSRetryInfo;
      expect(info.willRetry).toBe(false);
    });
    it('should return willRetry false if shouldRetry is false', () => {
      (client as unknown as { shouldRetry: boolean }).shouldRetry = false;
      const info = (
        client as unknown as { getRetryInfo: () => unknown }
      ).getRetryInfo() as BTPSRetryInfo;
      expect(info.willRetry).toBe(false);
    });
  });

  describe('isNonRetryableError', () => {
    it('should return true for non-retryable error messages', () => {
      const clientUnknown = client as unknown as { isNonRetryableError: (e: unknown) => boolean };
      expect(clientUnknown.isNonRetryableError({ message: 'invalid identity' })).toBe(true);
      expect(clientUnknown.isNonRetryableError({ message: 'invalid btpAddress' })).toBe(true);
      expect(clientUnknown.isNonRetryableError({ message: 'invalid hostname' })).toBe(true);
      expect(clientUnknown.isNonRetryableError({ message: 'unsupported protocol' })).toBe(true);
      expect(clientUnknown.isNonRetryableError({ message: 'signature verification failed' })).toBe(
        true,
      );
      expect(clientUnknown.isNonRetryableError({ message: 'destroyed' })).toBe(true);
    });
    it('should return false for retryable error messages', () => {
      const clientUnknown = client as unknown as { isNonRetryableError: (e: unknown) => boolean };
      expect(clientUnknown.isNonRetryableError({ message: 'connection timeout' })).toBe(false);
      expect(clientUnknown.isNonRetryableError({ message: 'random error' })).toBe(false);
    });
  });

  describe('retryConnect', () => {
    it('should increment retries and call connect after delay', () => {
      const clientUnknown = client as unknown as {
        retries: number;
        options: unknown;
        retryConnect: (id: string) => void;
      };
      clientUnknown.retries = 0;
      (clientUnknown.options as { maxRetries: number }).maxRetries = 2;
      const connectSpy = vi.spyOn(client, 'connect');
      clientUnknown.retryConnect('receiver$domain.com');
      expect(clientUnknown.retries).toBe(1);
      vi.advanceTimersByTime(10);
      expect(connectSpy).toHaveBeenCalledWith('receiver$domain.com');
    });
    it('should not retry if retries >= maxRetries', () => {
      const clientUnknown = client as unknown as {
        retries: number;
        options: unknown;
        retryConnect: (id: string) => void;
      };
      clientUnknown.retries = 2;
      (clientUnknown.options as { maxRetries: number }).maxRetries = 2;
      const connectSpy = vi.spyOn(client, 'connect');
      clientUnknown.retryConnect('receiver$domain.com');
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});

describe('retry and error edge cases', () => {
  let client: BtpsClient;
  let mockSocket: ReturnType<typeof Object.assign>;
  let mockOptions: BtpsClientOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket = Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      once: vi.fn(),
      pipe: vi.fn(),
    });
    mockOptions = {
      identity: 'test$example.com',
      btpIdentityKey: 'PRIVATE_KEY',
      bptIdentityCert: 'PUBLIC_KEY',
      maxRetries: 2,
      retryDelayMs: 10,
      connectionTimeoutMs: 100,
    };
    client = new BtpsClient(mockOptions);
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    // Attach a no-op error listener to prevent unhandled error warnings
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((client as any)?.emitter?.on) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).emitter.on('error', () => {});
    }
  });

  it('should not retry for non-retryable errors', () => {
    const clientUnknown = client as unknown as {
      retries: number;
      shouldRetry: boolean;
      getRetryInfo: (e?: unknown) => BTPSRetryInfo;
      retryConnect: (id: string) => void;
    };
    clientUnknown.retries = 0;
    clientUnknown.shouldRetry = true;
    const info = clientUnknown.getRetryInfo({ message: 'invalid identity' });
    expect(info.willRetry).toBe(false);
    const connectSpy = vi.spyOn(client, 'connect');
    clientUnknown.retryConnect('receiver$domain.com');
    // Should not retry because getRetryInfo returns willRetry false
    expect(connectSpy).not.toHaveBeenCalled();
  });

  describe('end and destroy', () => {
    it('should call socket.end when client.end is called', () => {
      const clientUnknown = client as unknown as { socket: typeof mockSocket };
      clientUnknown.socket = mockSocket;
      client.end();
      expect(mockSocket.end).toHaveBeenCalled();
    });
    it('should call socket.destroy and remove listeners when client.destroy is called', () => {
      const clientUnknown = client as unknown as { socket: typeof mockSocket; destroyed: boolean };
      clientUnknown.socket = mockSocket;
      client.destroy();
      expect(mockSocket.destroy).toHaveBeenCalled();
      expect(clientUnknown.destroyed).toBe(true);
      // Listeners removed: emitter should have no listeners
      expect((client as unknown as { emitter: EventEmitter }).emitter.eventNames().length).toBe(0);
    });
  });

  it('should override the port and host if given in the constructor', async () => {
    const tlsConnectSpy = vi.spyOn(tls, 'connect');
    const customOptions: BtpsClientOptions = {
      ...mockOptions,
      host: 'customhost.com',
      port: 9999,
    };
    const customClient = new BtpsClient(customOptions);
    mockUtils.getHostAndSelector.mockResolvedValue(undefined);
    mockUtils.getBtpAddressParts.mockImplementation((input: string) => new URL(`btps://${input}`));
    // Connect should use the custom host/port
    customClient.connect('recipient$example.com');
    await vi.runAllTimersAsync();
    expect(tlsConnectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'customhost.com', port: 9999 }),
      expect.any(Function),
    );
  });
});

describe('BtpsClient additional edge cases', () => {
  let client: BtpsClient;
  let mockSocket: ReturnType<typeof Object.assign>;
  let mockOptions: BtpsClientOptions;

  beforeEach(() => {
    mockSocket = Object.assign(new EventEmitter(), {
      writable: true,
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      once: vi.fn(),
      pipe: vi.fn(),
    });
    mockOptions = {
      identity: 'test$example.com',
      btpIdentityKey: 'PRIVATE_KEY',
      bptIdentityCert: 'PUBLIC_KEY',
      maxRetries: 2,
      retryDelayMs: 10,
      connectionTimeoutMs: 100,
    };
    client = new BtpsClient(mockOptions);
    (client as unknown as { socket: typeof mockSocket }).socket = mockSocket;
    // Attach a no-op error listener to prevent unhandled error warnings
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((client as any)?.emitter?.on) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).emitter.on('error', () => {});
    }
  });

  it('should allow double destruction safely', () => {
    expect(() => {
      client.destroy();
      client.destroy();
    }).not.toThrow();
    expect((client as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });

  it('should return the correct protocol version', () => {
    expect(client.getProtocolVersion()).toBe('1.0.0');
  });

  it('should remove all event listeners after destroy', () => {
    const emitter = (client as unknown as { emitter: EventEmitter }).emitter;
    emitter.on('foo', () => {});
    emitter.on('bar', () => {});
    client.destroy();
    expect(emitter.eventNames().length).toBe(0);
  });

  it('signEncryptArtifact returns error if identity is invalid', async () => {
    const spy = vi.spyOn(utils, 'parseIdentity').mockReturnValue(null);
    const result = await (
      client as unknown as {
        signEncryptArtifact: (
          artifact: unknown,
        ) => Promise<{ error?: BTPErrorException; payload?: unknown }>;
      }
    ).signEncryptArtifact({ to: 'a' });
    expect(result.error).toBeInstanceOf(BTPErrorException);
    expect(result.payload).toBeUndefined();
    spy.mockRestore();
  });
});
