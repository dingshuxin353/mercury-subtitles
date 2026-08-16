import { describe, expect, it } from 'vitest';
import { runtimeVersionProblem } from '../src/runtime-version.js';

describe('Node.js runtime guard', () => {
  it('accepts Node 24', () => {
    expect(runtimeVersionProblem('24.13.0')).toBeNull();
  });

  it('stops Node 22 before entering the App with a clear upgrade action', () => {
    const problem = runtimeVersionProblem('22.22.0');
    expect(problem).toContain('Node.js 22.22.0');
    expect(problem).toContain('需要 Node.js 24');
    expect(problem).toContain('安装或切换');
  });
});
