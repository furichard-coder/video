# ADR-0066｜QSV 模糊填边色度安全与成功后电源动作

日期：2026-09-15

## 问题与证据

实际受影响输出 `C:\大雪山\output\SceneryWalker_preview_20260915_0022.mp4` 的末段可稳定重现：中央 upright portrait正确、左侧blur正常、右侧blur呈高饱和绿色。8910秒附近的signalstats量测为左侧 `SATAVG≈2.4`、右侧 `SATAVG≈72–74`。来源 `VID_20260718_090633.mp4` 是H.264 3840×2160/yuv420p/BT.709，Display Matrix -90°；其canonical软件帧与来源hash正常。

v0.72高速leaf stage使用 `QSV decode → hwdownload NV12 → transpose → split → background scale/crop/boxblur + foreground scale → overlay → QSV encode`。FFmpeg可以成功退出，既有硬解fallback只处理错误码，因此无法发现仅一支filter branch的UV视觉损坏。短、单工作QSV不保证重现，实际长片分段输出及其色度统计是回归基准。

## 决策

1. 需要明确Display Matrix旋转且输出需要blurred-fill的输入不使用QSV/CUDA hardware decode，改用CPU decode并只执行一次canonical orientation；stage仍使用选择的hardware encoder。
2. 其他hardware decoded frame在进入任何split/boxblur前，从下载所需NV12明确转成planar yuv420p。
3. bump orientation normalizer、preview/clip cache与render signature。不得重用旧错误中继。
4. 实际修正样本采用CPU decode＋QSV encode，输出640×360/SAR1:1/DAR16:9，无rotation side data；右侧不再出现高饱和绿色，来源SHA-256保持 `0CCB6ABA1DB42E2900039B59474BC017B391360ACCD97DA7073403EAA0C4EC39`。

## 电源动作安全决策

- 默认关闭；启用时只接受固定trigger/action枚举。
- Render必须未取消且完成output validation；YouTube必须取得有效video result，若请求thumbnail则thumbnail也必须成功。
- Main process执行60秒倒数，Renderer可取消；新render/upload、busy guard或App明确关闭会取消。
- shutdown使用固定`shutdown.exe`参数；Hibernate使用固定`shutdown.exe /h`；Sleep使用固定PowerShell `SetSuspendState(Suspend)`脚本。全部以`shell:false`执行，不接收Renderer command字符串。
- 自动测试只使用注入executor/clock，不执行关机、休眠或睡眠。

## 限制

浏览器拖放交接无法可靠知道YouTube何时真正上传成功，因此YouTube触发只适用于App内官方API流程。Windows若禁用休眠或系统政策阻止睡眠，动作会显示失败，不会改用其他电源动作。
