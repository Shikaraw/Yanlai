# 贡献指南

感谢你对研来感兴趣。本文档说明如何搭建开发环境、项目约定，以及提交改动的流程。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 开发环境实测 24.15 |
| npm | ≥ 10 | |
| Python | ≥ 3.9 + Pillow | **仅**重新生成图标时需要（`pip install pillow`） |
| Git | 任意 | |

---

## 快速开始

```bash
git clone git@github.com:Shikaraw/Yanlai.git
cd Yanlai
npm install
npm run dev        # Vite HMR + Electron，改前端即时生效
```

改**主进程**代码（`electron/**`）需要重启 `npm run dev`。

### 离线开发（不需要 API Key）

```bash
npm run mock       # 启动本地 mock LLM 服务 http://127.0.0.1:8899/v1
```

设置里填 `http://127.0.0.1:8899/v1`，模型名 `mock-tutor`，Key 随意填。

**注意**：mock 返回的是**写死的假内容**，只能验证代码链路（流式解析、工具调用、渲染、导出），
**不能验证讲解质量**。涉及提示词效果的改动必须用真实模型测试。

---

## 项目约定

### 代码风格

- **无 UI 组件库、无图标库** —— 设计系统在 `src/styles/app.css`，图标在 `src/components/Icons.tsx`。
  新增 UI 请复用现有 CSS 变量与原语，不要引入新依赖。
- **注释写「为什么」不写「是什么」**。以下类型的注释是受欢迎的：
  - 解释反直觉的实现（如「这里必须绕过系统代理，因为…」）
  - 记录实测得到的结论（附现象或数据）
  - 说明为什么不采用更常见的方案
- 不写「下一行做了什么」式的注释。

### 类型

TypeScript 开着但 `strict: false`（历史原因）。新增代码请写完整类型，
尤其是跨进程 IPC 的载荷 —— 那些类型定义在 `src/lib/bridge.ts`。

### 主进程 vs 渲染进程

| 能力 | 放哪 | 原因 |
|---|---|---|
| 文件读写、弹窗、托盘、通知 | 主进程 | 需要 Node 权限 |
| 网络请求（LLM / TTS） | 渲染进程 | 有 `fetch`，且便于按会话取消 |
| 网络请求（更新检查） | 主进程 | 需要独立 session 绕过系统代理 |
| 定时任务（提醒） | 主进程 | 窗口隐藏时仍需工作 |
| 业务逻辑 / 状态 | 渲染进程 | |

新增系统能力必须：
1. 在 `electron/main.cjs` 注册 `ipcMain.handle`
2. 在 `electron/preload.cjs` 加入白名单
3. 在 `src/lib/bridge.ts` 补类型 + 浏览器 mock

---

## 测试

```bash
npm test              # 全部套件
npm run typecheck     # 类型检查
```

| 套件 | 环境 | 覆盖 |
|---|---|---|
| `tests/math.plot.test.mjs` | node | 表达式解析、数值方法、SVG 输出 |
| `tests/kb.context.test.mjs` | node | 分块、BM25、token 预算、上下文压缩 |
| `tests/export.test.cjs` | electron | DOCX / PDF / HTML 真实产物 |
| `tests/tts.test.cjs` | electron | SAPI 音色、WAV 头 |
| `tests/updater.test.cjs` | electron | 版本比较、镜像回退 |

### 写测试的约定

- **断言行为，不断言实现**。检查「解压出的 docx 里有这段中文」，而不是「调用了某个函数」。
- **失败必须非零退出**。运行器靠退出码判断。
- 需要 Electron 环境的套件用 `.cjs` 并在 `tests/run.mjs` 里通过 electron 二进制运行。
- 网络相关测试要能**离线通过**（把连通性检查写成「成功或明确报告失败」而非硬断言）。

新增测试：在 `tests/` 加文件，并在 `tests/run.mjs` 的 `suites`（node）或 Electron 循环里登记。

---

## 提交改动

### 分支

```bash
git checkout -b feat/你的功能名
```

### 提交信息

用简洁的中文或英文，说明**做了什么**与**为什么**：

```
修复工具轮与正文轮之间的 Markdown 粘连

工具执行后模型开始新的正文块，但两者之间没有分隔符，
导致 "## 标题" 被渲染成字面文本。

现在轮次间插入空行，并补充了回归测试。
```

### 提交前检查清单

- [ ] `npm run typecheck` 无错误
- [ ] `npm test` 全部通过
- [ ] 涉及 UI 的改动，实际启动应用看过效果（`npm start`）
- [ ] 涉及提示词的改动，**用真实模型验证**过效果
- [ ] 若改了主进程或 IPC，检查了 preload 白名单与 bridge 类型

---

## 版本号

遵循项目的三段式方案（PATCH 固定两位）：

```bash
npm run version:bump patch   # 1.0.00 → 1.0.01   小改动
npm run version:bump minor   # 1.0.05 → 1.1.00   大改动
npm run version:bump major   # 1.4.02 → 2.0.00   重大改动
```

脚本会同步 `package.json`、`src/lib/prompts.ts`、`README.md`。

---

## 打包

```bash
npm run dist
```

产物在 `release/`。首次打包需从 GitHub 拉取 NSIS 工具链，
脚本已默认使用 npmmirror 镜像；必要时用环境变量覆盖：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://your.mirror/ npm run dist
```

**不要**改动版本号传递机制 —— `scripts/dist.mjs` 通过 `APP_VERSION` 环境变量传递版本，
因为 `1.0.00` 不是合法 semver，electron-builder 会把它规范成 `1.0.0`。

---

## 重新生成图标

```bash
npm run icon
```

流程：Electron 渲染 `build/icon.svg` 出 1024px 母图 → Pillow 用 Lanczos 降采样出各尺寸
+ 组装多分辨率 `.ico` + 生成托盘图标。

修 **`build/icon.svg` 是唯一的图标源**，其它 PNG/ICO 都是派生产物（已 gitignore）。
用单张 1024 母图降采样，比让浏览器直接渲染 16px 更清晰。

---

## 网络受限环境的注意事项

这个项目在**网络受限环境**（国内直连 GitHub 不稳定）下开发，有些约定因此而来：

- `scripts/git-retry.sh` —— git 操作的重试包装（自动在 443/22 端口间切换）
  ```bash
  ./scripts/git-retry.sh push origin main
  ```
- 更新检查默认走镜像，**不要**改成默认直连
- 更新请求用独立 session 绕过系统代理，**不要**改回默认会话（见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 5 条）

---

## 文档

| 文件 | 内容 |
|---|---|
| [README.md](../README.md) | 概览、安装、功能总表 |
| [docs/USAGE.md](USAGE.md) | 面向使用者的完整操作手册 |
| [docs/ARCHITECTURE.md](ARCHITECTURE.md) | 架构与设计取舍（**改代码前建议先读**） |
| [docs/CONTRIBUTING.md](CONTRIBUTING.md) | 本文档 |

改了行为请同步更新文档，尤其是 `ARCHITECTURE.md` 里的「已修复的真实缺陷」表 ——
那份清单是项目的记忆。

---

## 报告问题

提交 Issue 时请附上：

1. 复现步骤
2. 期望行为 vs 实际行为
3. 设置 → 数据 → 打开日志，附上相关日志
4. 应用版本（设置 → 关于）

---

## License

MIT。提交即表示你同意以相同许可发布你的贡献。
