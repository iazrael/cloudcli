import { assert } from 'vitest';

// Vitest executes client tests in jsdom, where Vite externalizes Node's assert
// module. Tests import `node:assert/strict`, so the shim must be strict too:
// chai's `equal`/`deepEqual` are `==` and loose deep equality, which quietly
// turned every frontend assertion into a weaker one than the import promised
// (`assert.equal(2, '2')` passed).
const strict = {
  ...assert,
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
};

export default strict;
export const { equal, strictEqual, deepEqual, deepStrictEqual, ok, match } = strict;
