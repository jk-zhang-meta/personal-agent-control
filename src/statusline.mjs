import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.mjs';
import { assertSafeManagedObject } from './path-safety.mjs';

const configs = {
  codex: ['.codex/config.toml', '~/.codex/statusline/statusline.py'],
  claude: ['.claude/settings.json', '~/.claude/statusline/statusline.sh'],
  agy: ['.gemini/antigravity-cli/settings.json', '~/.gemini/antigravity-cli/statusline/statusline.py'],
  grok: ['.grok/config.toml', '~/.grok/statusline/statusline.py'],
};

export function statuslineSkill(profile) {
  return profile?.skills.find(skill => skill.name === 'personal-statusline');
}

export async function statuslineChanges(context, neutral, clients, selected) {
  const changes = [];
  for (const host of clients) {
    const [relativePath, legacy] = configs[host];
    const file = path.join(context.home, relativePath);
    await assertSafeManagedObject(context.home, file, 'statusline configuration', 'file');
    let source;
    try { source = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; source = ''; }
    const suffix = path.join('scripts', host + '.py');
    if (selected) {
      const payload = path.join(selected.root, suffix);
      await assertSafeManagedObject(selected.root, payload, 'statusline script', 'file');
      await fs.access(payload);
    } else if (!source) continue;
    const script = path.join(neutral, 'personal-statusline', suffix);
    const result = await run('python3', ['-I', '-B', path.join(context.root, 'scripts/statusline-config.py')], {
      input: JSON.stringify({ host, source, script, legacy, home: context.home, enabled: Boolean(selected) }),
    });
    const content = JSON.parse(result.stdout);
    if (source !== content) changes.push({ file, relativePath, source, content });
  }
  return changes;
}
