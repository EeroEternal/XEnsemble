/**
 * Resolve locale from a Fastify request's Accept-Language header.
 * Returns 'zh' for any Chinese variant, otherwise 'en'.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string} 'en' or 'zh'
 */
function detectLocale(request) {
  const header = request?.headers?.['accept-language'];
  if (!header) return 'en';
  // Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
  const languages = header.split(',').map((s) => s.trim().toLowerCase());
  for (const lang of languages) {
    const tag = lang.split(';')[0];
    if (tag.startsWith('zh')) return 'zh';
  }
  return 'en';
}

module.exports = { detectLocale };
