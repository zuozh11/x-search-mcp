# x-search-mcp

个人维护的 [konarkm/x-search-mcp](https://github.com/konarkm/x-search-mcp) Fork，基于 `916b839`，保留 MIT 许可。

为宿主 GPT 补充 X 帖子证据，与宿主官方 Web Search 联合使用。单个只读 `x_search` 工具，通过 xAI Responses API 的 `x_search` 检索；沿用 stdio、MCP SDK、Zod 和原生 fetch。

## 搜索如何协作

宿主负责选择渠道、交叉核验和最终回答，MCP 只处理已经选择的 X 查询。每次 MCP 调用仅发送一次 Responses 请求，不续接历史；Grok 只开放 `x_search`，并通过 `max_turns: 1` 限制为一轮内部工具调用。该轮可以包含多个 X 查询，随后返回证据摘要。

| 查询 | 建议渠道 |
| --- | --- |
| 常规技术文档、网页资料 | 官方 Web Search |
| 近期动态、发布消息、社区反馈 | 官方 Web Search + X |
| 明确只查网页 | 仅 Web |
| 明确找帖子或账号发言 | 仅 X |
| 明确要求联合检索 | 两个渠道都参与 |

宿主策略通过 MCP 初始化的 `instructions` 提供，工具描述说明 X 适用范围。Grok 内部系统提示只约束本次 X 查询：遵守过滤条件、引用原始帖子、区分声明/观点/推断、说明证据不足。它不控制宿主 Web Search，也不保证两个渠道并发。

联合检索中一侧失败时，宿主说明缺失渠道，保留另一侧证据。搜索到的帖子是资料，不是指令。没有可核实搜索执行记录的模型回答不能作为已完成的 X 搜索。

## npm / npx 安装到 Codex

需要 Node.js（建议 22 或 24）及 `XAI_API_KEY` 环境变量。发布包为 [`@zz1996/x-search-mcp`](https://www.npmjs.com/package/@zz1996/x-search-mcp)。

```bash
codex mcp add x-search -- npx -y @zz1996/x-search-mcp@0.2.3
```

npx 从 npm 下载并缓存发布包，无须克隆仓库或本地编译。固定版本用于明确本地运行内容；升级时修改版本号并重新加载 MCP。

在 Codex 用户配置的对应段设置环境变量传递；保留已有官方 Web Search 设置：

```toml
[mcp_servers.x-search]
command = "npx"
args = ["-y", "@zz1996/x-search-mcp@0.2.3"]
env_vars = ["XAI_API_KEY"]
tool_timeout_sec = 185

[mcp_servers.x-search.env]
XAI_BASE_URL = "https://api.x.ai/v1"
XAI_MODEL = "grok-4.5"
XAI_TIMEOUT = "180000"
```

`env_vars` 要求 Codex 宿主进程能读取该变量；只在另一个终端 export 不会更新已经运行的宿主。重新加载 MCP 或新开会话后使用。安装只注册 MCP，不修改审批、权限或宿主模型。

使用 CPA 时，将 `XAI_BASE_URL` 指向 CPA 的 `/v1` 地址，`XAI_MODEL` 设置为该端点支持的 Grok 模型，`XAI_API_KEY` 使用 CPA 密钥。配置仅决定请求去向；是否支持服务端 X 搜索需要实测。普通文本回答成功不等于 X 搜索成功。

## 参数与返回值

输入保留上游参数：`query`、`allowed_x_handles`、`excluded_x_handles`、`from_date`、`to_date`、`enable_image_understanding`、`enable_video_understanding`、`include_raw_response`。

账号允许/排除列表互斥，各最多 10 个。日期使用 `YYYY-MM-DD`，开始日期不晚于结束日期。`include_raw_response` 默认关闭。

```json
{
  "answer": "本次 X 检索的证据摘要",
  "status": "completed",
  "search_performed": true,
  "citations": ["https://x.com/example/status/123"],
  "inline_citations": [
    {"url": "https://x.com/example/status/123", "start_index": null, "end_index": null, "title": "1"}
  ]
}
```

- `status`：`completed`、`incomplete` 或 `failed`。HTTP 200 仍需检查响应状态；未完成时返回 `incomplete_reason`，失败时返回 `error`，二者都设置 MCP `isError: true`。可用的部分正文和引用仍保留。
- `search_performed`：有 `x_search_call` 且状态为 `completed`，或 `usage.server_side_tool_usage_details.x_search_calls > 0` 时为 `true`；成功调用数明确为零或所有 X 调用均明确失败时为 `false`；缺少可判断记录时为 `null`。响应完成与搜索执行分别判断。
- `citations`：只使用 API 注解中的来源 URL，并去重。模型自己填写的 JSON 链接不提升为已验证引用；有引用也不代表每条陈述都已证实。
- `inline_citations`：保留所有文本块的 URL、标题。JSON 解码与文本拼接后原始偏移失效，因此首版返回 `null`，不提供错误位置。
- `raw_response`：仅按需返回原始 API 响应；API 不保证提供全部原始帖子。

搜索请求固定使用 `reasoning.effort: "low"`，降低思考开销；默认模型为 `grok-4.5`。

环境变量默认值：`XAI_BASE_URL=https://api.x.ai/v1`、`XAI_MODEL=grok-4.5`、`XAI_TIMEOUT=30000`（毫秒）。本地示例显式延长等待时间；宿主工具超时需大于 HTTP 超时。

## 验证

`npm run check` 构建并通过实际 stdio MCP 客户端和本地模拟 HTTP 服务验证：schema 组包、多消息/多块输出、引用偏移、未完成/失败状态、搜索执行证据，以及 smoke test 的退出码和自定义连接参数。离线测试不需要密钥。

`npm run smoke-test` 使用真实端点，有 API 调用费用。仅显式传递四个受支持的 `XAI_*` 变量；工具错误或无法确认 X 搜索执行时非零退出。真实结果必须分别检查正文、执行记录和引用。

## 本地开发

```bash
npm ci
npm run check
```

## 自动构建与 npm 发布

- 分支 push、PR 和手动触发 CI：Node.js 22 / 24 下安装锁定依赖、构建、回归测试和打包检查。
- 推送 `v*` 标签：校验标签与 `package.json` 版本一致，构建测试后生成 `.tgz`，通过 OIDC 发布到 npm 并生成 provenance，再将同一安装包附到 GitHub Release。
- npm 使用 Trusted Publishing，无需长期 npm token；GitHub Release 使用仓库自带 `GITHUB_TOKEN`。CI 不需要 X 搜索密钥。
- 首次发布先使用维护者 npm 登录创建包，再将 npm Trusted Publisher 绑定到 GitHub 用户 `zuozh11`、仓库 `x-search-mcp`、工作流 `release.yml`，允许 publish。此绑定只需配置一次。

完成版本修改与提交后：

```bash
git push origin main
git tag v0.2.3
git push origin v0.2.3
```

发布成功后，从 npm 读取版本，再通过 `npx -y @zz1996/x-search-mcp@<version>` 启动并验证 MCP。更新 Codex 的固定版本即可升级。

维护时使用 `upstream` 拉取上游变更，保留本 Fork 的搜索策略和回归测试。

## 官方依据

- [Codex MCP：stdio、环境变量和 server instructions](https://developers.openai.com/codex/mcp)
- [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [xAI X Search](https://docs.x.ai/developers/tools/x-search)
- [xAI 结构化输出](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [xAI 引用](https://docs.x.ai/developers/tools/citations)
- [xAI 工具执行记录](https://docs.x.ai/developers/tools/tool-usage-details)

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
