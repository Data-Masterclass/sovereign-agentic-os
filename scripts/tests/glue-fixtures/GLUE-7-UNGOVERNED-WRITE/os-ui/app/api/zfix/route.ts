// Negative twin for GLUE-7: a mutating route with no governance authorize() before the effect.
export async function POST(): Promise<Response> {
  return new Response('written', { status: 200 });
}
