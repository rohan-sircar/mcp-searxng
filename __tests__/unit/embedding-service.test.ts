#!/usr/bin/env tsx

/**
 * Unit Tests: embedding-service.ts
 * 
 * Tests for text/vision embedding service, image download, and cosine similarity
 */

import { strict as assert } from 'node:assert';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { FetchMocker, createMockFetch, createCapturingMockFetch } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const fetchMocker = new FetchMocker();
const envManager = new EnvManager();

async function runTests() {
  console.log('🧪 Testing: embedding-service.ts\n');

  // ========== Text Embedding Service Tests ==========

  await testFunction('Text embedding: Error when EMBEDDING_SERVICE_URL not set', async () => {
    envManager.delete('EMBEDDING_SERVICE_URL');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    
    try {
      await callTextEmbeddingService('test');
      assert.fail('Should have thrown error when URL not set');
    } catch (error: any) {
      assert.ok(error.message.includes('EMBEDDING_SERVICE_URL') || error.message.includes('undefined'));
    }
    
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Successful request with string input', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    const { mockFetch, getCapturedUrl, getCapturedOptions } = createCapturingMockFetch();

    fetchMocker.mock(async (url, options) => {
      await mockFetch(url, options);
      throw new Error('MOCK_STOP');
    });

    try {
      await callTextEmbeddingService('test query');
    } catch {
      // expected
    }

    const url = getCapturedUrl();
    assert.ok(url.includes('/embeddings'), `Expected /embeddings in URL, got: ${url}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Successful request with array input', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callTextEmbeddingService(['title 1', 'title 2', 'title 3']);
    } catch {
      // expected
    }

    assert.ok(Array.isArray(capturedBody.input), 'Expected input to be an array');
    assert.strictEqual(capturedBody.input.length, 3);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Request includes model field', async () => {
    // Clear module from cache to pick up new env vars
    const modCacheKey = '../../src/embedding-service.js';
    const modPath = new URL(modCacheKey, import.meta.url).pathname;
    const { default: modCache } = await import('node:module') as any;
    const cachedModule = modCache._cache?.get?.(modPath);
    
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    envManager.set('EMBEDDING_MODEL', 'custom-model-name');
    
    // Re-import to pick up new env vars
    const moduleUrl = new URL(`../../src/embedding-service.js?cacheBust=${Date.now()}`, import.meta.url).href;
    const { callTextEmbeddingService } = await import(moduleUrl);
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callTextEmbeddingService('test');
    } catch {
      // expected
    }

    assert.strictEqual(capturedBody.model, 'custom-model-name');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Default model when EMBEDDING_MODEL not set', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    envManager.delete('EMBEDDING_MODEL');
    
    const moduleUrl = new URL(`../../src/embedding-service.js?cacheBust=${Date.now()}`, import.meta.url).href;
    const { callTextEmbeddingService } = await import(moduleUrl);
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callTextEmbeddingService('test');
    } catch {
      // expected
    }

    assert.strictEqual(capturedBody.model, 'jinaai/jina-embeddings-v5-omni-nano-retrieval');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Response parsing returns array of embeddings', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: {
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await callTextEmbeddingService('test');
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0].embedding, [0.1, 0.2, 0.3]);
    assert.deepStrictEqual(result[1].embedding, [0.4, 0.5, 0.6]);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Error on invalid response (missing data array)', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: { notData: [] }
    });

    fetchMocker.mock(mockFetch);

    try {
      await callTextEmbeddingService('test');
      assert.fail('Should have thrown error for invalid response');
    } catch (error: any) {
      assert.ok(error.message.includes('missing') || error.message.includes('invalid'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: HTTP error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Server error'
    });

    fetchMocker.mock(mockFetch);

    try {
      await callTextEmbeddingService('test');
      assert.fail('Should have thrown HTTP error');
    } catch (error: any) {
      assert.ok(error.message.includes('500') || error.message.includes('Server Error'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Text embedding: Network error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callTextEmbeddingService } = await import('../../src/embedding-service.js');
    
    const networkError = new Error('ECONNREFUSED');
    (networkError as any).code = 'ECONNREFUSED';
    
    fetchMocker.mock(async () => {
      throw networkError;
    });

    try {
      await callTextEmbeddingService('test');
      assert.fail('Should have thrown network error');
    } catch (error: any) {
      assert.ok(error.message.includes('Failed to call text embedding service') || error.message.includes('ECONNREFUSED'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  // ========== Vision Embedding Service Tests ==========

  await testFunction('Vision embedding: Error when EMBEDDING_SERVICE_URL not set', async () => {
    envManager.delete('EMBEDDING_SERVICE_URL');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    try {
      await callVisionEmbeddingService('iVBORw0KGgoAAAANSUhEUg==');
      assert.fail('Should have thrown error when URL not set');
    } catch (error: any) {
      assert.ok(error.message.includes('EMBEDDING_SERVICE_URL') || error.message.includes('undefined'));
    }
    
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Request uses OpenAI image_url format', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callVisionEmbeddingService('iVBORw0KGgoAAAANSUhEUg==');
    } catch {
      // expected
    }

    assert.ok(Array.isArray(capturedBody.input), 'Expected input to be an array');
    assert.strictEqual(capturedBody.input.length, 1);
    assert.ok('image_url' in capturedBody.input[0], 'Expected image_url in input item');
    assert.ok(capturedBody.input[0].image_url.url.startsWith('data:image/jpeg;base64,'), 'Expected data URI prefix');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Request includes image_url with base64 data', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callVisionEmbeddingService('testimagebase64data');
    } catch {
      // expected
    }

    assert.ok(Array.isArray(capturedBody.input));
    assert.strictEqual(capturedBody.input.length, 1);
    assert.ok('image_url' in capturedBody.input[0]);
    assert.strictEqual(capturedBody.input[0].image_url.url, 'data:image/jpeg;base64,testimagebase64data');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Request includes model field', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    envManager.set('EMBEDDING_MODEL', 'vision-model-test');
    
    const moduleUrl = new URL(`../../src/embedding-service.js?cacheBust=${Date.now()}`, import.meta.url).href;
    const { callVisionEmbeddingService } = await import(moduleUrl);
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callVisionEmbeddingService('base64data');
    } catch {
      // expected
    }

    assert.strictEqual(capturedBody.model, 'vision-model-test');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Default model name is jina-embeddings-v5-omni-nano-retrieval', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    let capturedBody: any;

    fetchMocker.mock(async (url, options) => {
      capturedBody = JSON.parse((options?.body as string) || '{}');
      throw new Error('MOCK_STOP');
    });

    try {
      await callVisionEmbeddingService('base64data');
    } catch {
      // expected
    }

    assert.strictEqual(capturedBody.model, 'jinaai/jina-embeddings-v5-omni-nano-retrieval');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Successful response with flat array embedding', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: {
        data: [
          { embedding: [0.1, 0.2, 0.3] }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await callVisionEmbeddingService('iVBORw0KGgoAAAANSUhEUg==');
    assert.ok(Array.isArray(result.embedding));
    assert.strictEqual(result.embedding.length, 3);
    assert.deepStrictEqual(result.embedding, [0.1, 0.2, 0.3]);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Successful response with nested array embedding ([[...]])', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: {
        data: [
          { embedding: [[0.1, 0.2, 0.3]] }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await callVisionEmbeddingService('iVBORw0KGgoAAAANSUhEUg==');
    assert.ok(Array.isArray(result.embedding));
    assert.strictEqual(result.embedding.length, 3);
    assert.deepStrictEqual(result.embedding, [0.1, 0.2, 0.3]);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Response returns required fields', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: {
        data: [
          { embedding: [0.1, 0.2, 0.3] }
        ]
      }
    });

    fetchMocker.mock(mockFetch);

    const result = await callVisionEmbeddingService('base64data');
    assert.ok('embedding' in result, 'Expected embedding field');
    assert.ok('prompt' in result, 'Expected prompt field');
    assert.ok('time_eval' in result, 'Expected time_eval field');
    assert.ok('time_prompt' in result, 'Expected time_prompt field');
    assert.ok('tokens_count' in result, 'Expected tokens_count field');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Error on invalid response (missing data wrapper)', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: { notData: [] }
    });

    fetchMocker.mock(mockFetch);

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown error for missing data wrapper');
    } catch (error: any) {
      assert.ok(error.message.includes('invalid') || error.message.includes('data'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Error on empty data array response', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: { data: [] }
    });

    fetchMocker.mock(mockFetch);

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown error for empty data array response');
    } catch (error: any) {
      assert.ok(error.message.includes('invalid') || error.message.includes('data'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Error when embedding field missing', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: { data: [{ not_embedding: [0.1, 0.2] }] }
    });

    fetchMocker.mock(mockFetch);

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown error for missing embedding field');
    } catch (error: any) {
      assert.ok(error.message.includes('missing') || error.message.includes('invalid'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Error when embedding is not an array', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      json: { data: [{ embedding: 'not-an-array' }] }
    });

    fetchMocker.mock(mockFetch);

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown error for non-array embedding');
    } catch (error: any) {
      assert.ok(error.message.includes('missing') || error.message.includes('invalid'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: HTTP error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: '{"error":{"code":500,"message":"Failed to tokenize prompt","type":"server_error"}}'
    });

    fetchMocker.mock(mockFetch);

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown HTTP error');
    } catch (error: any) {
      assert.ok(error.message.includes('500') || error.message.includes('Server Error'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Network error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    
    const networkError = new Error('ENOTFOUND');
    (networkError as any).code = 'ENOTFOUND';
    
    fetchMocker.mock(async () => {
      throw networkError;
    });

    try {
      await callVisionEmbeddingService('base64data');
      assert.fail('Should have thrown network error');
    } catch (error: any) {
      assert.ok(error.message.includes('Failed to call vision embedding service') || error.message.includes('ENOTFOUND'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Vision embedding: Request URL includes /embeddings path', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { callVisionEmbeddingService } = await import('../../src/embedding-service.js');
    let capturedUrl: string;

    fetchMocker.mock(async (url, options) => {
      capturedUrl = url.toString();
      throw new Error('MOCK_STOP');
    });

    try {
      await callVisionEmbeddingService('base64data');
    } catch {
      // expected
    }

    assert.ok(capturedUrl.includes('/embeddings'), `Expected /embeddings in URL, got: ${capturedUrl}`);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  // ========== Image Download Tests ==========

  await testFunction('Image download: Successful download returns base64 string', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { downloadImageAsBase64 } = await import('../../src/embedding-service.js');
    
    // Create a mock image (1x1 red pixel PNG)
    const mockBytes = new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);

    const mockFetch = createMockFetch({
      ok: true,
      body: new TextDecoder().decode(mockBytes)
    });

    // Override the mock to return proper binary data
    fetchMocker.mock(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => mockBytes.buffer.slice(mockBytes.byteOffset, mockBytes.byteOffset + mockBytes.byteLength),
      text: async () => new TextDecoder().decode(mockBytes)
    } as any));

    const result = await downloadImageAsBase64('https://example.com/image.png');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Base64 should only contain valid characters
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(result), 'Expected valid base64 characters');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Image download: HTTP error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { downloadImageAsBase64 } = await import('../../src/embedding-service.js');
    
    const mockFetch = createMockFetch({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    });

    fetchMocker.mock(mockFetch);

    try {
      await downloadImageAsBase64('https://example.com/missing.png');
      assert.fail('Should have thrown HTTP error');
    } catch (error: any) {
      assert.ok(error.message.includes('404') || error.message.includes('Failed to download image'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('Image download: Network error handling', async () => {
    envManager.set('EMBEDDING_SERVICE_URL', 'http://test-embedding.example.com/v1');
    
    const { downloadImageAsBase64 } = await import('../../src/embedding-service.js');
    
    const networkError = new Error('ECONNREFUSED');
    (networkError as any).code = 'ECONNREFUSED';
    
    fetchMocker.mock(async () => {
      throw networkError;
    });

    try {
      await downloadImageAsBase64('https://example.com/image.jpg');
      assert.fail('Should have thrown network error');
    } catch (error: any) {
      assert.ok(error.message.includes('Failed to download image') || error.message.includes('ECONNREFUSED'));
    }

    fetchMocker.restore();
    envManager.restore();
  }, results);

  // ========== Cosine Similarity Tests ==========

  await testFunction('Cosine similarity: Identical vectors return 1.0', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vec = [1, 2, 3];
    const sim = cosineSimilarity(vec, vec);
    assert.strictEqual(sim, 1.0);
  }, results);

  await testFunction('Cosine similarity: Orthogonal vectors return 0.0', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [1, 0, 0];
    const vecB = [0, 1, 0];
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, 0.0);
  }, results);

  await testFunction('Cosine similarity: Opposite vectors return -1.0', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [1, 2, 3];
    const vecB = [-1, -2, -3];
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, -1.0);
  }, results);

  await testFunction('Cosine similarity: Dimension mismatch throws error', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [1, 2, 3];
    const vecB = [1, 2];
    
    try {
      cosineSimilarity(vecA, vecB);
      assert.fail('Should have thrown dimension mismatch error');
    } catch (error: any) {
      assert.ok(error.message.includes('Dimension mismatch') || error.message.includes('mismatch'));
    }
  }, results);

  await testFunction('Cosine similarity: Zero vector returns 0', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [0, 0, 0];
    const vecB = [1, 2, 3];
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, 0);
  }, results);

  await testFunction('Cosine similarity: Negative similarity for angled vectors', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [1, 0, 0];
    const vecB = [-1, 1, 0];
    const sim = cosineSimilarity(vecA, vecB);
    assert.ok(sim < 0, `Expected negative similarity, got ${sim}`);
  }, results);

  await testFunction('Cosine similarity: Positive similarity for similar vectors', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [1, 0, 0];
    const vecB = [1, 0.1, 0];
    const sim = cosineSimilarity(vecA, vecB);
    assert.ok(sim > 0 && sim < 1, `Expected positive similarity less than 1, got ${sim}`);
  }, results);

  await testFunction('Cosine similarity: Works with floating point values', async () => {
    const { cosineSimilarity } = await import('../../src/embedding-service.js');
    const vecA = [0.1, 0.2, 0.3];
    const vecB = [0.15, 0.25, 0.35];
    const sim = cosineSimilarity(vecA, vecB);
    assert.ok(sim > 0.99, `Expected very high similarity for similar vectors, got ${sim}`);
  }, results);

  printTestSummary(results, 'Embedding Service Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
