/**
 * 依赖/构建产物对 git 隐身：写入 workspace 的 `.git/info/exclude`（幂等）。
 *
 * 为什么用 .git/info/exclude 而不是改用户的 .gitignore：
 * - exclude 文件位于 .git/ 内部，git 自身永不跟踪 → 不在用户项目里产生任何
 *   新增/修改文件，git 变更面板零干扰，也不会被 commit/push 带走；
 * - per-clone 生效：preview workspace 本就是每次部署独立的 clone，天然匹配；
 * - ignore 规则只影响 untracked 文件，对用户已跟踪文件零影响（安全兜底）。
 *
 * 为什么是静态超集、不需要按项目识别依赖：
 * - 主流生态的依赖/产物目录名集合小且稳定，指向不存在目录的条目零副作用；
 * - gitignore 语法 `node_modules/`（无前导 /）匹配任意深度，覆盖 LLM 部署
 *   计划可能往任意子目录（web/、server/…）安装依赖的情况；
 * - 本脚本幂等，每次部署/clone 都会重跑：将来扩充条目后，已有 workspace
 *   下次部署自动补齐（实用意义上的"实时更新"）。
 *
 * 刻意不加歧义名（vendor/、bin/、obj/、env/）：这些名字可能被项目有意提交，
 * 虽然 ignore 不影响已跟踪文件，但会藏住其中新增的 untracked 文件。
 */
const DEPENDENCY_EXCLUDE_HEADER = '# --- XEnsemble managed: dependencies & build artifacts (auto-appended, idempotent) ---';

const DEPENDENCY_EXCLUDE_ENTRIES = [
    DEPENDENCY_EXCLUDE_HEADER,
    // Node 生态（npm/pnpm/yarn/bun 共用 node_modules）
    'node_modules/',
    'bower_components/',
    // Python
    '__pycache__/',
    '*.py[cod]',
    '*.egg-info/',
    '.eggs/',
    '.venv/',
    'venv/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    '.tox/',
    '.ipynb_checkpoints/',
    // Rust / Maven（Go 不使用 target/）
    'target/',
    // 前端 / 通用构建产物
    'dist/',
    'build/',
    'out/',
    '.next/',
    '.nuxt/',
    '.output/',
    '.svelte-kit/',
    '.vite/',
    '.turbo/',
    '.parcel-cache/',
    // pnpm 8+ 项目本地 store（pnpm config set store-dir ./.pnpm-store）
    '.pnpm-store/',
    // Yarn Berry PnP 缓存与解析映射
    '.yarn/cache/',
    '.pnp.cjs',
    // mise 版本管理器 installs_path（MISE_INSTALLS_DIR=.tools）
    '.tools/',
    // Elm 编译产物
    'elm-stuff/',
    // Angular 构建缓存
    '.angular/cache/',
    // 缓存 / 杂项
    '.cache/',
    'coverage/',
    '.nyc_output/',
    '.gradle/',
    '.eslintcache',
    '*.tsbuildinfo',
    '.DS_Store',
];

// 幂等 POSIX sh 脚本：逐条 grep -qxF 精确整行匹配，只追加缺失条目，绝不删除
// 用户自己的 exclude 规则。heredoc 加单引号避免任何变量展开。
// git 目录定位（boxlite 沙箱把 .git 挂载成 /workspace.git，/workspace 下无 .git，
// 旧脚本 `if [ -d .git ]` 直接跳过导致 exclude 从未写入）：
//   1) /workspace.git 目录（boxlite 挂载，写入即主仓库 .git/info/exclude，per-clone 生效）
//   2) .git 文件（git worktree 的 gitdir 指针，解析出真实 gitdir，绝对/相对路径都支持）
//   3) .git 目录（普通 clone / local provider）
const DEPENDENCY_EXCLUDE_SCRIPT = `GIT_DIR=''
if [ -d /workspace.git ]; then
  GIT_DIR=/workspace.git
elif [ -f .git ] && [ -s .git ]; then
  GIT_DIR="$(sed -n 's/^gitdir:[[:space:]]*//p' .git | head -1)"
  case "$GIT_DIR" in
    /*) ;;
    *)
      if RESOLVED="$(cd -P "$(pwd -P)" >/dev/null 2>&1 && cd -P "$GIT_DIR" 2>/dev/null && pwd -P)"; then
        GIT_DIR="$RESOLVED"
      else
        GIT_DIR=''
      fi
      ;;
  esac
fi
if [ -z "$GIT_DIR" ] && [ -d .git ]; then
  GIT_DIR=.git
fi
if [ -n "$GIT_DIR" ] && [ -d "$GIT_DIR" ]; then
  mkdir -p "$GIT_DIR/info" 2>/dev/null || true
  touch "$GIT_DIR/info/exclude" 2>/dev/null || true
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    grep -qxF "$entry" "$GIT_DIR/info/exclude" 2>/dev/null || printf '%s\\n' "$entry" >> "$GIT_DIR/info/exclude"
  done <<'XENSEMBLE_EXCLUDE_EOF'
${DEPENDENCY_EXCLUDE_ENTRIES.join('\n')}
XENSEMBLE_EXCLUDE_EOF
  echo EXCLUDE_OK
fi
`;

module.exports = {
    DEPENDENCY_EXCLUDE_HEADER,
    DEPENDENCY_EXCLUDE_ENTRIES,
    DEPENDENCY_EXCLUDE_SCRIPT,
};
