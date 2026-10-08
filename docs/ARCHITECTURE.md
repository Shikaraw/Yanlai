# 研来 · 架构与设计取舍

本文档记录**怎么实现的**以及**为什么这么选**。每一条取舍都尽量附上实测依据或反面案例，
因为「为什么不用某个更常见的方案」往往比「用了什么」更有信息量。

---

## 目录

- [整体分层](#整体分层)
- [进程与安全模型](#进程与安全模型)
- [目录结构](#目录结构)
- [关键设计取舍](#关键设计取舍)
  - [1. 数学表达式：手写解析器而非 eval](#1-数学表达式手写解析器而非-eval)
  - [2. 绘图：SVG 而非 canvas 位图](#2-绘图svg-而非-canvas-位图)
  - [3. 知识库检索：本地 BM25 而非 embedding](#3-知识库检索本地-bm25-而非-embedding)
  - [4. 省 token：五层上下文压缩](#4-省-token五层上下文压缩)
  - [5. 更新检查：绕过系统代理](#5-更新检查绕过系统代理)
  - [6. 工具产出：data URL 绝不内联进消息](#6-工具产出data-url-绝不内联进消息)
  - [7. 存储：IndexedDB 而非 localStorage](#7-存储indexeddb-而非-localstorage)
- [Agent 循环](#agent-循环)
- [提示词架构](#提示词架构)
- [时间规划调度器](#时间规划调度器)
- [朗读队列](#朗读队列)
- [文档导出管线](#文档导出管线)
- [测试策略](#测试策略)
- [已修复的真实缺陷](#已修复的真实缺陷)

---

## 整体分层

```
┌──────────────────────────────────────────────────────────┐
│ 渲染进程（React 19）                                      │
│  views/      页面：对话/规划/错题/卡片/知识库/统计/设置   │
│  components/ UI 原语、Markdown 渲染、消息气泡、图标       │
│  store/      zustand 状态（app / chat / data）            │
│  lib/        纯逻辑：llm / context / prompts / tools /    │
│              mathplot / kb / parse / tts / idb / util     │
├──────────────────────────────────────────────────────────┤
│ preload.cjs —— contextBridge 白名单（唯一的跨进程面）      │
├──────────────────────────────────────────────────────────┤
│ 主进程（Node，CommonJS）                                  │
│  main.cjs    窗口 / 托盘 / 防多开 / IPC / 菜单             │
│  lib/        store(原子IO) settings planner(调度)          │
│              docs(docx/pdf) tts(SAPI) tray updater        │
├──────────────────────────────────────────────────────────┤
│ 外部：LLM API · TTS API · GitHub Releases（检查更新）      │
└──────────────────────────────────────────────────────────┘
```

**为什么主进程用 CommonJS 而渲染进程用 ESM**：`package.json` 里 `"type": "module"` 让
`.js` 默认按 ESM 解析，而 Electron 主进程历史上要求 CommonJS。解决办法是主进程文件统一命名为
`.cjs`（`main.cjs` / `preload.cjs` / `lib/*.cjs`），避免为两套模块系统各维护一份配置。

---

## 进程与安全模型

渲染进程运行在 `contextIsolation: true` + `nodeIntegration: false` 下，**没有 Node 权限**。
所有系统能力通过 [preload.cjs](../electron/preload.cjs) 的 `contextBridge` 显式暴露：

```js
exposeInMainWorld('yanlai', {
  app, win, settings, dialog, fs, shell, clipboard, paths,
  attach, doc, tts, kb, planner, reminder, system, update, tray
})
```

安全约束：
- **文件操作限定**在工作区与数据目录，不提供任意路径递归删除
- **数学表达式不求值执行**（见下节）
- **导出 HTML 做转义**，模型或用户内容不会变成可执行标记
- **CSP** 限制脚本来源；外部链接一律交给系统浏览器，不在应用内加载
- **单实例锁**（`requestSingleInstanceLock`）防止多开造成数据竞争

`electron/main.cjs` 的窗口配置里还有一处细节：

```js
...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false })
```

应用自绘标题栏（含「进行中时段」读数和工具按钮），所以必须去掉系统边框，
否则会出现两条标题栏叠在一起。macOS 保留红绿灯，Windows/Linux 用自绘按钮。

---

## 目录结构

```
electron/                 主进程
  main.cjs                窗口、托盘、防多开、IPC、菜单、更新检查调度
  preload.cjs             contextBridge 白名单
  lib/
    store.cjs             原子读写（tmp+rename）、目录管理
    settings.cjs          默认值 + 深合并
    planner.cjs           时间规划调度器（常驻主进程，托盘下仍工作）
    docs.cjs              Markdown → DOCX / PDF / HTML
    tts.cjs               Windows SAPI / macOS say 语音合成
    tray.cjs              系统托盘与菜单
    updater.cjs           GitHub Release 检查 + 镜像回退
src/
  lib/
    bridge.ts             preload 的类型化封装（含浏览器 mock）
    idb.ts                IndexedDB 封装
    llm.ts                OpenAI 兼容流式客户端
    context.ts            省 token 的上下文构建
    prompts.ts            模块化系统提示词 + 12 种学习模式
    tools.ts              工具注册表（11 个工具）
    mathplot.ts           递归下降解析器 + SVG 绘图
    kb.ts                 分块 + BM25 检索
    parse.ts              PDF / DOCX / XLSX 文本提取
    tts.ts                朗读队列
    attachments.ts        粘贴/拖入/选取的附件摄取
    util.ts               工具函数（含 TTS 文本化、句子切分）
  store/                  useApp / useChat / useData
  components/             Icons / Markdown / MessageBubble / ui
  views/                  各页面 + ReminderApp（独立窗口）+ UpdatePanel
  styles/app.css          设计系统（CSS 变量驱动主题与强调色）
scripts/
  make-icons.mjs          SVG → PNG / ICO（Electron 渲染 + Pillow 降采样）
  bump-version.mjs        版本号管理
  dist.mjs                打包入口（注入 APP_VERSION 绕过 semver 规范化）
  mock-server.mjs         本地 mock LLM 服务
  git-retry.sh            不稳定网络下的 git 重试包装
tests/                    4 组测试套件 + 运行器
```

---

## 关键设计取舍

### 1. 数学表达式：手写解析器而非 eval

**问题**：绘图和计算工具的表达式来自**模型输出**，属于不可信输入。

**方案**：`src/lib/mathplot.ts` 里手写词法分析 + 递归下降解析器，产出闭包树。

```ts
tokenize()  → 处理 LaTeX（\frac、\sqrt、^{}、{}）、隐式规则、科学计数法
compileExpr() → cmp → sum → term → unary → power → atom（右结合幂）
```

**为什么不 `eval` / `new Function`**：模型完全可能输出 `process.exit(1)` 或更糟的东西。
测试里专门验证了这点：

```
✓ JS injection is rejected (no eval)     # makeFn('process.exit(1)') 抛错而非执行
✓ malformed expression throws
✓ illegal character throws
```

**顺带解决的兼容问题**：模型常写 `\sqrt{9}`、`x^{-2}`、`\pi`、`2^{3}`。
分词器先把结构化命令归一化（`\frac{a}{b}` → `((a)/(b))`，`\sqrt{x}` → `sqrt(x)`），
再把剩余花括号转成圆括号——这一条是实测发现的缺陷：最初不处理花括号，
导致所有 `\sqrt` / `\frac` 直接抛「无法识别的字符 `{`」。

### 2. 绘图：SVG 而非 canvas 位图

**四个理由**：
1. 缩放不糊（讲解时经常需要放大看局部）
2. 体积极小（一帧 24KB，位图动辄几百 KB）
3. 能直接嵌入 DOCX / PDF 导出
4. 能在消息里内联渲染，也能作为 artifact 存起来复看

**难点是渐近线处理**。`tan(x)` 在 ±π/2 处不连续，朴素采样会画出垂直长线。
解法是比较相邻采样点的跳变幅度与 y 轴跨度：

```ts
function isDiscontinuity(y0, y1, yRange) {
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return true
  return Math.abs(y1 - y0) > yRange * 1.6   // 超过整个画面 1.6 倍即判定为断裂
}
```

断裂处把折线拆成多段独立 polyline。测试验证 `tan(x)` 在 `[-6,6]` 上确实被切成多支：

```
✓ tan(x) splits into multiple branches     (polylines > 1)
```

**自动标注**也只对单条显函数曲线做（零点 + 极值），多曲线对比时标注会变成噪声。

### 3. 知识库检索：本地 BM25 而非 embedding

**常见做法**是用向量库 + embedding 模型。这里**故意不用**：

| 维度 | 本地 BM25 | embedding 方案 |
|---|---|---|
| Token 成本 | **0** | 每次检索一次 embedding 调用 |
| 额外依赖 | 无 | 第二个 API Key 或本地模型 |
| 离线可用 | ✅ | 需联网或本地推理 |
| 中文教材表现 | 好（术语字面重合） | 好 |

**关键判断**：学习资料场景下，学生的提问通常**与教材共享字面术语**
（问「拉格朗日中值定理的条件」，教材里写的就是「拉格朗日中值定理」）。
这种场景 BM25 的表现与向量检索相当，但成本从「每次一毛钱」变成「零」。

**中文分词**：不引入分词库，用「一元 + 二元 + 三元」混合切分：

```ts
indexTokens('拉格朗日中值定理')
// → ['拉','拉格','拉格朗', '格','格朗','格朗日', ...]
```

一元的召回好、二元的精度好、三元的能抓住「拉格朗」这类技术名词。
停用词过滤掉「的了是在和」等高频字。

**评分细节**：
- BM25（k1=1.4, b=0.72）+ 查询覆盖率加成（防止单个常见词主导）
- 标题命中加权 1.2×
- 片段携带所属标题，命中标题也能加分

实测结果：

```
✓ finds the Lagrange section
✓ finds the Cauchy section (洛必达 basis)
✓ finds the Taylor expansion
✓ unrelated query yields no strong hits       # 「量子纠缠」best score < 3
```

### 4. 省 token：五层上下文压缩

详见 `src/lib/context.ts`。核心问题：每轮都重发整段历史，40 轮对话的成本是线性膨胀的。

| 层 | 机制 | 实现要点 |
|---|---|---|
| 1 | **瞬时注入** | 检索结果作为 system 消息注入**当轮**，不写回历史 |
| 2 | **图片衰减** | 只有近期窗口内的截图发送真实图片数据 |
| 3 | **工具输出衰减** | 窗口外的工具返回压成一行摘要，保留文件引用 |
| 4 | **本地摘要** | 窗口外的助手回复用结构骨架替代（**不调用付费摘要**） |
| 5 | **去重** | 重复引用合并 |

**几个非显而易见的地方：**

**（a）摘要不能太激进。** 初版实现里，`digestContent` 在「提取到的骨架少于阈值」时会回退到
"取前 6 个句子"，结果把反复出现的正文段落整段带了进来——压缩率反而变差。
修复：只在**完全没有结构**（无标题、无列表）时才回退到句子抽取。

**（b）工具轮必须整轮保留或整轮删除。** API 规定：带 `tool_calls` 的 assistant 消息，
其后必须紧跟对应的 `tool` 结果消息。早期实现会把 `tool` 结果单独剥掉，导致请求被服务端拒绝。
修复后按「整个工具轮」为单位处理，并在最后做一次孤儿消息清理：

```ts
// final safety: remove orphan tool messages
const callIds = new Set()
for (const m of out) for (const t of m.tool_calls || []) callIds.add(t.id)
const cleaned = out.filter(m => m.role !== 'tool' || callIds.has(m.tool_call_id))
```

**（c）工具产出不能内联进正文。** 这是一个实测抓到的**真实浪费**：绘图工具产出的是
`data:image/svg+xml;base64,...`（约 25KB），早期实现把它作为 Markdown 图片写进了消息 `content`。
后果有两层：
- 每轮请求都把这 25KB 当**文本**重发（约 6000+ token/轮）
- 它与下一轮模型输出的 Markdown 之间**没有分隔符**，导致 `## 解题思路` 渲染成字面文本

修复：图表由 `ArtifactCard` 从 `message.artifacts` 渲染，**绝不写进 content**。
同时在工具轮与后续正文轮之间插入 `\n\n` 分隔符。

### 5. 更新检查：绕过系统代理

**这是一个只有实测才能发现的坑。**

现象：用 `curl` 直连 `https://gh-proxy.com/https://api.github.com/...` **成功**（HTTP 404 = 通了，
只是仓库还没 Release），但同样的 URL 在 Electron 里报 `net::ERR_CONNECTION_CLOSED`。

排查过程：

```js
// 默认会话（继承系统代理 FlClash:7890）
{"label":"default","err":"net::ERR_CONNECTION_CLOSED"}

// 显式 direct
{"label":"direct-mode","status":404,"len":144}     // ← 通了！

// session.resolveProxy(url)  →  "DIRECT"（但实际仍走了代理）
```

**根因**：Electron 默认会话继承操作系统代理设置。本机运行着 Clash 类工具，
其**上游节点实际不可用**（实测：走代理访问 baidu 返回 200，访问 google/github 全部超时）。
于是所有走系统代理的请求全部失败。

**修复**：更新请求使用**独立 session**，并显式设为 `direct`：

```js
const UPDATE_PARTITION = 'persistent:yanlai-update'
updateSession.setProxy({ mode: 'direct' })
```

并给需要的人留了 `update.useSystemProxy` 开关（默认关）。

**为什么这一条值得写进文档**：这不是「优化」，而是**功能能否工作**的分水岭。
如果按常规做法用默认会话，更新检查在这台机器上 100% 失败。

### 6. 工具产出：data URL 绝不内联进消息

见上文 [4(c)](#4-省-token五层上下文压缩)。单独列出是因为它同时是**正确性 bug**（渲染错乱）
和**成本 bug**（每轮数千 token）。

### 7. 存储：IndexedDB 而非 localStorage

`localStorage` 的配额约 5MB，而对话历史里含 base64 图片附件，很快超限，
且**写入失败是静默的**——用户会以为记录成功了。

`src/lib/idb.ts` 封装 IndexedDB，并提供**优雅降级**：若 IndexedDB 不可用
（隐私模式等），退回内存 Map，保证会话内应用仍可用，而不是直接崩溃。

```
object stores: kv · chats · wrongbook · flashcards · kb · chunks · stats · artifacts
```

---

## Agent 循环

`src/store/useChat.ts` 的 `send()` 是一个**多轮工具调用循环**：

```
1. 本地分类（0 token）
   ├─ 是否像「学生报告自己错了」→ 注入提示，让模型可靠地记录错题
   ├─ 知识库检索（本地 BM25）→ 组装瞬时上下文
   └─ 错题本关联 → 组装「你以前错过同类知识点」提示
2. 组装系统提示词（按模式选模块）
3. buildContext() 构建预算内载荷（五层压缩）
4. 流式循环（最多 maxToolRounds 轮）：
   ├─ streamChat() 收 delta / reasoning / tool_call delta
   ├─ 有 tool_calls → 逐个执行 → 结果回填 → 进入下一轮
   └─ 无 tool_calls → 本轮即答案，结束
5. 收尾：TTS 队列 flush、usage 记录、滚动摘要更新、会话数上限裁剪
```

**流式工具调用的拼接**：OpenAI 协议里 tool call 的 `arguments` 是**分片**到达的，
必须按 `index` 累积：

```ts
onToolCallDelta(calls) {
  for (const c of calls) {
    let slot = pending.find(p => p.index === c.index)
    if (!slot) { slot = { index: c.index, argsText: '' }; pending.push(slot) }
    if (c.id) slot.id = c.id
    if (c.name) slot.name = (slot.name || '') + c.name   // 名字也可能分片
    if (c.argsText) slot.argsText += c.argsText
  }
}
```

**参数解析容错**：模型偶尔输出带尾逗号或单引号的 JSON，`safeParse` 做两次尝试后
保留原文（`{_raw: ...}`），让工具自己报错而不是让整个对话中断。

**SSE 解析**：逐行消费，保留不完整的尾行。早期版本写过一个「按空行分割事件」的逻辑，
残留成死代码——已清理。同时容忍 `event:` / `id:` / `:` 注释行等非 `data:` 前缀。

---

## 提示词架构

`src/lib/prompts.ts` 的核心思想：**系统提示词按需拼装，不相关的模块一分钱不花**。

```
IDENTITY（身份与输出规范）
  ├─ MATH       —— 仅数学相关模式含
  ├─ WRONG_RULES—— 仅错题/讲解/复盘等模式含
  ├─ KB_RULES   —— 知识库非空时才含
  ├─ toolsModule(toolNames) —— 只描述本模式实际可用的工具
  ├─ CONCISE    —— 省 token 表达纪律
  └─ FeatureDef.instruction —— 该模式的专门指令
```

`assembleSystemPrompt()` 依据 feature 的 `modules` 与 `tools` 决定包含哪些段落。
例如「总结大纲」模式不会携带绘图规则，「作文批改」不会携带错题管理规则。

**工具描述也要省**：工具描述本身是系统提示词的一部分，每轮都计费。
所以 `tools.ts` 里每个工具的 `description` 都刻意写短，把详细说明放在参数 schema 的
`description` 里（只在需要时被模型读取）。

**为什么 feature 定义里带 `seed`**：不同模式的输入格式不同（错题分析需要题干+错解+正解），
预填模板能显著降低学生的使用门槛。

---

## 时间规划调度器

`electron/lib/planner.cjs` 运行在**主进程**，这样窗口收进托盘甚至隐藏时提醒依然工作。

**三种模式的解析**：

```js
resolveDayItems(schedule, date)
  weekly  → schedule.weekly[isoDay]
  workday → workdays.includes(dow) ? work : rest
  unified → activeDays.includes(dow) ? unified : []
```

**防重复提醒**：以 `${dateKey}:${itemId}` 为键记录已触发，跨天自动清空。

**防「补课式轰炸」**：只在目标时间点后的 **90 秒窗口内**触发。
如果应用关闭了两小时后重开，不会把错过的提醒全部弹出来：

```js
if (nowMs >= fireAt && nowMs - fireAt < 90000 && !this.fired.has(gk)) { ... }
```

`snooze`（稍后再说）单独存队列，**不受暂停状态影响**——用户明确要求延后提醒时，
暂停开关不应把它一起静音。

---

## 朗读队列

`src/lib/tts.ts` 用**队列**而非「合成完整段再播放」，这是「边输出边朗读」能工作的前提。

三种引擎统一在一个接口后面：
- `system` —— Windows SAPI 合成到 wav，再经 `<audio>` 播放（**可取消**）
- `api` —— 任何兼容 `POST /audio/speech` 的接口
- `browser` —— Web Speech API

**句子切分**：`drainSentences()` 在流式文本中切出可朗读的完整句。
这里有个实测发现：初版实现**丢弃**长度不足 8 字的片段，
导致「所以。」这类短句直接消失（后面跟长句时尤其明显）。
修复为**短句向后累积**而非丢弃，并保证增量喂入不丢字：

```
✓ incremental feeding loses no characters
```

**文本化处理**：`speakable()` 把 Markdown 和 LaTeX 转成可读中文。
`\frac{a}{b}` → 「b 分之 a」，`\int` → 「积分」，`\sin` → 「正弦」，`x^2` → 「x 的 2 次方」。
代码块整段跳过并提示「代码块已省略」。

**缓存**：同一段文本的合成结果按内容缓存（最多 80 条），重复朗读不再重新合成。

---

## 文档导出管线

`electron/lib/docs.cjs`

**Markdown → DOCX**：不引入完整 Markdown 解析器，而是自己实现覆盖学习场景的子集
（标题、列表、表格、代码、引用、强调、分隔线）。原因是完整解析器的 AST 转换层
代码量远大于收益，而学习文档用到的 Markdown 特性很有限。

产出的是真正的 `.docx`（zip + OOXML），测试里通过解压校验内容：

```
✓ docx is a zip (PK header)
✓ docx contains the title / Chinese body text / list items / table cells / code
✓ docx preserves math as text
```

**Markdown → PDF**：用 Chromium 的 `printToPDF`。建一个隐藏窗口加载打印样式 HTML，
导出后销毁。**注意**：销毁隐藏窗口会触发 `window-all-closed`，
测试脚本里必须保留一个存活窗口，否则进程会在导出中途退出。

**XSS 防护**：`buildPrintHtml` 对标题与正文转义：

```js
✓ raw HTML in markdown is escaped     # <img onerror=...> 变成 &lt;img
```

---

## 测试策略

`tests/run.mjs` 自带轻量运行器（`node` 跑逻辑套件，`electron` 跑需要 Chromium/主进程的套件），
不引入 Jest/Vitest——测试目标是最小依赖、可离线、失败即非零退出。

| 套件 | 环境 | 重点 |
|---|---|---|
| `math.plot` | node | 表达式解析、数值方法、SVG 结构 |
| `kb.context` | node | 分块、BM25 排序、token 预算、压缩正确性 |
| `export` | electron | DOCX/PDF/HTML 实际产物校验 |
| `tts` | electron | SAPI 音色列表、WAV 头、语速影响 |
| `updater` | electron | 版本比较、镜像回退、连通性 |

**测试哲学**：断言**行为**而非实现。例如不检查「是否调用了某个内部函数」，
而是检查「解压出的 docx 里有没有这段中文」。

**测试中发现的问题**：多断言最初写错了（例如用 218 字的文本去验证「长内容被打摘要」，
但摘要阈值是 420 字，根本不会触发）。修正断言时也确认了实现是对的——这本身有价值：
它证明阈值行为符合预期。

---

## 已修复的真实缺陷

以下都是**开发过程中被测试或实测抓到**的，不是预防性编码：

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | `\sqrt{9}` 等花括号无法分词 | **所有** LaTeX 风格的 `\frac`/`\sqrt` 绘图与计算失败 | 分词器增加结构化命令归一化 |
| 2 | 工具轮与正文轮无分隔符 | `## 标题` 渲染成字面文本，Markdown 结构丢失 | 轮次间插入 `\n\n` |
| 3 | 图表 data URL 内联进 content | 每轮多计约 6000 token；且污染 Markdown | 改为只走 `artifacts`，绝不进 content |
| 4 | NSIS 安装包与 portable 同名 | portable **静默覆盖**了安装包 | 两个 target 分别指定 `artifactName` |
| 5 | `1.0.00` 被 semver 规范化 | 安装包文件名变成 `1.0.0`，与界面显示不一致 | 通过 `APP_VERSION` 环境变量传递 |
| 6 | `drainSentences` 丢弃短句 | 「边输出边朗读」漏读句子 | 短句向后累积而非丢弃 |
| 7 | 摘要回退策略过于激进 | 反复出现的正文被带回，压缩率下降 | 仅无结构时才回退到句子抽取 |
| 8 | 工具轮单独剥离 tool 消息 | 违反 API 契约，请求被拒 | 按整轮处理 + 孤儿消息清理 |
| 9 | 更新检查继承系统代理 | 全部请求 `ERR_CONNECTION_CLOSED`，功能完全不可用 | 独立 session + `direct` 模式 |
| 10 | 窗口帧与自绘标题栏重叠 | 出现两条标题栏 | Windows/Linux 用 `frame: false` |

---

## 后续可做

- **向量检索叠加**：在 BM25 之上加可选 embedding 重排，保留纯本地路径作为默认
- **错题图片**：支持给错题附加题目截图
- **导出错题本**为可打印的 Word / PDF 复习册
- **多模型分工**：便宜模型做检索整理，强模型做难题讲解
- **云同步**：端到端加密的进度同步（目前刻意保持纯本地）

---

[← 返回 README](../README.md)
