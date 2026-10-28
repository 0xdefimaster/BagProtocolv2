import schema from '@/docs/schemas/bag.v1.schema.json';

export const dynamic = 'force-static';
export const revalidate = 3600;

/** The canonical bag.json v1 JSON Schema at the path its `$id` names, for editors and external bag.json tooling. */
export function GET(): Response {
  return Response.json(schema, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
