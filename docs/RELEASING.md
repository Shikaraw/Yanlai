# 发布流程

本文档说明如何发布一个新版本，以及**为什么发布必须在 GitHub Actions 上执行**。

---

## 为什么不能在本机发布

开发机此前处于受限网络，历史实测结论如下（2026-10-10 发布执行时，正常 SSH 与无鉴权 GitHub API 读取已连通；认证发布仍由 Actions 完成）：

| 通道 | 结果 |
|---|---|
| 直连 `api.github.com` / `github.com` / `uploads.github.com` | 全部不可达 |
| 系统代理（FlClash :7890） | 上游节点不可用，国外站点全部超时 |
| 公共镜像（gh-proxy 等） | API **读取**正常，但会**替换 Authorization 头** |

最后一条是关键。实测把任意 token（甚至伪造的）发给镜像，`/user` 返回的都是镜像自己的账号：

```bash
# 无 token
curl -s "https://gh-proxy.com/https://api.github.com/user"        → login: aeroheaven
# 带伪造 token
curl -s -H "Authorization: Bearer ghp_totallyFake000" \
     "https://gh-proxy.com/https://api.github.com/user"            → login: aeroheaven
```

同一现象在 POST 上也成立（返回的是镜像账号的 403，而非 401）。因此：

- ✅ **可以**用镜像检查更新、读取 Release 信息（应用内更新检查正常工作）
- ❌ **不可以**用镜像创建 Release 或上传附件（你的 token 会被丢弃）
- ❌ 也不可以用镜像下载需要鉴权的私有资源

**结论**：发布走 GitHub Actions —— 它在 GitHub 自己的机器上运行，使用自动注入的
`GITHUB_TOKEN`，无需任何个人令牌，也不受本机网络影响。

---

## 发布步骤

### v2.0.00 当前准备状态（2026-10-10）

- 用户明确确认拥有尚未公开发布的 CleverCalculator，并授权公开发布集成后的源码与二进制：**发布批准与源码再分发门禁已解决**。原始源码未附独立许可证，不为 CleverCalculator 新设 MIT 许可证；CPython/SymPy/mpmath 等第三方许可证与 notices 保留并继续适用。
- 已执行既有 `npm run version:bump major`，当前版本 `2.0.00`；同步 package.json、prompt 版本、README 徽章，并单独同步 package-lock 的顶层及根 package 版本（不改依赖解析）。
- 元数据准备已完成，用户明确授权后续构建、提交、推送、打 tag 与公开发布；正式产物使用 `release/v2.0.00`，不复用或重命名旧检查包。
- 既有 `1.0.01` 检查包、大小、SHA-256 及测试结果属于历史快照，不是 `2.0.00` 发布产物。未覆盖验收项见 [V2-VERIFICATION.md](V2-VERIFICATION.md)，授权不等于全部技术验收完成。

### 1. 更新版本号

```bash
npm run version:bump patch   # 1.0.00 → 1.0.01   小改动
npm run version:bump minor   # 1.0.05 → 1.1.00   大改动
npm run version:bump major   # 1.4.02 → 2.0.00   重大改动
```

脚本会同步 `package.json`、`src/lib/prompts.ts`、`README.md`。还需同步 `package-lock.json` 顶层 `version` 与 `packages[""].version`；仅升版时保持依赖版本、解析 URL 与 integrity 不变。

### 2. 更新 CHANGELOG

在 [CHANGELOG.md](../CHANGELOG.md) 顶部加一节，写清新的版本号、日期与改动。

### 3. 本地验证

```bash
npm run typecheck
npm test
npm run build
```

### 4. 提交并打 tag

```bash
# 先创建发布分支；仅暂存经审查的应用/运行时/版本文档文件。
# 不要 git add -A：排除 .zcode、个人数据、学习资料压缩包及本地检查产物。
git switch -c release/v2.0.00
git diff --cached --check
git commit -m "发布 v2.0.00：专注监测、计划库与本地计算器"
git switch main
git merge --ff-only release/v2.0.00
git tag -a v2.0.00 -m "研来 v2.0.00"
```

> tag 名必须是 `v` + `package.json` 里的版本号。
> 例如 package.json 是 `1.0.00`，tag 就是 `v1.0.00`（**保留两位 patch**）。

### 5. 推送

优先使用正常 SSH 路由与已验证主机密钥，先检查远端不存在同名 tag，禁止 force push：

