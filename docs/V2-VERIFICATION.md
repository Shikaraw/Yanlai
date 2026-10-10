# v2.0.00 发布准备与验证记录

记录日期：2026-10-10。记录发布准备元数据、既有本地检查产物及验证边界，不是 Release 公告。

## 当前状态与发布门禁

- 当前包版本为 **`2.0.00`**；使用既有 `version:bump major` 脚本更新 package.json、prompt 版本与 README 徽章，并同步 package-lock 根元数据。元数据准备已完成，用户明确授权并要求继续构建、提交、推送、打 tag 与公开发布；正式构建记录见下文。
- **发布批准已解决**：本次用户明确授权准备 v2.0.00 并公开发布集成后的源码与二进制；不再以此前仅确认统计功能的反馈作为待批准状态。用户已明确要求继续执行发布，但授权不等于全部技术验收完成。
- **CleverCalculator 源码再分发门禁已解决**：用户明确确认其拥有尚未公开发布的 CleverCalculator，并给予上述公开发布授权。原始源码树未找到独立许可证的事实保留，但不再作为这次集成源码/二进制发布的授权阻断；不为 CleverCalculator 新设 MIT 许可证。CPython/SymPy/mpmath 等第三方许可证与 notices 保留并继续适用，仓库 MIT 声明不自动替代它们或权利人的具体授权。
- **最新既有检查输出为 `release/v2-calculator-input-final`**，其 `npm test`、`npm run typecheck`、`npm run build` 与 portable 构建均**通过，退出码 0**，包含 211/211 真实 worker 快捷输入与 11 项 helper 测试。精确路径/大小/SHA-256 见下文；已完成隔离启动、打开即预热、闲置关闭/重开复用、快捷输入运算与侧栏/展开布局检查；其余完整桌面验收仍未全部覆盖。
- 上述旧构建与验收是**升版前 `1.0.01` 的历史检查快照**。正式 `2.0.00` 的 test/typecheck/build、NSIS 与 portable 构建已通过，精确产物记录见下一节。不得重命名旧 EXE 或复用其大小/哈希作为 v2 发布证据。
- 旧 `release/v2-inspection-ready` 的通过结果与便携版追加验收仍对当时功能有效，但不覆盖后续计算器预热/输入实现；已被最终检查快照取代。

## v2.0.00 正式本地构建

- `npm test`、`npm run typecheck`、`npm run build` 均退出码 0，包含真实 worker 输入 211/211 与 helper 11 项。
- 使用已有 Electron distribution，`electron-builder --win nsis portable --x64 --publish never -c.electronDist=node_modules/electron/dist -c.directories.output=release/v2.0.00` 退出码 0。
- 打包后的运行时逐文件大小/SHA-256、额外文件与依赖隔离检查通过：951 文件，39,600,165 字节（不含 manifest）。

| 本地构建文件 | 字节 | SHA-256 |
|---|---:|---|
| `release/v2.0.00/Yanlai-2.0.00-Setup-x64.exe` | 137,050,476 | `1df86615622bafef5950424a7b465da9472d444b733284c4d7a1171e5dbc1c59` |
| `release/v2.0.00/Yanlai-2.0.00-Portable-x64.exe` | 136,756,164 | `6bf11bcf38689505e5e4d417b5bce31b595ee23a9b2075f93c0d8ab2143654d0` |

以上是本地正式构建证据，不是 GitHub 上传资产的哈希；tag workflow 会用锁定依赖在 runner 上重新构建，公开资产需另行核验。未执行安装/卸载，不触碰已安装数据。完整输入法、GUI 取消、全部窗口尺寸与 NSIS 安装/卸载行为仍未覆盖。

## 候选功能与行为

