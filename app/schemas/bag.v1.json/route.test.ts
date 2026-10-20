import { describe, expect, it } from 'vitest';
import schema from '../../../docs/schemas/bag.v1.schema.json';
import { GET } from './route';

describe('GET /schemas/bag.v1.json', () => {
  it('serves the canonical checked-in schema as cacheable JSON', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(await response.json()).toEqual(schema);
  });
});
