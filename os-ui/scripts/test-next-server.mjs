/* test-only shim for next/server */
export const NextResponse = {
  json(obj, init) {
    return {
      status: (init && init.status) || 200,
      async json() { return obj; },
    };
  },
};