| 功能 | 当前行为 |
|---|---|
| 保存方案 | 新建空白、另存为、保存方案/名称、选择并启用、删除；至少保留一个，删除当前方案切换到剩余方案 |
| AI 计划 | 新的未启用草稿，不覆盖当前方案、不自动启用/提醒，包括首个 AI 方案 |
| 场景复制/编辑 | 工作日与休息日互拷产生独立时段 id、名称不变、不改源场景；模板保存失败不显示成功；`isNew` 区分新增与已有项 |
| 跨夜调度 | 本地跨午夜结束、昨天跨夜进行中时段、跨午夜提前提醒；以日期/planId/时段身份防重，保存/重新启用不清空 guard，90 秒触发窗口 |
| 专注监测 | 默认关闭、主动 opt-in；仅当前启用计划的学习/复习时段；独立于提醒暂停，侧边导航显示状态 |
| 专注数据 | 最多 90 天日聚合、可选最多 2000 条且 90 天内 session；近 7 天趋势、最新 20 条切屏记录；关闭保留数据，确认清除聚合/session/未结束片段，不改开关、不删打卡 |
| 隐私边界 | 只观察研来窗口，不读取其他应用内容；不回填未观察间隔，不等同真实学习质量 |
| 计算器 | 真实右侧侧栏、可展开主区域；本地微积分/矩阵/ODE 不调用 AI；矩阵表格和原始文本；复制/插入不自动发送；会话历史最多 20 条 |
| 模式输入 | 光标/选区插入、模板包裹选区并选中主体、退格/清空、各模式草稿与示例；矩阵编辑器 1–8 行/列、单位矩阵和操作表达式生成；ODE 快捷条件最多 8 条；生成/填例均不自动计算 |

### 预热、常驻与停止

打开计算器即调用 readiness 预热内置 Python/SymPy，普通聊天启动不预热。就绪 worker 空闲常驻复用，空闲关闭侧栏/离开页面不会卸载。计算中离开会取消请求并结束 worker；取消计算结束 worker，重启结束旧 worker 再预热，真正退出应用结束 worker。最小化到托盘不是退出，空闲 worker 仍可保留。

Windows x64 内置 **CPython 3.13.12、SymPy 1.14.0、mpmath 1.3.0**，无需系统 Python，不含 Qt、numpy、matplotlib。受限 JSON worker 支持取消、超时、崩溃错误与重启；其他平台等效运行时未验证。

[内存实测与复现](CALCULATOR-MEMORY.md)：就绪时工作集 **55.04 MiB** / 私有提交 **47.62 MiB**；代表性运算后空闲 15 秒 **60.77 / 52.13 MiB**，没有自动卸载 Python/SymPy。新 worker 就绪耗时示例 **2.912 秒**，不是保证的冷启动耗时，文件/杀毒缓存未保证冷态。这是该机器单次 worker 采样，不是整个应用内存、峰值、泄漏认证或最坏运算；性能随硬件、缓存、负载和表达式复杂度变化。

### session schema 与兼容

可选 `sessions` 每条为 `{start, end, durationMs, kind, endReason}`，`kind` 是 `focused` / `outOfWindow`，`endReason` 是 `switch`、`schedule`、`gap`、`stop`。记录仅描述已观察窗口区间，不含其他应用元数据。沿用 `version: 1` 与 IndexedDB key，旧版只有日聚合仍兼容；旧 UTC 日期桶不迁移、不自动重解释为本地日期。

## 升版前计算器检查（已回报历史结果）

本次文档编辑不另行执行源码测试；以下按已回报结果记录。

