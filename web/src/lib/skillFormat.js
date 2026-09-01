/**
 * SKILL.md 格式工具：从 content 解析 YAML frontmatter（name/description）。
 *
 * 产物格式对齐 Anthropic Agent Skills：content 以 `---` 开头的 YAML frontmatter +
 * markdown 正文。手动创建的 skill（source='manual'）可能没有 frontmatter，需兼容。
 */

/**
 * 解析 SKILL.md frontmatter。
 * @param {string} content
 * @returns {{ name: string|null, description: string|null, body: string }}
 */
export function parseSkillFrontmatter(content) {
  const text = String(content || '');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const frontmatter = text.slice(3, end);
      const body = text.slice(end + 4).replace(/^\n/, '');
      const name = pickYamlValue(frontmatter, 'name');
      const description = pickYamlValue(frontmatter, 'description');
      return { name, description, body };
    }
  }
  return { name: null, description: null, body: text };
}

/** 从 YAML 行中提取 key 的标量值（剥离引号，忽略数组/嵌套）。 */
function pickYamlValue(yaml, key) {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
  const m = yaml.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * 获取技能展示用描述：优先 frontmatter description，否则取正文首段。
 * @param {string} content
 * @param {number} [maxLen]
 * @returns {string}
 */
export function getSkillDescription(content, maxLen = 120) {
  const { description, body } = parseSkillFrontmatter(content);
  const raw = (description && description.trim())
    || body.trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  const s = raw.trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}
