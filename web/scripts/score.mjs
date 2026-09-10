/**
 * Put a score in place before anything that needs one runs.
 *
 * `src/score.ts` is the authored film and is not committed (NOTICE section 3).
 * A fresh clone has only `src/score.example.ts`, so copy that in rather than
 * failing the build for someone who just wants to see the renderer work.
 *
 * An existing score.ts is never touched.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../src/score.example.ts', import.meta.url));
const score = fileURLToPath(new URL('../src/score.ts', import.meta.url));

if (!existsSync(score)) {
  copyFileSync(example, score);
  console.log('src/score.ts was missing; copied src/score.example.ts into place.');
}
