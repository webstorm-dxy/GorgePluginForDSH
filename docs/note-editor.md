# 判定线音符编辑器（Judgement-line note editor）

`client.js` §15.5 的竖向音符编辑器：一条轨道（判定线）作为一列时间轴，横向是
note 的 `position`，纵向是 `hitTime`，判定线是编辑/起播位置，最左侧显示音频频谱。
它只是同一份谱面数据的另一个视图：所有编辑仍走现有的 `add` / `patch` ops，不改变
Host、`.g` 编解码或元素模型。

## 1. 入口与退出

| 入口 | 条件 |
|---|---|
| 双击轨道条 | 选择工具（`V`）下，命中 lane 元素的条带 |
| 双击轨道条左侧标签区 | 任何工具下都可以（条带前 ~110px；其余部分保持双击放置） |
| 双击轨道行的名称栏 | 任何工具下都可以 |

- 编辑器以绝对定位覆盖 `.dgc-center`，时间轴保持挂载；返回后 `t0` / pps / scrollY
  不变。
- “返回时间轴”按钮或 `Esc` 退出；`Esc` 先清空选择，再退出。
- 打开时清空全局选择、把 `activeStaff` 设为该谱表。**打开不会 seek transport**：判定线
  直接落在当前 playhead 上（不会跳到轨道开头）。曲线面板打开时不能进入音符编辑器
  （先应用/取消草稿）；反过来打开曲线面板会关闭本编辑器。播放预览层在其上方，关闭
  预览后回到本编辑器。
- 判定线是编辑器自己的时间视图：滚轮/拖动频谱只移动它；按播放（Space、走带播放键、
  播放预览）时先 seek 到判定线再开始，因此修改时总是从当前判定线处播放。播放期间
  判定线跟随走带；走带上的显式定位（回到开头、走带条、方向键、左侧定位）也会同步
  判定线。
- 轨道被撤销删除、项目切换/重载时自动关闭。

## 2. 几何

canvas 尺寸为 `w × h`，`floor` 到整数；默认 pps = 160。

```text
spectrumW = clamp(round(w * 0.08), 34, 54)     // 最左频谱条
rulerW    = clamp(round(w * 0.06), 28, 46)     // 节拍数字栏
rightPad  = clamp(round(w * 0.03), 10, 18)
left      = spectrumW + rulerW
laneW     = w - left - rightPad
judgeGap  = clamp(round(h * 0.12), 48, 112)    // 判定线距底部
judgeY    = h - judgeGap
chipW     = clamp((2.0 / 11.5) * laneW, 36, 156)   // note 贴图世界宽 2.0
x(pos)    = left + (pos + 5.75) / 11.5 * laneW
y(t)      = judgeY - (t - viewAnchor) * pps        // 未来在上
```

- 横向范围 ±5.75 世界单位；列线每 0.5，中心 0 与 ±5 加粗；位置吸附到 0.5 格
  （与时间吸附共用工具栏开关，Alt 临时关闭），并 clamp 到 ±5.5。
- 时间吸附复用主时间轴的 `snapTime`：`secondsPerBeat = 60 / bpm`，原点为
  `tempo.offset`，细分由工具栏的 1/1…1/16 决定。
- 节拍线按细分绘制；整拍加粗，每 4 拍最粗。数字每 1/2/4 拍视缩放抽稀
  （`beatPixel >= 130` 每拍、`>= 64` 每 2 拍、否则每 4 拍）。
- 判定线固定在 `judgeY`；`viewAnchor` 是它所在的图表时间。左侧显示
  `判定线 · 时间 · ♪拍`。暂停时 `viewAnchor` 由滚轮/频谱自由改变；播放时它等于
  `transport.time`（判定线跟随走带）；播放键会先 `seek` 到它。
- 时间轴向上，因此向上滚轮（`deltaY < 0`）把判定线移向 **更晚**的时间（时间值
  增大），向下滚轮移向更早；与画面内容移动方向一致。

## 3. 数据映射

| 视图 | 字段 | 说明 |
|---|---|---|
| 横向位置 | `fields.position`（`VariableFloat.baseValue`） | 缺省 0；无该字段时水平拖动会写整个 typed `position` |
| 纵向时间 | `fields.hitTime` | 绝对时间 `element.start`；写回时减去该元素所属 period 的 `timeOffset` |
| Hold 长度 | `fields.holdTime` | 引擎默认 1；编辑器最小 0.05s 或一个吸附步长 |
| 轨道 | `fields.name` | 本视图只聚合该 staff 内同名 lane 的 note/hold |
| 轨道有效窗口 | `generateTime … + keepTime` | 窗口外的音符半透明（可能不参与播放） |

- 创建目标 period：优先“覆盖点击时间的同名 lane 元素”的 period，否则
  `pickPeriod(project, staffId, absTime)`。
- 新建字段来自 `fieldsForNewElement(catalog, type)`，再覆盖 `laneName` /
  `hitTime` / `position` / `holdTime`。
- 数字统一 `round(..., 6)`；时间/位置在提交时 clamp（绝对时间 ≥ 0，位置 ±5.5）。

## 4. 绘制

1. 背景。
2. 最左频谱条：读取 `waves[clip.file].spectrum` 与
   `spectrumCanvasFor(spectrum)` 缓存；按可见时间区间取每个 clip 的列范围，
   用 `translate + rotate(-90°) + drawImage` 旋转到竖条。缓存 canvas 不可用时
   按 `spectrum.data` 粗采样；再退化为波形；都不可用时显示
   `频谱计算中…` / `频谱不可用`。