| 检查 | 状态与边界 |
|---|---|
| 真实 bundled worker 快捷输入 | **211/211 通过（修正后）**；此前矩阵 `^` 与 ODE `Abs` 问题已修正并复跑。矩阵软键盘 `^` 插入 `**`，ODE 不提供 `Abs` 默认模板 |
| 输入 helper 测试 | **11 项通过**；选区/模板等纯逻辑与 live capture 加固不等于完整 GUI 验收 |
| worker 预热/生命周期回归 | 已有 `tests/calculator.test.cjs` 通过记录，覆盖共享启动、空闲复用、取消/关闭竞态、实际 bundled runtime 与 relocated packaged layout；详见内存记录 |
| 浏览器 GUI 模板 | 已观察模板主体选中替换及函数嵌套 |
| 浏览器 GUI 矩阵编辑器 | 已观察单位矩阵后点行列式生成 `det([[1,0],[0,1]])`，未自动计算 |
| 浏览器 GUI ODE 示例 | 二阶初值填入 `y''+y=0`，条件为 `y(0)=0`、`y'(0)=1` |
| 浏览器 Ctrl+A 全选包裹 | 按键组合未成功投递/未选中，**不宣称 GUI 全选包裹已验证**；不是已证明的应用失败 |
| 本轮完整 test/typecheck/build/portable | **全部通过，退出码 0**；211/211 worker 与 11 helper 纳入最终测试，输出 `release/v2-calculator-input-final` |
| 新包桌面定向检查 | **通过**：隔离启动主进程 77316；打开计算器前无 Python 子进程，打开后在首次计算前显示已就绪（worker 67708）；空闲关闭侧栏、重新打开及展开主区域后仍为同一 worker。求导示例返回 `cos(x)`；清空表达式后软键盘「定积分 ∫」生成公式并计算返回 `1/3`。矩阵编辑器生成单位矩阵，行列式按钮生成 `det([[1,0],[0,1]])` 而不自动计算，计算返回 `1`；ODE 二阶初值示例填入方程与两条条件后求解返回 `y=sin(x)`。截图检查侧栏与展开布局。通过「退出研来」正常关闭后，主进程 77316 与 Python 67708 均不再存在，便携启动任务退出码 0。未逐项覆盖全部矩阵/ODE 操作、输入法、GUI 取消或全部窗口尺寸 |
| NSIS 安装/卸载 | 未实装验证 |

## 上一轮 ready 检查快照（仍对旧功能有效）

旧 `npm test`、`npm run typecheck`、`npm run build` 和 ready portable 构建均退出码 **0**，含当时最终仪表盘修订；资源 manifest 逐文件 SHA-256/大小及额外文件检查通过。不能沿用“最终全部通过”来描述本轮新改动。

旧浏览器 GUI 标题栏/侧栏透明问题复测通过；周复制六目标且源日禁用、另存为独立方案通过。隔离开发版 Electron 已观察主区域/侧栏、实际内置 Python 积分 `x²`（0 到 1）→ `1/3`、矩阵求逆 `[[1,2],[3,4]]` → `[[-2,1],[3/2,-1/2]]`，重启后「Python 已就绪」。

### 2026-10-10 ready 便携版追加验收

在解锁环境，以独立 `inspection-user-data` 实际启动旧 ready EXE（文件未修改，无需重打包）：

- 启动/渲染通过；界面保存 00:00–23:00 学习时段，开启监测后窗口内时间累积。
- 最小化/恢复观察切屏时长、次数、饼图比例及起止时间明细；用户明确确认统计功能无问题，额外切屏来自用户操作。
- 便携版侧栏实际调用打包 Python，定积分返回 `1/3`。
- 首次关闭显示退出/托盘选择，记住选择默认未勾选。选择托盘后窗口隐藏、进程保留；再次启动同 profile EXE 恢复原窗口，第二实例退出码 0。
- 正常退出后重启 PID 改变，计划、监测偏好、非零统计及切屏次数保留。
- 未验证托盘图标双击、上课类型实际 GUI 切换、旧便携版矩阵/ODE 全流程或 NSIS 安装/卸载。交错的用户操作不构成受控精确计时/次数一致性检查。

这些结果取代旧“ready EXE 尚未启动/锁屏阻断”状态，但不能转移到本轮新包，也不表示批准发布。不得为测试解锁用户机器。

## 本地检查产物与隔离配置

### 本轮最终产物（构建与定向桌面检查通过）

- 路径：`D:/Tools/ZCode/workspace/StudyAgent/release/v2-calculator-input-final/Yanlai-1.0.01-inspection-Portable-x64.exe`。
- 最终 test/typecheck/build/portable 均退出码 **0**。
- 大小：**117,529,809 字节（112.09 MiB / 117.53 MB）**。
- SHA-256：`5A00DB0AC19F23177CD051A41A90E41F4946C5E7AB19986D1703560E53950D10`。
- 最新[启动独立检查版.cmd](../release/v2-calculator-input-final/启动独立检查版.cmd)已创建，设置绝对 `YANLAI_INSPECTION_PROFILE=%~dp0inspection-user-data` 后启动同目录 EXE。
- 已取代此前本轮 `release/v2-calculator-input` 目标及旧 ready 产物；这是本地检查包，不是发布批准。**新包定向桌面检查通过，不等于全部桌面行为已验收**。

