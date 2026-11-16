# 这个目录被精简过

上游包：[pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT，`LICENSE` 已随包保留）。

留着的是**完整可用**的最小集合，删除的文件都是运行时用不到的。

## 删了什么

| 删除 | 数量 | 为什么 |
|---|---|---|
| `types/` | 33 个 `.d.ts` | TypeScript 类型声明。本插件是纯 JS，不用 TS 编译。 |
| `dist/esm/` | 29 个 `.mjs` | ESM 格式的构建产物。功能与 UMD 版完全相同，只是模块格式不同。 |
| `dist/index.mjs` | 1 个（33 字节） | 转发壳：`export * from './esm/index.mjs'`。`esm/` 删了就成死链。 |

## 留着什么

```
dist/index.js   318 KB   ← 自包含 UMD，全部功能都在这个文件里
LICENSE         1 KB     ← MIT 许可证，必须留
package.json    3 KB     ← 上游包元数据
README.md       10 KB    ← 上游文档
```

本插件只 import 这一个文件：

```js
// lib/search.js
const mod = await import('../vendor/pinyin-pro/dist/index.js')
```

## ⚠️ 一个已知的不一致

`package.json` 里的 `exports` / `module` 字段仍然指向 `dist/esm/index.mjs`（已删）。

**这不影响任何功能**——因为没有代码会走 `package.json` 的解析规则，我们用的是显式相对路径。
之所以不改它，是为了让这份文件的其余元数据保持上游原样。

## 怎么恢复成完整版

```bash
npm pack pinyin-pro        # 拿到 .tgz 原版
# 或者从 GitHub 拉对应版本
```

上游版本见 `package.json` 的 `version` 字段。

## 为什么这样不算"依赖"

原话（项目作者的定义）：「脱离他我就会出问题，或者他动我也会死，那才算强依赖。」

pinyin-pro 已经下到本地、锁死版本、可以自己改，所以它不合格。而且它是**可选**的：

```js
// lib/search.js —— 整个 vendor 目录删掉，插件照样能跑
try { ... await import(...) } catch { pinyin = null }
```

删掉之后检索退化到纯字面匹配（拼音和首字母两层失效），不会崩。验证见 `test/nodep.mjs`。