```bash
git ls-remote origin refs/tags/v2.0.00
git push origin main
git push origin v2.0.00
```

既有 `git-retry.sh` 会关闭主机密钥验证，不用于正式发布。公共代理仅可用于无鉴权公开读取，不能承载认证写入。

### 6. 等待 Actions 自动发布

推送 tag 会触发 [`.github/workflows/release.yml`](../.github/workflows/release.yml)：

1. 在 `windows-latest` 上检出代码
2. `npm ci` 安装依赖
3. 类型检查 + 测试
4. 构建前端
5. `electron-builder` 打包出安装版与免安装版
6. **自动创建 Release 并上传两个 `.exe`**

进度在仓库的 **Actions** 标签页查看，约 10-15 分钟。

> 也可以在 Actions 页面手动触发（workflow_dispatch），填入要发布的 tag。

### 7. 验证

```bash
# 确认 tag 存在
git ls-remote origin | grep <版本>

# 确认 Release 可被应用读到（应用内「检查更新」也走这条路径）
curl -s "https://gh-proxy.com/https://api.github.com/repos/Shikaraw/Yanlai/releases/latest"
```

---

## 产物命名

| 文件 | 说明 |
|---|---|
| `Yanlai-<版本>-Setup-x64.exe` | NSIS 安装版 |
| `Yanlai-<版本>-Portable-x64.exe` | portable 免安装版 |

**文件名必须是 ASCII。** 实测发现 GitHub 的「更新 Release 资产」接口对非 ASCII
文件名返回 404，首次发布时正因此在第二个资产上中断（Release 被回滚）。
应用内通过 `assetLabel()` 把 ASCII 名字映射成「安装版 / 免安装版」显示给用户。

**注意**：两个 target **必须**有不同的 `artifactName`。
早期版本忽略这点，导致 portable 静默覆盖了安装包（见 ARCHITECTURE.md）。

---

## 版本号与 semver 的冲突

`1.0.00` **不是**合法 semver，electron-builder 会把它规范成 `1.0.0`。
因此打包入口 [`scripts/dist.mjs`](../scripts/dist.mjs) 与 CI 都通过
`APP_VERSION` 环境变量传递原始版本号，`artifactName` 里用 `${env.APP_VERSION}`：

```json
"artifactName": "研来-Yanlai-${env.APP_VERSION}-安装包-${arch}.${ext}"
```

**改打包配置时不要**把 `${env.APP_VERSION}` 换回 `${version}`，否则文件名会变成 `1.0.0`，
与界面显示的 `1.0.00` 不一致。

---

## 更新检查与 Release 的关系

应用内的「检查更新」逻辑：

1. 请求 `https://api.github.com/repos/Shikaraw/Yanlai/releases/latest`（经镜像）
2. 解析 `tag_name`，与本地 `app.getVersion()` 比较
3. 若远端更新 → 弹窗，列出 `assets` 供下载

所以：

- **没有 Release 时**返回 404，应用显示「仓库中还没有发布任何 Release」而不是报错
- **有 Release 后**自动开始提示新版本
- 下载链接会**自动套用镜像前缀**，方便国内用户

**首次发布后的必要验证**：装一个 `1.0.00`，再发布 `1.0.01`，
确认旧版本能检测到并提示升级。这是唯一能端到端验证更新链路的方法。

---

## 常见问题

**Q：Actions 构建失败在 `npm ci`**
A：`package-lock.json` 与 `package.json` 不同步。本地执行 `npm install` 后提交 lock 文件。

**Q：electron-builder 下载工具链超时**
A：GitHub runner 能直连，一般不会。若确实遇到，可在 workflow 里加
`ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量。

**Q：发布步骤报 404 且 Release 被回滚**
A：几乎总是**非 ASCII 资产文件名**导致。改用 `Yanlai-<版本>-Setup-x64.exe` 这类
纯 ASCII 名称。发布脚本用的是 `gh release create`（runner 预装），
它比第三方 release action 更能稳妥处理多资产上传。

**Q：想重跑发布**
A：脚本会先删除同名 Release 再重建，保证资产完整。直接重跑 workflow 即可。

**Q：想发布 macOS / Linux 版本**
A：在 `release.yml` 里加对应 job（`macos-latest` / `ubuntu-latest`），
把 `npx electron-builder --win` 换成对应平台参数，并加到 `files:` 里。

---

[← 返回 README](../README.md)
