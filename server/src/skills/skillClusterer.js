/**
 * Skill clusterer (L2) —— 主题指纹聚簇，纯规则零 LLM。
 *
 * 设计对齐 02-技术设计规格 §3.3：
 * - 输入：conversation summary 的 overview（一句话）
 * - 1. 小写化、去标点、去停用词（中英各一份小词表）
 * - 2. 取词集合，Jaccard 相似度 = |A∩B| / |A∪B|
 * - 3. 相似度 ≥ 0.6 → 同簇
 * - 4. 簇合并：传递闭包（A~B, B~C ⇒ A,B,C 同簇），簇 id = 簇内最早候选的 sessionId
 * - MVP 不用 embedding；预留 similarityFn 注入位
 */

const SIMILARITY_THRESHOLD = 0.6;

// 中英文停用词小表（§3.3，够用即可，不追求完整）
const STOPWORDS = new Set([
    // EN
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with',
    'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
    'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we', 'they',
    'he', 'she', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no',
    'but', 'if', 'then', 'so', 'can', 'will', 'would', 'should', 'about',
    'how', 'what', 'when', 'where', 'which', 'who', 'why', 'up', 'down',
    'out', 'off', 'over', 'under', 'again', 'there', 'here', 'each', 'few',
    'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too',
    'very', 'just', 'than', 'into', 'your', 'my', 'our', 'their', 'his', 'her',
    // ZH（常见虚词 / 单字高频）
    '的', '了', '在', '和', '与', '及', '是', '有', '我', '你', '他', '她',
    '它', '这', '那', '就', '都', '也', '很', '会', '能', '要', '把', '被',
    '对', '用', '为', '等', '进行', '一个', '我们', '你们', '他们', '这个', '那个',
]);

/**
 * 归一化 overview 为词集合（§3.3 步骤 1-2）。
 *
 * 中英处理差异：英文按空白/标点切词；中文无空格，MVP 不引分词库，
 * 连续中文段按 **2-gram（相邻两字）** 切分，兼顾语义与停用词过滤。
 *
 * @param {string} overview
 * @returns {string[]} 去重后的词/gram 数组（小写、去标点、去停用词）
 */
function tokenize(overview) {
    const text = String(overview || '').toLowerCase();
    const out = [];
    // 分段：连续中文段 | 拉丁字母数字词（含下划线）
    const re = /[\u4e00-\u9fff]+|[a-z0-9_]+/gu;
    for (const match of text.matchAll(re)) {
        const tok = match[0];
        if (/[\u4e00-\u9fff]/.test(tok)) {
            // 中文段 → 2-gram；单字直接保留
            if (tok.length === 1) {
                out.push(tok);
            } else {
                for (let i = 0; i < tok.length - 1; i += 1) {
                    out.push(tok.slice(i, i + 2));
                }
            }
        } else {
            out.push(tok);
        }
    }
    const seen = new Set();
    const deduped = [];
    for (const tok of out) {
        if (STOPWORDS.has(tok)) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        deduped.push(tok);
    }
    return deduped;
}

/**
 * 生成主题指纹（§2.3 存储用）：词集合按空格连接。
 * @param {string} overview
 * @returns {string} 空 overview / 无词时返回 ''
 */
function fingerprint(overview) {
    return tokenize(overview).join(' ');
}

/**
 * Jaccard 相似度。
 * @param {string[]|Set} a
 * @param {string[]|Set} b
 * @returns {number} 0~1；两集合皆空时视为 1（都无有效主题词）
 */
function jaccard(a, b) {
    const setA = a instanceof Set ? a : new Set(a || []);
    const setB = b instanceof Set ? b : new Set(b || []);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const x of setA) {
        if (setB.has(x)) intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * 两 overview 是否相似（§3.3 步骤 3）。
 * @param {string} a
 * @param {string} b
 * @param {Function} [similarityFn] 预留注入位（MVP 默认 Jaccard）
 * @returns {boolean}
 */
function areSimilar(a, b, similarityFn = jaccard) {
    return similarityFn(tokenize(a), tokenize(b)) >= SIMILARITY_THRESHOLD;
}

/**
 * 聚簇：对候选列表做传递闭包合并（§3.3 步骤 4）。
 *
 * @param {Array<{ sessionId: string, overview: string }>} candidates
 * @param {object} [opts]
 * @param {Function} [opts.similarityFn] 预留注入位
 * @returns {Array<{ clusterId: string, size: number, sessionIds: string[] }>}
 *   clusterId = 簇内最早候选的 sessionId（按输入顺序首次出现者）。
 */
function cluster(candidates = [], { similarityFn } = {}) {
    const sim = (a, b) => (similarityFn ? similarityFn(a, b) : areSimilar(a, b));

    // Union-Find（按 index）
    const parent = candidates.map((_, i) => i);
    const find = (x) => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
            if (sim(candidates[i].overview, candidates[j].overview)) union(i, j);
        }
    }

    const groups = new Map(); // rootIdx -> { sessionIds }
    for (let i = 0; i < candidates.length; i += 1) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(i);
    }

    const result = [];
    for (const memberIdx of groups.values()) {
        // 簇 id = 簇内最早候选 sessionId（index 最小者即输入序最早）
        memberIdx.sort((a, b) => a - b);
        result.push({
            clusterId: candidates[memberIdx[0]].sessionId,
            size: memberIdx.length,
            sessionIds: memberIdx.map((i) => candidates[i].sessionId),
        });
    }
    return result;
}

module.exports = {
    SIMILARITY_THRESHOLD,
    STOPWORDS,
    tokenize,
    fingerprint,
    jaccard,
    areSimilar,
    cluster,
};
