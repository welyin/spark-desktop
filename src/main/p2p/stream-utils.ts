/**
 * 从不同 libp2p 事件/返回值形态中提取可读写 stream。
 *
 * 兼容两类接口：
 * - 传统 source/sink 形式
 * - MessageStream 形式（send + AsyncIterator）
 */
export function resolveProtocolStream(input: any): any | null {
  const candidates = [
    input,
    input?.stream,
    input?.incomingStream,
    input?.detail,
    input?.detail?.stream,
    input?.detail?.incomingStream
  ];

  for (const candidate of candidates) {
    const hasLegacyIo = candidate?.source && candidate?.sink;
    const hasMessageStreamIo = typeof candidate?.send === 'function' && typeof candidate?.[Symbol.asyncIterator] === 'function';
    if (hasLegacyIo || hasMessageStreamIo) {
      return candidate;
    }
  }

  return null;
}

/**
 * 将单帧数据解码为 utf8 文本。
 * 兼容 Buffer、Uint8Array、Uint8ArrayList，以及字符串直传场景。
 */
export function decodeChunkToUtf8(chunk: any): string {
  if (!chunk) {
    return '';
  }

  if (typeof chunk === 'string') {
    return chunk;
  }

  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }

  if (typeof chunk.subarray === 'function') {
    try {
      const bytes = chunk.subarray();
      if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
        return Buffer.from(bytes).toString('utf8');
      }
    } catch {
      // ignore and continue
    }
  }

  return '';
}

/**
 * 从协议流读取“第一个有效文本帧”。
 *
 * 注意：这里不是读取到 EOF，而是读取到首个非空帧后立即返回，
 * 用于 request-response 场景避免双方都等待关闭导致死锁。
 */
export async function readStreamAsString(stream: any, timeoutMs = 3000): Promise<string> {
  const resolvedStream = resolveProtocolStream(stream);
  if (!resolvedStream) {
    throw new Error('protocol stream is unavailable');
  }

  const iterator = resolvedStream.source?.[Symbol.asyncIterator]?.() ?? resolvedStream[Symbol.asyncIterator]?.();
  if (!iterator) {
    throw new Error('stream source is not iterable');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const nextChunk = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('stream read timeout')), remaining);
      })
    ]);

    if (!nextChunk || nextChunk.done) {
      return '';
    }

    const text = decodeChunkToUtf8(nextChunk.value);
    const sanitized = text.replace(/\u0000/g, '').trim();
    if (sanitized.length > 0) {
      return sanitized;
    }
  }

  throw new Error('stream read timeout');
}

/**
 * 向协议流写入一帧 utf8 文本。
 * 同时支持 sink 模式与 send 模式，并在 send 模式下处理 drain/close。
 */
export async function writeStringToStream(stream: any, text: string): Promise<void> {
  const resolvedStream = resolveProtocolStream(stream);
  if (!resolvedStream) {
    throw new Error('protocol stream is unavailable');
  }

  const data = Buffer.from(text, 'utf8');

  if (typeof resolvedStream.sink === 'function') {
    await resolvedStream.sink((async function* () {
      yield data;
    })());
    return;
  }

  if (typeof resolvedStream.send === 'function') {
    const writable = resolvedStream.send(data);
    if (!writable && typeof resolvedStream.onDrain === 'function') {
      await resolvedStream.onDrain();
    }
    if (typeof resolvedStream.close === 'function') {
      await resolvedStream.close();
    }
    return;
  }

  throw new Error('protocol stream is not writable');
}

/**
 * 安全 JSON 解析：失败时返回 null 并输出上下文日志，避免抛异常打断同步流程。
 */
export function parseJsonSafely(text: string, context: string): any | null {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch (error) {
    console.warn(`[p2p][json] invalid ${context}`, {
      preview: normalized.slice(0, 120),
      error: String(error)
    });
    return null;
  }
}
