#!/usr/bin/env node
// Doc-sync guard: core code changes must arrive together with their
// architecture doc (docs/core/). Enforced from .husky/pre-commit.
//
// Two sanctioned exits (also printed on failure):
//   - architecture changed → update the doc, `git add`, commit again;
//   - ordinary bug fix with no architectural impact → `git commit --no-verify`
//     and do NOT pad the docs just to satisfy the check.
import { execSync } from 'node:child_process';

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const RULES = [
  {
    doc: 'docs/core/providers.md',
    code: ['server/modules/providers/', 'server/shared/types.ts', 'server/shared/interfaces.ts'],
  },
  {
    doc: 'docs/core/chat.md',
    code: ['server/modules/websocket/', 'src/modules/chat/'],
  },
  {
    doc: 'docs/core/frontend.md',
    code: ['src/shared/'],
  },
  {
    doc: 'docs/core/overview.md',
    code: [
      'server/index.ts',
      'server/load-env.ts',
      'server/modules/database/schema.ts',
      'server/modules/database/migrations.ts',
    ],
  },
];

function stagedFiles() {
  const out = execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

const files = stagedFiles();
if (files.length === 0) process.exit(0);

const missing = RULES.filter((rule) => {
  const codeTouched = files.some(
    (file) => file === rule.code || rule.code.some((prefix) => file.startsWith(prefix)),
  );
  return codeTouched && !files.includes(rule.doc);
});

if (missing.length === 0) process.exit(0);

console.error('\n✋ 本次提交改了核心代码，但没有同步 docs/core/ 架构文档：\n');
for (const rule of missing) {
  console.error(`  · ${rule.code.join('、')}`);
  console.error(`    → 需要同时更新 ${rule.doc}\n`);
}
console.error('两条出口：');
console.error('  1. 动了架构（接口/协议/扩展点/能力/性能不变量）：更新对应文档并 git add 后重新提交；');
console.error('  2. 普通 bug 修复、没动架构：git commit --no-verify 直接提交，不要为凑检查往文档里塞琐事。');
console.error('     文档要精不要长。\n');
process.exit(1);