### 上一轮 ready 文件（历史产物，已被取代）

- 路径：`D:/Tools/ZCode/workspace/StudyAgent/release/v2-inspection-ready/Yanlai-1.0.01-inspection-Portable-x64.exe`
- 构建退出码：**0**；大小：**117,525,049 字节（112.08 MiB / 117.53 MB）**。
- SHA-256：`F10FD6A293395ABA73F58BDDF9A5DC12C5C5E15A2607548C2E8250CA67FF1D6F`。
- 本地检查文件，不是发布；已被本轮最终候选取代。

旧[启动独立检查版.cmd](../release/v2-inspection-ready/启动独立检查版.cmd)及[检查说明](../release/v2-inspection-ready/检查说明.md)仅适用于上一轮候选。`YANLAI_INSPECTION_PROFILE` 必须是专用绝对目录，启动在单实例锁前设置 `userData`；启动器使用 `%~dp0inspection-user-data`，相对路径报错。**直接启动 EXE 默认使用个人数据目录**。隔离配置/数据不是 OS 沙箱。

此前旧输出 `EPERM` 经已有 Electron runtime 重试成功；旧 `release/v2-inspection-local/win-unpacked` 的 `du` 513M 是目录占用，不是安装包大小，不能断言杀毒软件是原因。较早 portable **117,523,250 字节**及 complete/final/portable 快照已被旧 ready 取代。

## 运行时资源体积

| 指标 | 字节 | 含义 |
|---|---:|---|
| manifest 文件（不含 manifest） | 39,600,110 | 校验基数 |
| 资源合计（含 manifest） | 39,772,854 | 约 37.93 MiB |
| ZIP 压缩估计 | 15,580,570 | 约 14.86 MiB，仅估计 |

以上沿用升版前资源记录，**不是新包大小或整个应用内存**；含 manifest 的体积与 ZIP 估计为授权元数据修改前历史值。本任务仅编辑 manifest 授权文本，未编辑被哈希资源。并行工作已更新 worker 授权说明及对应 manifest 校验项；当前 951 个资源文件的逐项大小/SHA-256 校验通过，`totalBytes` 为 39,600,165，manifest 为 169,055 字节，合计 39,769,220 字节。此为当前资源元数据，不是新构建安装包；历史资源体积与压缩估计不重标为当前值。源码再分发门禁已由权利人明确授权解决，不新设 MIT 许可证。

## 剩余验收与放行条件

- [x] 旧 ready 构建与上述追加便携版验收记录保留。
- [x] 修正后真实 worker 快捷输入 211/211、helper 11 项通过已回报。
- [x] 浏览器模板主体/嵌套、矩阵生成及 ODE 示例已观察，限制已记录。
- [x] 本轮最终 test/typecheck/build/portable 全部退出码 0，新包精确路径、大小、SHA-256 及隔离启动器已记录。
- [x] 隔离启动新包，完成打开即预热、同 worker 复用、快捷输入求导/积分、矩阵行列式、ODE 二阶初值、侧栏/展开布局与正常退出释放 worker 的定向验收。
- [ ] 补充未覆盖的完整输入法、GUI 取消、其他矩阵/ODE 操作、全部窗口尺寸及需要时 NSIS 安装/卸载验证。
- [x] CleverCalculator 权利人明确确认所有权并授权公开发布集成源码与二进制；源码再分发门禁已解决，不新设 MIT 许可证，保留第三方许可证与 notices。
- [x] 本次用户明确授权 v2.0.00 构建、提交、推送、打 tag 与公开发布，发布批准门禁已解决。
- [x] 正式 `2.0.00` test/typecheck/build、NSIS 与 portable 构建通过；新的大小与 SHA-256 见上文，既有 `1.0.01` 检查包不能代替。

## 相关文档

[README](../README.md) · [USAGE](USAGE.md) · [CALCULATOR-MEMORY](CALCULATOR-MEMORY.md) · [ARCHITECTURE](ARCHITECTURE.md) · [CHANGELOG](../CHANGELOG.md)
