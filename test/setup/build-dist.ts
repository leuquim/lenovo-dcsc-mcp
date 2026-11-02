import { execFileSync } from 'node:child_process';

/** Subprocess tests run the compiled server, so every vitest run builds it first. */
export default function setup(): void {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
}
