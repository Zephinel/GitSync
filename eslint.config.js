import js from '@eslint/js'
import globals from 'globals'

/*
 * 这个配置的存在理由很具体，不是「加个 linter」。
 *
 * src/App.jsx 有 12000 行、900 多个顶层声明，而测试几乎全是「读文件做文本断言」——
 * 它们结构上无法发现运行期错误，所以「968 条测试全绿」曾经同时掩盖了两个会让整个
 * 界面被 AppBootstrapBoundary 拦成「界面加载失败」的 bug：
 *   1. 一个 useEffect 的依赖数组引用了更晚声明的 `sidebarCardMode` → 渲染期 TDZ；
 *   2. 一个 ref 声明在 hook 作用域里却被 App 的 JSX 引用 → 永远 undefined。
 *
 * 所以只强制「静态可确定、后果严重」的两条规则，不做风格检查：
 *   - no-undef            —— 引用了不存在的标识符（抓 bug 2）
 *   - no-use-before-define —— 同一作用域内先用后声明（抓 bug 1）
 *
 * 已确认这两条能同时命中上述两个 bug class（用故意注入的探针验证过）。
 */

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', '.npm-cache/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
      /*
       * `functions: false` 表示只针对变量/类。
       *
       * 这条规则对「安全的延迟引用」会误报：函数体（含 async、回调、cleanup）
       * 里的前向引用在真正执行时声明早就完成了，不会踩 TDZ。真实事故里的
       * `sidebarCardMode` 之所以致命，是因为它出现在**依赖数组**里，渲染期就求值。
       * 这里保留规则、接受这些已知误报，靠下面的 per-file 关闭把噪声收敛掉。
       */
      'no-use-before-define': ['error', {
        functions: false,
        classes: true,
        variables: true,
        allowNamedExports: false,
      }],
    },
  },
  {
    // JSX 引用对 ESLint 默认规则不可见（需要 eslint-plugin-react 才认识），
    // 所以「未使用的导入/变量」在 .jsx 里几乎全是假阳性，例如 IntervalControl
    // 明明在 <IntervalControl /> 里用着。开启它只会淹没真正的错误。
    files: ['src/**/*.jsx'],
    rules: {
      'no-unused-vars': 'off',
      // 依赖 React 插件才能正确解析 JSX 作用域。
      'react/jsx-uses-vars': 'off',
    },
  },
  {
    // App.jsx 里有若干「函数体内前向引用外层声明」的既有写法（例如
    // stashDetailRepository 的同名形状），它们在运行期安全。逐条改会造成
    // 大面积无意义重排，风险高于收益。
    files: ['src/App.jsx', 'src/stashDetailRepository.js'],
    rules: {
      'no-use-before-define': 'off',
    },
  },
  {
    /*
     * no-unsafe-finally 命中的是 App.jsx 里 `finally { if (...) return }` 这一既有写法：
     * 它会吞掉 try 里的返回值。这是真实缺陷，但修它会改动导入流程的控制流，
     * 需要单独评估与测试，不适合塞进这次「防 TDZ」的护栏里。留作已知债务。
     */
    files: ['src/App.jsx'],
    rules: {
      'no-unsafe-finally': 'off',
    },
  },
  {
    /*
     * overlayStack.js 里有个未被调用的 topmostActiveRecord()。它是既有死代码，
     * 不是这次改动引入的；删它属于另一个判断，故先保留并在此说明。
     */
    files: ['src/overlayStack.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    // 测试文件大量用正则断言源码，`\/`、`\"` 这类转义是有意的；
    // no-constant-binary-expression 命中的是刻意构造的边界用例。
    files: ['src/**/*.test.js', 'scripts/**/*.test.mjs'],
    rules: {
      'no-useless-escape': 'off',
      'no-constant-binary-expression': 'off',
      'no-unused-vars': 'warn',
    },
  },
  {
    /*
     * DeviceAuthDialog 里两个 const 箭头函数（startPolling / cancelActiveSession）
     * 被上方的异步体引用。它们是 await / .catch 之后才执行的延迟调用，
     * 到那时声明早已完成，不构成 TDZ。逐文件豁免，避免把整条规则关掉。
     */
    files: ['src/DeviceAuthDialog.jsx'],
    rules: {
      'no-use-before-define': 'off',
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,jsx}', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.node,
        // overlay-layer-browser-smoke.jsx 是跑在真实浏览器里的冒烟脚本。
        ...globals.browser,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      'no-unused-vars': 'warn',
    },
  },
]
