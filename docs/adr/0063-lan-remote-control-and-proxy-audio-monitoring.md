# ADR 0063｜LAN Remote Control 與 Proxy 音效即時監聽

日期：2026-09-14
狀態：Accepted（v0.70.0）

## 決策

第一階段不建立原生 iOS App。Electron Main process 內建 Node `http` server，以 REST command + authenticated SSE state stream 提供同一 Wi-Fi 上的 iPhone Safari 控制頁。Server 預設關閉，只綁定一個私人 LAN IPv4；沒有 Internet、port forwarding、來源媒體瀏覽或任意 FFmpeg API。

`RenderCommandState` 是 Desktop IPC 與 Remote adapter 的唯一 command/state authority。Remote 只能启动 Windows 已选择输出位置、完成设置并明确「准备远端启动」的 request。Pause 只在 staged FFmpeg wave、final encode 前、audio post-process 前的 checkpoint-safe boundary 生效；先显示 `PAUSING`，绝不 OS suspend 或直接操作 FFmpeg process。断线只移除 SSE client，Windows render 继续；重连先发送最新 revision snapshot。

配对凭证是 256-bit random、十分钟、单次使用，位于 QR URL fragment，HTTP 请求与 referrer 不会携带。兑换后使用 HttpOnly、SameSite=Strict、限定 Path 的短效 session cookie，JavaScript 另持有 CSRF secret；Host 与 Origin 必须精确匹配实际绑定 IP/port，remote address 必须是私人 LAN，另有 body 上限、rate limit、session idle/absolute expiry、CSP、no-store。Cancel 需要先取得 30 秒单次 nonce，再提交明确 `CANCEL`；server stop/restart 会清除 session 并旋转 pairing。

音效试听沿用 v0.69 `AudioPreviewService`，画面只复用既有 H.264 proxy，不为音效参数重新 Encode。使用者选择素材并把 proxy 播放头移到目标位置后，App 从唯读高品质来源建立当前位置前 5 秒起、最多 20 秒的 M4A audio cache。Audio cache key 包含来源 size/mtime、asset、timeline revision、range、完整 DSP 参数和 previewer version；临时档 atomic finalize，Renderer 以 sequence + AbortController 执行 debounce/latest-request-wins。

Proxy video 是播放主时钟；隐藏的 A/B audio element 跟随 currentTime，漂移超过 120 ms 才校正。Original／Enhanced 或 5.1→Stereo compatibility monitoring 切换保持同一播放头。Preview cache 永不进入 final output；正式输出仍从原始高品质 audio master 执行处理。Cache 上限 2 GiB、TTL 七天，并在启动和每次建立后执行 LRU 清理。

## 已知边界

- SSE 是 WebSocket 的单向等效实时状态通道；控制命令走 REST，符合第一阶段需求且减少额外 server framework。
- 单一 monolithic FFmpeg 工作执行中没有安全即时 Pause 点；可能维持 `PAUSING` 到该工作结束或进入下一安全边界。
- 5.1 双声道试听仍是明确标示的 compatibility downmix，不宣称 HRTF/binaural。
- 当前快速试听针对一支所选素材及其来源时间，不等同整条多素材／BGM timeline 的实时混音引擎。
- 外网控制未来只考虑 VPN／Tailscale 型安全网络，不直接提供 port forwarding。