3. 轨道有效时间窗口：淡蓝底 + 上下虚线。
4. 横向位置列 + 边框。
5. 节拍线（裁剪在 lane 区）。
6. 左侧节拍数字（裁剪在 ruler 槽）。
7. Hold 体（夹在头/尾之间的圆角竖条 + `innerNotes` 刻度）。
8. note chip：2.0 世界单位宽的圆角长条，颜色取 catalog；Tap/Hold 中心菱形，
   Drag 两端箭头，Taplik 中心星形；选中白描边；窗口外 0.42 alpha。
9. 放置 ghost（45% alpha、白色虚线描边）与框选矩形。
10. 顶部位置刻度、判定线、悬浮提示、空状态。

## 5. 交互

| 手势 | 行为 |
|---|---|
| 点/拖频谱或节拍栏 | 定位 transport 与判定线（拖动持续 scrub） |
| 滚轮 | `- deltaY / pps` 秒滚动判定线（不改变 transport；播放中会先暂停） |
| Ctrl/Cmd + 滚轮 | 缩放 pps（40…900，判定线锚定） |
| `Q` / `W` / `E` / `R` | Tap / Drag / Taplik / Hold 工具 |
| 点击空白（放置工具） | 在吸附点创建；松开时一个 `add` |
| 按下后上下拖动（Hold） | 头固定在按下点，拖出 `holdTime`；单击默认 1 拍 |
| 选择工具点音符 | 选中；Shift/Ctrl/Cmd 追加 |
| 拖动音符 | 同时改 `hitTime` 与 `position`（吸附；Alt 关闭） |
| 拖 Hold 尾部 | 只改 `holdTime` |
| 空白拖动 | 框选 |
| `Delete` | 删除选中音符 |
| `↑` / `↓` | 时间微调一个吸附步长（Shift ×4） |
| `←` / `→` | 位置微调 0.5（Shift 1.0） |
| `+` / `-` / `0` | 放大 / 缩小 / 重置 pps |
| `Ctrl/Cmd+A` | 选中本轨道全部音符 |
| `Esc` | 先清空选择，再退出 |

- 打开编辑器与滚动判定线都不会移动 transport（回归：进编辑器/滚轮不再让播放跳回
  开头）。
- 播放键（Space / 走带 / 播放预览）在编辑器打开时先 seek 到判定线再播放（回归：
  修改时从当前判定线起播，而不是从头）。主界面（编辑器关闭）则从播放头起播。
- 开始移动/创建时若正在播放会暂停，避免坐标随 transport 变化。
- 创建后保持当前放置工具并选中新音符，方便连续打谱。
- 所有手势一次 `session.edit`，因此撤销/重做与时间轴一致。

## 6. 产生的 op

```js
// 新建
{ op: 'add', staffId, periodId, element: { id, type, fields } }

// 移动（绝对 start 按元素自己的 period 换算）
{ op: 'patch', elementId, path: ['hitTime'], value }
{ op: 'patch', elementId, path: ['position', 'fields', 'baseValue'], value }
// 原元素没有 position 时：
{ op: 'patch', elementId, path: ['position'], value: { t:'obj', type:'GorgeFramework.VariableFloat', fields:{ baseValue } } }

// 改 Hold 长度
{ op: 'patch', elementId, path: ['holdTime'], value }
```

## 7. 测试钩子

`clientPlugin.__noteEditor`（不可枚举）：

- `layout(width, height)`、`positionToX`、`xToPosition`、`timeToY`、`yToTime`、
  `snapPosition`、`toolForKey`
- `buildLaneEditorModel(project, staffId, laneName)`
- `positionOf`、`positionPatch`、`holdTimeOf`、`pickLanePeriodId`

`tests/client-smoke.mjs` 的 fixture 模式会：双击轨道条打开；检查频谱标题、
判定线标签与节拍数字；依次用 Q/W/E/R 创建四种 note；拖动一个 note 断言
`hitTime` + `position` patch；拖 Hold 尾断言 `holdTime`；框选删除；Esc 与返回
按钮；再用“放置工具下的标签区双击”和“名称栏双击”重新打开。`GORGE_SMOKE_REAL=1`
模式验证真实项目/真实 catalog 下的页面渲染不抛错。

## 8. 约定与限制

- 时间方向：未来在上、判定线近底部（仓库既有 rpe-next 约定）。如需反向，只需
  改 `noteTimeToY` / `noteYToTime` 和判定线位置的几何常量。
- 判定线是编辑/起播位置：滚轮只滚它，播放时先 seek 到它；点击/拖动频谱、节拍栏会
  同时定位 transport。主界面（无编辑器）的播放键仍从走带播放头开始。
- 横向固定 ±5.5；超出部分被裁剪。真实 corpus 的 note `position` 约 -5…5。
- `position` 的 `variationCurve` 在编辑器中不参与定位（按 `baseValue` 显示）；
  Inspector 仍可编辑完整曲线。
- 轨道有效窗口外的音符会显示但半透明；播放绑定还受 `leadTime` 影响，本视图
  不模拟 `Environment.FindAliveLane`。
- 频谱复用客户端缓存 STFT，不新增分析或 Host 端点。
