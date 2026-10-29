# DSH ElevenLabs Voice

为 DeepSeek Harness Desktop 提供按钮录音、Scribe 批量转写和手动回答朗读。按照统一语音需求 V1.4 实现第一阶段：**Core + DSH Voice**。Pet Voice 仅预留同包扩展位置，实时对话属于第二阶段。

## 使用

1. 在 Windows 中设置 `ELEVENLABS_API_KEY`，完全退出并重新启动 DSH。插件只读取宿主进程的环境变量，不读注册表，不提供密钥输入框。
2. 打开 **DSH 设置 → ElevenLabs Voice**，填写自己的 **Voice ID**，保存。默认 STT 为 `scribe_v2`，TTS 为 `eleven_v4`；可手动填写其他可用模型，例如 `eleven_v4_turbo`。
3. 输入框旁点击 🎙 开始录音，再次点击结束。默认最多 300 秒，到时自动结束并转写。浮层提供计时、音量反馈、结束及取消。
4. 转写插入当前光标或替换选区，发送前可编辑。默认**不自动发送**。无有效语音、取消或失败时不提交。
5. 点击回答旁的 **朗读**，或选中该回答的部分正文后点 **朗读选中内容**。播放器支持暂停、继续、停止、重播、音量和段内进度。

设置页提供录音测试和声音试听。试听、转写均会消耗 ElevenLabs 账户额度。术语表会产生额外费用，具体按官方计费规则执行。

### 安装

下载 GitHub Release 的 `.tgz`，通过 DSH 插件安装入口导入，或使用 DSH CLI：

```powershell
dsh plugin --profile desktop add C:\Downloads\dsh-elevenlabs-voice-1.0.0.tgz
```

开发安装：

```powershell
git clone https://github.com/ThirvenGree/dsh-elevenlabs-voice.git
cd dsh-elevenlabs-voice
npm ci
npm run build
dsh plugin --profile desktop add "file:C:/path/to/dsh-elevenlabs-voice"
```

安装后重启 DSH。某些版本的 CLI 会复制本地包而不是建立链接；修改源码后需要重新安装或使用自己的部署脚本同步构建产物。卸载仅移除本插件，不修改 Agent、BrowserSkill、角色、记忆、工作区或历史记录。

## 插入与会话规则

- 转写**完成时**读取原生输入框光标、选区和草稿版本，通过原生 `captureInsertion` / `insertText` 插入，保持一次撤销边界和引用对象。
- 未聚焦的草稿追加到末尾。接缝两侧都是汉字时不补空格，否则补一个空格；已有空白不重复补。
- 录音中切换会话会结束录音并上传，结果始终属于原会话。能够访问原输入壳时写回原草稿；壳已卸载时保留文本，提供复制和手动插入当前会话。
- 原会话已删除时丢弃结果。跨会话返回**绝不自动发送**。
- 录音测试只展示结果，不插入、不自动发送。

## 朗读、缓存与隐私

只取 DSH 会话投影中对应回答的 `text` 块，排除推理、工具调用、工具日志、系统消息；不从整页抓取内容。选区必须位于同一回答所在的聊天轮次内，并能匹配其可见正文。

Markdown 先转换为适合朗读的文字；长回答按句段分块，逐段请求。没有摘要模型、额外润色模型、自动朗读、快捷键、SSML、语速或风格滑块。

音频仅保存在当前客户端内存中，按 **会话 + 文本 + Voice ID + 模型 + 输出格式** 缓存，最多 64 段 / 64 MiB。缓存命中直接重播；改变模型或声音重新生成。刷新、关闭或禁用插件会清除缓存。原始录音和音频不写磁盘。测试生成的音频不随代码发布。

非敏感配置保存在 `$DSH_HOME/elevenlabs-voice/config.json`，默认 DSH_HOME 为用户目录下的 `.dsh`。连接诊断只返回环境变量是否存在、请求编号和请求模型，不返回密钥，也不保存转写原文或请求正文。服务端没有返回模型确认头时，诊断不会把请求模型伪装成已确认模型。

本机接口检查 loopback Host、实际端口、对端地址、Origin 和 CSRF token，防止跨站或 DNS 重绑定请求。请求设超时和并发上限；禁用或卸载会取消运行中的服务调用和音频资源。代理仅支持显式填写本机 HTTP 代理，不接受远程代理或嵌入凭据。

## 连接故障

- 缺少环境变量：设置后需要完全重启 DSH，正在运行的进程不会自动继承。
- 无效 key 与缺少权限分别显示；模型列表接口缺少读取权限不等于 key 无效。可手动试听验证 TTS。
- API key 需要有对应 STT / TTS 权限，声音也必须属于账户可用范围。余额、频率限制、网络错误及超时分别提示。
- 麦克风权限须由用户在系统 / 浏览器中授予；输出设备切换依赖浏览器 `setSinkId`，不支持时使用系统默认。

## 扩展结构

`src/core.js` 管理 ElevenLabs API、取消、错误和请求回执；`src/host.js` 提供受保护的本机接口及可选的原生 Speech Provider 注册；`src/client.js` 管理 DSH 插槽、录音、插入及播放；`src/shared.js` 放置配置校验及纯函数。

Pet 的能力声明固定为 `petVoice:false`，设置 `pet.enabled:false`。后续在同一个包内加入独立的 Voice ID、LLM、会话和实时音频模块，共用环境变量与 API 层；不需要另装一套语音插件。本版本不会开始 Pet 录音或改变现有 Pet 插件。Speech Engine 公网入口方案待第二阶段确定。

## 开发与验证

```sh
npm ci
npm run check
npm run build
npm test
npm pack
```

测试覆盖当前光标插入、选区替换、一次撤销调用、取消及延迟授权资源释放、跨会话归属及禁止自动发送、录音时限、空语音、不点击不合成、缓存重播、正文过滤、错误类型、上传限制和本机请求保护。原生界面和账户实测记录见 [ACCEPTANCE.md](ACCEPTANCE.md)。测试不会调用真实 ElevenLabs。

官方参考：[模型](https://elevenlabs.io/docs/overview/models)、[批量 STT](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)、[TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[关键词约束及计费](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting)。可用模型及额度取决于账户。
