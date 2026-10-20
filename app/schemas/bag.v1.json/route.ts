import schema from '../../../docs/schemas/bag.v1.schema.json';

export const dynamic = 'force-static';
export const revalidate = 3600;

/** Public schema endpoint used by editors and external bag.json tooling. */
export function GET(): Response {
  return Response.json(schema, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
