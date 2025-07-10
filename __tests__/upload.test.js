// __tests__/upload.test.js
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../server.js';

// Give IPFS a bit more time for add operations
jest.setTimeout(30000);

describe('IPFS Web UI', () => {
  it('serves the homepage at GET /', async () => {
    await request(app)
      .get('/')
      .expect(200)
      .expect('Content-Type', /html/);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/upload')
      .expect(400)
      .expect('Content-Type', /json/);
    expect(res.body.error).toMatch(/No file uploaded/);
  });

  it('uploads a file and returns a CID', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('Hello IPFS'), 'hello.txt')
      .expect(200)
      .expect('Content-Type', /json/);

    // The response should include a non-empty CID string
    expect(typeof res.body.cid).toBe('string');
    expect(res.body.cid.length).toBeGreaterThan(0);
  });
});