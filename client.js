/**
 * Dremu 谱面工坊 — browser half of the `@local/gorge-chart-studio` bundle.
 *
 * Registers a "Dremu 谱面工坊" entry in the sidebar panel list and a full-page
 * chart studio in the `main` panel: a timeline editor for Gorge/Dremu `.g`
 * staff files (the format used by the Deenty/Gorge rhythm game).
 *
 * Editing model follows rpe-next (Re:PhiEdit Next): horizontal time axis with a
 * snapping beat grid, multi-select, a property inspector with per-field editors
 * and a docked, beat-aligned curve panel, undo/redo, and audio playback. A
 * lane strip can also open a vertical judgement-line note editor: horizontal
 * note position, vertical time with a BPM beat grid, a fixed judgement line and
 * a left-hand spectrogram (see §15.5).
 *
 * The Host half owns the project (parsing/serializing `.g`, saving to disk,
 * revisions, agent tools). This half mirrors it over
 * `/plugins/gorge-chart/state` + SSE and pushes edits optimistically with
 * `{ baseRev, ops }`; when the Host reports a revision this tab did not produce
 * (an agent edit), it refetches the whole state.
 *
 * Everything is plain browser JavaScript: no Harness client package is
 * imported, styling uses `--dsw-alias-*` theme tokens, and the stylesheet is
 * rendered by the page component so unmounting removes it.
 *
 * The bundle loader serves exactly one client module per package, so this half
 * stays one file. It is organized as numbered sections; jump to them with
 * "NN ·" (search for `// 07 ·` and so on):
 *
 *   01 locale dictionaries        11 left pane
 *   02 small utilities            12 inspector
 *   03 curve sampling             13 transport bar
 *   04 optimistic op application  14 timeline layout model
 *   05 stylesheet                 15 timeline canvas
 *   06 host bridge (HTTP + SSE)  15.5 note editor
 *   07 audio (waveforms + clips)  16 open-project dialog
 *   08 UI primitives              17 playback scene
 *   09 generic value editor       18 page assembly
 *   10 curve editor panel         19 sidebar panel icon
 *   11 left pane                  20 client plugin entry
 */
window.__ModuleLoader__.load({
  id: '@local/gorge-chart-studio',
  factory(require) {
    'use strict';

    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const NS = 'gorgeChart';
    const PANEL_ID = 'gorge-chart';
    const API = '/plugins/gorge-chart';
    const STATE_URL = API + '/state';
    const EDIT_URL = API + '/edit';
    const EVENTS_URL = API + '/events';
    const OPEN_URL = API + '/open';
    const CREATE_URL = API + '/create';
    const SAVE_URL = API + '/save';
    const EXPORT_URL = API + '/export';
    const FILE_URL = API + '/file';
    const PROJECTS_URL = API + '/projects';
    const RELOAD_URL = API + '/reload';
    const IMPORT_AUDIO_URL = API + '/import-audio';

    // Timeline geometry.
    const RULER_H = 26;
    const WAVE_H = 44;
    const ROW_H = 34;
    /** Collapsible staff (谱表) header row above each group of lanes. */
    const GROUP_H = 25;
    const GUTTER_W = 148;
    const NOTE_R = 6;
    const MIN_PPS = 1.2;
    const MAX_PPS = 900;
    const PPS_DEFAULT = 46;
    const SNAP_DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16];
    /** Playback speeds offered by both transport bars. */
    const RATE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    const MAX_HISTORY = 200;
    /** localStorage key for the waveform/spectrum strip preference. */
    const WAVE_MODE_KEY = 'gorge-chart:wave-mode';

    /** Read the persisted audio-strip mode (`wave` or `spectrum`). */
    function readWaveModePreference() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          return window.localStorage.getItem(WAVE_MODE_KEY) === 'spectrum' ? 'spectrum' : 'wave';
        }
      } catch (error) {
        /* private mode / blocked storage: fall back to the waveform */
      }
      return 'wave';
    }

    /** Palette used when a catalog entry has no colour of its own. */
    const FALLBACK_COLORS = ['#38e8c4', '#7c8cff', '#ffd166', '#ff7ab6', '#8bd450', '#f4845f', '#a78bfa', '#4dd0e1'];

    // ========================================================================
    // 01 · Locale dictionaries (registered through the Client locale service).
    // ========================================================================

    const zh = {
      panel: 'Dremu 谱面工坊',
      title: 'Dremu 谱面工坊',
      subtitle: 'Gorge / Dremu .g 谱表编辑器',
      openProject: '打开项目',
      openProjectPlaceholder: '项目目录绝对路径，或 “谱面库” 中的名称',
      open: '打开',
      newProject: '新建项目',
      newProjectHint: '创建一个全新的谱面工程目录：写入一个空白谱表（可选再加一个剧情谱表），然后立即打开。',
      projectNameLabel: '项目名称',
      projectNamePlaceholder: '例如 MySong',
      projectParentLabel: '创建位置',
      projectParentHint: '必须是已存在的目录；项目会创建为该目录下的同名文件夹。',
      projectTemplateLabel: '初始谱表',
      projectTemplateChart: '空白谱面',
      projectTemplateChartDesc: '一个空谱表，先写轨道和音符',
      projectTemplateStoryboard: '谱面 + 剧情',
      projectTemplateStoryboardDesc: '再加一个空的剧情谱表',
      projectLengthLabel: '初始长度（秒）',
      projectLengthHint: '新谱表 period 的最小长度（minLength），之后可随时修改。',
      projectNameRequired: '请输入项目名称',
      projectNameInvalid: '名称不能包含 \\ / : * ? " < > |，也不能以 “.” 开头或结尾',
      projectParentRequired: '请输入创建位置',
      projectLengthInvalid: '初始长度必须是 0 或正数',
      projectPathPreview: '即将创建',
      projectCreating: '正在创建…',
      projectCreated: '已创建项目',
      reload: '重新载入',
      save: '保存',
      saveAll: '保存全部',
      saved: '已保存',
      saving: '正在保存…',
      export: '导出 ZIP',
      exporting: '正在导出…',
      exportHint: '把当前谱面包成 ZIP（含未保存修改与引用素材）并下载到本机',
      exported: '导出完成',
      exportFailed: '导出失败',
      exportSkipped: '个未引用素材未打包',
      unsaved: '未保存',
      clean: '已同步',
      project: '项目',
      projects: '谱面库',
      recent: '最近打开',
      selectProject: '选择项目',
      noProject: '还没有打开谱面项目',
      noProjectHint: '打开一个包含 .g 谱表文件的目录，例如 ~/Music/DremuTest',
      loadFailed: '载入失败',
      loading: '正在载入…',
      retry: '重试',
      close: '关闭',
      cancel: '取消',
      apply: '应用',
      reset: '重置',
      delete: '删除',
      duplicate: '复制一份',
      undo: '撤销',
      redo: '重做',
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      staffs: '谱表',
      elements: '元素',
      lanes: '轨道',
      notes: '元素',
      search: '搜索…',
      filterAll: '全部',
      filterNotes: '音符',
      filterLanes: '轨道',
      filterOther: '其它',
      inspector: '属性',
      noSelection: '未选中元素',
      noSelectionHint: '在时间轴上点击元素以编辑属性；双击空白处放置当前工具的元素。',
      multiSelection: '已选中 {count} 个元素',
      projectInfo: '谱面信息',
      tempo: 'BPM',
      autoBpm: '自动BPM',
      autoBpmHint: '从项目音频自动测定 BPM，并修改项目 BPM',
      autoBpmBusy: '分析中…',
      bpmDetected: '已测定 BPM：{bpm}',
      bpmNoAudio: '没有可分析的音频（请等待频谱加载，或确认音频长于 3 秒）',
      bpmLowConfidence: '置信度较低，可手动微调',
      offset: '偏移',
      offsetUnit: '秒',
      duration: '时长',
      staffCount: '谱表数',
      elementCount: '元素数',
      periodCount: '周期数',
      warnings: '提醒',
      shortcuts: '快捷键',
      timeline: '时间轴',
      tools: '工具',
      toolSelect: '选择',
      toolTap: '放置 Tap',
      toolDrag: '放置 Drag',
      toolHold: '放置 Hold',
      toolLane: '放置轨道',
      toolGuideLane: '放置引导轨道',
      snap: '吸附',
      snapOff: '自由',
      autoScroll: '跟随播放',
      zoomIn: '放大',
      zoomOut: '缩小',
      fitAll: '全览',
      play: '播放',
      pause: '暂停',
      stop: '停止',
      rate: '倍速',
      time: '时间',
      beat: '拍',
      selected: '选中',
      start: '开始',
      length: '长度',
      field: '字段',
      value: '值',
      addField: '添加字段',
      fieldUnused: '未使用',
      type: '类型',
      typeUnknown: '未知类型',
      curveEditor: '曲线编辑器',
      curveOf: '曲线：{name}',
      addPoint: '添加控制点',
      removePoint: '删除控制点',
      curveSegments: '分段',
      curveSegment: '段',
      curveSegmentCount: '{count} 段',
      curveNewSegment: '新建段',
      curveNewSegmentAt: '在 {time} 新建段',
      curveChooseType: '选择新段的函数类型',
      curveChangeType: '修改函数类型',
      curveDeleteSegment: '删除该段',
      curveOnlySegment: '至少保留一个段',
      curveStart: '开始',
      curveEnd: '结束',
      curveLength: '长度',
      curveMakeFinite: '设为有限',
      curveFunctionType: '函数类型',
      curveParams: '函数参数',
      curveWillConvert: '新建段或拖动段边界后会转换为分段函数；段外返回 0。',
      curveConverted: '分段函数：段外返回 0。',
      curveValueJump: '段边界数值不连续',
      curveAutoFix: '自动修复',
      curveAutoFixHint: '把右侧段曲线整体平移，使边界数值与左侧一致',
      curveValueJumpAt: '{time}s 处：左 {left} / 右 {right}',
      curveNoJump: '段边界数值连续',
      curveElementOrigin: '元素时间',
      curveBeatGrid: '节拍刻度对齐主时间线',
      curveTimeAxis: '时间 / 秒',
      curveEdited: '已修改',
      curveOutside: '段外 = 0',
      curvePanelHint: '拖动段边界调整时间与长度；右键新建、修改类型或删除段；拖动控制点调整函数参数。',
      curveAddAtPlayhead: '在播放头/段中点新建段',
      curveFit: '适应视图',
      curveNoSegments: '暂无分段：右键新建一个段',
      curveOpenBusy: '请先应用或取消当前曲线编辑',
      curvePreviewBusy: '曲线编辑中，请先应用或取消',
      curveLeftClosed: '左闭',
      curveRightClosed: '右闭',
      curveCompositeHint: '复合函数的外函数输入是内函数输出，请用数值编辑参数。',
      curveTypeConstant: '常量',
      curveTypeLinearFunction: '线性函数 kx+b',
      curveTypeLinear: '线性关键点',
      curveTypeCubic: '三次样条',
      curveTypePeriodic: '周期函数',
      curveTypeAxial: '轴对称',
      curveTypeAddition: '相加',
      curveTypeComposite: '复合',
      preview: '预览',
      numeric: '数值',
      asText: '文本',
      advanced: '其它字段',
      advancedHint: '这些字段不在当前元素类型的内置描述里，可直接编辑其原始值。',
      newElement: '新建元素',
      elementPalette: '元素类型',
      newElementAt: '在 {time} 新建 {type}',
      created: '已创建',
      deleted: '已删除',
      dragHint: '拖动移动时间，拖动右边缘改变长度',
      emptyStaff: '（空谱表）',
      addStaff: '添加谱表',
      addElement: '添加元素',
      newStaff: '新建谱表',
      newStaffHint: '创建新的 .g 谱表文件，保存后写入项目目录。',
      staffKindChartOption: '谱面',
      staffKindStoryboardOption: '演出',
      staffKindChartDesc: '音符、长条与轨道的表演谱表',
      staffKindStoryboardDesc: '剧情图片的演出谱表',
      staffNameLabel: '名称',
      staffFileLabel: '文件',
      staffClassLabel: '类名',
      defaultStaffName: '新谱表',
      defaultStoryboardName: '新剧情板',
      staffMenuHint: '右键：修改别名或删除谱表',
      renameStaff: '修改别名',
      deleteStaff: '删除谱表',
      staffAliasLabel: '别名',
      staffAliasHint: '别名是 .g 头部里的 displayName，只改界面显示名，不改文件名与类名。',
      staffAliasEmpty: '别名不能为空',
      staffAliasSaved: '已修改别名',
      deleteStaffTitle: '删除谱表',
      deleteStaffWarning: '将永久删除谱表「{name}」；它的 .g 文件（含 .bak 备份）会从磁盘移除，此操作无法撤销。',
      deleteStaffAudioWarning: '这是音频谱表，删除后它的音频乐段也会一并移除。',
      staffDeleted: '已删除谱表',
      create: '创建',
      elementTarget: '目标谱表',
      elementTime: '位置',
      paletteHint: '点击类型，在当前播放头处添加元素。',
      paletteNeedStaff: '请先添加一个谱表',
      paletteNoMatch: '没有匹配的类型',
      createdStaff: '已创建谱表',
      createdElement: '已创建元素',
      audio: '音频',
      audioPeriods: '音频乐段',
      audioPeriodCount: '{count} 个乐段',
      addAudioPeriod: '添加音频乐段',
      newAudioPeriod: '新建音频乐段',
      audioPeriodHint: '乐段是音频谱表里的一个 @Song：选一个音频文件，设置它在谱面时间轴上的开始时间。',
      audioTargetStaff: '音频谱表',
      audioFileLabel: '音频文件',
      audioFileFromProject: '项目内文件',
      audioFileImport: '从本机导入',
      audioFileImportHint: '选择本机的音频文件，导入时会复制到项目目录。',
      audioNameLabel: '名称',
      audioTimeLabel: '开始时间（秒）',
      audioNeedFile: '请选择或导入一个音频文件',
      audioNeedName: '名称不能为空',
      audioImporting: '正在导入…',
      audioImportFailed: '音频导入失败',
      audioHostStale: '当前 Host 还没有加载音频乐段功能：请退出并重新打开 DeepSeek Harness（或重启 DSH 服务）后再试。',
      audioHostStaleShort: '需重启 DSH 才能添加音频乐段',
      audioImported: '已导入音频文件',
      audioCreated: '已添加音频乐段',
      audioDeleted: '已删除音频乐段',
      noAudioPeriods: '这个音频谱表还没有乐段',
      audioPeriodMissing: '音频文件缺失',
      deleteAudioPeriod: '删除乐段',
      deleteAudioPeriodTitle: '删除音频乐段',
      deleteAudioPeriodWarning: '将从 {staff} 中删除乐段「{name}」，音频文件本身会保留在项目目录里。',
      audioPeriodNoStaff: '请先添加一个音频谱表',
      audioPeriodAutoStaff: '项目还没有音频谱表，保存时会自动创建 Song.g。',
      audioMissing: '未找到音频文件',
      waveLoading: '波形载入中…',
      waveUnavailable: '波形不可用',
      waveViewTitle: '音频显示',
      waveViewWaveform: '波形',
      waveViewSpectrum: '频谱',
      waveViewHint: '右键波形区域可切换波形与频谱',
      spectrumLoading: '频谱计算中…',
      spectrumUnavailable: '频谱不可用',
      following: '跟随',
      staffChart: '谱表',
      staffAudio: '音频',
      staffStoryboard: '演出',
      staffOther: '其它',
      laneOrphan: '未归属',
      miscRow: '其它元素',
      offline: '已断开',
      online: '已连接',
      deleteConfirm: '删除选中的 {count} 个元素？',
      discardCurve: '放弃曲线修改？',
      errorPrefix: '错误：',
      ok: '好的',
      autoScrollOn: '已开启跟随播放',
      autoScrollOff: '已关闭跟随播放',
      helpTitle: '操作说明',
      helpBody:
        '滚轮上下滚动谱表，Shift+滚轮横向滚动，Ctrl+滚轮缩放。在空白处拖动框选，拖动元素改变时间，拖动右边缘改变长度。空格播放/暂停，Delete 删除，Ctrl+Z 撤销，Ctrl+Shift+Z 重做，Ctrl+S 保存。选择工具下双击轨道条（或双击轨道名称栏）进入判定线音符编辑器；编辑器内 Q/W/E/R 放置 Tap/Drag/Taplik/Hold。',
      editTime: '时间（秒）',
      laneName: '轨道',
      innerNotes: '长条内点',
      goto: '定位',
      seek: '跳转',
      jumpToStart: '回到开头',
      playbackOpen: '播放预览',
      playbackTitle: '纯播放预览',
      playbackClose: '关闭预览',
      playbackHint: '纯播放 · 无判定与谱面信号',
      playbackLanes: '轨道',
      playbackNotes: '音符',
      playbackUnbound: '未绑定',
      playbackEmpty: '该谱面没有可播放的 Dremu 轨道',
      playbackRestart: '从头播放',
      playbackBackground: '背景',
      playbackNoAudio: '无音频：按谱面时钟播放',
      selectTool: '选择工具',
      placeHint: '在时间轴上双击放置',
      applying: '正在应用…',
      rev: '版本',
      dirtyDot: '有未保存修改',
      emptyElementList: '当前谱表没有匹配的元素',
      dropAssets: '素材',
      assetImages: '图片',
      assetAudio: '音频',
      timelineEmpty: '双击时间轴放置元素，或打开示例项目',
      errorGeneric: '操作失败',
      unsupportedValue: '（不支持的数值）',
      unnamed: '未命名',
      toolTaplik: '放置 Taplik',
      noteEditor: '判定线音符编辑器',
      noteEditorBack: '返回时间轴',
      noteEditorHint: 'Q Tap · W Drag · E Taplik · R Hold · 拖动移动 · 拖 Hold 尾部改长度 · Alt 关闭吸附',
      noteEditorEmpty: '这条判定线还没有音符；按 Q/W/E/R 选择类型后点击放置',
      noteEditorOpenHint: '双击进入音符编辑器',
      noteEditorPosition: '位置',
      noteEditorJudge: '判定线',
      noteEditorSpectrumShort: '频谱',
      noteEditorNotesCount: '{count} 个音符',
      noteEditorNoLane: '该判定线已不存在',
    };

    const en = {
      panel: 'Dremu Chart Studio',
      title: 'Dremu Chart Studio',
      subtitle: 'Gorge / Dremu .g staff editor',
      openProject: 'Open project',
      openProjectPlaceholder: 'Absolute folder path, or a library name',
      open: 'Open',
      newProject: 'New project',
      newProjectHint:
        'Create a brand-new chart project folder: one empty chart staff (optionally a storyboard staff) is written and opened immediately.',
      projectNameLabel: 'Project name',
      projectNamePlaceholder: 'e.g. MySong',
      projectParentLabel: 'Location',
      projectParentHint: 'An existing folder; the project is created as a same-named folder inside it.',
      projectTemplateLabel: 'Starter staffs',
      projectTemplateChart: 'Blank chart',
      projectTemplateChartDesc: 'One empty staff for lanes and notes',
      projectTemplateStoryboard: 'Chart + storyboard',
      projectTemplateStoryboardDesc: 'Also add an empty storyboard staff',
      projectLengthLabel: 'Initial length (s)',
      projectLengthHint: 'The new period minLength; you can change it later.',
      projectNameRequired: 'Enter a project name',
      projectNameInvalid: 'The name must not contain \\ / : * ? " < > | or start/end with a dot',
      projectParentRequired: 'Enter a location',
      projectLengthInvalid: 'The initial length must be 0 or a positive number',
      projectPathPreview: 'Will create',
      projectCreating: 'Creating…',
      projectCreated: 'Project created',
      reload: 'Reload from disk',
      save: 'Save',
      saveAll: 'Save all',
      saved: 'Saved',
      saving: 'Saving…',
      export: 'Export ZIP',
      exporting: 'Exporting…',
      exportHint: 'Package the chart as a ZIP (unsaved edits and referenced assets included) and download it',
      exported: 'Export complete',
      exportFailed: 'Export failed',
      exportSkipped: 'unreferenced assets left out',
      unsaved: 'Unsaved',
      clean: 'In sync',
      project: 'Project',
      projects: 'Chart library',
      recent: 'Recent',
      selectProject: 'Choose a project',
      noProject: 'No chart project is open',
      noProjectHint: 'Open a folder that contains .g staff files, e.g. ~/Music/DremuTest',
      loadFailed: 'Failed to load',
      loading: 'Loading…',
      retry: 'Retry',
      close: 'Close',
      cancel: 'Cancel',
      apply: 'Apply',
      reset: 'Reset',
      delete: 'Delete',
      duplicate: 'Duplicate',
      undo: 'Undo',
      redo: 'Redo',
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select all',
      staffs: 'Staffs',
      elements: 'Elements',
      lanes: 'Lanes',
      notes: 'Elements',
      search: 'Search…',
      filterAll: 'All',
      filterNotes: 'Notes',
      filterLanes: 'Lanes',
      filterOther: 'Other',
      inspector: 'Inspector',
      noSelection: 'Nothing selected',
      noSelectionHint: 'Click an element on the timeline to edit it; double-click empty space to place the current tool.',
      multiSelection: '{count} elements selected',
      projectInfo: 'Chart info',
      tempo: 'BPM',
      autoBpm: 'Auto BPM',
      autoBpmHint: 'Detect the BPM from the project audio and update the project BPM',
      autoBpmBusy: 'Analyzing…',
      bpmDetected: 'Detected BPM: {bpm}',
      bpmNoAudio: 'No audio available for analysis (wait for the spectrum, or use audio longer than 3 s)',
      bpmLowConfidence: 'Low confidence; adjust manually if needed',
      offset: 'Offset',
      offsetUnit: 's',
      duration: 'Length',
      staffCount: 'Staffs',
      elementCount: 'Elements',
      periodCount: 'Periods',
      warnings: 'Notes',
      shortcuts: 'Shortcuts',
      timeline: 'Timeline',
      tools: 'Tools',
      toolSelect: 'Select',
      toolTap: 'Place Tap',
      toolDrag: 'Place Drag',
      toolHold: 'Place Hold',
      toolLane: 'Place lane',
      toolGuideLane: 'Place guide lane',
      snap: 'Snap',
      snapOff: 'Free',
      autoScroll: 'Follow playback',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fitAll: 'Fit',
      play: 'Play',
      pause: 'Pause',
      stop: 'Stop',
      rate: 'Rate',
      time: 'Time',
      beat: 'Beat',
      selected: 'Selected',
      start: 'Start',
      length: 'Length',
      field: 'Field',
      value: 'Value',
      addField: 'Add field',
      fieldUnused: 'Not used',
      type: 'Type',
      typeUnknown: 'Unknown type',
      curveEditor: 'Curve editor',
      curveOf: 'Curve: {name}',
      addPoint: 'Add point',
      removePoint: 'Remove point',
      curveSegments: 'Segments',
      curveSegment: 'Segment',
      curveSegmentCount: '{count} segments',
      curveNewSegment: 'New segment',
      curveNewSegmentAt: 'New segment at {time}',
      curveChooseType: 'Choose the new segment function type',
      curveChangeType: 'Change function type',
      curveDeleteSegment: 'Delete this segment',
      curveOnlySegment: 'Keep at least one segment',
      curveStart: 'Start',
      curveEnd: 'End',
      curveLength: 'Length',
      curveMakeFinite: 'Make finite',
      curveFunctionType: 'Function type',
      curveParams: 'Function parameters',
      curveWillConvert: 'Adding a segment or moving a boundary converts this curve to a piecewise function (0 outside its pieces).',
      curveConverted: 'Piecewise function: 0 outside its pieces.',
      curveValueJump: 'Value jump at a segment boundary',
      curveAutoFix: 'Auto fix',
      curveAutoFixHint: 'Shift the right segment so its value matches the left at the boundary',
      curveValueJumpAt: 'at {time}s: left {left} / right {right}',
      curveNoJump: 'Boundary values are continuous',
      curveElementOrigin: 'Element time',
      curveBeatGrid: 'Beat grid follows the main timeline',
      curveTimeAxis: 'Time / s',
      curveEdited: 'Modified',
      curveOutside: 'outside = 0',
      curvePanelHint: 'Drag segment boundaries to change time/length; right-click to add, retype or delete a segment; drag handles to edit function parameters.',
      curveAddAtPlayhead: 'New segment at the playhead/midpoint',
      curveFit: 'Fit view',
      curveNoSegments: 'No segments yet — right-click to add one',
      curveOpenBusy: 'Apply or cancel the current curve edit first',
      curvePreviewBusy: 'Finish the curve edit first',
      curveLeftClosed: 'Left closed',
      curveRightClosed: 'Right closed',
      curveCompositeHint: 'A composite curve feeds the inner result into the outer curve; edit its parameters numerically.',
      curveTypeConstant: 'Constant',
      curveTypeLinearFunction: 'Linear function kx+b',
      curveTypeLinear: 'Linear keys',
      curveTypeCubic: 'Cubic spline',
      curveTypePeriodic: 'Periodic',
      curveTypeAxial: 'Axial symmetric',
      curveTypeAddition: 'Addition',
      curveTypeComposite: 'Composite',
      preview: 'Preview',
      numeric: 'Numbers',
      asText: 'Text',
      advanced: 'Other fields',
      advancedHint: 'Fields not described by the built-in schema; edit the raw value directly.',
      newElement: 'New element',
      elementPalette: 'Element type',
      newElementAt: 'Create {type} at {time}',
      created: 'Created',
      deleted: 'Deleted',
      dragHint: 'Drag to move in time, drag the right edge to resize',
      emptyStaff: '(empty staff)',
      addStaff: 'Add staff',
      addElement: 'Add element',
      newStaff: 'New staff',
      newStaffHint: 'Creates a new .g staff file and writes it to the project on save.',
      staffKindChartOption: 'Chart',
      staffKindStoryboardOption: 'Storyboard',
      staffKindChartDesc: 'Notes, holds and lanes for the playfield',
      staffKindStoryboardDesc: 'Storyboard images shown over the chart',
      staffNameLabel: 'Name',
      staffFileLabel: 'File',
      staffClassLabel: 'Class',
      defaultStaffName: 'New staff',
      defaultStoryboardName: 'New storyboard',
      staffMenuHint: 'Right-click: rename alias or delete the staff',
      renameStaff: 'Rename alias',
      deleteStaff: 'Delete staff',
      staffAliasLabel: 'Alias',
      staffAliasHint: 'The alias is the .g header displayName; it only changes the UI label, not the file or class name.',
      staffAliasEmpty: 'Alias cannot be empty',
      staffAliasSaved: 'Alias updated',
      deleteStaffTitle: 'Delete staff',
      deleteStaffWarning: 'This permanently deletes the staff “{name}”. Its .g file (including the .bak backup) is removed from disk; this cannot be undone.',
      deleteStaffAudioWarning: 'This is an audio staff; its audio periods are removed with it.',
      staffDeleted: 'Staff deleted',
      create: 'Create',
      elementTarget: 'Target staff',
      elementTime: 'Position',
      paletteHint: 'Pick a type to add it at the playhead.',
      paletteNeedStaff: 'Add a staff first',
      paletteNoMatch: 'No matching type',
      createdStaff: 'Staff created',
      createdElement: 'Element created',
      audio: 'Audio',
      audioPeriods: 'Audio periods',
      audioPeriodCount: '{count} clip(s)',
      addAudioPeriod: 'Add audio period',
      newAudioPeriod: 'New audio period',
      audioPeriodHint: 'One audio period is one @Song clip: pick an audio file and the chart time where it starts.',
      audioTargetStaff: 'Audio staff',
      audioFileLabel: 'Audio file',
      audioFileFromProject: 'Project file',
      audioFileImport: 'Import from this computer',
      audioFileImportHint: 'The picked file is copied into the project directory when imported.',
      audioNameLabel: 'Name',
      audioTimeLabel: 'Start time (s)',
      audioNeedFile: 'Choose or import an audio file',
      audioNeedName: 'Name cannot be empty',
      audioImporting: 'Importing…',
      audioImportFailed: 'Audio import failed',
      audioHostStale: 'This Host has not loaded audio periods yet: quit and reopen DeepSeek Harness (or restart the DSH service) and try again.',
      audioHostStaleShort: 'Restart DSH to add audio periods',
      audioImported: 'Audio file imported',
      audioCreated: 'Audio period added',
      audioDeleted: 'Audio period deleted',
      noAudioPeriods: 'This audio staff has no audio period yet',
      audioPeriodMissing: 'Audio file is missing',
      deleteAudioPeriod: 'Delete period',
      deleteAudioPeriodTitle: 'Delete audio period',
      deleteAudioPeriodWarning: 'Removes “{name}” from {staff}; the audio file itself stays in the project directory.',
      audioPeriodNoStaff: 'Add an audio staff first',
      audioPeriodAutoStaff: 'No audio staff yet; saving creates Song.g automatically.',
      audioMissing: 'Audio file not found',
      waveLoading: 'Loading waveform…',
      waveUnavailable: 'Waveform unavailable',
      waveViewTitle: 'Audio view',
      waveViewWaveform: 'Waveform',
      waveViewSpectrum: 'Spectrum',
      waveViewHint: 'Right-click the waveform to switch between waveform and spectrum',
      spectrumLoading: 'Computing spectrum…',
      spectrumUnavailable: 'Spectrum unavailable',
      following: 'Follow',
      staffChart: 'Chart',
      staffAudio: 'Audio',
      staffStoryboard: 'Storyboard',
      staffOther: 'Other',
      laneOrphan: 'Unassigned',
      miscRow: 'Other elements',
      offline: 'Disconnected',
      online: 'Connected',
      deleteConfirm: 'Delete {count} selected element(s)?',
      discardCurve: 'Discard curve changes?',
      errorPrefix: 'Error: ',
      ok: 'OK',
      autoScrollOn: 'Follow playback on',
      autoScrollOff: 'Follow playback off',
      helpTitle: 'How to edit',
      helpBody:
        'Wheel scrolls staff rows, Shift+wheel scrolls time, Ctrl+wheel zooms. Drag empty space to box-select, drag an element to move it, drag its right edge to resize. Space plays/pauses, Delete deletes, Ctrl+Z undoes, Ctrl+Shift+Z redoes, Ctrl+S saves. With the select tool, double-click a lane strip (or a lane name) to open the judgement-line note editor; Q/W/E/R place Tap/Drag/Taplik/Hold there.',
      editTime: 'Time (s)',
      laneName: 'Lane',
      innerNotes: 'Inner notes',
      goto: 'Go to',
      seek: 'Seek',
      jumpToStart: 'Back to start',
      playbackOpen: 'Play preview',
      playbackTitle: 'Autoplay preview',
      playbackClose: 'Close preview',
      playbackHint: 'Playback only · no judgement or chart signals',
      playbackLanes: 'Lanes',
      playbackNotes: 'Notes',
      playbackUnbound: 'Unbound',
      playbackEmpty: 'This chart has no playable Dremu lanes',
      playbackRestart: 'Restart',
      playbackBackground: 'Background',
      playbackNoAudio: 'No audio: following the chart clock',
      selectTool: 'Select tool',
      placeHint: 'Double-click on the timeline to place',
      applying: 'Applying…',
      rev: 'rev',
      dirtyDot: 'Unsaved changes',
      emptyElementList: 'No elements match in this staff',
      dropAssets: 'Assets',
      assetImages: 'Images',
      assetAudio: 'Audio',
      timelineEmpty: 'Double-click the timeline to place an element, or open a sample project',
      errorGeneric: 'Operation failed',
      unsupportedValue: '(unsupported value)',
      unnamed: 'unnamed',
      toolTaplik: 'Place Taplik',
      noteEditor: 'Judgement-line note editor',
      noteEditorBack: 'Back to timeline',
      noteEditorHint: 'Q Tap · W Drag · E Taplik · R Hold · drag to move · drag a hold tail to resize · Alt disables snapping',
      noteEditorEmpty: 'No notes on this judgement line — pick a type with Q/W/E/R and click to place one',
      noteEditorOpenHint: 'Double-click to open the note editor',
      noteEditorPosition: 'Position',
      noteEditorJudge: 'Judgement line',
      noteEditorSpectrumShort: 'Spec',
      noteEditorNotesCount: '{count} notes',
      noteEditorNoLane: 'This judgement line no longer exists',
    };

    // ========================================================================
    // 02 · Small utilities.
    // ========================================================================

    /** Clamp a number into an inclusive range. */
    function clamp(value, lo, hi) {
      return value < lo ? lo : value > hi ? hi : value;
    }

    /** Round to `digits` decimals without float dust. */
    function round(value, digits) {
      const factor = Math.pow(10, digits === undefined ? 3 : digits);
      return Math.round(value * factor) / factor;
    }

    /** True for a plain object (not null, not an array). */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** True for a typed value wrapper `{ t: 'obj' | 'arr' | 'ref' | 'expr' }`. */
    function isTypedValue(value) {
      return isPlainObject(value) && typeof value.t === 'string' && ['obj', 'arr', 'ref', 'expr'].indexOf(value.t) !== -1;
    }

    /** Deep clone through JSON (the value tree is JSON-safe by contract). */
    function deepClone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    /** Format seconds as m:ss.mmm (or h:mm:ss.mmm past an hour). */
    function formatTime(seconds) {
      const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
      const totalMs = Math.round(value * 1000);
      const ms = totalMs % 1000;
      const totalSec = Math.floor(totalMs / 1000);
      const sec = totalSec % 60;
      const totalMin = Math.floor(totalSec / 60);
      const min = totalMin % 60;
      const hour = Math.floor(totalMin / 60);
      const pad = (number, width) => String(number).padStart(width, '0');
      if (hour > 0) return hour + ':' + pad(min, 2) + ':' + pad(sec, 2) + '.' + pad(ms, 3);
      return min + ':' + pad(sec, 2) + '.' + pad(ms, 3);
    }

    /**
     * Truncate text with an ellipsis so it fits `maxWidth` in the context's
     * current font. Canvas has no CSS text-overflow, so the gutter labels need
     * this to avoid drawing over neighbouring columns.
     */
    function fitText(ctx, text, maxWidth) {
      const value = text === null || text === undefined ? '' : String(text);
      if (!(maxWidth > 0) || value.length === 0) return '';
      if (ctx.measureText(value).width <= maxWidth) return value;
      const ellipsis = '…';
      let low = 0;
      let high = value.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(value.slice(0, mid) + ellipsis).width <= maxWidth) low = mid;
        else high = mid - 1;
      }
      return low > 0 ? value.slice(0, low) + ellipsis : '';
    }

    /** Format a number for a compact readout (trims zeroes, max 3 decimals). */
    function formatNum(value, digits) {
      if (!Number.isFinite(value)) {
        if (value === Infinity) return '+∞';
        if (value === -Infinity) return '−∞';
        return 'NaN';
      }
      const rounded = round(value, digits === undefined ? 4 : digits);
      return String(rounded);
    }

    /** Screen-reader friendly type label: `Dremu.DremuTap` -> `DremuTap`. */
    function shortType(type) {
      if (typeof type !== 'string') return '';
      const dot = type.lastIndexOf('.');
      return dot === -1 ? type : type.slice(dot + 1);
    }

    /** Type label without the namespace: `GorgeFramework.VariableFloat` -> `VariableFloat`. */
    function stripNamespace(type) {
      return shortType(type);
    }

    /** Parse a numeric input, tolerating empty / non-numeric text. */
    function parseNumberInput(text) {
      if (typeof text === 'number') return Number.isFinite(text) ? text : null;
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed === '') return null;
      if (trimmed === '-∞' || trimmed === '-inf') return -Infinity;
      if (trimmed === '+∞' || trimmed === '∞' || trimmed === 'inf') return Infinity;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    /** Canonical number field text (`10.0` style for integers, like the .g writer). */
    function numberText(value) {
      if (!Number.isFinite(value)) {
        if (value === Infinity) return '(1.0/0.0)';
        if (value === -Infinity) return '(-1.0/0.0)';
        return 'NaN';
      }
      if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toFixed(1);
      return String(value);
    }

    /** Read a path inside a value tree (arrays support numeric segments). */
    function getAtPath(root, path) {
      let current = root;
      for (const segment of path) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) current = current[Number(segment)];
        else if (isPlainObject(current)) current = current[segment];
        else return undefined;
      }
      return current;
    }

    /** Immutably set a path inside a value tree copy; returns the new root. */
    function setAtPath(root, path, value) {
      if (path.length === 0) return deepClone(value);
      const copy = deepClone(root);
      let current = copy;
      for (let i = 0; i < path.length - 1; i += 1) {
        const segment = path[i];
        let next = Array.isArray(current) ? current[Number(segment)] : current[segment];
        if (next === null || next === undefined) {
          next = typeof path[i + 1] === 'number' ? [] : {};
          if (Array.isArray(current)) current[Number(segment)] = next;
          else current[segment] = next;
        }
        current = next;
      }
      const last = path[path.length - 1];
      if (Array.isArray(current)) current[Number(last)] = deepClone(value);
      else current[last] = deepClone(value);
      return copy;
    }

    /** Effective numeric value of a scalar Value, else null. */
    function valueAsNumber(value) {
      if (typeof value === 'number') return value;
      if (isTypedValue(value) && value.t === 'expr') {
        if (typeof value.special === 'number') return value.special;
        const special = String(value.special || '');
        if (special === 'Infinity' || special === '+Infinity') return Infinity;
        if (special === '-Infinity') return -Infinity;
        if (special === 'NaN') return NaN;
        const source = typeof value.src === 'string' ? value.src.trim() : '';
        if (/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(source)) return Number(source);
        if (/^[-+]?\d+(?:\.\d+)?\/0(?:\.0+)?$/.test(source)) {
          return source.startsWith('-') ? -Infinity : Infinity;
        }
        return null;
      }
      return null;
    }

    /** String value for display. */
    function valueAsString(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (isTypedValue(value)) {
        if (value.t === 'ref') return String(value.path || '');
        if (value.t === 'expr') return String(value.src || '');
        return stripNamespace(value.type);
      }
      return '';
    }

    /** Human label for any Value. */
    function describeValue(value) {
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'number') return formatNum(value, 6);
      if (typeof value === 'string') return '"' + value + '"';
      if (isTypedValue(value)) {
        if (value.t === 'ref') return String(value.path || '');
        if (value.t === 'expr') return String(value.src || '');
        if (value.t === 'arr') return stripNamespace(value.type) + '[' + (value.items ? value.items.length : 0) + ']';
        const keys = Object.keys(value.fields || {});
        return stripNamespace(value.type) + ' {' + keys.length + '}';
      }
      if (Array.isArray(value)) return '[' + value.length + ']';
      return '{}';
    }

    // ========================================================================
    // 03 · Curve sampling (display only; the Host model is authoritative).
    // ========================================================================

    /** Sample one curve-ish Value at x; returns a number (null when unknown). */
    function sampleCurve(value, x) {
      if (value === null || value === undefined) return null;
      const scalar = valueAsNumber(value);
      if (scalar !== null) return scalar;
      if (!isTypedValue(value) || value.t !== 'obj') return null;
      const type = stripNamespace(value.type);
      const fields = value.fields || {};
      const num = (name, fallback) => {
        const raw = valueAsNumber(fields[name]);
        return raw === null ? fallback : raw;
      };
      switch (type) {
        case 'ConstantFunctionCurve':
        case 'ConstantCurve':
          return num('value', 0);
        case 'LinearFunctionCurve':
          // Engine default is k = 0, b = 0 (constant 0), not the identity.
          return num('k', 0) * x + num('b', 0);
        case 'LinearCurve': {
          const t0 = num('timeStart', 0);
          const t1 = num('timeEnd', 1);
          const v0 = num('valueStart', 0);
          // Engine default is the identity ramp (0 -> 1).
          const v1 = num('valueEnd', 1);
          if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 === t0) return t0 <= x ? v1 : v0;
          const t = clamp((x - t0) / (t1 - t0), 0, 1);
          return v0 + (v1 - v0) * t;
        }
        case 'CubicHermiteSpline':
        case 'HermiteSpline': {
          const start = fields.startPoint;
          const endPoint = fields.endPoint;
          const x1 = start && isTypedValue(start) ? valueAsNumber(start.fields && start.fields.x) : null;
          const y1 = start && isTypedValue(start) ? valueAsNumber(start.fields && start.fields.y) : null;
          const x2 = endPoint && isTypedValue(endPoint) ? valueAsNumber(endPoint.fields && endPoint.fields.x) : null;
          const y2 = endPoint && isTypedValue(endPoint) ? valueAsNumber(endPoint.fields && endPoint.fields.y) : null;
          const fromX = x1 === null ? 0 : x1;
          const fromY = y1 === null ? 0 : y1;
          const toX = x2 === null ? 1 : x2;
          const toY = y2 === null ? 1 : y2;
          // Host `evaluateCurve` uses strict bounds and treats a degenerate
          // axis/span as the corresponding endpoint (see dremu-model.js).
          if (x < fromX) return fromY;
          if (x > toX) return toY;
          const dx = toX - fromX;
          if (dx === 0) return toY;
          const dy = toY - fromY;
          if (dy === 0) return fromY;
          const clampWeight = (value, fallback) => {
            const weight = Number.isFinite(value) ? value : fallback;
            return Math.max(0, Math.min(1, weight));
          };
          const wt1 = clampWeight(num('startWeight', 1 / 3), 1 / 3);
          const wt2 = clampWeight(num('endWeight', 1 / 3), 1 / 3);
          const tangent1 = num('startTangent', 0);
          const tangent2 = num('endTangent', 0);
          const xdx = (x - fromX) / dx;
          const wt2s = 1 - wt2;
          let t = 0.5;
          if (Math.abs(wt1 - 1 / 3) < 1e-12 && Math.abs(wt2 - 1 / 3) < 1e-12) {
            t = xdx;
          } else {
            // Weighted cubic Hermite parameter solve, ported from
            // GorgeFramework CubicHermiteSpline.AnimationCurveInterpolant
            // (third-order Householder iteration).
            for (let iteration = 0; iteration < 50; iteration += 1) {
              const t2 = 1 - t;
              const fg = 3 * t2 * t2 * t * wt1 + 3 * t2 * t * t * wt2s + t * t * t - xdx;
              if (Math.abs(fg) < 2 * 2.23e-16) break;
              const fpg = 3 * t2 * t2 * wt1 + 6 * t2 * t * (wt2s - wt1) + 3 * t * t * (1 - wt2s);
              const fppg = 6 * t2 * (wt2s - 2 * wt1) + 6 * t * (1 - 2 * wt2s + wt1);
              const fpppg = 18 * wt1 - 18 * wt2s + 6;
              const denominator = 6 * fpg * fpg * fpg - 6 * fg * fpg * fppg + fg * fg * fpppg;
              if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-18) break;
              const next = t - (6 * fg * fpg * fpg - 3 * fg * fg * fppg) / denominator;
              if (!Number.isFinite(next)) break;
              t = Math.max(0, Math.min(1, next));
            }
          }
          const tt = 1 - t;
          const yp1dy = (tangent1 * dx) / dy;
          const yp2dy = (tangent2 * dx) / dy;
          const y = 3 * tt * tt * t * wt1 * yp1dy + 3 * tt * t * t * (1 - wt2 * yp2dy) + t * t * t;
          return fromY + y * dy;
        }
        case 'PiecewiseFunctionCurve':
        case 'PiecewiseCurve': {
          const list = fields.functionPieces;
          const items = list && isTypedValue(list) && Array.isArray(list.items) ? list.items : [];
          for (const item of items) {
            if (!isTypedValue(item) || item.t !== 'obj') continue;
            const pieceFields = item.fields || {};
            const startX = valueAsNumber(pieceFields.startX);
            const endX = valueAsNumber(pieceFields.endX);
            // Host: a missing bound is unbounded; bounds are open unless the
            // corresponding flag is exactly true.
            const leftClosed = pieceFields.leftClosed === true;
            const rightClosed = pieceFields.rightClosed === true;
            const afterLeft = startX === null ? true : leftClosed ? x >= startX : x > startX;
            const beforeRight = endX === null ? true : rightClosed ? x <= endX : x < endX;
            if (afterLeft && beforeRight) {
              const inner = sampleCurve(pieceFields.functionCurve, x);
              return inner === null ? 0 : inner;
            }
          }
          return 0;
        }
        case 'AxialSymmetricFunctionCurve': {
          const inner = fields.functionCurve;
          const axis = num('axis', 0);
          const keepLeft = fields.keepLeft === true;
          const mirrored = keepLeft ? (x <= axis ? x : 2 * axis - x) : x >= axis ? x : 2 * axis - x;
          const value = sampleCurve(inner, mirrored);
          return value === null ? 0 : value;
        }
        case 'PeriodicFunctionCurve': {
          const startX = num('startX', 0);
          const endX = num('endX', 0);
          const period = endX - startX;
          if (!(period > 0)) {
            const value = sampleCurve(fields.functionCurve, x);
            return value === null ? 0 : value;
          }
          let phase = startX + ((((x - startX) % period) + period) % period);
          if (phase === startX && fields.leftClosed !== true) phase = endX - 1e-9;
          const value = sampleCurve(fields.functionCurve, phase);
          return value === null ? 0 : value;
        }
        case 'AdditionFunctionCurve': {
          const first = fields.firstFunctionCurve;
          const second = fields.secondFunctionCurve;
          const a = sampleCurve(first, x);
          const b = sampleCurve(second, x);
          return (a === null ? 0 : a) + (b === null ? 0 : b);
        }
        case 'CompositeFunctionCurve': {
          const inner = sampleCurve(fields.innerFunctionCurve, x);
          const nested = sampleCurve(fields.outerFunctionCurve, inner === null ? 0 : inner);
          return nested === null ? 0 : nested;
        }
        case 'VariableFloat': {
          const base = num('baseValue', 0);
          const variation = sampleCurve(fields.variationCurve, x);
          return variation === null ? base : base + variation;
        }
        case 'VariableVector2':
          return null;
        default:
          return null;
      }
    }

    /** Numeric curve types the piecewise segment editor can create/draw. */
    const CURVE_FN_TYPE_ORDER = [
      'ConstantFunctionCurve',
      'LinearFunctionCurve',
      'LinearCurve',
      'CubicHermiteSpline',
      'PeriodicFunctionCurve',
      'AxialSymmetricFunctionCurve',
      'AdditionFunctionCurve',
      'CompositeFunctionCurve',
    ];

    /** Locale key for one segment function type (fallback: the bare type name). */
    const CURVE_FN_TYPE_KEYS = {
      ConstantFunctionCurve: 'curveTypeConstant',
      LinearFunctionCurve: 'curveTypeLinearFunction',
      LinearCurve: 'curveTypeLinear',
      CubicHermiteSpline: 'curveTypeCubic',
      PeriodicFunctionCurve: 'curveTypePeriodic',
      AxialSymmetricFunctionCurve: 'curveTypeAxial',
      AdditionFunctionCurve: 'curveTypeAddition',
      CompositeFunctionCurve: 'curveTypeComposite',
    };

    /** Legacy type spellings accepted by the curve editor. */
    const CURVE_FN_TYPE_ALIASES = ['ConstantCurve', 'HermiteSpline', 'PiecewiseCurve'];

    /** True when one typed value is a curve the segment editor can edit. */
    function isCurveEditorValue(value) {
      if (!isTypedValue(value) || value.t !== 'obj') return false;
      const type = stripNamespace(value.type);
      return CURVE_FN_TYPE_ORDER.indexOf(type) !== -1 || CURVE_FN_TYPE_ALIASES.indexOf(type) !== -1 || type === 'PiecewiseFunctionCurve';
    }

    // ========================================================================
    // 04 · Local (optimistic) op application — mirrors the Host model contract.
    // ========================================================================

    /** Find one element plus its staff/period by id. */
    function findElement(project, elementId) {
      if (!project || !Array.isArray(project.staffs)) return null;
      for (const staff of project.staffs) {
        const periods = staff.periods || [];
        for (let pi = 0; pi < periods.length; pi += 1) {
          const period = periods[pi];
          const elements = period.elements || [];
          for (let ei = 0; ei < elements.length; ei += 1) {
            if (elements[ei].id === elementId) {
              return { staff, period, element: elements[ei], periodIndex: pi, elementIndex: ei };
            }
          }
        }
      }
      return null;
    }

    /** Recompute an element's derived timing fields after a fields change. */
    function deriveTiming(element, period, catalog) {
      const entry = catalogEntry(catalog, element.type);
      const timing = (entry && entry.timing) || {};
      const fields = element.fields || {};
      const offset = period && Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
      const readNumber = (name) => {
        if (!name) return null;
        const raw = valueAsNumber(fields[name]);
        return raw === null ? null : raw;
      };
      let start = readNumber(timing.start);
      if (start === null) start = readNumber('hitTime');
      if (start === null) start = readNumber('startMoment');
      if (start === null) start = readNumber('generateTime');
      if (start === null) start = 0;
      let duration = readNumber(timing.duration);
      if (duration === null) duration = readNumber('keepTime');
      if (duration === null) duration = readNumber('holdTime');
      const laneField = timing.lane || 'laneName';
      const laneRaw = fields[laneField];
      element.start = round(offset + start, 6);
      element.duration = duration === null ? null : round(duration, 6);
      element.lane = typeof laneRaw === 'string' ? laneRaw : null;
      return element;
    }

    /** Catalog lookup by element type. */
    function catalogEntry(catalog, type) {
      if (!catalog || !Array.isArray(catalog.elements)) return null;
      for (const entry of catalog.elements) if (entry.type === type) return entry;
      return null;
    }

    /**
     * Field name that stores an element's start time. The catalog descriptor is
     * authoritative: a field that is currently absent from the parsed element
     * simply uses its injector default (0), and patching it creates it, which is
     * exactly what the .g writer needs.
     */
    function resolveStartField(catalog, element) {
      const entry = catalogEntry(catalog, element && element.type);
      const timing = (entry && entry.timing) || {};
      if (typeof timing.start === 'string' && timing.start.length > 0) return timing.start;
      const fields = (element && element.fields) || {};
      return ['hitTime', 'generateTime', 'startMoment'].find((name) => fields[name] !== undefined) || null;
    }

    /** Field name that stores an element's duration (null when it has none). */
    function resolveDurationField(catalog, element) {
      const entry = catalogEntry(catalog, element && element.type);
      const timing = (entry && entry.timing) || {};
      if (typeof timing.duration === 'string' && timing.duration.length > 0) return timing.duration;
      const fields = (element && element.fields) || {};
      return ['keepTime', 'holdTime'].find((name) => fields[name] !== undefined) || null;
    }

    /** Color for an element type, from the catalog or the fallback palette. */
    function elementColor(catalog, type) {
      const entry = catalogEntry(catalog, type);
      if (entry && entry.color) return entry.color;
      let hash = 0;
      const text = String(type || '');
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
    }

    /** Category for an element type, from the catalog. */
    function elementCategory(catalog, type) {
      const entry = catalogEntry(catalog, type);
      return (entry && entry.category) || 'other';
    }

    /** Ensure a period slice holds an element; returns the period id used. */
    function pickPeriod(project, staffId, time) {
      const staff = (project.staffs || []).find((item) => item.id === staffId);
      if (!staff || !Array.isArray(staff.periods) || staff.periods.length === 0) return null;
      let best = staff.periods[0];
      let bestDistance = Infinity;
      for (const period of staff.periods) {
        const offset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
        const length = Number.isFinite(period.minLength) ? period.minLength : 20;
        if (time >= offset && time < offset + length) return period.id;
        const distance = Math.min(Math.abs(time - offset), Math.abs(time - (offset + length)));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = period;
        }
      }
      return best.id;
    }

    /** All audio clips of a wire project (new `audioPeriods`, legacy `audio`). */
    function audioClipsOf(project) {
      if (!project) return [];
      if (Array.isArray(project.audioPeriods) && project.audioPeriods.length > 0) return project.audioPeriods;
      if (project.audio) {
        return [
          {
            id: 'a0',
            staffId: '',
            method: 'GetSong',
            name: project.audio.name || '',
            relativePath: '',
            file: project.audio.file || '',
            offset: Number.isFinite(project.audio.offset) ? project.audio.offset : 0,
            duration: Number.isFinite(project.audio.duration) ? project.audio.duration : null,
            missing: false,
          },
        ];
      }
      return [];
    }

    /** Re-sort the local audio clips and refresh the legacy `audio` view. */
    function refreshLocalAudio(project) {
      const clips = [];
      for (const staff of project.staffs || []) {
        if (!staff || staff.kind !== 'audio') continue;
        for (const clip of staff.audioPeriods || []) clips.push(Object.assign({ staffId: staff.id }, clip));
      }
      clips.sort((a, b) => (a.offset || 0) - (b.offset || 0) || String(a.staffId).localeCompare(String(b.staffId)));
      project.audioPeriods = clips;
      const first = clips[0] || null;
      project.audio = first
        ? { file: first.file || '', name: first.name || '', duration: first.duration === undefined ? null : first.duration, offset: first.offset || 0 }
        : null;
      return clips;
    }

    /** Find one audio clip and its staff in the local wire project. */
    function findAudioClip(project, staffId, audioPeriodId) {
      const wanted = String(audioPeriodId || '');
      if (!wanted) return null;
      for (const staff of (project && project.staffs) || []) {
        if (!staff || staff.kind !== 'audio') continue;
        if (staffId && staff.id !== staffId) continue;
        for (const clip of staff.audioPeriods || []) {
          if (clip.id === wanted || clip.method === wanted) return { staff, clip };
        }
      }
      return null;
    }

    /** Next unique @Song method name for optimistic audio-period creation. */
    function nextAudioMethodName(clips) {
      const used = new Set((clips || []).map((clip) => clip && clip.method).filter(Boolean));
      let base = 'GetSong';
      const first = clips && clips.length > 0 ? String(clips[0].method || '') : '';
      const prefix = first.replace(/\d+$/, '');
      if (['GetSong', 'Period', 'Song', 'Audio'].indexOf(prefix) !== -1) base = prefix;
      if (!used.has(base)) return base;
      let index = 1;
      while (used.has(base + index)) index += 1;
      return base + index;
    }

    /**
     * Recompute `project.duration` exactly like the Host model does: the last
     * element end, extended by every audio clip end. Deleting the audio staff
     * locally must shrink the transport, not leave a stale length.
     */
    function recomputeLocalDuration(project) {
      let lastEnd = 0;
      for (const staff of project.staffs || []) {
        for (const period of staff.periods || []) {
          for (const element of period.elements || []) {
            const end = (element.start || 0) + (element.duration || 0);
            if (Number.isFinite(end) && end > lastEnd) lastEnd = end;
          }
        }
      }
      for (const clip of audioClipsOf(project)) {
        const end = (Number.isFinite(clip.offset) ? clip.offset : 0) + (Number.isFinite(clip.duration) ? clip.duration : 0);
        if (Number.isFinite(end) && end > lastEnd) lastEnd = end;
      }
      project.duration = round(Math.max(lastEnd, 0), 6);
      return project.duration;
    }

    /**
     * Apply the Host's op list locally so the UI updates before the round trip.
     * Returns the new project plus the inverse ops (used for undo).
     */
    function applyOpsLocal(project, ops, catalog) {
      const next = deepClone(project);
      const inverse = [];
      const errors = [];
      for (const op of ops || []) {
        try {
          if (!op || typeof op !== 'object') continue;
          if (op.op === 'patch') {
            const found = findElement(next, op.elementId);
            if (!found) {
              errors.push('unknown element ' + op.elementId);
              continue;
            }
            const path = Array.isArray(op.path) ? op.path : [];
            const previous = getAtPath(found.element.fields, path);
            if (path.length === 0) {
              inverse.push({ op: 'patch', elementId: op.elementId, path: [], value: deepClone(found.element.fields) });
              found.element.fields = deepClone(op.value) || {};
            } else {
              inverse.push({ op: 'patch', elementId: op.elementId, path: deepClone(path), value: deepClone(previous) });
              found.element.fields = setAtPath(found.element.fields, path, op.value);
            }
            deriveTiming(found.element, found.period, catalog);
          } else if (op.op === 'add') {
            const staff = (next.staffs || []).find((item) => item.id === op.staffId);
            if (!staff) {
              errors.push('unknown staff ' + op.staffId);
              continue;
            }
            if (!op.element || typeof op.element.type !== 'string') {
              errors.push('add requires element.type');
              continue;
            }
            const explicitPeriod = typeof op.periodId === 'string' && op.periodId.length > 0;
            const absoluteStart = op.element.start !== undefined && Number.isFinite(Number(op.element.start)) ? Number(op.element.start) : 0;
            let period = null;
            if (explicitPeriod) {
              period = (staff.periods || []).find((item) => item.id === op.periodId) || null;
              if (!period) {
                errors.push('unknown period ' + op.periodId + ' in ' + op.staffId);
                continue;
              }
            } else if ((staff.periods || []).length === 0) {
              // Mirror the Host: an `add` without a period allocates one.
              period = { id: 'p0', method: 'Period', timeOffset: round(absoluteStart, 6), minLength: null, elements: [] };
              staff.periods = [period];
            } else {
              const periodId = pickPeriod(next, op.staffId, absoluteStart);
              period = (staff.periods || []).find((item) => item.id === periodId) || (staff.periods || [])[0];
            }
            const fields = deepClone(op.element.fields) || {};
            const entry = catalogEntry(catalog, op.element.type);
            const timing = (entry && entry.timing) || {};
            if (!explicitPeriod && timing.start && fields[timing.start] === undefined) {
              fields[timing.start] = round(absoluteStart - (Number.isFinite(period.timeOffset) ? period.timeOffset : 0), 6);
            }
            const element = {
              id: op.element.id || 'new:' + Math.random().toString(36).slice(2, 10),
              type: op.element.type,
              fields,
            };
            element.category = elementCategory(catalog, element.type);
            deriveTiming(element, period, catalog);
            period.elements = period.elements || [];
            period.elements.push(element);
            inverse.push({ op: 'remove', elementId: element.id });
          } else if (op.op === 'remove') {
            const found = findElement(next, op.elementId);
            if (!found) {
              errors.push('unknown element ' + op.elementId);
              continue;
            }
            inverse.push({
              op: 'add',
              staffId: found.staff.id,
              periodId: found.period.id,
              element: { id: found.element.id, type: found.element.type, fields: deepClone(found.element.fields) },
            });
            found.period.elements.splice(found.elementIndex, 1);
          } else if (op.op === 'addAudioPeriod') {
            let staff = null;
            if (typeof op.staffId === 'string' && op.staffId.length > 0) {
              staff = (next.staffs || []).find((item) => item.id === op.staffId) || null;
              if (!staff) {
                errors.push('unknown staff ' + op.staffId);
                continue;
              }
              if (staff.kind !== 'audio') {
                errors.push('staff ' + staff.id + ' is not an audio staff');
                continue;
              }
            } else {
              staff = (next.staffs || []).find((item) => item && item.kind === 'audio') || null;
            }
            let createdStaff = false;
            if (!staff) {
              const identity = uniqueStaffIdentity(next, 'audio');
              const dir = typeof next.dir === 'string' ? next.dir.replace(/\/$/, '') : '';
              staff = {
                id: identity.fileName,
                file: dir ? dir + '/' + identity.fileName : identity.fileName,
                kind: 'audio',
                form: '',
                displayName: '新音频',
                className: identity.className,
                periods: [],
                audioPeriods: [],
              };
              next.staffs = next.staffs || [];
              next.staffs.push(staff);
              createdStaff = true;
            }
            const relativeFile = String(op.file || '').replace(/\\/g, '/');
            if (!relativeFile) {
              errors.push('addAudioPeriod requires file');
              continue;
            }
            const clips = staff.audioPeriods || (staff.audioPeriods = []);
            const method = typeof op.method === 'string' && op.method.length > 0 ? op.method : nextAudioMethodName(clips);
            const extension = relativeFile.indexOf('.') === -1 ? '' : relativeFile.slice(relativeFile.lastIndexOf('.'));
            const baseName = relativeFile.split('/').pop() || relativeFile;
            const name = typeof op.name === 'string' && op.name.trim().length > 0 ? op.name.trim() : baseName.slice(0, baseName.length - extension.length);
            const offset = Number.isFinite(Number(op.timeOffset)) ? round(Number(op.timeOffset), 6) : 0;
            const dir = typeof next.dir === 'string' ? next.dir.replace(/\/$/, '') : '';
            let maxIndex = -1;
            for (const clip of clips) {
              const match = /^a(\d+)$/.exec(String(clip.id || ''));
              if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
            }
            const clip = {
              id: 'a' + (maxIndex + 1),
              staffId: staff.id,
              method,
              name,
              assetType: 'GorgeFramework.WavAudioAsset',
              relativePath: relativeFile,
              file: dir ? dir + '/' + relativeFile : relativeFile,
              offset,
              duration: Number.isFinite(Number(op.duration)) ? round(Number(op.duration), 6) : null,
              sampleRate: null,
              channels: null,
              format: null,
              missing: false,
            };
            clips.push(clip);
            refreshLocalAudio(next);
            // Undo runs the inverse list in reverse: remove the clip before the
            // staff it was auto-created in.
            if (createdStaff) inverse.push({ op: 'removeStaff', staffId: staff.id });
            inverse.push({ op: 'removeAudioPeriod', staffId: staff.id, audioPeriodId: clip.id });
          } else if (op.op === 'patchAudioPeriod') {
            const found = findAudioClip(next, op.staffId, op.audioPeriodId);
            if (!found) {
              errors.push('unknown audio period ' + op.audioPeriodId);
              continue;
            }
            const fields = op.fields && typeof op.fields === 'object' ? op.fields : {};
            const previous = {};
            if (fields.timeOffset !== undefined && Number.isFinite(Number(fields.timeOffset))) {
              previous.timeOffset = found.clip.offset;
              found.clip.offset = round(Number(fields.timeOffset), 6);
            }
            if (typeof fields.name === 'string' && fields.name.trim().length > 0) {
              previous.name = found.clip.name;
              found.clip.name = fields.name.trim();
            }
            if (typeof fields.file === 'string' && fields.file.length > 0) {
              previous.file = found.clip.relativePath || found.clip.file;
              found.clip.relativePath = fields.file.replace(/\\/g, '/');
              const dir = typeof next.dir === 'string' ? next.dir.replace(/\/$/, '') : '';
              found.clip.file = dir ? dir + '/' + found.clip.relativePath : found.clip.relativePath;
            }
            refreshLocalAudio(next);
            inverse.push({ op: 'patchAudioPeriod', staffId: found.staff.id, audioPeriodId: found.clip.id, fields: previous });
          } else if (op.op === 'removeAudioPeriod') {
            const found = findAudioClip(next, op.staffId, op.audioPeriodId);
            if (!found) {
              errors.push('unknown audio period ' + op.audioPeriodId);
              continue;
            }
            if (found.clip.relativePath) {
              inverse.push({
                op: 'addAudioPeriod',
                staffId: found.staff.id,
                file: found.clip.relativePath,
                name: found.clip.name,
                timeOffset: found.clip.offset,
                method: found.clip.method,
              });
            }
            found.staff.audioPeriods = (found.staff.audioPeriods || []).filter((clip) => clip !== found.clip);
            refreshLocalAudio(next);
          } else if (op.op === 'setMeta') {
            const previous = { op: 'setMeta' };
            if (op.tempo) {
              previous.tempo = deepClone(next.tempo);
              next.tempo = Object.assign({}, next.tempo || {}, op.tempo);
            }
            if (op.title !== undefined) {
              previous.title = next.title;
              next.title = op.title;
            }
            inverse.push(previous);
          } else if (op.op === 'setStaffName') {
            const staff = (next.staffs || []).find((item) => item.id === op.staffId);
            if (!staff) {
              errors.push('unknown staff ' + op.staffId);
              continue;
            }
            inverse.push({ op: 'setStaffName', staffId: op.staffId, displayName: staff.displayName });
            staff.displayName = op.displayName;
          } else if (op.op === 'addStaff') {
            const kind = op.kind === 'storyboard' ? 'storyboard' : op.kind === 'audio' ? 'audio' : 'chart';
            const className =
              typeof op.className === 'string' && op.className.length > 0
                ? op.className
                : (typeof op.fileName === 'string' && op.fileName.length > 0 ? op.fileName.replace(/\.g$/i, '') : kind === 'storyboard' ? 'Storyboard' : kind === 'audio' ? 'Song' : 'Staff');
            const fileName =
              typeof op.fileName === 'string' && op.fileName.length > 0 ? op.fileName : className + '.g';
            const form =
              kind === 'audio'
                ? ''
                : kind === 'storyboard' ? 'DeentyStoryboard' : typeof op.form === 'string' && op.form.length > 0 ? op.form : 'Dremu';
            const displayName =
              typeof op.displayName === 'string' && op.displayName.trim().length > 0
                ? op.displayName.trim()
                : kind === 'storyboard' ? '新剧情板' : kind === 'audio' ? '新音频' : '新谱表';
            if ((next.staffs || []).some((item) => String(item.id).toLowerCase() === fileName.toLowerCase())) {
              errors.push('staff already exists: ' + fileName);
              continue;
            }
            const timeOffset = Number.isFinite(op.timeOffset) ? op.timeOffset : 0;
            const minLength = Number.isFinite(op.minLength) ? op.minLength : null;
            const dir = typeof next.dir === 'string' ? next.dir.replace(/\/$/, '') : '';
            next.staffs = next.staffs || [];
            next.staffs.push({
              id: fileName,
              file: dir ? dir + '/' + fileName : fileName,
              kind,
              form,
              displayName,
              className,
              periods:
                kind === 'audio'
                  ? []
                  : [
                      {
                        id: 'p0',
                        method: 'Period',
                        timeOffset: round(timeOffset, 6),
                        minLength,
                        elements: [],
                      },
                    ],
              ...(kind === 'audio' ? { audioPeriods: [] } : {}),
            });
            inverse.push({ op: 'removeStaff', staffId: fileName });
          } else if (op.op === 'removeStaff') {
            const staffIndex = (next.staffs || []).findIndex((item) => item.id === op.staffId);
            if (staffIndex === -1) {
              errors.push('unknown staff ' + op.staffId);
              continue;
            }
            const staff = next.staffs[staffIndex];
            const period = (staff.periods || [])[0] || null;
            next.staffs.splice(staffIndex, 1);
            refreshLocalAudio(next);
            // Undo runs the inverse list in reverse: queue the audio periods
            // before the `addStaff` that recreates their owner, so the staff
            // exists by the time they are re-added.
            if (staff.kind === 'audio') {
              for (const clip of staff.audioPeriods || []) {
                if (!clip.relativePath) continue;
                inverse.push({
                  op: 'addAudioPeriod',
                  staffId: staff.id,
                  file: clip.relativePath,
                  name: clip.name,
                  timeOffset: clip.offset,
                  method: clip.method,
                });
              }
            }
            inverse.push({
              op: 'addStaff',
              kind: staff.kind === 'storyboard' ? 'storyboard' : staff.kind === 'audio' ? 'audio' : 'chart',
              form: staff.form,
              displayName: staff.displayName,
              className: staff.className,
              fileName: staff.id,
              timeOffset: period && Number.isFinite(period.timeOffset) ? period.timeOffset : 0,
              minLength: period && Number.isFinite(period.minLength) ? period.minLength : null,
            });
          } else {
            errors.push('unsupported op ' + op.op);
          }
        } catch (error) {
          errors.push(String((error && error.message) || error));
        }
      }
      if (inverse.length > 0) recomputeLocalDuration(next);
      return { project: next, inverse, errors };
    }

    // ========================================================================
    // 05 · Stylesheet.
    // Rendered as a React element by the page so unmounting removes it; only
    // theme tokens are used for chrome colours.
    // ========================================================================

    const STYLE_TEXT = [
      '.dgc-root{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;overflow:hidden;position:relative}',
      '.dgc-header{display:flex;align-items:center;gap:10px;padding:0 14px;height:46px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-title{display:flex;flex-direction:column;min-width:0;margin-right:4px}',
      '.dgc-title strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}',
      '.dgc-title span{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}',
      '.dgc-spacer{flex:1 1 auto}',
      '.dgc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;height:28px;padding:0 10px;font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}',
      '.dgc-autoBpm{height:24px;padding:0 7px;font-size:11px;flex:0 0 auto}',
      '.dgc-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-btn:disabled{opacity:.45;cursor:default}',
      '.dgc-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dgc-btn.is-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}',
      '.dgc-btn.is-ghost{background:transparent;border-color:transparent;padding:0 8px}',
      '.dgc-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.dgc-btn.is-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dgc-btn.is-active{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dgc-icon{width:16px;height:16px;display:block}',
      '.dgc-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dgc-badge.is-dirty{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.dgc-badge.is-clean{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.dgc-input{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;height:26px;padding:0 8px;font:inherit;font-size:12px;min-width:0;width:100%;box-sizing:border-box}',
      '.dgc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dgc-input.is-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}',
      '.dgc-select{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;height:26px;padding:0 6px;font:inherit;font-size:12px;cursor:pointer}',
      '.dgc-toolbar{display:flex;align-items:center;gap:6px;padding:6px 12px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}',
      '.dgc-toolgroup{display:flex;align-items:center;gap:4px;padding-right:8px;margin-right:2px;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-toolgroup:last-child{border-right:none}',
      '.dgc-toolbar label{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dgc-body{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}',
      '.dgc-side{flex:0 0 236px;min-width:180px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-height:0}',
      '.dgc-sideSection{display:flex;flex-direction:column;min-height:0}',
      '.dgc-sideSection.is-staffs{flex:0 0 auto;max-height:46%;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-sideSection.is-elements{flex:1 1 auto;min-height:0}',
      '.dgc-sideHead{display:flex;align-items:center;gap:6px;padding:7px 10px 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dgc-sideHead .dgc-spacer{flex:1}',
      '.dgc-headBtn{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);width:20px;height:20px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:0 0 auto}',
      '.dgc-headBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.dgc-headBtn:disabled{opacity:.4;cursor:default}',
      '.dgc-list{overflow:auto;min-height:0;flex:1 1 auto;padding:0 6px 8px}',
      '.dgc-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;user-select:none}',
      '.dgc-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dgc-row.is-active{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)}',
      '.dgc-row .dgc-dot{width:8px;height:8px;border-radius:2px;flex:0 0 auto}',
      '.dgc-row .dgc-rowLabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
      '.dgc-row .dgc-rowMeta{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-row .dgc-rowBtn{opacity:.55;border:none;background:none;color:inherit;cursor:pointer;padding:0 2px;font-size:11px}',
      '.dgc-row .dgc-rowBtn:hover{opacity:1}',
      '.dgc-menu{position:fixed;z-index:80;min-width:186px;max-width:260px;padding:4px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:1px}',
      '.dgc-menuHead{padding:5px 8px 6px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-menuItem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dgc-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dgc-menuItem.is-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dgc-menuItem.is-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
      '.dgc-warnCard{border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:12px;line-height:17px}',
      '.dgc-groupHead{display:flex;align-items:center;gap:6px;margin:6px 0 2px;padding:3px 6px;font-size:10.5px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);text-transform:uppercase;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-groupHead:first-child{margin-top:0;border-top:none}',
      '.dgc-hint{padding:10px 12px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dgc-center{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-base)}',
      '.dgc-canvasWrap{flex:1 1 auto;min-height:0;position:relative;overflow:hidden}',
      '.dgc-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:default}',
      '.dgc-inspector{flex:0 0 322px;min-width:260px;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-height:0}',
      '.dgc-inspectorBody{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 16px}',
      '.dgc-sectionTitle{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);margin:10px 0 6px}',
      '.dgc-sectionTitle:first-child{margin-top:0}',
      '.dgc-field{display:grid;grid-template-columns:104px minmax(0,1fr);gap:8px;align-items:center;padding:2px 0}',
      '.dgc-fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dgc-fieldBody{display:flex;align-items:center;gap:5px;min-width:0}',
      '.dgc-fieldControl{flex:1 1 auto;min-width:0}',
      '.dgc-optionalCheck{width:13px;height:13px;margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dgc-optionalHint{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-fieldBody .dgc-input{height:24px;font-size:12px}',
      '.dgc-numWrap{position:relative;flex:1 1 auto;min-width:0}',
      '.dgc-tree{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;margin:4px 0 6px;background:var(--dsw-alias-bg-layer-2)}',
      '.dgc-treeHead{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.dgc-chips{display:flex;flex-wrap:wrap;gap:4px}',
      '.dgc-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:999px;padding:1px 8px;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dgc-chip.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dgc-transport{display:flex;align-items:center;gap:10px;padding:7px 12px;flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-clock{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-width:128px}',
      '.dgc-scrub{flex:1 1 auto;position:relative;height:22px;display:flex;align-items:center;min-width:80px}',
      '.dgc-scrub input{width:100%;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dgc-status{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
      '.dgc-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-bg-base) 76%, transparent);z-index:4;padding:24px}',
      '.dgc-overlayCard{max-width:520px;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);border-radius:12px;padding:18px 20px;box-shadow:0 12px 32px rgba(0,0,0,.28)}',
      '.dgc-overlayCard h3{margin:0 0 6px;font-size:14px;font-weight:600}',
      '.dgc-overlayCard p{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dgc-rowActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dgc-modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dgc-modal{width:min(760px,94vw);max-height:86vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.36);overflow:hidden}',
      '.dgc-modalHead{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-modalHead h3{margin:0;font-size:13.5px;font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dgc-modalBody{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}',
      '.dgc-modalCanvas{flex:1 1 auto;min-width:0;position:relative;background:var(--dsw-alias-bg-base)}',
      '.dgc-modalSide{flex:0 0 300px;min-width:220px;overflow:auto;padding:10px 12px;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-modalFoot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-dialogBody{display:flex;flex-direction:column;gap:10px;padding:12px 14px}',
      '.dgc-dialogField{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dgc-dialogField .dgc-input{height:28px;font-size:12.5px}',
      '.dgc-kindGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.dgc-kindCard{appearance:none;text-align:left;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:2px;font:inherit}',
      '.dgc-kindCard strong{font-size:12.5px;font-weight:600}',
      '.dgc-kindCard span{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary)}',
      '.dgc-kindCard.is-active{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent)}',
      '.dgc-dialogFoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-paletteMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 14px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dgc-paletteList{max-height:min(52vh,430px);overflow:auto;padding:0 8px 10px;min-height:0}',
      '.dgc-paletteRow{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;border:1px solid transparent;background:transparent;width:100%;font:inherit;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dgc-paletteRow:hover,.dgc-paletteRow:focus-visible{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);outline:none}',
      '.dgc-paletteRow strong{font-size:12.5px;font-weight:500}',
      '.dgc-paletteRow .dgc-rowMeta{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dgc-swatch{width:9px;height:9px;border-radius:3px;flex:0 0 auto}',
      '.dgc-dialogEmpty{padding:20px 14px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dgc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.dgc-empty h3{margin:0;font-size:14px;color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dgc-listRowSlim{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:1px 4px}',
      '.dgc-tag{font-size:10px;border-radius:4px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.dgc-offline{color:var(--dsw-alias-state-warn-primary)}',
      '.dgc-err{color:var(--dsw-alias-state-error-primary)}',
      '.dgc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.dgc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.dgc-player{position:absolute;inset:0;z-index:50;display:flex;flex-direction:column;background:#0b1220;color:#e8eef9}',
      '.dgc-playerHead{display:flex;align-items:center;gap:8px;padding:0 14px;height:46px;flex:0 0 auto;background:rgba(10,16,26,.9);border-bottom:1px solid rgba(255,255,255,.12)}',
      '.dgc-playerTitle{display:flex;flex-direction:column;min-width:0;margin-right:4px}',
      '.dgc-playerTitle strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}',
      '.dgc-playerTitle span{font-size:11px;color:rgba(232,238,249,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}',
      '.dgc-playerBadge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.18);color:rgba(232,238,249,.78);white-space:nowrap}',
      '.dgc-playerBadge.is-warn{color:#fbbf24;border-color:currentColor}',
      '.dgc-playerStage{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center}',
      '.dgc-playerFrame{position:relative;flex:0 0 auto;overflow:hidden}',
      '.dgc-playerCanvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
      '.dgc-playerEmpty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(232,238,249,.72);font-size:13px;pointer-events:none;text-align:center;padding:24px}',
      '.dgc-playerNote{position:absolute;left:14px;bottom:10px;font-size:11px;color:rgba(232,238,249,.55);pointer-events:none}',
      '.dgc-playerBar{display:flex;align-items:center;gap:10px;padding:8px 14px;flex:0 0 auto;background:rgba(10,16,26,.9);border-top:1px solid rgba(255,255,255,.12)}',
      '.dgc-playerBar .dgc-clock{color:#e8eef9;min-width:118px}',
      '.dgc-player .dgc-btn{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.18);color:#e8eef9}',
      '.dgc-player .dgc-btn:hover:not(:disabled){background:rgba(255,255,255,.16)}',
      '.dgc-player .dgc-btn.is-primary{background:#3b82f6;border-color:transparent;color:#fff}',
      '.dgc-player .dgc-btn.is-ghost{background:transparent}',
      '.dgc-playerLabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:rgba(232,238,249,.72);white-space:nowrap}',
      '.dgc-playerLabel .dgc-select{background:rgba(255,255,255,.08);color:#e8eef9;border-color:rgba(255,255,255,.18)}',
      '.dgc-playerCheck{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:rgba(232,238,249,.72);white-space:nowrap}',
      '.dgc-curveLayer{position:relative;flex:1 1 auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-height:0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-center.has-curve .dgc-canvasWrap{flex:0 0 auto;height:var(--dgc-timeline-h,38%);min-height:120px;max-height:58%;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dgc-curveHead{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:0 0 auto;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-curveTitle{display:flex;flex-direction:column;min-width:0;margin-right:4px;flex:0 1 auto}',
      '.dgc-curveTitle strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}',
      '.dgc-curveTitle span{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}',
      '.dgc-curveBody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.dgc-curvePlot{flex:1 1 auto;min-width:0;min-height:120px;position:relative;background:var(--dsw-alias-bg-base)}',
      '.dgc-curveCanvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:default}',
      '.dgc-curveSide{flex:0 1 auto;width:100%;min-width:0;min-height:0;max-height:46%;display:flex;flex-direction:column;border-left:none;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dgc-curveSideBody{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 12px 18px}',
      '.dgc-curveSegList{display:flex;flex-direction:column;gap:2px;margin:0 0 6px;max-height:190px;overflow:auto}',
      '.dgc-curveSeg{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;cursor:pointer;border:1px solid transparent;min-width:0}',
      '.dgc-curveSeg:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dgc-curveSeg.is-active{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent)}',
      '.dgc-curveSegColor{width:8px;height:8px;border-radius:2px;flex:0 0 auto}',
      '.dgc-curveSegLabel{flex:1 1 auto;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-curveSegMeta{flex:0 1 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}',
      '.dgc-curveWarn{border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent);border-radius:8px;padding:6px 8px;margin:6px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary)}',
      '.dgc-curveWarn strong{display:block;font-weight:600;margin-bottom:2px}',
      '.dgc-curveWarnRow{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dgc-curveWarnHead{display:flex;align-items:center;gap:6px;margin-bottom:2px}',
      '.dgc-curveWarnHead strong{flex:1 1 auto;display:block;margin:0;font-weight:600}',
      '.dgc-curveAutoFix{height:22px;padding:0 7px;font-size:11px;flex:0 0 auto}',
      '.dgc-curveNote{margin:8px 0 2px;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dgc-curveFoot{display:flex;align-items:center;gap:10px;padding:6px 12px;flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.dgc-curveHint{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-noteEditor{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dgc-noteEditorHead{flex:0 0 auto;min-height:34px;display:flex;align-items:center;gap:8px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.dgc-noteEditorTitle{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%}',
      '.dgc-noteEditorMeta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;max-width:34%}',
      '.dgc-noteEditorHint{flex:1 1 auto;min-width:0;text-align:right;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dgc-noteCanvasWrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}',
      '.dgc-noteCanvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:default}',
    ].join('\n');

    /** Stylesheet element rendered by the page (removed with the page). */
    function StyleSheet() {
      return h('style', { 'data-gorge-chart-studio': 'true' }, STYLE_TEXT);
    }

    /** Cached style token colours resolved from the document (canvas drawing). */
    const tokenCache = new Map();
    function cssToken(name, fallback) {
      if (tokenCache.has(name)) return tokenCache.get(name);
      let value = fallback;
      try {
        const resolved = window.getComputedStyle(document.documentElement).getPropertyValue(name);
        if (resolved && resolved.trim()) value = resolved.trim();
      } catch (error) {
        /* keep the fallback */
      }
      tokenCache.set(name, value);
      return value;
    }
    /** Drop the token cache (theme switches). */
    function resetTokenCache() {
      tokenCache.clear();
    }

    // ========================================================================
    // 06 · Host bridge: state fetch, SSE, optimistic edits, undo/redo.
    // ========================================================================

    /** GET JSON with an abort signal; throws a readable Error on failure. */
    async function fetchJson(url, options) {
      const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok) {
        const message = body && (body.error || body.message) ? body.error || body.message : 'HTTP ' + response.status;
        const error = new Error(message);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    }

    /** `1234567` -> `1.2 MB` for export notices. */
    function formatByteSize(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit];
    }

    /** Hand a Blob to the browser as a file download (hidden anchor). */
    function saveBlobAsFile(blob, filename) {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('this browser cannot create a download');
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      if (document.body && typeof document.body.appendChild === 'function') document.body.appendChild(link);
      link.click();
      if (document.body && typeof document.body.removeChild === 'function') document.body.removeChild(link);
      // Revoking immediately can cancel the download in some browsers; a
      // minute is far longer than navigation to the blob URL takes.
      const timer = window.setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (error) {
          /* the browser may already have revoked it */
        }
      }, 60000);
      // Node-based harnesses must not wait a minute for the process to exit.
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    /**
     * One shared chart document session: server state plus the local optimistic
     * copy, the edit queue, and the undo/redo stacks.
     */
    function useChartSession() {
      const [state, setState] = useState(null);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState(null);
      const [connection, setConnection] = useState('connecting');
      const [saving, setSaving] = useState(false);
      const [exporting, setExporting] = useState(false);
      /** Download progress in whole percent, or null before bytes arrive. */
      const [exportPercent, setExportPercent] = useState(null);
      const [notice, setNotice] = useState(null);

      const stateRef = useRef(null);
      /** Latest optimistic project: the base for every local op application. */
      const projectRef = useRef(null);
      const exportingRef = useRef(false);
      const serverRevRef = useRef(0);
      const queueRef = useRef(Promise.resolve());
      const historyRef = useRef({ past: [], future: [] });
      const inflightRef = useRef(0);
      /** Highest revision seen on SSE that this tab did not produce yet. */
      const pendingRevRef = useRef(0);
      const mountedRef = useRef(true);

      stateRef.current = state;

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      /** Replace the whole client state from a Host payload. */
      const acceptState = useCallback((payload, options) => {
        if (!payload || typeof payload !== 'object') return;
        const settings = options || {};
        serverRevRef.current = Number.isFinite(payload.rev) ? payload.rev : serverRevRef.current;
        projectRef.current = payload.project || null;
        pendingRevRef.current = 0;
        setState(payload);
        setPhase(payload.project ? 'ready' : 'empty');
        setError(null);
        if (settings.keepHistory !== true) historyRef.current = { past: [], future: [] };
      }, []);

      /** Refetch the whole document (agent edits, open, reload, conflict). */
      const refresh = useCallback(async (options) => {
        try {
          const payload = await fetchJson(STATE_URL);
          if (!mountedRef.current) return;
          acceptState(payload, options);
        } catch (failure) {
          if (!mountedRef.current) return;
          setError(String((failure && failure.message) || failure));
          setPhase((current) => (current === 'ready' ? current : 'error'));
        }
      }, [acceptState]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      // SSE: the Host notifies `{rev, dirty}`. A revision this tab did not
      // produce means an agent/tool changed the project — refetch everything.
      useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        let source;
        try {
          source = new EventSource(EVENTS_URL);
        } catch (failure) {
          setConnection('offline');
          return undefined;
        }
        source.onopen = () => setConnection('online');
        source.onerror = () => setConnection('offline');
        source.onmessage = (event) => {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch (failure) {
            payload = null;
          }
          if (!payload) return;
          if (payload.rev !== undefined && payload.rev !== serverRevRef.current) {
            // An agent/tool edit produced this revision. Refetch, unless our own
            // edit batch is in flight — then remember it and refetch when the
            // queue drains (otherwise the page stays on a stale project).
            if (inflightRef.current === 0) refresh();
            else pendingRevRef.current = Math.max(pendingRevRef.current, payload.rev);
          }
          if (payload.dirty !== undefined) {
            setState((current) => (current ? Object.assign({}, current, { dirty: payload.dirty }) : current));
          }
        };
        return () => {
          try {
            source.close();
          } catch (error) {
            /* ignore */
          }
        };
      }, [refresh]);

      /** Push one op batch to the Host, serialised so baseRev stays current. */
      const pushOps = useCallback(
        (ops) => {
          inflightRef.current += 1;
          const send = async (batch, attempt) => {
            const baseRev = serverRevRef.current;
            try {
              const result = await fetchJson(EDIT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ baseRev, ops: batch }),
              });
              if (result && Number.isFinite(result.rev)) serverRevRef.current = result.rev;
              if (!mountedRef.current) return;
              setState((current) =>
                current
                  ? Object.assign({}, current, {
                      rev: result && Number.isFinite(result.rev) ? result.rev : current.rev,
                      dirty: result && result.dirty !== undefined ? result.dirty : true,
                    })
                  : current,
              );
              const errors = result && Array.isArray(result.errors) ? result.errors : [];
              const rejected = result && result.changed === false;
              if (errors.length > 0 || rejected) {
                setNotice({ kind: 'error', text: noticeText('errorPrefix') + (errors.length > 0 ? errors.join('; ') : noticeText('errorGeneric')) });
                // The Host did not (fully) accept the batch: resync so the page
                // never shows an edit the document does not contain.
                refresh();
              }
            } catch (failure) {
              if (failure && failure.status === 409 && attempt === 0) {
                // Someone else changed the revision: resync, re-apply the batch
                // on top of the fresh state, then retry once with the new baseRev.
                await refresh();
                if (projectRef.current) applyOptimisticRef.current(batch);
                return send(batch, 1);
              }
              if (mountedRef.current) {
                setNotice({ kind: 'error', text: noticeText('errorPrefix') + String((failure && failure.message) || failure) });
                if (failure && failure.status === 409) refresh();
              }
            }
          };
          queueRef.current = queueRef.current
            .then(() => send(ops, 0))
            .catch(() => undefined)
            .then(() => {
              inflightRef.current = Math.max(0, inflightRef.current - 1);
              if (inflightRef.current === 0 && mountedRef.current && pendingRevRef.current > serverRevRef.current) {
                pendingRevRef.current = 0;
                refresh();
              }
            });
          return queueRef.current;
        },
        [refresh],
      );

      /**
       * Apply one op batch optimistically against the latest project and mirror
       * it into React state. Returns the inverse ops and any local errors.
       */
      const applyOptimistic = useCallback((ops) => {
        const current = stateRef.current;
        const base = projectRef.current;
        if (!current || !base) return { inverse: [], errors: ['no open project'] };
        const result = applyOpsLocal(base, ops, current.catalog);
        projectRef.current = result.project;
        setState((previous) => (previous ? Object.assign({}, previous, { project: result.project, dirty: true }) : previous));
        return { inverse: result.inverse, errors: result.errors };
      }, []);
      const applyOptimisticRef = useRef(applyOptimistic);
      applyOptimisticRef.current = applyOptimistic;

      /**
       * Apply ops (instant UI) and queue them for the Host. When `record` is
       * true the inverse ops land on the undo stack. The inverse is computed
       * synchronously here — never inside a setState updater, which React may
       * defer until after this function returns.
       */
      const edit = useCallback(
        (ops, options) => {
          const settings = options || {};
          if (!Array.isArray(ops) || ops.length === 0) return;
          const result = applyOptimistic(ops);
          if (settings.record !== false) {
            historyRef.current.past.push({ ops: deepClone(ops), inverse: deepClone(result.inverse) });
            if (historyRef.current.past.length > MAX_HISTORY) historyRef.current.past.shift();
            historyRef.current.future = [];
          }
          if (result.errors.length > 0) setNotice({ kind: 'error', text: result.errors.join('; ') });
          if (settings.sync !== false) {
            const pending = pushOps(ops);
            // Audio-period ops need the Host's probe metadata (duration, file
            // existence) to render/play the new clip; refetch canonically while
            // keeping this gesture on the undo stack.
            if (ops.some((op) => op && typeof op.op === 'string' && op.op.indexOf('AudioPeriod') !== -1)) {
              pending.then(() => refresh({ keepHistory: true })).catch(() => undefined);
            }
          }
        },
        [applyOptimistic, pushOps, refresh],
      );

      /** Undo the last recorded op batch (local + Host). Inverse ops run in reverse. */
      const undo = useCallback(() => {
        const entry = historyRef.current.past.pop();
        if (!entry) return;
        const inverseOps = entry.inverse.slice().reverse();
        applyOptimistic(inverseOps);
        historyRef.current.future.push(entry);
        pushOps(inverseOps);
      }, [applyOptimistic, pushOps]);

      /** Redo the last undone batch. */
      const redo = useCallback(() => {
        const entry = historyRef.current.future.pop();
        if (!entry) return;
        applyOptimistic(entry.ops);
        historyRef.current.past.push(entry);
        pushOps(entry.ops);
      }, [applyOptimistic, pushOps]);

      /** POST /open with an absolute path or a library name. */
      const openProject = useCallback(
        async (dir) => {
          setSaving(false);
          try {
            const payload = await fetchJson(OPEN_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dir }),
            });
            acceptState(payload);
            return true;
          } catch (failure) {
            setNotice({ kind: 'error', text: noticeText('loadFailed') + ': ' + String((failure && failure.message) || failure) });
            return false;
          }
        },
        [acceptState],
      );

      /**
       * POST /create and adopt the new project. Answers `{ ok: true }` or
       * `{ ok: false, error }` so the dialog can show the Host's validation
       * message inline instead of closing.
       */
      const createProject = useCallback(
        async (request) => {
          try {
            const payload = await fetchJson(CREATE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request || {}),
            });
            acceptState(payload);
            const name = payload && payload.created && payload.created.name ? payload.created.name : (request && request.name) || '';
            setNotice({ kind: 'ok', text: noticeText('projectCreated') + (name ? ' · ' + name : '') });
            return { ok: true };
          } catch (failure) {
            return { ok: false, error: String((failure && failure.message) || failure) };
          }
        },
        [acceptState],
      );

      /** Force a Host-side save of the open project. */
      const save = useCallback(async () => {
        if (!stateRef.current || !stateRef.current.project) return false;
        setSaving(true);
        try {
          await queueRef.current;
          const result = await fetchJson(SAVE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setState((current) => (current ? Object.assign({}, current, { dirty: false }) : current));
          setNotice({
            kind: result && result.errors && result.errors.length > 0 ? 'error' : 'ok',
            text:
              result && result.errors && result.errors.length > 0
                ? result.errors.join('; ')
                : noticeText('saved') + (result && result.written ? ' · ' + result.written.length : ''),
          });
          return true;
        } catch (failure) {
          setNotice({ kind: 'error', text: noticeText('errorGeneric') + ': ' + String((failure && failure.message) || failure) });
          return false;
        } finally {
          setSaving(false);
        }
      }, []);

      /**
       * Download the open project as a chart `.zip` package.
       *
       * The Host builds the archive from its live document, so unsaved edits
       * are included; the client only waits for its pending edit queue so the
       * package matches what the editor shows. The response is streamed into a
       * Blob (with a percent readout) and saved through a hidden anchor.
       */
      const exportProject = useCallback(async () => {
        const current = stateRef.current;
        if (!current || !current.project || exportingRef.current) return false;
        exportingRef.current = true;
        setExporting(true);
        setExportPercent(null);
        try {
          await queueRef.current;
          const response = await fetch(EXPORT_URL, { cache: 'no-store' });
          if (!response.ok) {
            let message = 'HTTP ' + response.status;
            try {
              const payload = await response.json();
              if (payload && (payload.error || payload.message)) message = payload.error || payload.message;
            } catch (error) {
              /* keep the HTTP status text */
            }
            throw new Error(message);
          }
          const header = (name) => (response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null);
          let filename = '';
          const encodedName = header('x-export-filename');
          if (encodedName) {
            try {
              filename = decodeURIComponent(encodedName);
            } catch (error) {
              filename = encodedName;
            }
          }
          if (!filename) {
            const dir = typeof current.project.dir === 'string' ? current.project.dir.replace(/[\\/]+$/, '') : '';
            const base = dir.slice(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1) || 'chart';
            filename = base + '.zip';
          }
          let blob;
          const total = Number(header('content-length')) || 0;
          if (response.body && typeof response.body.getReader === 'function' && typeof Blob === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let received = 0;
            let shownPercent = -1;
            for (;;) {
              const step = await reader.read();
              if (step.done) break;
              if (!step.value) continue;
              chunks.push(step.value);
              received += step.value.length;
              if (total > 0) {
                const percent = Math.min(100, Math.floor((received / total) * 100));
                if (percent !== shownPercent) {
                  shownPercent = percent;
                  setExportPercent(percent);
                }
              }
            }
            blob = new Blob(chunks, { type: 'application/zip' });
          } else {
            blob = await response.blob();
          }
          saveBlobAsFile(blob, filename);
          const skipped = Number(header('x-export-skipped'));
          const skippedText = Number.isFinite(skipped) && skipped > 0 ? ' · ' + skipped + ' ' + noticeText('exportSkipped') : '';
          setNotice({ kind: 'ok', text: noticeText('exported') + ' · ' + filename + ' · ' + formatByteSize(blob.size) + skippedText });
          return true;
        } catch (failure) {
          setNotice({ kind: 'error', text: noticeText('exportFailed') + ': ' + String((failure && failure.message) || failure) });
          return false;
        } finally {
          exportingRef.current = false;
          setExporting(false);
          setExportPercent(null);
        }
      }, []);

      /** Re-read the project from disk. */
      const reload = useCallback(async () => {
        try {
          const payload = await fetchJson(RELOAD_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          acceptState(payload);
          setNotice({ kind: 'ok', text: noticeText('reload') });
        } catch (failure) {
          setNotice({ kind: 'error', text: String((failure && failure.message) || failure) });
        }
      }, [acceptState]);

      return {
        state,
        phase,
        error,
        connection,
        saving,
        exporting,
        exportPercent,
        notice,
        setNotice,
        refresh,
        edit,
        undo,
        redo,
        canUndo: () => historyRef.current.past.length > 0,
        canRedo: () => historyRef.current.future.length > 0,
        historyRef,
        openProject,
        createProject,
        save,
        exportProject,
        reload,
      };
    }

    /** Translation for code outside React (notices): best-effort zh default. */
    function noticeText(key) {
      return zh[key] !== undefined ? zh[key] : key;
    }

    // ========================================================================
    // 07 · Audio: per-clip waveform peaks + a multi-<audio> transport.
    // ========================================================================

    /** Peak count used for the timeline waveform strip. */
    const WAVE_BINS = 4096;
    /**
     * Spectrogram resolution: dynamic time columns (about 44 per second, matching
     * a 23 ms FFT hop at 44.1 kHz so the strip stays crisp at ordinary zoom
     * levels) × log-frequency bands.
     */
    const SPECTRUM_MIN_COLUMNS = 360;
    const SPECTRUM_MAX_COLUMNS = 8192;
    const SPECTRUM_COLUMNS_PER_SECOND = 44;
    const SPECTRUM_BANDS = 128;
    const SPECTRUM_FFT = 1024;
    const SPECTRUM_MIN_HZ = 40;
    const SPECTRUM_MAX_HZ = 16000;

    /** Periodic Hann window for the STFT. */
    function hannWindow(size) {
      const window = new Float32Array(size);
      for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      return window;
    }
    const SPECTRUM_WINDOW = hannWindow(SPECTRUM_FFT);

    /** In-place iterative radix-2 FFT (length must be a power of two). */
    function fftInPlace(real, imag) {
      const n = real.length;
      for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          const tr = real[i];
          real[i] = real[j];
          real[j] = tr;
          const ti = imag[i];
          imag[i] = imag[j];
          imag[j] = ti;
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wLenR = Math.cos(angle);
        const wLenI = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let wR = 1;
          let wI = 0;
          const half = len >> 1;
          for (let j = 0; j < half; j += 1) {
            const uR = real[i + j];
            const uI = imag[i + j];
            const vR = real[i + j + half] * wR - imag[i + j + half] * wI;
            const vI = real[i + j + half] * wI + imag[i + j + half] * wR;
            real[i + j] = uR + vR;
            imag[i + j] = uI + vI;
            real[i + j + half] = uR - vR;
            imag[i + j + half] = uI - vI;
            const nextR = wR * wLenR - wI * wLenI;
            wI = wR * wLenI + wI * wLenR;
            wR = nextR;
          }
        }
      }
    }

    /**
     * Compute a compact spectrogram from a mono sample reader.
     *
     * `sampleAt(frame)` returns -1..1; `frames` is the clip length in samples.
     * The result has `columns × bands` 0..255 intensity values (row 0 = lowest
     * frequency). Column count scales with the clip duration (~12/s, clamped to
     * 360…8192) so the cached image can be downscaled on screen instead of
     * blurred up from a low-resolution strip.
     */
    function computeSpectrum(sampleAt, frames, sampleRate) {
      if (!(frames > 0) || !(sampleRate > 0) || typeof sampleAt !== 'function') return null;
      const duration = frames / sampleRate;
      const columns = Math.max(
        SPECTRUM_MIN_COLUMNS,
        Math.min(SPECTRUM_MAX_COLUMNS, Math.round(duration * SPECTRUM_COLUMNS_PER_SECOND)),
      );
      const bands = SPECTRUM_BANDS;
      const fftSize = SPECTRUM_FFT;
      const half = fftSize >> 1;
      const binHz = sampleRate / fftSize;
      const nyquist = sampleRate / 2;
      const maxHz = Math.max(SPECTRUM_MIN_HZ * 2, Math.min(SPECTRUM_MAX_HZ, nyquist * 0.95));
      const edges = new Float64Array(bands + 1);
      for (let b = 0; b <= bands; b += 1) {
        edges[b] = SPECTRUM_MIN_HZ * Math.pow(maxHz / SPECTRUM_MIN_HZ, b / bands);
      }
      const data = new Uint8Array(columns * bands);
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);
      for (let c = 0; c < columns; c += 1) {
        const center = Math.floor(((c + 0.5) / columns) * frames);
        const start = center - half;
        for (let i = 0; i < fftSize; i += 1) {
          const frame = start + i;
          real[i] = frame >= 0 && frame < frames ? sampleAt(frame) * SPECTRUM_WINDOW[i] : 0;
          imag[i] = 0;
        }
        fftInPlace(real, imag);
        for (let b = 0; b < bands; b += 1) {
          const from = Math.max(1, Math.floor(edges[b] / binHz));
          const to = Math.min(half - 1, Math.max(from, Math.ceil(edges[b + 1] / binHz) - 1));
          let power = 0;
          for (let i = from; i <= to; i += 1) {
            const magnitude = real[i] * real[i] + imag[i] * imag[i];
            if (magnitude > power) power = magnitude;
          }
          const normalized = Math.sqrt(power) / half;
          const db = 20 * Math.log10(normalized + 1e-7);
          const level = Math.max(0, Math.min(1, (db + 75) / 60));
          data[c * bands + b] = Math.round(level * 255);
        }
      }
      return { columns, bands, data, minHz: SPECTRUM_MIN_HZ, maxHz, sampleRate };
    }

    /** Heat-map colour for one spectrogram intensity (0..1). */
    function spectrumColorRgb(value) {
      const v = Math.max(0, Math.min(1, value));
      const stops = [
        [0, [8, 10, 26]],
        [0.22, [38, 30, 104]],
        [0.45, [112, 34, 138]],
        [0.68, [212, 76, 92]],
        [0.85, [250, 166, 58]],
        [1, [255, 246, 198]],
      ];
      for (let i = 0; i < stops.length - 1; i += 1) {
        const a = stops[i];
        const b = stops[i + 1];
        if (v > b[0]) continue;
        const t = b[0] === a[0] ? 0 : (v - a[0]) / (b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * t),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * t),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * t),
        ];
      }
      return [255, 246, 198];
    }

    /**
     * Estimate a tempo from an onset-strength envelope with a Goertzel
     * tempogram: candidates 60…200 BPM in 0.25 BPM steps, harmonic support for
     * 2×/3× the fundamental, and a mild log-normal prior around 120 BPM.
     */
    function detectBpmFromOnsets(onsets, rate) {
      const count = onsets && onsets.length ? onsets.length : 0;
      if (!(rate > 0) || count < Math.max(16, Math.round(rate * 3))) return null;
      let mean = 0;
      for (let i = 0; i < count; i += 1) mean += onsets[i];
      mean /= count;
      const signal = new Float32Array(count);
      let peak = 0;
      for (let i = 0; i < count; i += 1) {
        const value = Math.max(0, onsets[i] - mean * 0.3);
        signal[i] = value;
        if (value > peak) peak = value;
      }
      if (peak <= 0) return null;
      // Hann window keeps the long-clip DFT from leaking between candidates.
      const window = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
        signal[i] /= peak;
      }
      const MIN_BPM = 60;
      const MAX_BPM = 200;
      const STEP = 0.25;
      const candidates = Math.floor((MAX_BPM - MIN_BPM) / STEP) + 1;
      const magnitudes = new Float32Array(candidates);
      for (let index = 0; index < candidates; index += 1) {
        const bpm = MIN_BPM + index * STEP;
        const frequency = bpm / 60;
        const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
        let previous = 0;
        let current = 0;
        for (let i = 0; i < count; i += 1) {
          const next = signal[i] * window[i] + coefficient * current - previous;
          previous = current;
          current = next;
        }
        const power = current * current + previous * previous - coefficient * previous * current;
        magnitudes[index] = Math.sqrt(Math.max(0, power)) / count;
      }
      const at = (bpm) => {
        const position = (bpm - MIN_BPM) / STEP;
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        if (lower < 0 || upper >= candidates) return 0;
        if (lower === upper) return magnitudes[lower];
        const fraction = position - lower;
        return magnitudes[lower] * (1 - fraction) + magnitudes[upper] * fraction;
      };
      const weightedScores = new Float32Array(candidates);
      let best = null;
      for (let index = 0; index < candidates; index += 1) {
        const bpm = MIN_BPM + index * STEP;
        let score = magnitudes[index];
        if (bpm * 2 <= MAX_BPM) score += 0.5 * at(bpm * 2);
        if (bpm * 3 <= MAX_BPM) score += 0.25 * at(bpm * 3);
        const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
        const weighted = score * (0.55 + 0.45 * prior);
        weightedScores[index] = weighted;
        if (!best || weighted > best.weighted) best = { index, bpm, weighted, magnitude: magnitudes[index] };
      }
      if (!best) return null;
      // Parabolic interpolation between the three bins around the peak gives a
      // sub-step estimate (the 0.25 BPM grid alone would drift on long songs).
      const left = best.index > 0 ? weightedScores[best.index - 1] : best.weighted;
      const right = best.index + 1 < candidates ? weightedScores[best.index + 1] : best.weighted;
      const denominator = left - 2 * best.weighted + right;
      let delta = denominator !== 0 ? (0.5 * (left - right)) / denominator : 0;
      if (!Number.isFinite(delta)) delta = 0;
      delta = Math.max(-0.49, Math.min(0.49, delta));
      const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, best.bpm + delta * STEP));
      let average = 0;
      for (let index = 0; index < candidates; index += 1) average += magnitudes[index];
      average /= candidates;
      const confidence = average > 1e-9 ? Math.max(0, Math.min(1, best.magnitude / (average * 5))) : 0;
      return { bpm, confidence };
    }

    /**
     * Detect the BPM of one spectrogram: low-band-weighted spectral flux (bass
     * and kick carry the beat; offbeat hats matter less) followed by the
     * tempogram detector above.
     *
     * @returns {{bpm:number, confidence:number}|null}
     */
    function detectBpmFromSpectrum(spectrum, duration) {
      if (!spectrum || !spectrum.data || !(duration > 3)) return null;
      const columns = spectrum.columns;
      const bands = spectrum.bands;
      const rate = columns / duration;
      if (!(rate > 0) || columns < 8) return null;
      const envelope = new Float32Array(columns);
      for (let column = 1; column < columns; column += 1) {
        let flux = 0;
        for (let band = 0; band < bands; band += 1) {
          const index = column * bands + band;
          const difference = spectrum.data[index] - spectrum.data[index - bands];
          if (difference <= 0) continue;
          // 3× weight at the lowest band, tapering to 1× at the top.
          flux += difference * (1 + 2 * (1 - band / Math.max(1, bands - 1)));
        }
        envelope[column] = flux;
      }
      return detectBpmFromOnsets(envelope, rate);
    }

    /**
     * Pick a project-wide BPM. A long main song outweighs a short sting even
     * when the sting's pulse is cleaner, so confidence is scaled by duration
     * (full weight from 30 s).
     */
    function detectProjectBpm(clips, waves) {
      let best = null;
      for (const clip of clips || []) {
        if (!clip) continue;
        const key = clip.file || clip.relativePath || '';
        const wave = key && waves ? waves[key] : null;
        if (!wave || !wave.spectrum) continue;
        const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : wave.duration;
        const result = detectBpmFromSpectrum(wave.spectrum, duration);
        if (!result || !Number.isFinite(result.bpm)) continue;
        const weight = Math.min(1, Math.max(0, duration || 0) / 30);
        const score = result.confidence * weight;
        if (!best || score > best.score) {
          best = {
            bpm: result.bpm,
            confidence: result.confidence,
            score,
            clipId: clip.id || null,
            clipName: clip.name || clip.method || '',
          };
        }
      }
      return best;
    }

    /** Cached offscreen canvas for one spectrogram (browsers only). */
    function spectrumCanvasFor(spectrum) {
      if (!spectrum || !spectrum.data) return null;
      if (spectrum._canvas !== undefined) return spectrum._canvas;
      spectrum._canvas = null;
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
        const canvas = document.createElement('canvas');
        canvas.width = spectrum.columns;
        canvas.height = spectrum.bands;
        const context = canvas.getContext('2d');
        if (!context || typeof context.createImageData !== 'function' || typeof context.putImageData !== 'function') return null;
        const image = context.createImageData(spectrum.columns, spectrum.bands);
        const pixels = image.data;
        for (let c = 0; c < spectrum.columns; c += 1) {
          for (let b = 0; b < spectrum.bands; b += 1) {
            const rgb = spectrumColorRgb(spectrum.data[c * spectrum.bands + b] / 255);
            const y = spectrum.bands - 1 - b;
            const at = (y * spectrum.columns + c) * 4;
            pixels[at] = rgb[0];
            pixels[at + 1] = rgb[1];
            pixels[at + 2] = rgb[2];
            pixels[at + 3] = 255;
          }
        }
        context.putImageData(image, 0, 0);
        spectrum._canvas = canvas;
      } catch (error) {
        spectrum._canvas = null;
      }
      return spectrum._canvas;
    }

    /**
     * Parse the RIFF/WAVE header and return a frame reader. Supports PCM
     * 8/16/24/32-bit and IEEE-float 32-bit files (format 1 or 3).
     */
    function readWavInfo(buffer) {
      const view = new DataView(buffer);
      if (view.byteLength < 44) return null;
      const readAscii = (offset, length) => {
        let text = '';
        for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
        return text;
      };
      if (readAscii(0, 4) !== 'RIFF' || readAscii(8, 4) !== 'WAVE') return null;
      let offset = 12;
      let audioFormat = 1;
      let channels = 2;
      let sampleRate = 44100;
      let bits = 16;
      let dataOffset = -1;
      let dataLength = 0;
      while (offset + 8 <= view.byteLength) {
        const id = readAscii(offset, 4);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'fmt ') {
          audioFormat = view.getUint16(body, true);
          channels = view.getUint16(body + 2, true) || 1;
          sampleRate = view.getUint32(body + 4, true) || 44100;
          bits = view.getUint16(body + 14, true) || 16;
        } else if (id === 'data') {
          dataOffset = body;
          dataLength = Math.min(size, view.byteLength - body);
          break;
        }
        offset = body + size + (size % 2);
      }
      if (dataOffset < 0 || dataLength <= 0) return null;
      if ([8, 16, 24, 32].indexOf(bits) === -1) return null;
      if (audioFormat !== 1 && !(audioFormat === 3 && bits === 32)) return null;
      const bytesPerSample = bits / 8;
      const frameBytes = bytesPerSample * channels;
      const frames = Math.floor(dataLength / frameBytes);
      if (frames <= 0) return null;
      const readSample = (frame, channel) => {
        const base = dataOffset + frame * frameBytes + channel * bytesPerSample;
        if (bits === 16) return view.getInt16(base, true) / 32768;
        if (bits === 24) {
          const raw = view.getUint8(base) | (view.getUint8(base + 1) << 8) | (view.getInt8(base + 2) << 16);
          return raw / 8388608;
        }
        if (bits === 32) return audioFormat === 3 ? view.getFloat32(base, true) : view.getInt32(base, true) / 2147483648;
        return (view.getUint8(base) - 128) / 128;
      };
      const sampleAt = (frame) => {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) sum += readSample(frame, channel);
        return sum / channels;
      };
      return { view, audioFormat, channels, sampleRate, bits, dataOffset, dataLength, frameBytes, frames, sampleAt };
    }

    /** Read a PCM/float WAV into a mono peak array. */
    function wavPeaks(buffer, bins) {
      const info = readWavInfo(buffer);
      if (!info) return null;
      const peaks = new Float32Array(bins);
      const step = info.frames / bins;
      for (let bin = 0; bin < bins; bin += 1) {
        const from = Math.floor(bin * step);
        const to = Math.min(info.frames, Math.floor((bin + 1) * step));
        let peak = 0;
        for (let frame = from; frame < to; frame += 1) {
          const magnitude = Math.abs(info.sampleAt(frame));
          if (magnitude > peak) peak = magnitude;
        }
        peaks[bin] = peak;
      }
      let spectrum = null;
      try {
        spectrum = computeSpectrum(info.sampleAt, info.frames, info.sampleRate);
      } catch (error) {
        spectrum = null;
      }
      return { peaks, duration: info.frames / info.sampleRate, sampleRate: info.sampleRate, channels: info.channels, spectrum };
    }

    /** Decode non-WAV audio through Web Audio as a fallback for the waveform. */
    async function decodePeaks(buffer, bins) {
      const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineCtor) return null;
      const context = new OfflineCtor(1, 1, 44100);
      const decoded = await new Promise((resolve, reject) => {
        try {
          const result = context.decodeAudioData(buffer.slice(0), resolve, reject);
          if (result && typeof result.then === 'function') result.then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
      if (!decoded) return null;
      const channels = [];
      for (let index = 0; index < decoded.numberOfChannels; index += 1) channels.push(decoded.getChannelData(index));
      const length = channels.length > 0 ? channels[0].length : 0;
      if (length <= 0) return null;
      const sampleAt =
        channels.length === 1
          ? (frame) => channels[0][frame]
          : (frame) => {
              let sum = 0;
              for (const channel of channels) sum += channel[frame];
              return sum / channels.length;
            };
      const peaks = new Float32Array(bins);
      const step = length / bins;
      for (let bin = 0; bin < bins; bin += 1) {
        const from = Math.floor(bin * step);
        const to = Math.min(length, Math.floor((bin + 1) * step));
        let peak = 0;
        for (let frame = from; frame < to; frame += 1) {
          const magnitude = Math.abs(sampleAt(frame));
          if (magnitude > peak) peak = magnitude;
        }
        peaks[bin] = peak;
      }
      let spectrum = null;
      try {
        spectrum = computeSpectrum(sampleAt, length, decoded.sampleRate);
      } catch (error) {
        spectrum = null;
      }
      return {
        peaks,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        spectrum,
      };
    }

    /** File URL for one project asset (absolute path). */
    function assetUrl(filePath) {
      return FILE_URL + '?path=' + encodeURIComponent(filePath || '');
    }

    /**
     * Load and analyse every distinct audio clip used by the project for the
     * timeline waveform strip. Returns `{ waves, status }` where `waves` maps
     * `clip.file || clip.relativePath` to `{ peaks, duration, spectrum }`
     * (`spectrum` is the cached STFT result used by the spectrum view).
     */
    function useWaveforms(clips) {
      const [waves, setWaves] = useState({});
      const [status, setStatus] = useState('none');
      const signature = (clips || [])
        .map((clip) => (clip ? clip.file || clip.relativePath || '' : ''))
        .filter((path, index, all) => path && all.indexOf(path) === index)
        .join('\n');
      useEffect(() => {
        let cancelled = false;
        const paths = signature ? signature.split('\n') : [];
        // Keep already-decoded waves; only the new paths need fetching.
        setWaves((current) => {
          const next = {};
          for (const path of paths) if (current[path]) next[path] = current[path];
          return next;
        });
        if (paths.length === 0) {
          setStatus('none');
          return undefined;
        }
        setStatus('loading');
        let remaining = paths.length;
        let failed = false;
        const settle = () => {
          remaining -= 1;
          if (cancelled || remaining > 0) return;
          setStatus(failed ? 'error' : 'ready');
        };
        for (const target of paths) {
          fetch(assetUrl(target), { cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.arrayBuffer();
            })
            .then((buffer) => {
              if (cancelled) return null;
              let result = null;
              try {
                result = wavPeaks(buffer, WAVE_BINS);
              } catch (error) {
                result = null;
              }
              if (result) {
                setWaves((current) => Object.assign({}, current, { [target]: result }));
                return null;
              }
              return decodePeaks(buffer, WAVE_BINS)
                .then((decoded) => {
                  if (cancelled || !decoded) {
                    if (!cancelled) failed = true;
                    return;
                  }
                  setWaves((current) => Object.assign({}, current, { [target]: decoded }));
                })
                .catch(() => {
                  failed = true;
                });
            })
            .catch(() => {
              failed = true;
            })
            .finally(settle);
        }
        return () => {
          cancelled = true;
        };
      }, [signature]);
      return { waves, status };
    }

    /** Stable identity of one audio clip across wire refreshes. */
    function audioClipKey(clip, index) {
      if (!clip) return 'clip:' + index;
      return [clip.staffId || '', clip.id || clip.method || '', clip.file || clip.relativePath || '', index].join('|');
    }

    /** True while `time` is inside one audio clip's chart-time window. */
    function clipActiveAt(clip, time, audio) {
      if (!clip) return false;
      const start = Number.isFinite(clip.offset) ? clip.offset : 0;
      if (time < start - 1e-6) return false;
      let length = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : null;
      if (length === null && audio && Number.isFinite(audio.duration) && audio.duration > 0) length = audio.duration;
      return length === null || time < start + length;
    }

    /**
     * Transport for one or more audio clips ("音频乐段"), exposing the live
     * chart playhead and the usual play/pause/seek/rate controls.
     *
     * Each clip gets its own <audio> element; clips start/stop as the playhead
     * enters/leaves `[offset, offset + duration)`. The clock is audio-driven
     * while a clip is actually playing and falls back to the wall clock for
     * gaps, missing audio, and before the first clip starts.
     */
    function useTransport(clips, fallbackDuration, resetKey) {
      const audioMapRef = useRef(new Map());
      const [time, setTime] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [rate, setRateState] = useState(1);
      const [duration, setDuration] = useState(fallbackDuration || 0);
      const [muted, setMuted] = useState(false);
      const timeRef = useRef(0);
      const rafRef = useRef(0);
      const clipsRef = useRef([]);
      const playingRef = useRef(false);
      const rateRef = useRef(1);
      const mutedRef = useRef(false);
      const durationRef = useRef(fallbackDuration || 0);
      /** Wall-clock anchor: chart time + performance.now() + rate at anchor. */
      const anchorRef = useRef({ chart: 0, at: 0, rate: 1 });
      const clipSignature = (clips || [])
        .map((clip, index) => audioClipKey(clip, index) + ':' + (clip.offset || 0) + ':' + (clip.duration === null || clip.duration === undefined ? '' : clip.duration))
        .join('||');

      clipsRef.current = Array.isArray(clips) ? clips : [];

      const pauseAll = useCallback(() => {
        for (const entry of audioMapRef.current.values()) {
          try {
            entry.audio.pause();
          } catch (error) {
            /* ignore */
          }
        }
      }, []);

      const disposeAll = useCallback(() => {
        for (const entry of audioMapRef.current.values()) {
          try {
            entry.audio.pause();
            entry.audio.removeAttribute('src');
          } catch (error) {
            /* ignore */
          }
        }
        audioMapRef.current.clear();
      }, []);

      const ensureAudio = useCallback((clip) => {
        if (!clip || typeof Audio !== 'function') return null;
        const key = audioClipKey(clip, 0);
        const existing = audioMapRef.current.get(key);
        if (existing) return existing.audio;
        const source = clip.file || clip.relativePath || '';
        if (!source) return null;
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = assetUrl(source);
        const entry = { audio, key };
        audioMapRef.current.set(key, entry);
        return audio;
      }, []);

      useEffect(
        () => () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
          disposeAll();
        },
        [disposeAll],
      );

      // A different project (or reload) replaces the document: drop elements and
      // reset the playhead. Adding another clip must NOT reset it.
      useEffect(() => {
        disposeAll();
        timeRef.current = 0;
        anchorRef.current = { chart: 0, at: performance.now(), rate: rateRef.current };
        playingRef.current = false;
        setTime(0);
        setPlaying(false);
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
      }, [resetKey, disposeAll]);

      // Keep one element per live clip; drop elements whose clip disappeared.
      useEffect(() => {
        const wanted = new Set();
        for (const clip of clipsRef.current) {
          if (!clip) continue;
          const audio = ensureAudio(clip);
          if (audio) wanted.add(audioClipKey(clip, 0));
        }
        for (const [key, entry] of Array.from(audioMapRef.current.entries())) {
          if (wanted.has(key)) continue;
          try {
            entry.audio.pause();
            entry.audio.removeAttribute('src');
          } catch (error) {
            /* ignore */
          }
          audioMapRef.current.delete(key);
        }
      }, [clipSignature, ensureAudio]);

      // Duration: the project duration or the furthest clip end, whichever is
      // later. Audio metadata may refine an unknown clip duration while loading.
      useEffect(() => {
        let total = Number.isFinite(fallbackDuration) ? fallbackDuration : 0;
        for (const clip of clipsRef.current) {
          const length = Number.isFinite(clip.duration) ? clip.duration : 0;
          const end = (Number.isFinite(clip.offset) ? clip.offset : 0) + length;
          if (end > total) total = end;
        }
        durationRef.current = Math.max(total, 0);
        setDuration(durationRef.current);
      }, [fallbackDuration, clipSignature]);

      /** Start/stop clip elements to match `chartTime`. */
      const syncClips = useCallback((chartTime, options) => {
        const settings = options || {};
        const isPlaying = playingRef.current;
        for (const clip of clipsRef.current) {
          if (!clip) continue;
          const audio = ensureAudio(clip);
          if (!audio || audio.error) continue;
          const offset = Number.isFinite(clip.offset) ? clip.offset : 0;
          const active = clipActiveAt(clip, chartTime, audio);
          audio.playbackRate = rateRef.current;
          audio.muted = mutedRef.current;
          if (!active) {
            if (!audio.paused) {
              try {
                audio.pause();
              } catch (error) {
                /* ignore */
              }
            }
            if (settings.seek) {
              try {
                audio.currentTime = 0;
              } catch (error) {
                /* ignore */
              }
            }
            continue;
          }
          const target = Math.max(0, chartTime - offset);
          if (settings.seek || audio.paused || Math.abs(audio.currentTime - target) > 0.35) {
            try {
              audio.currentTime = target;
            } catch (error) {
              /* ignore */
            }
          }
          if (!isPlaying) {
            if (!audio.paused) {
              try {
                audio.pause();
              } catch (error) {
                /* ignore */
              }
            }
            continue;
          }
          if (audio.paused) {
            const promise = audio.play();
            if (promise && typeof promise.catch === 'function') promise.catch(() => undefined);
          }
        }
      }, [ensureAudio]);

      const tick = useCallback(() => {
        if (!playingRef.current) {
          rafRef.current = 0;
          return;
        }
        // Prefer an actually-playing clip as the clock; otherwise extrapolate
        // from the wall clock (gaps, loading media, missing audio).
        let authoritative = null;
        for (const clip of clipsRef.current) {
          const audio = ensureAudio(clip);
          if (!audio || !clipActiveAt(clip, timeRef.current, audio)) continue;
          if (audio.paused || audio.error || audio.readyState < 2) continue;
          const offset = Number.isFinite(clip.offset) ? clip.offset : 0;
          authoritative = { audio, offset };
          break;
        }
        let current;
        if (authoritative) {
          current = authoritative.audio.currentTime + authoritative.offset;
        } else {
          const anchor = anchorRef.current;
          current = anchor.chart + ((performance.now() - anchor.at) / 1000) * anchor.rate;
        }
        // Refine durations once an element knows its real length.
        let total = Number.isFinite(durationRef.current) ? durationRef.current : 0;
        for (const clip of clipsRef.current) {
          let length = Number.isFinite(clip.duration) ? clip.duration : 0;
          if (!length) {
            const audio = ensureAudio(clip);
            if (audio && Number.isFinite(audio.duration) && audio.duration > 0) length = audio.duration;
          }
          const end = (Number.isFinite(clip.offset) ? clip.offset : 0) + length;
          if (end > total) total = end;
        }
        if (total > 0 && Math.abs(total - durationRef.current) > 0.01) {
          durationRef.current = total;
          setDuration(total);
        }
        syncClips(current);
        if (durationRef.current > 0 && current >= durationRef.current) {
          current = durationRef.current;
          playingRef.current = false;
          setPlaying(false);
          pauseAll();
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
          }
        }
        if (Math.abs(current - timeRef.current) > 0.004) {
          timeRef.current = current;
          setTime(current);
        }
        if (playingRef.current) rafRef.current = requestAnimationFrame(tick);
      }, [ensureAudio, pauseAll, syncClips]);

      const play = useCallback(() => {
        const startChartTime = timeRef.current;
        playingRef.current = true;
        setPlaying(true);
        anchorRef.current = { chart: startChartTime, at: performance.now(), rate: rateRef.current };
        syncClips(startChartTime, { seek: true });
        if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
      }, [syncClips, tick]);

      const pause = useCallback(() => {
        playingRef.current = false;
        setPlaying(false);
        pauseAll();
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        setTime(timeRef.current);
      }, [pauseAll]);

      const seek = useCallback((seconds) => {
        const limit = durationRef.current > 0 ? durationRef.current : Infinity;
        const target = clamp(seconds, 0, limit);
        timeRef.current = target;
        anchorRef.current = { chart: target, at: performance.now(), rate: rateRef.current };
        setTime(target);
        syncClips(target, { seek: true });
      }, [syncClips]);

      const setRate = useCallback((value) => {
        anchorRef.current = { chart: timeRef.current, at: performance.now(), rate: value };
        rateRef.current = value;
        setRateState(value);
        syncClips(timeRef.current);
      }, [syncClips]);

      const toggleMute = useCallback(() => {
        const next = !mutedRef.current;
        mutedRef.current = next;
        setMuted(next);
        for (const entry of audioMapRef.current.values()) entry.audio.muted = next;
      }, []);

      playingRef.current = playing;
      rateRef.current = rate;
      mutedRef.current = muted;
      durationRef.current = duration > 0 ? duration : durationRef.current;

      return { time, timeRef, playing, duration, rate, muted, play, pause, seek, setRate, toggleMute };
    }

    // ========================================================================
    // 08 · UI primitives.
    // ========================================================================

    /** Inline 16px glyphs; stroke uses currentColor so theme colours apply. */
    const ICON_PATHS = {
      play: ['M5 3.5v9l8-4.5z'],
      pause: ['M5 3.5h2.2v9H5z', 'M8.8 3.5H11v9H8.8z'],
      stop: ['M4.5 4.5h7v7h-7z'],
      rewind: ['M10.5 3.5L4 8l6.5 4.5z'],
      save: ['M3.5 3.5h7.2l2 2v7H3.5z', 'M5.5 3.5v3.2h4.2V3.5'],
      export: ['M8 2.8v7.2', 'M5.3 7.4L8 10.1l2.7-2.7', 'M3.4 10.6v2.2h9.2v-2.2'],
      folder: ['M2.5 5.2h4l1.1 1.4h5.9v6.2h-11z'],
      undo: ['M6.4 4.2L3.2 7.4l3.2 3.2', 'M3.4 7.4h6.1a3.7 3.7 0 0 1 0 7.4H6.2'],
      redo: ['M9.6 4.2l3.2 3.2-3.2 3.2', 'M12.6 7.4H6.5a3.7 3.7 0 0 0 0 7.4h3.3'],
      plus: ['M8 3.6v8.8', 'M3.6 8h8.8'],
      minus: ['M3.6 8h8.8'],
      trash: ['M3.6 5h8.8', 'M6.3 5V3.6h3.4V5', 'M5 5l.5 8h5l.5-8'],
      pencil: ['M3.4 12.6l.7-3.1 7-7 2.4 2.4-7 7-3.1.7z', 'M9.9 4.4l1.8 1.8'],
      duplicate: ['M5.4 5.4h7v7h-7z', 'M3.6 10.6V3.6h7'],
      zoomIn: ['M7.9 3.4a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z', 'M11.2 11.2l2.4 2.4', 'M7.9 5.9v4', 'M5.9 7.9h4'],
      zoomOut: ['M7.9 3.4a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z', 'M11.2 11.2l2.4 2.4', 'M5.9 7.9h4'],
      fit: ['M3.2 6.2V3.4h3', 'M12.8 6.2V3.4h-3', 'M3.2 9.8v2.8h3', 'M12.8 9.8v2.8h-3'],
      select: ['M3.4 3.4l9 4-4 1.2-1.2 4z'],
      back: ['M9.6 3.4L5 8l4.6 4.6', 'M5.2 8h7.2'],
      tap: ['M8 3.4l3 4.6-3 4.6-3-4.6z'],
      taplik: ['M8 2.8l1.3 3.9 3.9 1.3-3.9 1.3L8 13.2l-1.3-3.9L2.8 8l3.9-1.3z'],
      drag: ['M3.4 8h9.2', 'M9.9 5.2L12.6 8l-2.7 2.8', 'M3.4 5.2h2.4', 'M3.4 10.8h2.4'],
      hold: ['M5 3.6h6v8.8H5z', 'M5 8h6'],
      lane: ['M2.6 10.6C5 10.6 5.6 5.4 8 5.4s3 5.2 5.4 5.2'],
      guide: ['M2.6 11.4C5.2 11.4 6 4.6 8 4.6s2.8 6.8 5.4 6.8', 'M2.6 11.4C5.2 11.4 6 8 8 8s2.8 3.4 5.4 3.4'],
      curve: ['M2.6 11.6C5 11.6 5.6 4.4 8 4.4s3 7.2 5.4 7.2'],
      dot: ['M8 6.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z'],
      chevron: ['M5.6 6.6L8 9l2.4-2.4'],
      info: ['M8 3.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z', 'M8 7.4v3', 'M8 5.6v.2'],
      reload: ['M12.6 4.4v3.2H9.4', 'M3.4 11.6V8.4h3.2', 'M4 6a4.5 4.5 0 0 1 7.6-1.4', 'M12 10a4.5 4.5 0 0 1-7.6 1.4'],
      grid: ['M3 6.2h10', 'M3 9.8h10', 'M6.2 3v10', 'M9.8 3v10'],
      volume: ['M3.6 6.4h2.2L8.4 3.8v8.4L5.8 9.6H3.6z', 'M10.4 6.2a2.6 2.6 0 0 1 0 3.6'],
      mute: ['M3.6 6.4h2.2L8.4 3.8v8.4L5.8 9.6H3.6z', 'M10.8 6.4l2.8 3.2', 'M13.6 6.4l-2.8 3.2'],
      close: ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6'],
      preview: ['M2.6 4.4h10.8v7.2H2.6z', 'M6.7 6.2v3.6l3.6-1.8z'],
      wave: ['M2.4 8c1.2 0 1.2-3.2 2.7-3.2S6.6 11.2 8.1 11.2 9.4 4.8 10.9 4.8s1.5 3.2 2.7 3.2'],
      spectrum: ['M3.4 9.8V7.4', 'M5.5 11.2V4.8', 'M7.6 10.4V5.6', 'M9.7 11.4V3.6', 'M11.8 9.6V6.4', 'M13.3 8.6V7.4'],
    };

    /** One inline icon. */
    function Icon(props) {
      const name = props.name || 'dot';
      const size = props.size || 15;
      const paths = ICON_PATHS[name] || ICON_PATHS.dot;
      return h(
        'svg',
        {
          className: 'dgc-icon',
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    /** A labelled toolbar/panel button. */
    function Button(props) {
      const className =
        'dgc-btn' +
        (props.variant === 'primary' ? ' is-primary' : '') +
        (props.variant === 'ghost' ? ' is-ghost' : '') +
        (props.variant === 'danger' ? ' is-danger' : '') +
        (props.active ? ' is-active' : '') +
        (props.className ? ' ' + props.className : '');
      return h(
        'button',
        {
          type: 'button',
          className,
          title: props.title,
          disabled: props.disabled,
          'aria-pressed': props.active === undefined ? undefined : !!props.active,
          onClick: props.onClick,
          style: props.style,
        },
        props.icon ? h(Icon, { name: props.icon, size: props.iconSize || 15 }) : null,
        props.children === undefined || props.children === null ? null : h('span', null, props.children),
      );
    }

    /** Checkbox that switches an optional schema field on or off. */
    function OptionalFieldToggle(props) {
      return h('input', {
        type: 'checkbox',
        className: 'dgc-optionalCheck',
        checked: props.checked === true,
        title: props.title,
        'aria-label': props.title,
        'data-field': props.name,
        onChange: (event) => {
          if (typeof props.onChange === 'function') {
            props.onChange(!!(event && event.target && event.target.checked));
          }
        },
      });
    }

    /** Label + control row used by the inspector. */
    function FieldRow(props) {
      const optional = props.optional || null;
      const bodyStyle = props.wide ? { display: 'block' } : undefined;
      return h(
        'div',
        { className: 'dgc-field' },
        h('span', { className: 'dgc-fieldLabel', title: props.title || props.label }, props.label),
        optional
          ? h(
              'span',
              { className: 'dgc-fieldBody', style: bodyStyle },
              h(OptionalFieldToggle, {
                name: optional.name,
                checked: optional.checked,
                title: optional.title || props.title || props.label,
                onChange: optional.onChange,
              }),
              h('span', { className: 'dgc-fieldControl' }, props.children),
            )
          : h('span', { className: 'dgc-fieldBody', style: bodyStyle }, props.children),
      );
    }

    /**
     * Numeric input that keeps a local text draft and commits on blur/Enter, so
     * one edit is one undo step. Arrow keys nudge by `step`.
     */
    function NumberField(props) {
      const value = props.value;
      const [text, setText] = useState(value === null || value === undefined ? '' : numberText(value));
      const focusedRef = useRef(false);
      useEffect(() => {
        if (!focusedRef.current) setText(value === null || value === undefined ? '' : numberText(value));
      }, [value]);
      const commit = useCallback(
        (raw) => {
          const parsed = parseNumberInput(raw);
          // A JSON number field can never carry ±Infinity/NaN: JSON.stringify
          // turns them into null, which would corrupt the .g value. Reject them
          // here and keep the last valid text instead.
          if (parsed === null || !Number.isFinite(parsed)) {
            setText(props.value === null || props.value === undefined ? '' : numberText(props.value));
            return;
          }
          if (props.value !== null && props.value !== undefined && Math.abs(parsed - props.value) < 1e-12) return;
          if (props.onCommit) props.onCommit(parsed);
        },
        [props.value, props.onCommit],
      );
      return h(
        'div',
        { className: 'dgc-numWrap' },
        h('input', {
          className: 'dgc-input is-mono',
          value: text,
          inputMode: 'decimal',
          spellCheck: false,
          placeholder: props.placeholder,
          disabled: props.disabled,
          onFocus: () => {
            focusedRef.current = true;
          },
          onChange: (event) => setText(event.target.value),
          onBlur: (event) => {
            focusedRef.current = false;
            commit(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const current = parseNumberInput(text);
              if (current === null) return;
              const step = props.step === undefined ? (event.shiftKey ? 1 : 0.1) : props.step;
              const next = round(current + (event.key === 'ArrowUp' ? step : -step), 6);
              setText(numberText(next));
              if (props.onCommit) props.onCommit(next);
            } else if (event.key === 'Escape') {
              setText(props.value === null || props.value === undefined ? '' : numberText(props.value));
              event.currentTarget.blur();
            }
          },
        }),
      );
    }

    /** Text input that commits on blur/Enter. */
    function TextField(props) {
      const [text, setText] = useState(props.value === null || props.value === undefined ? '' : String(props.value));
      const focusedRef = useRef(false);
      useEffect(() => {
        if (!focusedRef.current) setText(props.value === null || props.value === undefined ? '' : String(props.value));
      }, [props.value]);
      return h('input', {
        className: 'dgc-input',
        value: text,
        spellCheck: false,
        disabled: props.disabled,
        placeholder: props.placeholder,
        onFocus: () => {
          focusedRef.current = true;
        },
        onChange: (event) => setText(event.target.value),
        onBlur: (event) => {
          focusedRef.current = false;
          if (props.onCommit && event.target.value !== props.value) props.onCommit(event.target.value);
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          else if (event.key === 'Escape') {
            setText(props.value === null || props.value === undefined ? '' : String(props.value));
            event.currentTarget.blur();
          }
        },
      });
    }

    /** Checkbox row. */
    function Checkbox(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          disabled: props.disabled,
          onChange: (event) => props.onChange && props.onChange(event.target.checked),
        }),
        props.label ? h('span', { style: { fontSize: 12 } }, props.label) : null,
      );
    }

    /** Hex/alpha colour editor for ColorArgb-like values. */
    function ColorField(props) {
      const value = props.value;
      const fields = isTypedValue(value) && value.t === 'obj' ? value.fields || {} : {};
      const channel = (name, fallback) => {
        const raw = valueAsNumber(fields[name]);
        if (raw === null) return fallback;
        return raw > 1 ? clamp(raw / 255, 0, 1) : clamp(raw, 0, 1);
      };
      const red = channel('r', 1);
      const green = channel('g', 1);
      const blue = channel('b', 1);
      const alpha = channel('a', 1);
      const hex = '#' + [red, green, blue].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
      const write = (nextRed, nextGreen, nextBlue, nextAlpha) => {
        if (!props.onChange) return;
        const base = isTypedValue(value) && value.t === 'obj' ? deepClone(value) : { t: 'obj', type: 'GorgeFramework.ColorArgb', fields: {} };
        base.fields = base.fields || {};
        base.fields.r = round(nextRed, 4);
        base.fields.g = round(nextGreen, 4);
        base.fields.b = round(nextBlue, 4);
        base.fields.a = round(nextAlpha, 4);
        props.onChange(base);
      };
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' } },
        h('input', {
          type: 'color',
          value: hex,
          disabled: props.disabled,
          style: { width: 34, height: 24, padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, background: 'transparent' },
          onChange: (event) => {
            const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(event.target.value);
            if (!match) return;
            write(parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255, alpha);
          },
        }),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, NumberFieldWrapped({ value: alpha, onCommit: (next) => write(red, green, blue, next), step: 0.05, title: 'a' })),
      );
    }

    /** Small wrapper so ColorField can render an alpha NumberField inline. */
    function NumberFieldWrapped(props) {
      return h(NumberField, { value: props.value, onCommit: props.onCommit, step: props.step, placeholder: props.title });
    }

    // ========================================================================
    // 09 · Generic value editor (recursive over the typed value tree).
    // ========================================================================

    /** Field descriptor lookup inside a value-type schema. */
    function fieldSchema(schema, name) {
      if (!schema || !schema.fields || !schema.fields[name]) return null;
      return schema.fields[name];
    }

    /**
     * True only for a single ARGB colour object. Colour *curves*
     * (`LerpColorCurve`, `ColorCurve`) must fall through to the object tree:
     * they hold gradient stops and a progress curve, not r/g/b/a.
     */
    function isColorValue(value, schema) {
      if (!isTypedValue(value) || value.t !== 'obj') return false;
      const type = stripNamespace(value.type);
      if (/ColorCurve|Curve/.test(type)) return false;
      const fields = value.fields || {};
      const hasRgb = fields.r !== undefined || fields.g !== undefined || fields.b !== undefined;
      if (/^ColorArgb$|^Color$|^ColorRgb$/.test(type)) return true;
      if (schema && schema.type === 'color' && hasRgb) return true;
      return false;
    }

    /**
     * Editable tree for one Value. Every change produces the complete new
     * subtree through `onChange`; the inspector turns that into a patch op.
     */
    function ValueEditor(props) {
      const { value, onChange, schema, t, depth } = props;
      const level = depth || 0;
      const disabled = props.disabled === true;

      if (isColorValue(value, schema)) {
        return h(ColorField, { value, onChange, disabled });
      }

      if (isTypedValue(value)) {
        if (value.t === 'ref') {
          return h(TextField, {
            value: value.path,
            disabled,
            onCommit: (text) => onChange({ t: 'ref', path: text }),
          });
        }
        if (value.t === 'expr') {
          return h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' } },
            h(NumberField, {
              value: typeof value.special === 'number' ? value.special : null,
              disabled,
              onCommit: (next) =>
                onChange(
                  Number.isFinite(next)
                    ? { t: 'expr', src: numberText(next), special: next }
                    : { t: 'expr', src: next > 0 ? '(1.0/0.0)' : next < 0 ? '(-1.0/0.0)' : '(0.0/0.0)', special: next },
                ),
            }),
            h('span', { className: 'dgc-mono', style: { opacity: 0.6 } }, value.src),
          );
        }
        if (value.t === 'arr') {
          const items = Array.isArray(value.items) ? value.items : [];
          const itemSchema = (schema && schema.itemSchema) || null;
          return h(
            'div',
            { className: 'dgc-tree' },
            h(
              'div',
              { className: 'dgc-treeHead' },
              h('span', { className: 'dgc-tag' }, stripNamespace(value.type) || 'array'),
              h('span', null, items.length + ' 项'),
              h('span', { className: 'dgc-spacer' }),
              h(Button, {
                variant: 'ghost',
                icon: 'plus',
                title: t('addPoint'),
                disabled,
                onClick: () => {
                  const blank =
                    itemSchema && itemSchema.defaultValue !== undefined
                      ? deepClone(itemSchema.defaultValue)
                      : makeBlankValue(itemSchema, value.type);
                  onChange({ t: 'arr', type: value.type, items: items.concat([blank]) });
                },
              }),
            ),
            items.map((item, index) =>
              h(
                'div',
                { key: index, style: { display: 'flex', alignItems: 'flex-start', gap: 4, padding: '2px 0' } },
                h('span', { className: 'dgc-listRowSlim', style: { width: 18, paddingTop: 4 } }, String(index)),
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h(ValueEditor, {
                  value: item,
                  schema: itemSchema,
                  t,
                  depth: level + 1,
                  disabled,
                  path: (Array.isArray(props.path) ? props.path : []).concat('items', index),
                  collapsible: !isCurveEditorValue(item),
                  onEditCurve: props.onEditCurve,
                  onChange: (next) => {
                    const copy = items.slice();
                    copy[index] = next;
                    onChange({ t: 'arr', type: value.type, items: copy });
                  },
                })),
                h(Button, {
                  variant: 'ghost',
                  icon: 'trash',
                  title: t('delete'),
                  disabled,
                  onClick: () => {
                    const copy = items.slice();
                    copy.splice(index, 1);
                    onChange({ t: 'arr', type: value.type, items: copy });
                  },
                }),
              ),
            ),
          );
        }
        // Typed object.
        const fields = value.fields || {};
        const known = schema && schema.fields ? Object.keys(schema.fields) : [];
        const names = Object.keys(fields);
        const optionalMissing = known.filter(
          (name) =>
            names.indexOf(name) === -1 &&
            schema.fields[name] &&
            schema.fields[name].optional === true,
        );
        const ordered = known
          .filter((name) => names.indexOf(name) !== -1 || optionalMissing.indexOf(name) !== -1)
          .concat(names.filter((name) => known.indexOf(name) === -1));
        const fieldCount = names.length;
        const collapsed = level > 0 && props.collapsible !== false;
        const header = h(
          'div',
          { className: 'dgc-treeHead' },
          h('span', { className: 'dgc-tag' }, stripNamespace(value.type) || 'object'),
          h('span', { className: 'dgc-listRowSlim' }, String(fieldCount) + ' 字段'),
          props.onEditCurve && isCurveEditorValue(value)
            ? h(Button, {
                variant: 'ghost',
                icon: 'curve',
                title: t('curveEditor'),
                onClick: () => props.onEditCurve(value, onChange, Array.isArray(props.path) ? props.path : []),
              })
            : null,
        );
        const body = ordered.map((name) => {
          const childSchema = fieldSchema(schema, name);
          const present = names.indexOf(name) !== -1;
          const child = present ? fields[name] : undefined;
          const optional = !!(childSchema && childSchema.optional === true);
          const unused = optional && (child === null || child === undefined);
          const content = unused
            ? h('span', { className: 'dgc-optionalHint' }, t('fieldUnused'))
            : h(ValueEditor, {
                value: child,
                schema: childSchema,
                t,
                depth: level + 1,
                disabled,
                collapsible: false,
                path: (Array.isArray(props.path) ? props.path : []).concat('fields', name),
                onEditCurve: props.onEditCurve,
                onChange: (next) => {
                  const copy = deepClone(value);
                  copy.fields = copy.fields || {};
                  copy.fields[name] = next;
                  onChange(copy);
                },
              });
          const toggle = optional
            ? h(OptionalFieldToggle, {
                name,
                checked: !unused,
                title: (childSchema && childSchema.label) || name,
                onChange: (checked) => {
                  const copy = deepClone(value);
                  copy.fields = copy.fields && typeof copy.fields === 'object' ? copy.fields : {};
                  if (checked) copy.fields[name] = defaultValueForSchema(childSchema);
                  else delete copy.fields[name];
                  onChange(copy);
                },
              })
            : null;
          return h(
            'div',
            { key: name, className: 'dgc-field is-nested', style: { gridTemplateColumns: '72px minmax(0,1fr)' } },
            h('span', { className: 'dgc-fieldLabel', title: (childSchema && childSchema.label) || name }, (childSchema && childSchema.label) || name),
            h(
              'span',
              { className: 'dgc-fieldBody' },
              toggle,
              optional ? h('span', { className: 'dgc-fieldControl' }, content) : content,
            ),
          );
        });
        if (!collapsed) {
          const showHeader = level > 0 || !!props.onEditCurve;
          return h('div', { className: level === 0 ? 'dgc-tree' : 'dgc-tree' }, showHeader ? header : null, body);
        }
        return h(
          'details',
          { className: 'dgc-tree', open: level <= 1 },
          h('summary', { className: 'dgc-treeHead', style: { cursor: 'pointer' } }, h(Icon, { name: 'chevron', size: 13 }), h('span', { className: 'dgc-tag' }, stripNamespace(value.type) || 'object'), h('span', { className: 'dgc-listRowSlim' }, String(fieldCount))),
          body,
        );
      }

      // Scalars.
      if (typeof value === 'number') {
        if (schema && (schema.format === 'percent' || schema.unit === '%')) {
          return h(NumberField, { value, disabled, onCommit: onChange });
        }
        return h(NumberField, { value, disabled, step: props.step || (schema && schema.step), onCommit: onChange });
      }
      if (typeof value === 'boolean') {
        return h(Checkbox, { checked: value, disabled, onChange });
      }
      if (typeof value === 'string') {
        return h(TextField, { value, disabled, onCommit: onChange });
      }
      if (value === null || value === undefined) {
        return h('span', { className: 'dgc-listRowSlim' }, 'null');
      }
      return h('span', { className: 'dgc-listRowSlim' }, describeValue(value));
    }

    /** Default value used when an optional field is switched on or a missing
     * curve field is materialized. Curve fields start flat at zero so a new
     * variation/hold-line/progress curve does not add an unintended ramp. */
    function zeroLinearCurveValue() {
      return {
        t: 'obj',
        type: 'GorgeFramework.LinearCurve',
        fields: { timeStart: 0, valueStart: 0, timeEnd: 1, valueEnd: 0 },
      };
    }

    /** Opaque white used for a fresh ColorArgb / colour point. */
    function defaultColorArgbValue() {
      return { t: 'obj', type: 'GorgeFramework.ColorArgb', fields: { a: 1, r: 1, g: 1, b: 1 } };
    }

    /** A LerpColorCurve with a single opaque white stop. */
    function defaultLerpColorCurveValue() {
      return {
        t: 'obj',
        type: 'GorgeFramework.LerpColorCurve',
        fields: {
          colorPoints: { t: 'arr', type: 'GorgeFramework.ColorArgb', items: [defaultColorArgbValue()] },
        },
      };
    }

    /** A usable one-piece default (zero curve, finite closed range). */
    function defaultFunctionPieceValue() {
      return {
        t: 'obj',
        type: 'GorgeFramework.FunctionPiece',
        fields: {
          functionCurve: zeroLinearCurveValue(),
          startX: 0,
          endX: 1,
          leftClosed: true,
          rightClosed: true,
        },
      };
    }

    /** Build the default fields of a composite value from its descriptors. */
    function defaultFieldsForSchema(schema) {
      const fields = {};
      const descriptors = schema && schema.fields ? schema.fields : null;
      if (!descriptors) return fields;
      for (const name of Object.keys(descriptors)) {
        const descriptor = descriptors[name];
        if (!descriptor || descriptor.optional === true) continue;
        if (descriptor.default !== undefined) {
          fields[name] = deepClone(descriptor.default);
        } else if (descriptor.type === 'number' || descriptor.type === 'int' || descriptor.type === 'float') {
          fields[name] = 0;
        } else if (descriptor.type === 'boolean' || descriptor.type === 'bool') {
          fields[name] = false;
        } else if (descriptor.type === 'string') {
          fields[name] = '';
        }
      }
      return fields;
    }

    /**
     * Value to materialise for a catalog field that the parsed element omits
     * (its injector default). Patching it creates the field in the `.g` object.
     */
    function defaultValueForSchema(schema) {
      if (!schema) return 0;
      if (schema.defaultValue !== undefined) return deepClone(schema.defaultValue);
      if (schema.default !== undefined) return deepClone(schema.default);
      switch (schema.type) {
        case 'int':
        case 'number':
        case 'float':
          return 0;
        case 'string':
          return '';
        case 'boolean':
        case 'bool':
          return false;
        case 'color':
        case 'ColorArgb':
          return defaultColorArgbValue();
        case 'curve':
          return zeroLinearCurveValue();
        case 'vector2':
        case 'Vector2':
          return { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } };
        case 'array': {
          const elem = schema.elem || (schema.name === 'colorPoints' ? 'GorgeFramework.ColorArgb' : '');
          return {
            t: 'arr',
            type: elem,
            items: schema.name === 'colorPoints' ? [defaultColorArgbValue()] : [],
          };
        }
        case 'LerpColorCurve':
          return defaultLerpColorCurveValue();
        case 'VariableFloat':
          return { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: 0 } };
        case 'FunctionPiece':
          return defaultFunctionPieceValue();
        default:
          if (schema.type) {
            return makeBlankValue(
              schema,
              schema.type.indexOf('.') === -1 ? 'GorgeFramework.' + schema.type : schema.type,
            );
          }
          return makeBlankValue(schema);
      }
    }

    /** Blank value for a new array item when the schema has no default. */
    function makeBlankValue(schema, itemType) {
      const type = typeof itemType === 'string' && itemType ? itemType : '';
      if (!schema) {
        const shortType = stripNamespace(type);
        if (shortType === 'FunctionCurve' || shortType === 'curve') return zeroLinearCurveValue();
        if (shortType === 'ColorCurve') return defaultLerpColorCurveValue();
        if (type) return { t: 'obj', type, fields: {} };
        return {
          t: 'obj',
          type: 'GorgeFramework.FunctionPiece',
          fields: { startX: 0, endX: 1, leftClosed: true, rightClosed: true },
        };
      }
      if (schema.defaultValue !== undefined) return deepClone(schema.defaultValue);
      if (schema.default !== undefined) return deepClone(schema.default);
      if (schema.kind === 'curve' || schema.type === 'curve') return zeroLinearCurveValue();
      if (schema.type === 'number' || schema.type === 'int' || schema.type === 'float') return 0;
      if (schema.type === 'string') return '';
      if (schema.type === 'boolean' || schema.type === 'bool') return false;
      if (schema.type === 'array') return defaultValueForSchema(schema);
      const resolved =
        type ||
        (schema.type && schema.type.indexOf('.') === -1 && /^[A-Z]/.test(schema.type)
          ? 'GorgeFramework.' + schema.type
          : schema.type) ||
        '';
      if (!resolved) return { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: {} };
      const short = stripNamespace(resolved);
      if (short === 'FunctionPiece') return defaultFunctionPieceValue();
      if (short === 'ColorArgb') return defaultColorArgbValue();
      if (short === 'LerpColorCurve') return defaultLerpColorCurveValue();
      if (short === 'Vector2') return { t: 'obj', type: resolved, fields: { x: 0, y: 0 } };
      if (short === 'VariableFloat') return { t: 'obj', type: resolved, fields: { baseValue: 0 } };
      if (short === 'FunctionCurve') return zeroLinearCurveValue();
      if (short === 'ColorCurve') return defaultLerpColorCurveValue();
      return { t: 'obj', type: resolved, fields: defaultFieldsForSchema(schema) };
    }

    // ========================================================================
    // 10 · Curve editor panel — a docked, beat-aligned piecewise editor.
    //
    // The editor always works on a segment list. A plain function curve opens
    // as one synthetic segment and keeps its type; adding a second segment or
    // moving a segment boundary converts the draft to a PiecewiseFunctionCurve
    // on Apply. Segments share their boundaries (time continuity); value jumps
    // are marked, never smoothed automatically.
    // ========================================================================

    const CURVE_SEGMENT_COLORS = ['#38e8c4', '#7c8cff', '#ffd166', '#ff7ab6', '#8bd450', '#f4845f', '#a78bfa', '#4dd0e1'];
    const CURVE_MIN_SEGMENT = 0.001;
    const CURVE_LAYOUT = Object.freeze({ left: GUTTER_W, right: 18, top: 56, bottom: 28, rulerH: 22, bandH: 24, bandGap: 4 });
    const CURVE_NS = 'GorgeFramework.';

    /** Typed scalar/expression for a function-bound field. */
    function curveNumberValue(value) {
      if (Number.isFinite(value)) return value;
      if (value === Infinity) return { t: 'expr', src: '(1.0/0.0)', special: 'Infinity' };
      if (value === -Infinity) return { t: 'expr', src: '(-1.0/0.0)', special: '-Infinity' };
      return 0;
    }

    /** Bare type name of a curve value ('' when not a typed object). */
    function curveTypeOf(value) {
      return isTypedValue(value) && value.t === 'obj' ? stripNamespace(value.type) : '';
    }

    /** Human label of one segment function type (locale key, else bare name). */
    function curveTypeLabel(t, type) {
      const key = CURVE_FN_TYPE_KEYS[type];
      if (key && typeof t === 'function') {
        const text = t(key);
        if (text && text !== key) return text;
      }
      return shortType(type) || String(type || '');
    }

    /** Curve type choices for the type menu; unknown current types stay listed. */
    function curveTypeChoices(currentType) {
      const list = CURVE_FN_TYPE_ORDER.slice();
      if (currentType && list.indexOf(currentType) === -1) list.unshift(currentType);
      return list;
    }

    /** Catalog value-type schema for a curve (for the generic numeric editor). */
    function curveValueSchema(catalog, curve) {
      const type = curveTypeOf(curve);
      const valueTypes = catalog && catalog.valueTypes ? catalog.valueTypes : null;
      const entry = valueTypes && type ? valueTypes[type] : null;
      if (!entry || !entry.fields) return null;
      return { type, label: entry.label || type, fields: entry.fields };
    }

    /** Typed value object helper. */
    function curveObject(type, fields) {
      return { t: 'obj', type: CURVE_NS + type, fields };
    }

    /** Vector2 value helper. */
    function curveVector2(x, y) {
      return curveObject('Vector2', { x: round(x, 6), y: round(y, 6) });
    }

    /** Read a finite numeric field from a typed value. */
    function curveFieldNumber(curve, name, fallback) {
      const fields = curve && isTypedValue(curve) && curve.t === 'obj' ? curve.fields || {} : {};
      const raw = valueAsNumber(fields[name]);
      return raw === null || !Number.isFinite(raw) ? fallback : raw;
    }

    /** Immutably set one field of a typed object. */
    function curveSetField(curve, name, value) {
      const copy = deepClone(curve);
      copy.fields = copy.fields && typeof copy.fields === 'object' ? copy.fields : {};
      copy.fields[name] = value;
      return copy;
    }

    /** Immutably set one numeric field (rounded, finite). */
    function curveSetNumericField(curve, name, value) {
      return curveSetField(curve, name, round(Number.isFinite(value) ? value : 0, 6));
    }

    /** Immutably set several numeric fields at once. */
    function curveSetNumericFields(curve, values) {
      let next = curve;
      for (const name of Object.keys(values)) next = curveSetNumericField(next, name, values[name]);
      return next;
    }

    /** Immutably set a Vector2 field. */
    function curveSetPoint(curve, name, x, y) {
      return curveSetField(curve, name, curveVector2(x, y));
    }

    /** Read a Vector2 field into `{ x, y }` with fallbacks. */
    function curvePointOf(curve, name, x, y) {
      const fields = curve && curve.fields ? curve.fields : {};
      const point = fields[name];
      const pointFields = point && isTypedValue(point) && point.t === 'obj' ? point.fields || {} : {};
      const px = valueAsNumber(pointFields.x);
      const py = valueAsNumber(pointFields.y);
      return {
        x: px === null || !Number.isFinite(px) ? x : px,
        y: py === null || !Number.isFinite(py) ? y : py,
      };
    }

    /** Finite `[lo, hi]` of a curve's own x domain, else the fallback range. */
    function curveNaturalRange(curve, fallback) {
      const range = Array.isArray(fallback) && fallback.length === 2 && Number.isFinite(fallback[0]) && Number.isFinite(fallback[1]) ? fallback.slice() : [-1, 1];
      const type = curveTypeOf(curve);
      const fields = curve && isTypedValue(curve) && curve.t === 'obj' ? curve.fields || {} : {};
      const pair = (a, b) => {
        const lo = valueAsNumber(a);
        const hi = valueAsNumber(b);
        if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        if (lo === hi) return null;
        return [Math.min(lo, hi), Math.max(lo, hi)];
      };
      switch (type) {
        case 'LinearCurve':
          return pair(fields.timeStart, fields.timeEnd) || range;
        case 'CubicHermiteSpline':
        case 'HermiteSpline': {
          const start = fields.startPoint && fields.startPoint.fields ? fields.startPoint.fields : {};
          const end = fields.endPoint && fields.endPoint.fields ? fields.endPoint.fields : {};
          return pair(start.x, end.x) || range;
        }
        case 'PeriodicFunctionCurve':
          return pair(fields.startX, fields.endX) || range;
        case 'AxialSymmetricFunctionCurve': {
          const axis = valueAsNumber(fields.axis);
          if (axis === null || !Number.isFinite(axis)) return range;
          const span = Math.max(Math.abs(range[1] - range[0]), 1) / 2;
          return [axis - span, axis + span];
        }
        case 'PiecewiseFunctionCurve':
        case 'PiecewiseCurve': {
          const xs = [];
          const list = fields.functionPieces;
          const items = list && isTypedValue(list) && Array.isArray(list.items) ? list.items : [];
          for (const item of items) {
            if (!isTypedValue(item) || item.t !== 'obj') continue;
            const pieceFields = item.fields || {};
            const start = valueAsNumber(pieceFields.startX);
            const end = valueAsNumber(pieceFields.endX);
            if (start !== null && Number.isFinite(start)) xs.push(start);
            if (end !== null && Number.isFinite(end)) xs.push(end);
            const inner = curveNaturalRange(pieceFields.functionCurve, range);
            xs.push(inner[0], inner[1]);
          }
          if (!xs.length) return range;
          const lo = Math.min.apply(null, xs);
          const hi = Math.max.apply(null, xs);
          return hi > lo ? [lo, hi] : range;
        }
        case 'AdditionFunctionCurve': {
          const first = curveNaturalRange(fields.firstFunctionCurve, range);
          const second = curveNaturalRange(fields.secondFunctionCurve, range);
          return [Math.min(first[0], second[0]), Math.max(first[1], second[1])];
        }
        case 'CompositeFunctionCurve':
          return curveNaturalRange(fields.innerFunctionCurve, range);
        default:
          return range;
      }
    }

    /** One synthetic/default segment (all editor-local ids are `sN`). */
    function curveMakeSegment(id, start, end, curve, flags) {
      const options = flags || {};
      return {
        id,
        start,
        end,
        curve,
        leftClosed: options.leftClosed === undefined ? true : !!options.leftClosed,
        rightClosed: options.rightClosed === undefined ? true : !!options.rightClosed,
        hasLeftClosed: !!options.hasLeftClosed,
        hasRightClosed: !!options.hasRightClosed,
      };
    }

    /** Deep-copy a draft (source stays shared; every segment/curve is copied). */
    function cloneCurveDraft(draft) {
      return {
        source: draft.source,
        rootKind: draft.rootKind,
        segments: (draft.segments || []).map((segment) =>
          Object.assign({}, segment, { curve: deepClone(segment.curve) }),
        ),
        edited: draft.edited === true,
        converted: draft.converted === true,
        nextId: draft.nextId,
        normalized: draft.normalized === true,
      };
    }

    /**
     * Sort segments by start and make every adjacent pair share a boundary.
     * The first segment may start at -Infinity and the last may end at
     * +Infinity; every other bound is finite and strictly ordered.
     */
    function normalizeSegments(input) {
      const list = (Array.isArray(input) ? input : []).map((segment) => Object.assign({}, segment, { curve: segment.curve }));
      if (!list.length) return list;
      list.sort((a, b) => (a.start === b.start ? 0 : a.start < b.start ? -1 : 1));
      for (let i = 0; i < list.length; i += 1) {
        const segment = list[i];
        const last = i === list.length - 1;
        if (i > 0 && !Number.isFinite(segment.start)) segment.start = -Infinity;
        if (!last && !Number.isFinite(segment.end)) {
          const nextStart = list[i + 1] ? list[i + 1].start : null;
          segment.end = Number.isFinite(nextStart) ? nextStart : Number.isFinite(segment.start) ? segment.start + 1 : 0;
        }
        if (segment.start === Infinity) segment.start = Number.isFinite(segment.end) ? segment.end - 1 : 0;
        if (segment.end === -Infinity) segment.end = Number.isFinite(segment.start) ? segment.start + CURVE_MIN_SEGMENT : 0;
        if (!last || segment.end !== Infinity) {
          // Keep zero-length pieces as-is (the corpus uses an empty 0..0
          // FunctionPiece as a no-op); only repair inverted ranges.
          if (segment.end < segment.start) segment.end = Number.isFinite(segment.start) ? segment.start + CURVE_MIN_SEGMENT : 0;
        }
      }
      for (let i = 1; i < list.length; i += 1) {
        const previous = list[i - 1];
        if (!Number.isFinite(previous.end)) previous.end = Number.isFinite(list[i].start) ? list[i].start : (Number.isFinite(previous.start) ? previous.start + 1 : 0);
        list[i].start = previous.end;
        if (list[i].end < list[i].start) list[i].end = list[i].start + CURVE_MIN_SEGMENT;
      }
      return list;
    }

    /** Read any curve value into the segment draft used by the panel. */
    function readCurveDraft(value, options) {
      const opts = options || {};
      const fallback = Array.isArray(opts.fallbackRange) && opts.fallbackRange.length === 2 ? opts.fallbackRange.slice() : [-1, 1];
      const source = deepClone(value);
      const type = curveTypeOf(source);
      const draft = {
        source,
        rootKind: type === 'PiecewiseFunctionCurve' || type === 'PiecewiseCurve' ? 'piecewise' : 'curve',
        segments: [],
        edited: false,
        converted: false,
        nextId: 1,
        normalized: false,
      };
      if (draft.rootKind === 'piecewise') {
        const list = source.fields && source.fields.functionPieces;
        const items = list && isTypedValue(list) && Array.isArray(list.items) ? list.items : [];
        for (const item of items) {
          if (!isTypedValue(item) || item.t !== 'obj') continue;
          const fields = item.fields || {};
          const readBound = (raw, fallbackBound) => {
            const numeric = valueAsNumber(raw);
            if (numeric === null) return fallbackBound;
            if (Number.isFinite(numeric)) return numeric;
            if (numeric === Infinity || numeric === -Infinity) return numeric;
            return fallbackBound;
          };
          let start = readBound(fields.startX, -Infinity);
          let end = readBound(fields.endX, Infinity);
          if (start > end) {
            const swap = start;
            start = end;
            end = swap;
            draft.normalized = true;
          }
          const rawCurve = fields.functionCurve;
          // Preserve any typed function curve (including types the segment
          // editor does not offer); only null/missing values become a zero
          // constant, matching the engine's null-piece behaviour.
          const hasCurve = isTypedValue(rawCurve) && rawCurve.t === 'obj';
          const inner = hasCurve ? rawCurve : curveObject('ConstantFunctionCurve', { value: 0 });
          if (!hasCurve) draft.normalized = true;
          const hasLeftClosed = Object.prototype.hasOwnProperty.call(fields, 'leftClosed');
          const hasRightClosed = Object.prototype.hasOwnProperty.call(fields, 'rightClosed');
          draft.segments.push(curveMakeSegment('s' + draft.nextId, start, end, inner, {
            leftClosed: fields.leftClosed === true,
            rightClosed: fields.rightClosed === true,
            hasLeftClosed,
            hasRightClosed,
          }));
          draft.nextId += 1;
        }
        if (!draft.segments.length) {
          draft.segments.push(curveMakeSegment('s' + draft.nextId, fallback[0], fallback[1], curveObject('ConstantFunctionCurve', { value: 0 }), {}));
          draft.nextId += 1;
          draft.normalized = true;
        }
        const normalized = normalizeSegments(draft.segments);
        if (
          normalized.length !== draft.segments.length ||
          normalized.some((segment, index) => segment.start !== draft.segments[index].start || segment.end !== draft.segments[index].end)
        ) {
          draft.normalized = true;
        }
        draft.segments = normalized.map((segment, index) => Object.assign({}, segment, { id: 's' + (index + 1) }));
        draft.nextId = draft.segments.length + 1;
      } else {
        const span = curveNaturalRange(source, fallback);
        const curve = isCurveEditorValue(source) ? source : curveObject('ConstantFunctionCurve', { value: 0 });
        draft.segments.push(curveMakeSegment('s1', span[0], span[1], curve, { leftClosed: true, rightClosed: true }));
        draft.nextId = 2;
      }
      return draft;
    }

    /** True when a draft's output is a piecewise curve. */
    function curveDraftIsPiecewise(draft) {
      return draft.rootKind === 'piecewise' || draft.converted === true;
    }

    /** Build the value that Apply writes back. */
    function buildCurveValue(draft) {
      if (!draft) return null;
      if (draft.edited !== true) return deepClone(draft.source);
      if (!draft.segments.length) return deepClone(draft.source);
      if (curveDraftIsPiecewise(draft)) {
        const items = draft.segments.map((segment) => {
          const fields = { functionCurve: deepClone(segment.curve) };
          fields.startX = curveNumberValue(segment.start);
          fields.endX = curveNumberValue(segment.end);
          if (segment.hasLeftClosed) fields.leftClosed = segment.leftClosed === true;
          if (segment.hasRightClosed) fields.rightClosed = segment.rightClosed === true;
          return { t: 'obj', type: CURVE_NS + 'FunctionPiece', fields };
        });
        return {
          t: 'obj',
          type: CURVE_NS + 'PiecewiseFunctionCurve',
          fields: { functionPieces: { t: 'arr', type: CURVE_NS + 'FunctionPiece', items } },
        };
      }
      return deepClone(draft.segments[0].curve);
    }

    /** Boundary values of a draft: `[start0, end0 === start1, ..., endN]`. */
    function curveBoundaries(draft) {
      const out = [];
      for (let i = 0; i < draft.segments.length; i += 1) {
        out.push(draft.segments[i].start);
        if (i === draft.segments.length - 1) out.push(draft.segments[i].end);
      }
      return out;
    }

    /** Default selection: the first non-empty segment (corpus data can start with a 0..0 piece). */
    function firstCurveSegmentId(draft) {
      const list = draft && Array.isArray(draft.segments) ? draft.segments : [];
      const segment = list.find((item) => item.end > item.start) || list[0];
      return segment ? segment.id : null;
    }

    /** Materialize flags when a synthetic single segment becomes piecewise. */
    function curveConvertDraft(draft) {
      draft.converted = true;
      for (const segment of draft.segments) {
        if (!segment.hasLeftClosed) {
          segment.hasLeftClosed = true;
          segment.leftClosed = true;
        }
        if (!segment.hasRightClosed) {
          segment.hasRightClosed = true;
          segment.rightClosed = true;
        }
      }
    }

    /** Snap a curve-relative x to the main timeline beat division. */
    function snapCurveTime(x, tempo, snapDiv, anchorTime, enabled) {
      if (!enabled || !snapDiv || !Number.isFinite(x)) return round(x, 6);
      const anchor = Number.isFinite(anchorTime) ? anchorTime : 0;
      return round(snapTime(anchor + x, tempo, snapDiv, true) - anchor, 6);
    }

    /** Move one shared boundary (0..n) and keep the segments contiguous. */
    function setSegmentBoundary(draft, index, x, options) {
      const opts = options || {};
      if (!draft.segments.length) return draft;
      const count = draft.segments.length;
      if (!(index >= 0 && index <= count)) return draft;
      let value = Number.isFinite(x) ? x : NaN;
      if (!Number.isFinite(value)) return draft;
      if (opts.snap) value = snapCurveTime(value, opts.tempo, opts.snapDiv, opts.anchorTime, true);
      value = round(value, 6);
      const boundaries = curveBoundaries(draft);
      if (index > 0 && Number.isFinite(boundaries[index - 1])) value = Math.max(value, boundaries[index - 1] + CURVE_MIN_SEGMENT);
      if (index < count && Number.isFinite(boundaries[index + 1])) value = Math.min(value, boundaries[index + 1] - CURVE_MIN_SEGMENT);
      if (!Number.isFinite(value)) return draft;
      if (Math.abs(value - boundaries[index]) < 1e-9) return draft;
      const next = cloneCurveDraft(draft);
      if (index === 0) next.segments[0].start = value;
      else if (index === count) next.segments[count - 1].end = value;
      else {
        next.segments[index - 1].end = value;
        next.segments[index].start = value;
      }
      if (next.rootKind !== 'piecewise' && !next.converted) curveConvertDraft(next);
      next.edited = true;
      return next;
    }

    /** Replace one segment's inner function curve. */
    function updateSegmentCurve(draft, id, curve) {
      const index = draft.segments.findIndex((segment) => segment.id === id);
      if (index < 0) return draft;
      if (JSON.stringify(draft.segments[index].curve) === JSON.stringify(curve)) return draft;
      const next = cloneCurveDraft(draft);
      next.segments[index].curve = deepClone(curve);
      next.edited = true;
      return next;
    }

    /** Update the closed flags of one segment. */
    function setSegmentFlags(draft, id, flags) {
      const index = draft.segments.findIndex((segment) => segment.id === id);
      if (index < 0) return draft;
      const next = cloneCurveDraft(draft);
      const segment = next.segments[index];
      if (Object.prototype.hasOwnProperty.call(flags, 'leftClosed')) {
        segment.leftClosed = flags.leftClosed === true;
        segment.hasLeftClosed = true;
      }
      if (Object.prototype.hasOwnProperty.call(flags, 'rightClosed')) {
        segment.rightClosed = flags.rightClosed === true;
        segment.hasRightClosed = true;
      }
      next.edited = true;
      return next;
    }

    /** Immutable finite span of a segment for parameter-handle placement. */
    function curveHandleSpan(start, end, view) {
      let lo = Number.isFinite(start) ? start : view && Number.isFinite(view.x0) ? view.x0 : 0;
      let hi = Number.isFinite(end) ? end : view && Number.isFinite(view.x1) ? view.x1 : lo + 1;
      if (!(hi > lo)) {
        lo = view && Number.isFinite(view.x0) ? view.x0 : lo - 0.5;
        hi = view && Number.isFinite(view.x1) ? view.x1 : lo + 1;
      }
      return { lo, hi };
    }

    /** Default function curve of `type` anchored to the given boundary values. */
    function defaultSegmentCurve(type, start, end, valueStart, valueEnd) {
      const s = Number.isFinite(start) ? start : 0;
      const e = Number.isFinite(end) && end > s ? end : s + 1;
      const v0 = Number.isFinite(valueStart) ? valueStart : 0;
      const v1 = Number.isFinite(valueEnd) ? valueEnd : v0;
      switch (type) {
        case 'LinearFunctionCurve': {
          const k = e > s ? (v1 - v0) / (e - s) : 0;
          return curveObject('LinearFunctionCurve', { k: round(k, 6), b: round(v0 - k * s, 6) });
        }
        case 'LinearCurve':
          return curveObject('LinearCurve', { timeStart: round(s, 6), valueStart: round(v0, 6), timeEnd: round(e, 6), valueEnd: round(v1, 6) });
        case 'CubicHermiteSpline':
          return curveObject('CubicHermiteSpline', {
            startPoint: curveVector2(s, v0),
            startTangent: 0,
            startWeight: 0.33333,
            endPoint: curveVector2(e, v1),
            endTangent: 0,
            endWeight: 0.33333,
          });
        case 'PeriodicFunctionCurve':
          return curveObject('PeriodicFunctionCurve', {
            functionCurve: curveObject('LinearCurve', { timeStart: round(s, 6), valueStart: round(v0, 6), timeEnd: round(e, 6), valueEnd: round(v1, 6) }),
            startX: round(s, 6),
            endX: round(e, 6),
            leftClosed: true,
          });
        case 'AxialSymmetricFunctionCurve':
          return curveObject('AxialSymmetricFunctionCurve', {
            functionCurve: curveObject('LinearCurve', { timeStart: round(s, 6), valueStart: round(v0, 6), timeEnd: round(e, 6), valueEnd: round(v1, 6) }),
            axis: round(s, 6),
            keepLeft: false,
          });
        case 'AdditionFunctionCurve':
          return curveObject('AdditionFunctionCurve', {
            firstFunctionCurve: curveObject('ConstantFunctionCurve', { value: round(v0, 6) }),
            secondFunctionCurve: curveObject('ConstantFunctionCurve', { value: 0 }),
          });
        case 'CompositeFunctionCurve':
          return curveObject('CompositeFunctionCurve', {
            outerFunctionCurve: curveObject('ConstantFunctionCurve', { value: round(v0, 6) }),
            innerFunctionCurve: curveObject('ConstantFunctionCurve', { value: 0 }),
          });
        case 'ConstantFunctionCurve':
        default:
          return curveObject('ConstantFunctionCurve', { value: round(v0, 6) });
      }
    }

    /** Split segment `index` at `x`; the new right part uses `type`. */
    function splitCurveSegment(draft, index, x, type, options) {
      const opts = options || {};
      const segment = draft.segments[index];
      if (!segment) return { draft, segmentId: null };
      let cut = Number.isFinite(x) ? x : curveHandleSpan(segment.start, segment.end, opts.view).lo;
      if (Number.isFinite(segment.start)) cut = Math.max(cut, segment.start + CURVE_MIN_SEGMENT);
      if (Number.isFinite(segment.end)) cut = Math.min(cut, segment.end - CURVE_MIN_SEGMENT);
      cut = round(cut, 6);
      if (!(cut > segment.start && cut < segment.end)) return { draft, segmentId: null };
      const next = cloneCurveDraft(draft);
      const target = next.segments[index];
      const sourceCurve = target.curve;
      const sourceType = curveTypeOf(sourceCurve);
      const nextType = type && type !== sourceType ? type : sourceType || 'ConstantFunctionCurve';
      const cutValue = sampleCurve(sourceCurve, cut);
      const finiteEnd = Number.isFinite(target.end) ? target.end : curveHandleSpan(target.start, target.end, opts.view).hi;
      const endValue = sampleCurve(sourceCurve, finiteEnd);
      const newCurve =
        nextType === sourceType
          ? deepClone(sourceCurve)
          : defaultSegmentCurve(
              nextType,
              cut,
              finiteEnd,
              cutValue === null ? 0 : cutValue,
              endValue === null ? (cutValue === null ? 0 : cutValue) : endValue,
            );
      target.end = cut;
      const right = curveMakeSegment('s' + next.nextId, cut, segment.end, newCurve, {
        leftClosed: true,
        rightClosed: target.rightClosed,
        hasLeftClosed: true,
        hasRightClosed: target.hasRightClosed,
      });
      next.nextId += 1;
      next.segments.splice(index + 1, 0, right);
      if (next.rootKind !== 'piecewise' && !next.converted) curveConvertDraft(next);
      next.edited = true;
      next.segments = normalizeSegments(next.segments);
      return { draft: next, segmentId: right.id };
    }

    /** Add a segment outside the currently covered time range. */
    function addCurveSegmentOutside(draft, x, type, options) {
      const opts = options || {};
      if (!draft.segments.length) return { draft, segmentId: null };
      const first = draft.segments[0];
      const last = draft.segments[draft.segments.length - 1];
      const value = round(Number.isFinite(x) ? x : curveHandleSpan(first.start, last.end, opts.view).hi, 6);
      const next = cloneCurveDraft(draft);
      let added = null;
      if (Number.isFinite(first.start) && value < first.start) {
        const end = first.start;
        const share = sampleCurve(first.curve, end);
        const shared = share === null ? 0 : share;
        const start = Math.min(value, end - CURVE_MIN_SEGMENT);
        added = curveMakeSegment('s' + next.nextId, start, end, defaultSegmentCurve(type || 'ConstantFunctionCurve', start, end, shared, shared), {
          leftClosed: true,
          rightClosed: true,
          hasLeftClosed: true,
          hasRightClosed: true,
        });
        next.segments.unshift(added);
      } else if (Number.isFinite(last.end) && value > last.end) {
        const start = last.end;
        const share = sampleCurve(last.curve, start);
        const shared = share === null ? 0 : share;
        const end = Math.max(value, start + CURVE_MIN_SEGMENT);
        added = curveMakeSegment('s' + next.nextId, start, end, defaultSegmentCurve(type || 'ConstantFunctionCurve', start, end, shared, shared), {
          leftClosed: true,
          rightClosed: true,
          hasLeftClosed: true,
          hasRightClosed: true,
        });
        next.segments.push(added);
      } else {
        return { draft, segmentId: null };
      }
      next.nextId += 1;
      if (next.rootKind !== 'piecewise' && !next.converted) curveConvertDraft(next);
      next.edited = true;
      next.segments = normalizeSegments(next.segments);
      return { draft: next, segmentId: added.id };
    }

    /** Delete one segment; the left neighbor (or the right for the first) absorbs its span. */
    function deleteCurveSegment(draft, index) {
      if (!draft.segments[index] || draft.segments.length <= 1) return { draft, segmentId: null };
      const next = cloneCurveDraft(draft);
      const removed = next.segments[index];
      let selectId = null;
      if (index > 0) {
        next.segments[index - 1].end = removed.end;
        selectId = next.segments[index - 1].id;
      } else {
        next.segments[index + 1].start = removed.start;
        selectId = next.segments[index + 1].id;
      }
      next.segments.splice(index, 1);
      next.segments = normalizeSegments(next.segments);
      next.edited = true;
      return { draft: next, segmentId: selectId };
    }

    /** Replace a segment's function type, anchored to its current values. */
    function changeCurveSegmentType(draft, index, type, options) {
      const opts = options || {};
      const segment = draft.segments[index];
      if (!segment || !type) return draft;
      if (curveTypeOf(segment.curve) === type) return draft;
      const span = curveHandleSpan(segment.start, segment.end, opts.view);
      const startValue = sampleCurve(segment.curve, span.lo);
      const endValue = sampleCurve(segment.curve, span.hi);
      const next = cloneCurveDraft(draft);
      next.segments[index].curve = defaultSegmentCurve(
        type,
        span.lo,
        span.hi,
        startValue === null ? 0 : startValue,
        endValue === null ? (startValue === null ? 0 : startValue) : endValue,
      );
      next.edited = true;
      return next;
    }

    /** Numeric-value jumps at shared segment boundaries. */
    function curveBoundaryWarnings(draft) {
      const warnings = [];
      for (let i = 1; i < draft.segments.length; i += 1) {
        const boundary = draft.segments[i].start;
        if (!Number.isFinite(boundary)) continue;
        const left = sampleCurve(draft.segments[i - 1].curve, boundary);
        const right = sampleCurve(draft.segments[i].curve, boundary);
        if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right)) continue;
        const tolerance = 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
        if (Math.abs(left - right) > tolerance) warnings.push({ index: i, time: boundary, left, right });
      }
      return warnings;
    }

    /** Shift a curve vertically without changing its shape. */
    function offsetCurveValue(curve, delta) {
      if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) return deepClone(curve);
      if (!isCurveEditorValue(curve)) {
        return curveObject('AdditionFunctionCurve', {
          firstFunctionCurve: curve,
          secondFunctionCurve: curveObject('ConstantFunctionCurve', { value: round(delta, 6) }),
        });
      }
      const type = curveTypeOf(curve);
      const fields = curve && curve.fields ? curve.fields : {};
      switch (type) {
        case 'ConstantFunctionCurve':
          return curveSetNumericField(curve, 'value', curveFieldNumber(curve, 'value', 0) + delta);
        case 'LinearFunctionCurve':
          return curveSetNumericField(curve, 'b', curveFieldNumber(curve, 'b', 0) + delta);
        case 'LinearCurve':
          return curveSetNumericFields(curve, {
            valueStart: curveFieldNumber(curve, 'valueStart', 0) + delta,
            valueEnd: curveFieldNumber(curve, 'valueEnd', 1) + delta,
          });
        case 'CubicHermiteSpline': {
          const start = curvePointOf(curve, 'startPoint', 0, 0);
          const end = curvePointOf(curve, 'endPoint', 1, 1);
          let next = curveSetPoint(curve, 'startPoint', start.x, start.y + delta);
          next = curveSetPoint(next, 'endPoint', end.x, end.y + delta);
          return next;
        }
        case 'PeriodicFunctionCurve':
        case 'AxialSymmetricFunctionCurve': {
          const inner = fields.functionCurve;
          const shifted = isCurveEditorValue(inner)
            ? offsetCurveValue(inner, delta)
            : curveObject('ConstantFunctionCurve', { value: round(delta, 6) });
          return curveSetField(curve, 'functionCurve', shifted);
        }
        case 'AdditionFunctionCurve': {
          if (isCurveEditorValue(fields.firstFunctionCurve)) {
            return curveSetField(curve, 'firstFunctionCurve', offsetCurveValue(fields.firstFunctionCurve, delta));
          }
          if (isCurveEditorValue(fields.secondFunctionCurve)) {
            return curveSetField(curve, 'secondFunctionCurve', offsetCurveValue(fields.secondFunctionCurve, delta));
          }
          return curveSetField(curve, 'firstFunctionCurve', curveObject('ConstantFunctionCurve', { value: round(delta, 6) }));
        }
        default:
          // Composite and any future type: preserve the original function and
          // add a constant offset.
          return curveObject('AdditionFunctionCurve', {
            firstFunctionCurve: deepClone(curve),
            secondFunctionCurve: curveObject('ConstantFunctionCurve', { value: round(delta, 6) }),
          });
      }
    }

    /**
     * Remove value jumps at internal segment boundaries by shifting each right
     * segment (and, in turn, the next) so both sides meet. Segment boundaries
     * themselves never move; the outer ±∞ bounds are untouched.
     */
    function autoFixCurveBoundaryJumps(draft) {
      const next = cloneCurveDraft(draft);
      let changed = false;
      for (let i = 1; i < next.segments.length; i += 1) {
        const boundary = next.segments[i].start;
        if (!Number.isFinite(boundary)) continue;
        const left = sampleCurve(next.segments[i - 1].curve, boundary);
        const right = sampleCurve(next.segments[i].curve, boundary);
        if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right)) continue;
        const delta = left - right;
        const tolerance = 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
        if (Math.abs(delta) <= tolerance) continue;
        next.segments[i] = Object.assign({}, next.segments[i], {
          curve: offsetCurveValue(next.segments[i].curve, delta),
        });
        changed = true;
      }
      if (!changed) return draft;
      next.edited = true;
      return next;
    }

    /** Initial x view: finite segment bounds plus each inner curve's own domain. */
    function curveInitialView(draft, tempo, fallbackRange) {
      const bpm = tempo && Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : 120;
      const secondsPerBeat = 60 / bpm;
      const fallback = Array.isArray(fallbackRange) && fallbackRange.length === 2 ? fallbackRange : [-2 * secondsPerBeat, 2 * secondsPerBeat];
      const xs = [];
      for (const segment of draft.segments) {
        if (Number.isFinite(segment.start)) xs.push(segment.start);
        if (Number.isFinite(segment.end)) xs.push(segment.end);
        const natural = curveNaturalRange(segment.curve, fallback);
        xs.push(natural[0], natural[1]);
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const value of xs) {
        if (!Number.isFinite(value)) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      if (lo === Infinity) return { x0: fallback[0], x1: fallback[1] };
      if (!(hi > lo)) {
        lo -= 2 * secondsPerBeat;
        hi += 2 * secondsPerBeat;
      }
      const pad = Math.max((hi - lo) * 0.12, secondsPerBeat);
      let x0 = lo - pad;
      let x1 = hi + pad;
      const first = draft.segments[0];
      const last = draft.segments[draft.segments.length - 1];
      if (first && first.start === -Infinity) x0 = Math.min(x0, lo - 2 * secondsPerBeat);
      if (last && last.end === Infinity) x1 = Math.max(x1, hi + 2 * secondsPerBeat);
      if (!(x1 > x0)) {
        x0 -= secondsPerBeat;
        x1 += secondsPerBeat;
      }
      return { x0, x1 };
    }

    /** Auto y range for a draft inside a view. */
    function curveValueRange(draft, view) {
      const ys = [0];
      const push = (value) => {
        if (value !== null && Number.isFinite(value)) ys.push(value);
      };
      const piecewise = curveDraftIsPiecewise(draft);
      if (!piecewise && draft.segments.length === 1) {
        const count = 160;
        for (let i = 0; i < count; i += 1) push(sampleCurve(draft.segments[0].curve, view.x0 + ((view.x1 - view.x0) * i) / (count - 1)));
      } else {
        for (const segment of draft.segments) {
          const from = Math.max(segment.start, view.x0);
          const to = Math.min(segment.end, view.x1);
          if (!(to > from)) continue;
          const count = Math.max(2, Math.min(160, Math.round(((to - from) / (view.x1 - view.x0)) * 160)));
          for (let i = 0; i <= count; i += 1) push(sampleCurve(segment.curve, from + ((to - from) * i) / count));
        }
      }
      for (const segment of draft.segments) {
        for (const handle of curveParamHandles(segment.curve, { start: segment.start, end: segment.end, view })) {
          if (!handle.ghost) push(handle.y);
        }
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const value of ys) {
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      if (!(hi > lo)) {
        const base = Number.isFinite(lo) ? lo : 0;
        lo = base - 1;
        hi = base + 1;
      }
      const pad = (hi - lo) * 0.15;
      return [lo - pad, hi + pad];
    }

    /**
     * View that puts the curve panel's beat grid on the same screen x as the
     * main timeline: the left data edge is the main view's left time, and the
     * scale is the main timeline's pixels-per-second.
     */
    function curveAlignedView(anchorTime, mainView, plotWidth) {
      if (!mainView || !Number.isFinite(mainView.t0) || !Number.isFinite(mainView.pps) || mainView.pps <= 0) return null;
      if (!Number.isFinite(plotWidth) || plotWidth <= 0) return null;
      const anchor = Number.isFinite(anchorTime) ? anchorTime : 0;
      const x0 = mainView.t0 - anchor;
      const x1 = x0 + Math.max(1, plotWidth) / mainView.pps;
      if (!(x1 > x0)) return null;
      return { x0, x1 };
    }

    /** Pixel <-> data mapping of the curve panel (ruler + segment band + plot). */
    function curveLayout(width, height, view) {
      const left = CURVE_LAYOUT.left;
      const right = CURVE_LAYOUT.right;
      const plotTop = CURVE_LAYOUT.top;
      const plotBottom = Math.max(plotTop + 20, height - CURVE_LAYOUT.bottom);
      const plotW = Math.max(20, width - left - right);
      const plotH = Math.max(20, plotBottom - plotTop);
      const bandTop = CURVE_LAYOUT.rulerH + CURVE_LAYOUT.bandGap;
      const bandH = CURVE_LAYOUT.bandH;
      const safeX0 = Number.isFinite(view.x0) ? view.x0 : -1;
      const safeX1 = Number.isFinite(view.x1) && view.x1 > safeX0 ? view.x1 : safeX0 + 1;
      const safeY0 = Number.isFinite(view.y0) ? view.y0 : -1;
      const safeY1 = Number.isFinite(view.y1) && view.y1 > safeY0 ? view.y1 : safeY0 + 1;
      return {
        left,
        right,
        plotTop,
        plotBottom,
        plotW,
        plotH,
        rulerH: CURVE_LAYOUT.rulerH,
        bandTop,
        bandH,
        view: { x0: safeX0, x1: safeX1, y0: safeY0, y1: safeY1 },
        toX: (x) => left + ((x - safeX0) / (safeX1 - safeX0)) * plotW,
        toY: (y) => plotBottom - ((y - safeY0) / (safeY1 - safeY0)) * plotH,
        fromX: (px) => safeX0 + ((px - left) / plotW) * (safeX1 - safeX0),
        fromY: (py) => safeY0 + ((plotBottom - py) / plotH) * (safeY1 - safeY0),
      };
    }

    // ------------------------------------------------------------------------
    // Per-type draggable parameters. Each handle carries a `drag(x, y)` that
    // returns the updated curve; nested function curves recurse with a prefix.
    // ------------------------------------------------------------------------

    /** Collect draggable parameter handles of one function curve. */
    function curveParamHandles(curve, options) {
      const opts = options || {};
      const span = curveHandleSpan(opts.start, opts.end, opts.view);
      const handles = [];
      collectCurveParamHandles(curve, span, opts.view || null, '', handles, null);
      return handles.slice(0, 24);
    }

    /** Recursive worker for curveParamHandles. */
    function collectCurveParamHandles(curve, span, view, prefix, handles, parent) {
      const type = curveTypeOf(curve);
      const fields = curve && isTypedValue(curve) && curve.t === 'obj' ? curve.fields || {} : {};
      const num = (name, fallback) => curveFieldNumber(curve, name, fallback);
      const pushPoint = (key, x, y, xEditable, yEditable, drag, extra) => {
        handles.push(Object.assign({
          key: prefix + key,
          x,
          y,
          xEditable,
          yEditable,
          style: 'point',
          drag,
        }, extra || {}));
      };
      const pushVertical = (key, x, drag, extra) => {
        handles.push(Object.assign({
          key: prefix + key,
          x,
          y: 0,
          xEditable: true,
          yEditable: false,
          style: 'vertical',
          drag,
        }, extra || {}));
      };
      if (type === 'ConstantFunctionCurve' || type === 'ConstantCurve') {
        const value = num('value', 0);
        const x = (span.lo + span.hi) / 2;
        pushPoint('value', x, value, false, true, (nextX, nextY) => (nextY === null ? curve : curveSetNumericField(curve, 'value', nextY)), { label: 'value' });
        return;
      }
      if (type === 'LinearFunctionCurve') {
        const k = num('k', 0);
        const b = num('b', 0);
        const xa = span.lo + (span.hi - span.lo) / 3;
        const xb = span.lo + ((span.hi - span.lo) * 2) / 3;
        const ya = k * xa + b;
        const yb = k * xb + b;
        const solveA = (nextY) => {
          if (Math.abs(xb - xa) < 1e-9) return curve;
          const kk = (yb - nextY) / (xb - xa);
          return curveSetNumericFields(curve, { k: kk, b: nextY - kk * xa });
        };
        const solveB = (nextY) => {
          if (Math.abs(xa - xb) < 1e-9) return curve;
          const kk = (ya - nextY) / (xa - xb);
          return curveSetNumericFields(curve, { k: kk, b: nextY - kk * xb });
        };
        pushPoint('linear-a', xa, ya, false, true, (nextX, nextY) => (nextY === null ? curve : solveA(nextY)), { label: 'A' });
        pushPoint('linear-b', xb, yb, false, true, (nextX, nextY) => (nextY === null ? curve : solveB(nextY)), { label: 'B' });
        return;
      }
      if (type === 'LinearCurve') {
        const t0 = num('timeStart', span.lo);
        const t1 = num('timeEnd', span.hi);
        const v0 = num('valueStart', 0);
        const v1 = num('valueEnd', 1);
        pushPoint('key-start', t0, v0, true, true, (nextX, nextY) => {
          const x = nextX === null ? t0 : Math.min(nextX, t1 - 1e-4);
          const y = nextY === null ? v0 : nextY;
          return curveSetNumericFields(curve, { timeStart: x, valueStart: y });
        }, { label: 'start' });
        pushPoint('key-end', t1, v1, true, true, (nextX, nextY) => {
          const x = nextX === null ? t1 : Math.max(nextX, t0 + 1e-4);
          const y = nextY === null ? v1 : nextY;
          return curveSetNumericFields(curve, { timeEnd: x, valueEnd: y });
        }, { label: 'end' });
        return;
      }
      if (type === 'CubicHermiteSpline' || type === 'HermiteSpline') {
        const startPoint = curvePointOf(curve, 'startPoint', span.lo, 0);
        const endPoint = curvePointOf(curve, 'endPoint', span.hi, 1);
        const tangentStart = num('startTangent', 0);
        const tangentEnd = num('endTangent', 0);
        const h = Math.max((endPoint.x - startPoint.x) / 4, 1e-6);
        pushPoint('point-start', startPoint.x, startPoint.y, true, true, (nextX, nextY) => {
          const x = nextX === null ? startPoint.x : Math.min(nextX, endPoint.x - 1e-4);
          const y = nextY === null ? startPoint.y : nextY;
          return curveSetPoint(curve, 'startPoint', x, y);
        }, { label: 'start' });
        pushPoint('point-end', endPoint.x, endPoint.y, true, true, (nextX, nextY) => {
          const x = nextX === null ? endPoint.x : Math.max(nextX, startPoint.x + 1e-4);
          const y = nextY === null ? endPoint.y : nextY;
          return curveSetPoint(curve, 'endPoint', x, y);
        }, { label: 'end' });
        pushPoint('tangent-start', startPoint.x + h, startPoint.y + tangentStart * h, false, true, (nextX, nextY) => {
          if (nextY === null) return curve;
          return curveSetNumericField(curve, 'startTangent', (nextY - startPoint.y) / h);
        }, { style: 'tangent', label: 'tangent', lineTo: [startPoint.x, startPoint.y] });
        pushPoint('tangent-end', endPoint.x - h, endPoint.y - tangentEnd * h, false, true, (nextX, nextY) => {
          if (nextY === null) return curve;
          return curveSetNumericField(curve, 'endTangent', (endPoint.y - nextY) / h);
        }, { style: 'tangent', label: 'tangent', lineTo: [endPoint.x, endPoint.y] });
        return;
      }
      if (type === 'PeriodicFunctionCurve') {
        const startX = num('startX', span.lo);
        const endX = num('endX', span.hi);
        pushVertical('period-start', startX, (nextX) => {
          if (nextX === null) return curve;
          return curveSetNumericField(curve, 'startX', Math.min(nextX, endX - 1e-4));
        }, { label: 'startX' });
        pushVertical('period-end', endX, (nextX) => {
          if (nextX === null) return curve;
          return curveSetNumericField(curve, 'endX', Math.max(nextX, startX + 1e-4));
        }, { label: 'endX' });
        {
          const innerSpan = endX > startX ? { lo: startX, hi: endX } : span;
          const innerHandles = [];
          collectCurveParamHandles(fields.functionCurve, innerSpan, view, prefix + 'inner.', innerHandles, curve);
          for (const handle of innerHandles) {
            const childDrag = handle.drag;
            handles.push(
              Object.assign({}, handle, {
                drag: (nextX, nextY) => {
                  const updated = childDrag(nextX, nextY);
                  if (!updated || updated === fields.functionCurve) return curve;
                  return curveSetField(curve, 'functionCurve', updated);
                },
              }),
            );
          }
        }
        return;
      }
      if (type === 'AxialSymmetricFunctionCurve') {
        const axis = num('axis', span.lo);
        pushVertical('axis', axis, (nextX) => (nextX === null ? curve : curveSetNumericField(curve, 'axis', nextX)), { label: 'axis' });
        const innerHandles = [];
        collectCurveParamHandles(fields.functionCurve, span, view, prefix + 'inner.', innerHandles, curve);
        for (const handle of innerHandles) {
          const childDrag = handle.drag;
          handles.push(
            Object.assign({}, handle, {
              drag: (nextX, nextY) => {
                const updated = childDrag(nextX, nextY);
                if (!updated || updated === fields.functionCurve) return curve;
                return curveSetField(curve, 'functionCurve', updated);
              },
            }),
          );
          handles.push(Object.assign({}, handle, {
            key: handle.key + '.mirror',
            x: 2 * axis - handle.x,
            ghost: true,
            drag: () => curve,
          }));
        }
        return;
      }
      if (type === 'AdditionFunctionCurve') {
        const firstHandles = [];
        collectCurveParamHandles(fields.firstFunctionCurve, span, view, prefix + 'first.', firstHandles, curve);
        for (const handle of firstHandles) {
          const childDrag = handle.drag;
          handles.push(
            Object.assign({}, handle, {
              accent: 0,
              drag: (nextX, nextY) => {
                const updated = childDrag(nextX, nextY);
                if (!updated || updated === fields.firstFunctionCurve) return curve;
                return curveSetField(curve, 'firstFunctionCurve', updated);
              },
            }),
          );
        }
        const secondHandles = [];
        collectCurveParamHandles(fields.secondFunctionCurve, span, view, prefix + 'second.', secondHandles, curve);
        for (const handle of secondHandles) {
          const childDrag = handle.drag;
          handles.push(
            Object.assign({}, handle, {
              accent: 1,
              drag: (nextX, nextY) => {
                const updated = childDrag(nextX, nextY);
                if (!updated || updated === fields.secondFunctionCurve) return curve;
                return curveSetField(curve, 'secondFunctionCurve', updated);
              },
            }),
          );
        }
        return;
      }
      // CompositeFunctionCurve (and nested piecewise) have no direct x handles.
    }

    // ------------------------------------------------------------------------
    // Canvas painter (pure function of the panel state passed in `opts`).
    // ------------------------------------------------------------------------

    /** Small helper: apply a selection highlight to a color. */
    function curveWithAlpha(ctx, color, alpha) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
    }

    /** Paint the curve panel canvas. */
    function paintCurveCanvas(opts) {
      const canvas = opts.canvasRef && opts.canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 800, height: 420 };
      const width = Math.max(200, Math.round(rect.width || canvas.clientWidth || 800));
      const height = Math.max(120, Math.round(rect.height || canvas.clientHeight || 420));
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';

      const colors = {
        background: cssToken('--dsw-alias-bg-base', '#10131a'),
        layerOne: cssToken('--dsw-alias-bg-layer-1', '#171b24'),
        layerTwo: cssToken('--dsw-alias-bg-layer-2', '#1e2330'),
        border: cssToken('--dsw-alias-border-l1', '#2b3244'),
        label: cssToken('--dsw-alias-label-primary', '#eef1f7'),
        secondary: cssToken('--dsw-alias-label-secondary', '#8b93a7'),
        brand: cssToken('--dsw-alias-brand-primary', '#5b8cff'),
        warn: cssToken('--dsw-alias-state-warn-primary', '#f59e0b'),
      };

      const draft = opts.draft;
      const segments = draft.segments || [];
      const view = opts.view;
      const layout = curveLayout(width, height, view);
      const selected = segments.find((segment) => segment.id === opts.selectedId) || segments[0] || null;
      const selectedIndex = selected ? segments.indexOf(selected) : -1;
      const bpm = opts.tempo && Number.isFinite(opts.tempo.bpm) && opts.tempo.bpm > 0 ? opts.tempo.bpm : 120;
      const secondsPerBeat = 60 / bpm;
      const origin = (opts.tempo && Number.isFinite(opts.tempo.offset) ? opts.tempo.offset : 0) - (Number.isFinite(opts.anchorTime) ? opts.anchorTime : 0);
      const pixelsPerSecond = layout.plotW / (view.x1 - view.x0);
      const hover = opts.hover;
      const drag = opts.dragRef ? opts.dragRef.current : null;

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = colors.layerOne;
      ctx.fillRect(0, 0, width, layout.rulerH);
      ctx.fillStyle = colors.layerTwo;
      ctx.fillRect(0, layout.bandTop, width, layout.bandH);

      // Beat ruler + vertical grid (main timeline BPM/offset, anchored at the element).
      const division = opts.snapDiv || 4;
      let beatStep = 1 / division;
      let guard = 0;
      while (beatStep * secondsPerBeat * pixelsPerSecond < 4 && guard < 60) {
        beatStep *= 2;
        guard += 1;
      }
      if (!Number.isFinite(beatStep) || beatStep <= 0) beatStep = 1;
      let labelStep = beatStep;
      guard = 0;
      while (labelStep * secondsPerBeat * pixelsPerSecond < 58 && guard < 60) {
        labelStep *= 2;
        guard += 1;
      }
      const firstBeat = Math.ceil((view.x0 - origin) / secondsPerBeat / beatStep) * beatStep - beatStep;
      const lastBeat = (view.x1 - origin) / secondsPerBeat;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      for (let beat = firstBeat; beat <= lastBeat + beatStep; beat += beatStep) {
        const px = layout.toX(origin + beat * secondsPerBeat);
        if (px < layout.left - 0.5 || px > layout.left + layout.plotW + 0.5) continue;
        const whole = Math.abs(beat - Math.round(beat)) < 1e-9;
        ctx.strokeStyle = whole ? colors.border : 'rgba(120,130,150,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, layout.rulerH);
        ctx.lineTo(Math.round(px) + 0.5, layout.plotBottom);
        ctx.stroke();
        const labeled = Math.abs(beat / labelStep - Math.round(beat / labelStep)) < 1e-9;
        if (labeled && whole) {
          ctx.fillStyle = colors.secondary;
          ctx.fillText('♪' + formatNum(beat, Math.abs(beat - Math.round(beat)) < 1e-9 ? 0 : 1), px + 3, layout.rulerH - 6);
        }
      }
      // Seconds labels along the bottom.
      const secondCandidates = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
      let secondsStep = secondCandidates[secondCandidates.length - 1];
      for (const candidate of secondCandidates) {
        if (candidate * pixelsPerSecond >= 68) {
          secondsStep = candidate;
          break;
        }
      }
      guard = 0;
      while (secondsStep * pixelsPerSecond < 68 && guard < 60) {
        secondsStep *= 2;
        guard += 1;
      }
      if (!Number.isFinite(secondsStep) || secondsStep <= 0) secondsStep = 120;
      const firstSecond = Math.ceil(view.x0 / secondsStep) * secondsStep;
      for (let x = firstSecond; x <= view.x1 + secondsStep; x += secondsStep) {
        const px = layout.toX(x);
        if (px < layout.left || px > layout.left + layout.plotW) continue;
        ctx.fillStyle = colors.secondary;
        ctx.fillText(formatNum(x, 2) + 's', px + 2, height - 8);
      }

      // Horizontal value grid.
      for (let i = 0; i <= 4; i += 1) {
        const y = view.y0 + ((view.y1 - view.y0) * i) / 4;
        const py = layout.toY(y);
        ctx.strokeStyle = colors.border;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.moveTo(layout.left, Math.round(py) + 0.5);
        ctx.lineTo(layout.left + layout.plotW, Math.round(py) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors.secondary;
        ctx.fillText(formatNum(y, 3), 4, py + 3);
      }
      if (view.y0 < 0 && view.y1 > 0) {
        const py = layout.toY(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.beginPath();
        ctx.moveTo(layout.left, py);
        ctx.lineTo(layout.left + layout.plotW, py);
        ctx.stroke();
      }
      // Element origin (x = 0).
      if (view.x0 <= 0 && view.x1 >= 0) {
        const px = layout.toX(0);
        ctx.strokeStyle = 'rgba(124,140,255,0.45)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, layout.plotTop);
        ctx.lineTo(px, layout.plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = colors.secondary;
        ctx.fillText(opts.t('curveElementOrigin'), px + 3, layout.plotTop - 4);
      }
      // Outside-the-covered-range shading (piecewise only).
      if (curveDraftIsPiecewise(draft) && segments.length) {
        const first = segments[0];
        const last = segments[segments.length - 1];
        const regions = [];
        if (Number.isFinite(first.start) && first.start > view.x0) regions.push([view.x0, Math.min(first.start, view.x1)]);
        if (Number.isFinite(last.end) && last.end < view.x1) regions.push([Math.max(last.end, view.x0), view.x1]);
        for (const region of regions) {
          const x0 = layout.toX(region[0]);
          const x1 = layout.toX(region[1]);
          if (!(x1 > x0)) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, layout.plotTop, x1 - x0, layout.plotH);
          ctx.clip();
          ctx.strokeStyle = 'rgba(139,147,167,0.18)';
          ctx.lineWidth = 1;
          for (let offset = -layout.plotH; offset < x1 - x0 + layout.plotH; offset += 9) {
            ctx.beginPath();
            ctx.moveTo(x0 + offset, layout.plotBottom);
            ctx.lineTo(x0 + offset + layout.plotH, layout.plotTop);
            ctx.stroke();
          }
          ctx.restore();
          ctx.fillStyle = colors.secondary;
          ctx.fillText('0', x0 + (x1 - x0) / 2, layout.plotTop + 24);
        }
      }

      // Segment band.
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const from = Math.max(segment.start, view.x0);
        const to = Math.min(segment.end, view.x1);
        if (!(to > from)) continue;
        const x0 = layout.toX(from);
        const x1 = layout.toX(to);
        const color = CURVE_SEGMENT_COLORS[i % CURVE_SEGMENT_COLORS.length];
        const active = selected && segment.id === selected.id;
        curveWithAlpha(ctx, color, active ? 0.3 : 0.15);
        ctx.fillRect(x0 + 1, layout.bandTop + 2, Math.max(1, x1 - x0 - 2), layout.bandH - 4);
        ctx.globalAlpha = 1;
        if (active) {
          ctx.strokeStyle = colors.brand;
          ctx.lineWidth = 1.4;
          ctx.strokeRect(x0 + 1.5, layout.bandTop + 2.5, Math.max(1, x1 - x0 - 3), layout.bandH - 5);
        }
        ctx.fillStyle = colors.label;
        ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif';
        const label = i + 1 + ' · ' + curveTypeLabel(opts.t, curveTypeOf(segment.curve));
        if (x1 - x0 > 30) ctx.fillText(fitText(ctx, label, x1 - x0 - 12), x0 + 6, layout.bandTop + layout.bandH / 2 + 3);
      }

      // Segment boundary handles + warning marks.
      const boundaries = curveBoundaries(draft);
      for (let i = 0; i < boundaries.length; i += 1) {
        const boundary = boundaries[i];
        if (!Number.isFinite(boundary)) continue;
        if (boundary < view.x0 || boundary > view.x1) continue;
        const px = layout.toX(boundary);
        const active =
          (hover && hover.kind === 'boundary' && hover.index === i) ||
          (drag && drag.kind === 'boundary' && drag.boundaryIndex === i);
        ctx.strokeStyle = active ? colors.brand : 'rgba(220,226,240,0.28)';
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.setLineDash(active ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(px, layout.plotTop);
        ctx.lineTo(px, layout.plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(px, layout.bandTop + layout.bandH, active ? 6 : 5, 0, Math.PI * 2);
        ctx.fillStyle = active ? '#ffffff' : colors.brand;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = active ? colors.brand : 'rgba(255,255,255,0.82)';
        ctx.stroke();
      }
      for (const warning of opts.warnings || []) {
        if (warning.time < view.x0 || warning.time > view.x1) continue;
        const px = layout.toX(warning.time);
        const py = layout.plotTop + 12;
        ctx.beginPath();
        ctx.arc(px, py, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.warn;
        ctx.fill();
        ctx.fillStyle = '#10131a';
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('!', px, py + 3);
        ctx.textAlign = 'left';
      }

      // Curves.
      const drawCurve = (curve, from, to, color, lineWidth) => {
        if (!(to > from)) return;
        const pixelWidth = (to - from) * pixelsPerSecond;
        const count = Math.max(2, Math.min(500, Math.round(pixelWidth)));
        let started = false;
        ctx.beginPath();
        for (let i = 0; i <= count; i += 1) {
          const x = from + ((to - from) * i) / count;
          const y = sampleCurve(curve, x);
          if (y === null || !Number.isFinite(y)) {
            started = false;
            continue;
          }
          const px = layout.toX(x);
          const py = layout.toY(y);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      };
      if (!curveDraftIsPiecewise(draft) && segments.length === 1) {
        drawCurve(segments[0].curve, view.x0, view.x1, CURVE_SEGMENT_COLORS[0], 2);
      } else {
        for (let i = 0; i < segments.length; i += 1) {
          const segment = segments[i];
          const from = Math.max(segment.start, view.x0);
          const to = Math.min(segment.end, view.x1);
          const active = selected && segment.id === selected.id;
          drawCurve(segment.curve, from, to, CURVE_SEGMENT_COLORS[i % CURVE_SEGMENT_COLORS.length], active ? 2.4 : 1.7);
        }
      }

      // Parameter handles of the selected segment.
      if (selected) {
        const handles = curveParamHandles(selected.curve, { start: selected.start, end: selected.end, view });
        for (const handle of handles) {
          if (handle.ghost) continue;
          if (handle.x < view.x0 || handle.x > view.x1) continue;
          const px = layout.toX(handle.x);
          const color =
            handle.accent === 1 ? '#ff9f43' : handle.accent === 0 ? CURVE_SEGMENT_COLORS[selectedIndex % CURVE_SEGMENT_COLORS.length] : CURVE_SEGMENT_COLORS[selectedIndex % CURVE_SEGMENT_COLORS.length];
          const active = hover && hover.kind === 'param' && hover.key === handle.key;
          if (handle.style === 'vertical') {
            ctx.strokeStyle = active ? colors.brand : 'rgba(220,226,240,0.35)';
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(px, layout.plotTop);
            ctx.lineTo(px, layout.plotBottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = active ? '#ffffff' : color;
            ctx.fillRect(px - 4, layout.plotTop + 2, 8, 8);
            ctx.strokeStyle = colors.brand;
            ctx.strokeRect(px - 4, layout.plotTop + 2, 8, 8);
            if (active) {
              ctx.fillStyle = colors.label;
              ctx.font = '10px ui-monospace, monospace';
              ctx.fillText(formatNum(handle.x, 3), px + 8, layout.plotTop + 12);
            }
            continue;
          }
          const py = layout.toY(handle.y);
          if (handle.lineTo) {
            ctx.strokeStyle = 'rgba(220,226,240,0.35)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(layout.toX(handle.lineTo[0]), layout.toY(handle.lineTo[1]));
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.beginPath();
          ctx.arc(px, py, active ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = active ? '#ffffff' : color;
          ctx.fill();
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = active ? colors.brand : 'rgba(255,255,255,0.85)';
          ctx.stroke();
          if (active) {
            ctx.fillStyle = colors.label;
            ctx.font = '10px ui-monospace, monospace';
            ctx.fillText(formatNum(handle.x, 3) + 's / ' + formatNum(handle.y, 3), px + 8, py - 8);
          }
        }
      }

      // Hover crosshair + value readout.
      if (hover && hover.kind === 'plot' && Number.isFinite(hover.x)) {
        const px = layout.toX(hover.x);
        if (px >= layout.left && px <= layout.left + layout.plotW) {
          ctx.strokeStyle = 'rgba(220,226,240,0.35)';
          ctx.setLineDash([2, 4]);
          ctx.beginPath();
          ctx.moveTo(px, layout.plotTop);
          ctx.lineTo(px, layout.plotBottom);
          ctx.stroke();
          ctx.setLineDash([]);
          let value = null;
          for (const segment of segments) {
            if (hover.x >= segment.start && hover.x <= segment.end) {
              value = sampleCurve(segment.curve, hover.x);
              break;
            }
          }
          const beat = (hover.x - origin) / secondsPerBeat;
          const text =
            formatNum(hover.x, 3) +
            's · ' +
            (opts.t('beat') || 'beat') +
            ' ' +
            formatNum(beat, 3) +
            (value === null ? '' : ' · ' + formatNum(value, 3));
          ctx.font = '10.5px ui-monospace, monospace';
          const textWidth = ctx.measureText(text).width;
          const boxX = Math.min(px + 8, layout.left + layout.plotW - textWidth - 10);
          const boxY = layout.plotTop + 14;
          ctx.fillStyle = colors.layerTwo;
          ctx.fillRect(boxX - 4, boxY - 11, textWidth + 8, 17);
          ctx.strokeStyle = colors.border;
          ctx.strokeRect(boxX - 4.5, boxY - 11.5, textWidth + 9, 18);
          ctx.fillStyle = colors.label;
          ctx.fillText(text, boxX, boxY + 2);
        }
      }

      if (!segments.length) {
        ctx.fillStyle = colors.secondary;
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(opts.t('curveNoSegments'), width / 2, height / 2);
        ctx.textAlign = 'left';
      }
    }

    // ------------------------------------------------------------------------
    // Context menu (new segment / change type / delete).
    // ------------------------------------------------------------------------

    /** Small fixed menu for the curve panel. */
    function CurveContextMenu(props) {
      const { t, menu, segments, onClose, onSetView, onCreate, onChangeType, onDelete } = props;
      const menuRef = useRef(null);
      useEffect(() => {
        const close = () => onClose();
        const onPointerDown = (event) => {
          const node = menuRef.current;
          if (node && event && event.target && typeof node.contains === 'function' && node.contains(event.target)) return;
          onClose();
        };
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', close);
        window.addEventListener('wheel', close, true);
        window.addEventListener('blur', close);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('wheel', close, true);
          window.removeEventListener('blur', close);
        };
      }, [onClose]);
      const segment = menu.segmentId ? segments.find((item) => item.id === menu.segmentId) || null : null;
      const currentType = segment ? curveTypeOf(segment.curve) : '';
      const width = 244;
      const estimatedHeight = menu.view === 'root' ? 168 : 360;
      const left = clamp(Number.isFinite(menu.x) ? menu.x : 12, 8, Math.max(8, (window.innerWidth || 1200) - width - 8));
      const top = clamp(Number.isFinite(menu.y) ? menu.y : 12, 8, Math.max(8, (window.innerHeight || 800) - estimatedHeight - 8));
      const head =
        menu.view === 'root'
          ? segment
            ? t('curveSegment') + ' ' + (segments.indexOf(segment) + 1) + ' · ' + curveTypeLabel(t, currentType)
            : t('curveNewSegmentAt').replace('{time}', formatNum(menu.xData, 3) + 's')
          : menu.action === 'change'
            ? t('curveChangeType')
            : t('curveChooseType');
      const item = (key, label, icon, onClick, options) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'dgc-menuItem' + (options && options.danger ? ' is-danger' : ''),
            role: 'menuitem',
            disabled: options && options.disabled,
            style: options && options.disabled ? { opacity: 0.45, cursor: 'default' } : undefined,
            onClick: options && options.disabled ? undefined : onClick,
          },
          icon ? h(Icon, { name: icon, size: 13 }) : h('span', { style: { width: 13, flex: '0 0 13px' } }, ''),
          h('span', null, label),
        );
      return h(
        'div',
        {
          ref: menuRef,
          className: 'dgc-menu',
          role: 'menu',
          'aria-label': head,
          style: { left, top },
          onContextMenu: (event) => event.preventDefault(),
        },
        h('div', { className: 'dgc-menuHead' }, head),
        menu.view === 'root'
          ? [
              item('new', t('curveNewSegment'), 'plus', () => onSetView(menu.segmentId ? 'new' : 'new'), { disabled: menu.segmentId ? false : !menu.canInsert }),
              item('change', t('curveChangeType'), 'pencil', () => onSetView('change'), { disabled: !segment }),
              item('delete', t('curveDeleteSegment'), 'trash', onDelete, { danger: true, disabled: !segment || segments.length <= 1 }),
            ]
          : curveTypeChoices(currentType).map((type) =>
              h(
                'button',
                {
                  key: type,
                  type: 'button',
                  className: 'dgc-menuItem',
                  role: 'menuitemradio',
                  'aria-checked': type === currentType,
                  onClick: () => (menu.action === 'change' ? onChangeType(type) : onCreate(type)),
                },
                h('span', { style: { width: 13, textAlign: 'center', fontSize: 11, flex: '0 0 13px' } }, type === currentType ? '✓' : ''),
                h('span', null, curveTypeLabel(t, type)),
              ),
            ),
      );
    }

    // ------------------------------------------------------------------------
    // The docked panel.
    // ------------------------------------------------------------------------

    /** One finite/infinite boundary input. */
    function CurveBoundaryField(props) {
      const { t, value, onChange, onMakeFinite } = props;
      if (!Number.isFinite(value)) {
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', { className: 'dgc-mono dgc-listRowSlim' }, value > 0 ? '+∞' : '−∞'),
          onMakeFinite
            ? h(Button, { variant: 'ghost', onClick: onMakeFinite, title: t('curveMakeFinite') }, h('span', { className: 'dgc-listRowSlim' }, t('curveMakeFinite')))
            : null,
        );
      }
      return h(NumberField, { value, step: 0.05, onCommit: onChange });
    }

    /** The docked curve editor: beat ruler, segment band, plot and side editor. */
    function CurveEditorLayer(props) {
      const t = props.t;
      const target = props.target || {};
      const bpm = props.tempo && Number.isFinite(props.tempo.bpm) && props.tempo.bpm > 0 ? props.tempo.bpm : 120;
      const secondsPerBeat = 60 / bpm;
      const fallbackRange = useMemo(() => [-2 * secondsPerBeat, 2 * secondsPerBeat], [secondsPerBeat]);
      const anchorTime = Number.isFinite(target.anchorTime) ? target.anchorTime : 0;

      const initialRef = useRef(null);
      if (initialRef.current === null) {
        initialRef.current = readCurveDraft(target.value, { fallbackRange });
      }
      const [draft, setDraft] = useState(initialRef.current);
      const [selectedId, setSelectedId] = useState(() => firstCurveSegmentId(initialRef.current));
      const [view, setView] = useState(() => curveInitialView(initialRef.current, props.tempo, fallbackRange));
      const [hover, setHover] = useState(null);
      const [drag, setDrag] = useState(null);
      const [menu, setMenu] = useState(null);
      const [resizeTick, setResizeTick] = useState(0);
      const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
      const dragRef = useRef(null);
      const hoverRef = useRef(null);
      const canvasRef = useRef(null);
      const mainView = target.mainView;
      const draftRef = useRef(draft);
      const viewRef = useRef(view);
      const selectedIdRef = useRef(selectedId);
      const yRange = useMemo(() => curveValueRange(draft, view), [draft, view]);
      const yRangeRef = useRef(yRange);
      const warnings = useMemo(() => curveBoundaryWarnings(draft), [draft]);
      const autoFixWarnings = useCallback(() => setDraft((current) => autoFixCurveBoundaryJumps(current)), []);
      const boundaries = curveBoundaries(draft);
      const foundIndex = draft.segments.findIndex((segment) => segment.id === selectedId);
      const selectedIndex = foundIndex >= 0 ? foundIndex : draft.segments.length ? 0 : -1;
      const selected = selectedIndex >= 0 ? draft.segments[selectedIndex] : null;
      const currentType = selected ? curveTypeOf(selected.curve) : '';
      const piecewise = curveDraftIsPiecewise(draft);
      const dirty = draft.edited === true;

      draftRef.current = draft;
      viewRef.current = view;
      selectedIdRef.current = selected ? selected.id : selectedId;
      hoverRef.current = hover;
      yRangeRef.current = yRange;

      const changeDrag = useCallback((next) => {
        dragRef.current = next;
        setDrag(next);
      }, []);

      useEffect(() => {
        const onResize = () => setResizeTick((value) => value + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // Track the plot canvas size so the aligned view can be computed.
      useEffect(() => {
        const measure = () => {
          const canvas = canvasRef.current;
          if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return;
          const rect = canvas.getBoundingClientRect();
          const w = Math.round(rect.width || 0);
          const h = Math.round(rect.height || 0);
          setCanvasSize((previous) => (previous.w === w && previous.h === h ? previous : { w, h }));
        };
        measure();
        window.addEventListener('resize', measure);
        let observer = null;
        if (typeof ResizeObserver === 'function' && canvasRef.current) {
          observer = new ResizeObserver(measure);
          observer.observe(canvasRef.current);
        }
        return () => {
          window.removeEventListener('resize', measure);
          if (observer) observer.disconnect();
        };
      }, []);

      // Align the beat grid with the main timeline's time scale/offset until
      // the user explicitly zooms or pans the panel.
      useEffect(() => {
        const plotWidth = canvasSize.w - CURVE_LAYOUT.left - CURVE_LAYOUT.right;
        const aligned = curveAlignedView(anchorTime, mainView, plotWidth);
        if (!aligned) return;
        setView((previous) => {
          if (Math.abs(previous.x0 - aligned.x0) < 1e-9 && Math.abs(previous.x1 - aligned.x1) < 1e-9) return previous;
          return aligned;
        });
      }, [mainView, anchorTime, canvasSize.w, target.token]);

      // Re-key the draft when the page swaps to another curve target without a
      // remount (the page normally closes/unmounts first; this also keeps the
      // component correct under the test harness's positional hook slots).
      const activeTokenRef = useRef(target.token);
      useEffect(() => {
        if (activeTokenRef.current === target.token) return;
        activeTokenRef.current = target.token;
        const fresh = readCurveDraft(target.value, { fallbackRange });
        setDraft(fresh);
        setSelectedId(firstCurveSegmentId(fresh));
        setView(curveInitialView(fresh, props.tempo, fallbackRange));
        setHover(null);
        changeDrag(null);
        setMenu(null);
      }, [target.token, target.value, fallbackRange, props.tempo, changeDrag]);

      useDialogEscape(props.onClose);

      // A non-drag draft edit invalidates the hover readout (segment/type edit,
      // numeric input); a drag keeps its active handle hover.
      useEffect(() => {
        if (!dragRef.current && hoverRef.current) setHover(null);
      }, [draft]);

      // The shared x view can move under the pointer (main scroll/zoom); drop
      // the stale data readout until the next pointer move.
      useEffect(() => {
        if (!dragRef.current && hoverRef.current) setHover(null);
      }, [view.x0, view.x1]);

      /** Live view (frozen while a drag is in progress). */
      const currentView = () => {
        const active = dragRef.current;
        if (active && active.frozen) return active.frozen;
        return { x0: viewRef.current.x0, x1: viewRef.current.x1, y0: yRangeRef.current[0], y1: yRangeRef.current[1] };
      };

      /** Pointer position in canvas CSS pixels + the canvas rect. */
      const localPoint = (event) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const clientX = event && Number.isFinite(event.clientX) ? event.clientX : 0;
        const clientY = event && Number.isFinite(event.clientY) ? event.clientY : 0;
        return { x: clientX - rect.left, y: clientY - rect.top, width: rect.width || 800, height: rect.height || 420 };
      };

      /** Segment index whose [start, end] contains x (last segment closes its end). */
      const segmentIndexAt = (x) => {
        const list = draftRef.current.segments;
        for (let i = 0; i < list.length; i += 1) {
          const segment = list[i];
          if (x >= segment.start && (x < segment.end || (i === list.length - 1 && x <= segment.end))) return i;
        }
        return -1;
      };

      /** Closest handle, boundary or segment under a pointer. */
      const hitTest = (point) => {
        const v = currentView();
        const layout = curveLayout(point.width, point.height, v);
        const list = draftRef.current.segments;
        const bounds = curveBoundaries(draftRef.current);
        let boundaryIndex = -1;
        let boundaryDistance = 14;
        for (let i = 0; i < bounds.length; i += 1) {
          const boundary = bounds[i];
          if (!Number.isFinite(boundary)) continue;
          const px = layout.toX(boundary);
          const inBand = point.y >= layout.bandTop - 5 && point.y <= layout.bandTop + layout.bandH + 5;
          // Boundaries are grabbed from the segment band only, so parameter
          // handles that sit exactly on a segment edge remain draggable.
          if (!inBand) continue;
          const distance = Math.abs(px - point.x);
          if (distance < boundaryDistance) {
            boundaryDistance = distance;
            boundaryIndex = i;
          }
        }
        if (boundaryIndex >= 0) return { kind: 'boundary', index: boundaryIndex };
        const selectedNow = list.find((segment) => segment.id === selectedIdRef.current) || list[0];
        if (selectedNow) {
          const handles = curveParamHandles(selectedNow.curve, { start: selectedNow.start, end: selectedNow.end, view: v });
          let bestHandle = null;
          let bestDistance = 11 * 11;
          for (const handle of handles) {
            if (handle.ghost) continue;
            const px = layout.toX(handle.x);
            const py = handle.style === 'vertical' ? layout.plotTop + 6 : layout.toY(handle.y);
            const dx = px - point.x;
            const dy = py - point.y;
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
              bestDistance = distance;
              bestHandle = handle;
            }
          }
          if (bestHandle) return { kind: 'param', key: bestHandle.key };
        }
        if (point.y < layout.rulerH) return { kind: 'ruler' };
        const x = layout.fromX(point.x);
        const segmentIndex = segmentIndexAt(x);
        return {
          kind: point.y <= layout.bandTop + layout.bandH ? 'band' : 'plot',
          x,
          segmentIndex,
        };
      };

      const updateHover = (point) => {
        const hit = hitTest(point);
        let next = null;
        if (hit.kind === 'boundary') next = { kind: 'boundary', index: hit.index };
        else if (hit.kind === 'param') next = { kind: 'param', key: hit.key };
        else if (hit.kind === 'plot') next = { kind: 'plot', x: hit.x, segmentIndex: hit.segmentIndex };
        else if (hit.kind === 'band') next = { kind: 'band', x: hit.x, segmentIndex: hit.segmentIndex };
        const previousKey = hoverRef.current ? JSON.stringify(hoverRef.current) : '';
        const nextKey = next ? JSON.stringify(next) : '';
        if (previousKey !== nextKey) setHover(next);
      };

      const onPointerDown = (event) => {
        if (event && event.button !== undefined && event.button !== 0) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const point = localPoint(event);
        if (!point) return;
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          /* the harness / older browsers may not support pointer capture */
        }
        const hit = hitTest(point);
        const v = currentView();
        const frozen = { x0: v.x0, x1: v.x1, y0: v.y0, y1: v.y1 };
        if (hit.kind === 'boundary') {
          changeDrag({ kind: 'boundary', boundaryIndex: hit.index, frozen, pointerId: event.pointerId });
          setHover({ kind: 'boundary', index: hit.index });
          return;
        }
        if (hit.kind === 'param') {
          const selectedNow = draftRef.current.segments.find((segment) => segment.id === selectedIdRef.current) || draftRef.current.segments[0];
          if (selectedNow) {
            changeDrag({ kind: 'param', key: hit.key, segmentId: selectedNow.id, frozen, pointerId: event.pointerId });
            setHover({ kind: 'param', key: hit.key });
            return;
          }
        }
        if (hit.segmentIndex >= 0) {
          const segment = draftRef.current.segments[hit.segmentIndex];
          if (segment) setSelectedId(segment.id);
        }
        changeDrag({
          kind: 'pan',
          startX: point.x,
          startY: point.y,
          frozen,
          view0: { x0: viewRef.current.x0, x1: viewRef.current.x1 },
          pointerId: event.pointerId,
          moved: false,
          segmentIndex: hit.segmentIndex,
        });
      };

      const onPointerMove = (event) => {
        const point = localPoint(event);
        if (!point) return;
        const active = dragRef.current;
        if (!active) {
          updateHover(point);
          return;
        }
        if (active.kind === 'pan') {
          const dx = point.x - active.startX;
          const dy = point.y - active.startY;
          if (!active.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
          active.moved = true;
          const layout = curveLayout(point.width, point.height, active.frozen);
          const delta = (dx / layout.plotW) * (active.frozen.x1 - active.frozen.x0);
          if (typeof props.onTimelineSetT0 === 'function') {
            props.onTimelineSetT0(active.frozen.x0 + anchorTime - delta);
            return;
          }
          setView({ x0: active.view0.x0 - delta, x1: active.view0.x1 - delta });
          return;
        }
        if (active.kind === 'boundary') {
          const layout = curveLayout(point.width, point.height, active.frozen);
          const raw = layout.fromX(point.x);
          const nextX = props.snapOn ? snapCurveTime(raw, props.tempo, props.snapDiv, anchorTime, true) : round(raw, 6);
          setDraft((current) => setSegmentBoundary(current, active.boundaryIndex, nextX, { snap: false }));
          return;
        }
        if (active.kind === 'param') {
          const layout = curveLayout(point.width, point.height, active.frozen);
          const rawX = layout.fromX(point.x);
          const rawY = layout.fromY(point.y);
          const nextX = props.snapOn ? snapCurveTime(rawX, props.tempo, props.snapDiv, anchorTime, true) : round(rawX, 6);
          const nextY = round(rawY, 6);
          const segmentId = active.segmentId;
          const handleKey = active.key;
          const handleView = active.frozen;
          setDraft((current) => {
            const segment = current.segments.find((item) => item.id === segmentId);
            if (!segment) return current;
            const handles = curveParamHandles(segment.curve, { start: segment.start, end: segment.end, view: handleView });
            const handle = handles.find((item) => item.key === handleKey);
            if (!handle) return current;
            const nextCurve = handle.drag(handle.xEditable ? nextX : null, handle.yEditable ? nextY : null);
            if (!nextCurve) return current;
            return updateSegmentCurve(current, segmentId, nextCurve);
          });
        }
      };

      const onPointerUp = (event) => {
        const active = dragRef.current;
        if (!active) return;
        if (active.kind === 'pan' && !active.moved && active.segmentIndex >= 0) {
          const segment = draftRef.current.segments[active.segmentIndex];
          if (segment) setSelectedId(segment.id);
        }
        changeDrag(null);
        try {
          if (canvasRef.current) canvasRef.current.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
      };

      const onPointerCancel = (event) => {
        changeDrag(null);
        try {
          if (canvasRef.current) canvasRef.current.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
      };

      const onPointerLeave = () => {
        if (!dragRef.current) setHover(null);
      };

      const onWheel = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const point = localPoint(event);
        if (!point) return;
        const v = currentView();
        const layout = curveLayout(point.width, point.height, v);
        if (event.shiftKey || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0)) {
          const delta = ((event.shiftKey ? event.deltaY : event.deltaX) / layout.plotW) * (v.x1 - v.x0);
          if (typeof props.onTimelineScroll === 'function') {
            props.onTimelineScroll(delta);
            return;
          }
          setView({ x0: v.x0 + delta, x1: v.x1 + delta });
          return;
        }
        const factor = Math.exp((event.deltaY || 0) * 0.0015);
        if (typeof props.onTimelineZoom === 'function') {
          const anchorX = clamp(point.x, layout.left, layout.left + layout.plotW);
          const absoluteTime = anchorTime + layout.fromX(anchorX);
          props.onTimelineZoom(1 / factor, absoluteTime, anchorX);
          return;
        }
        const span = clamp((v.x1 - v.x0) * factor, 1e-4, 1e6);
        const ratio = clamp((point.x - layout.left) / layout.plotW, 0, 1);
        const anchorX = layout.fromX(clamp(point.x, layout.left, layout.left + layout.plotW));
        setView({ x0: anchorX - ratio * span, x1: anchorX + (1 - ratio) * span });
      };

      const onContextMenu = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        const point = localPoint(event);
        if (!point) return;
        const v = currentView();
        const layout = curveLayout(point.width, point.height, v);
        const rawX = layout.fromX(point.x);
        const snappedX = round(snapCurveTime(rawX, props.tempo, props.snapDiv, anchorTime, props.snapOn), 6);
        const segmentIndex = segmentIndexAt(snappedX);
        const segment = segmentIndex >= 0 ? draftRef.current.segments[segmentIndex] : null;
        if (segment) setSelectedId(segment.id);
        const first = draftRef.current.segments[0];
        const last = draftRef.current.segments[draftRef.current.segments.length - 1];
        const canInsert = !segment && ((first && Number.isFinite(first.start) && snappedX < first.start) || (last && Number.isFinite(last.end) && snappedX > last.end));
        setMenu({
          x: event && Number.isFinite(event.clientX) ? event.clientX : 24,
          y: event && Number.isFinite(event.clientY) ? event.clientY : 24,
          xData: snappedX,
          segmentId: segment ? segment.id : null,
          canInsert,
          view: 'root',
          action: null,
        });
      };

      const closeMenu = useCallback(() => setMenu(null), []);
      const menuSetView = (nextView) => {
        setMenu((current) => (current ? Object.assign({}, current, { view: nextView, action: nextView === 'change' ? 'change' : 'new' }) : current));
      };
      const menuCreate = (type) => {
        const current = menu;
        if (!current) return;
        const ref = draftRef.current;
        let result;
        if (current.segmentId) {
          const index = ref.segments.findIndex((segment) => segment.id === current.segmentId);
          result = splitCurveSegment(ref, index, current.xData, type, { view: currentView() });
        } else {
          result = addCurveSegmentOutside(ref, current.xData, type, { view: currentView() });
        }
        if (result.draft !== ref) {
          setDraft(result.draft);
          if (result.segmentId) setSelectedId(result.segmentId);
        }
        setMenu(null);
      };
      const menuChangeType = (type) => {
        const current = menu;
        if (!current || !current.segmentId) return;
        const index = draftRef.current.segments.findIndex((segment) => segment.id === current.segmentId);
        if (index >= 0) setDraft((draftNow) => changeCurveSegmentType(draftNow, index, type, { view: currentView() }));
        setMenu(null);
      };
      const menuDelete = () => {
        const current = menu;
        if (!current || !current.segmentId) return;
        const ref = draftRef.current;
        const index = ref.segments.findIndex((segment) => segment.id === current.segmentId);
        if (index >= 0) {
          const result = deleteCurveSegment(ref, index);
          if (result.draft !== ref) {
            setDraft(result.draft);
            setSelectedId(result.segmentId || (result.draft.segments[0] ? result.draft.segments[0].id : null));
          }
        }
        setMenu(null);
      };

      const typeOptions = curveTypeChoices(currentType);
      const onTypeSelect = (event) => {
        const type = event && event.target ? event.target.value : '';
        if (!type) return;
        setDraft((current) => {
          const index = current.segments.findIndex((segment) => segment.id === selectedIdRef.current);
          return index >= 0 ? changeCurveSegmentType(current, index, type, { view: currentView() }) : current;
        });
      };
      const onBoundaryCommit = (index, value) => {
        if (!Number.isFinite(value)) return;
        setDraft((current) => setSegmentBoundary(current, index, round(value, 6), { snap: false }));
      };
      const onMakeBoundaryFinite = (index) => {
        const edge = index === 0 ? viewRef.current.x0 : viewRef.current.x1;
        setDraft((current) => setSegmentBoundary(current, index, round(edge, 6), { snap: false }));
      };
      const onFlagChange = (id, flags) => setDraft((current) => setSegmentFlags(current, id, flags));

      const addSegment = () => {
        const ref = draftRef.current;
        const segment = ref.segments.find((item) => item.id === selectedIdRef.current) || ref.segments[0];
        if (!segment) return;
        const index = ref.segments.indexOf(segment);
        const playhead = props.playheadRef && Number.isFinite(props.playheadRef.current) ? props.playheadRef.current : null;
        const relative = playhead === null ? null : playhead - anchorTime;
        const span = curveHandleSpan(segment.start, segment.end, currentView());
        let cut = relative;
        if (cut === null || !(cut > segment.start && cut < segment.end)) cut = (span.lo + span.hi) / 2;
        cut = snapCurveTime(cut, props.tempo, props.snapDiv, anchorTime, props.snapOn);
        const type = curveTypeOf(segment.curve) || 'ConstantFunctionCurve';
        const result = splitCurveSegment(ref, index, cut, type, { view: currentView() });
        if (result.draft !== ref) {
          setDraft(result.draft);
          if (result.segmentId) setSelectedId(result.segmentId);
        }
      };

      const deleteSelected = () => {
        const ref = draftRef.current;
        const index = ref.segments.findIndex((segment) => segment.id === selectedIdRef.current);
        if (index < 0) return;
        const result = deleteCurveSegment(ref, index);
        if (result.draft !== ref) {
          setDraft(result.draft);
          setSelectedId(result.segmentId || (result.draft.segments[0] ? result.draft.segments[0].id : null));
        }
      };

      const reset = () => {
        const fresh = readCurveDraft(target.value, { fallbackRange });
        setDraft(fresh);
        setSelectedId(firstCurveSegmentId(fresh));
        setHover(null);
        changeDrag(null);
        setMenu(null);
      };

      const fit = () => {
        if (typeof props.onTimelineFit === 'function') {
          props.onTimelineFit();
          return;
        }
        setView(curveInitialView(draftRef.current, props.tempo, fallbackRange));
        setHover(null);
        setMenu(null);
      };

      const apply = () => {
        if (typeof props.onApply === 'function') props.onApply(buildCurveValue(draftRef.current));
      };
      const paintView = (() => {
        const active = dragRef.current;
        if (active && active.frozen) return active.frozen;
        return { x0: view.x0, x1: view.x1, y0: yRange[0], y1: yRange[1] };
      })();

      useEffect(() => {
        paintCurveCanvas({
          canvasRef,
          draft,
          view: paintView,
          selectedId: selected ? selected.id : null,
          hover,
          dragRef,
          warnings,
          tempo: props.tempo,
          anchorTime,
          snapDiv: props.snapDiv || 4,
          t,
        });
      }, [draft, view, yRange, selected, selectedId, hover, drag, menu, props.tempo, props.snapDiv, anchorTime, t, warnings, resizeTick]);

      let cursor = 'default';
      if (drag) cursor = drag.kind === 'pan' ? 'grabbing' : drag.kind === 'boundary' ? 'ew-resize' : 'grabbing';
      else if (hover) cursor = hover.kind === 'boundary' ? 'ew-resize' : hover.kind === 'param' ? 'pointer' : hover.kind === 'plot' || hover.kind === 'band' ? 'grab' : 'default';

      const subtitle = [
        target.elementType ? shortType(target.elementType) : '',
        t('curveElementOrigin') + ' ' + formatTime(anchorTime),
        t('tempo') + ' ' + formatNum(bpm, 2),
        props.snapOn ? t('snap') + ' 1/' + (props.snapDiv || 4) : t('snapOff'),
      ]
        .filter(Boolean)
        .join(' · ');

      const rangeLabel = (segment) => {
        const side = (value) => (Number.isFinite(value) ? formatNum(value, 2) + 's' : value > 0 ? '+∞' : '−∞');
        return side(segment.start) + ' – ' + side(segment.end);
      };

      const lengthLabel =
        selected && Number.isFinite(selected.start) && Number.isFinite(selected.end)
          ? formatNum(selected.end - selected.start, 3) + 's'
          : '∞';

      const startBoundary = selected ? selectedIndex : -1;
      const endBoundary = selected ? selectedIndex + 1 : -1;
      const boundaryField = (index) => {
        if (index < 0) return null;
        const value = boundaries[index];
        return h(CurveBoundaryField, {
          t,
          value,
          onChange: (next) => onBoundaryCommit(index, next),
          onMakeFinite: Number.isFinite(value) ? null : () => onMakeBoundaryFinite(index),
        });
      };

      const header = h(
        'div',
        { className: 'dgc-curveHead' },
        h(Icon, { name: 'curve' }),
        h(
          'div',
          { className: 'dgc-curveTitle' },
          h('strong', null, (target.name ? target.name + ' · ' : '') + t('curveEditor')),
          h('span', null, subtitle),
        ),
        h('span', { className: 'dgc-badge' }, t('curveSegmentCount').replace('{count}', String(draft.segments.length))),
        dirty ? h('span', { className: 'dgc-badge is-dirty' }, t('curveEdited')) : null,
        draft.converted ? h('span', { className: 'dgc-badge is-dirty' }, t('curveConverted')) : null,
        h('span', { className: 'dgc-spacer' }),
        h(Button, { icon: 'plus', title: t('curveAddAtPlayhead'), onClick: addSegment }, t('curveNewSegment')),
        h(Button, { variant: 'ghost', icon: 'fit', title: t('curveFit'), onClick: fit }),
        h(Button, { variant: 'ghost', icon: 'reload', title: t('reset'), onClick: reset }),
        h(Button, { onClick: props.onClose }, t('cancel')),
        h(Button, { variant: 'primary', onClick: apply }, t('apply')),
        h(Button, { variant: 'ghost', onClick: props.onClose, title: t('close') }, '×'),
      );

      const side = h(
        'div',
        { className: 'dgc-curveSide' },
        h(
          'div',
          { className: 'dgc-curveSideBody' },
          h(
            'div',
            { className: 'dgc-sectionTitle' },
            h('span', null, t('curveSegments')),
            h('span', { className: 'dgc-badge' }, String(draft.segments.length)),
            h('span', { className: 'dgc-spacer' }),
            h(Button, { variant: 'ghost', icon: 'plus', title: t('curveAddAtPlayhead'), onClick: addSegment }),
          ),
          h(
            'div',
            { className: 'dgc-curveSegList' },
            draft.segments.map((segment, index) =>
              h(
                'div',
                {
                  key: segment.id,
                  className: 'dgc-curveSeg' + (segment.id === (selected ? selected.id : '') ? ' is-active' : ''),
                  onClick: () => setSelectedId(segment.id),
                  title: rangeLabel(segment),
                },
                h('span', { className: 'dgc-curveSegColor', style: { background: CURVE_SEGMENT_COLORS[index % CURVE_SEGMENT_COLORS.length] } }),
                h('span', { className: 'dgc-curveSegLabel' }, index + 1 + ' · ' + curveTypeLabel(t, curveTypeOf(segment.curve))),
                h('span', { className: 'dgc-curveSegMeta' }, rangeLabel(segment)),
              ),
            ),
          ),
          warnings.length
            ? h(
                'div',
                { className: 'dgc-curveWarn' },
                h(
                  'div',
                  { className: 'dgc-curveWarnHead' },
                  h('strong', null, t('curveValueJump') + ' × ' + warnings.length),
                  h(
                    Button,
                    {
                      variant: 'ghost',
                      className: 'dgc-curveAutoFix',
                      title: t('curveAutoFixHint'),
                      onClick: autoFixWarnings,
                    },
                    t('curveAutoFix'),
                  ),
                ),
                warnings.map((warning) =>
                  h(
                    'div',
                    { key: warning.index, className: 'dgc-curveWarnRow' },
                    t('curveValueJumpAt')
                      .replace('{time}', formatNum(warning.time, 3))
                      .replace('{left}', formatNum(warning.left, 3))
                      .replace('{right}', formatNum(warning.right, 3)),
                  ),
                ),
              )
            : null,
          selected
            ? h(
                'div',
                null,
                h('div', { className: 'dgc-sectionTitle' }, t('curveSegment') + ' ' + (selectedIndex + 1)),
                h(
                  FieldRow,
                  { label: t('curveFunctionType') },
                  h(
                    'select',
                    { className: 'dgc-select', value: currentType, onChange: onTypeSelect, style: { width: '100%' } },
                    typeOptions.map((type) => h('option', { key: type, value: type }, curveTypeLabel(t, type))),
                  ),
                ),
                h(FieldRow, { label: t('curveStart') }, boundaryField(startBoundary)),
                h(FieldRow, { label: t('curveEnd') }, boundaryField(endBoundary)),
                h(FieldRow, { label: t('curveLength') }, h('span', { className: 'dgc-mono' }, lengthLabel)),
                piecewise
                  ? h(
                      FieldRow,
                      { label: t('curveLeftClosed') },
                      h(Checkbox, { checked: selected.leftClosed === true, onChange: (next) => onFlagChange(selected.id, { leftClosed: next }) }),
                    )
                  : null,
                piecewise
                  ? h(
                      FieldRow,
                      { label: t('curveRightClosed') },
                      h(Checkbox, { checked: selected.rightClosed === true, onChange: (next) => onFlagChange(selected.id, { rightClosed: next }) }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dgc-rowActions', style: { margin: '8px 0' } },
                  h(Button, { variant: 'danger', icon: 'trash', disabled: draft.segments.length <= 1, title: t('curveDeleteSegment'), onClick: deleteSelected }, t('curveDeleteSegment')),
                ),
                h('div', { className: 'dgc-curveNote' }, piecewise ? t('curveConverted') : t('curveWillConvert')),
                h('div', { className: 'dgc-sectionTitle' }, t('curveParams')),
                h(ValueEditor, {
                  key: selected.id + ':' + currentType,
                  value: selected.curve,
                  schema: curveValueSchema(props.catalog, selected.curve),
                  t,
                  depth: 0,
                  onChange: (next) => setDraft((current) => updateSegmentCurve(current, selected.id, next)),
                }),
                currentType === 'CompositeFunctionCurve' ? h('div', { className: 'dgc-curveNote' }, t('curveCompositeHint')) : null,
              )
            : h('div', { className: 'dgc-hint' }, t('curveNoSegments')),
        ),
      );

      const footer = h(
        'div',
        { className: 'dgc-curveFoot' },
        h('span', { className: 'dgc-curveHint' }, t('curvePanelHint')),
        h('span', { className: 'dgc-spacer' }),
        warnings.length
          ? h(
              'span',
              { className: 'dgc-err', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              t('curveValueJump') + ' × ' + warnings.length,
              h(
                Button,
                {
                  variant: 'ghost',
                  className: 'dgc-curveAutoFix',
                  title: t('curveAutoFixHint'),
                  onClick: autoFixWarnings,
                },
                t('curveAutoFix'),
              ),
            )
          : h('span', { className: 'dgc-listRowSlim' }, t('curveNoJump')),
        h('span', { className: 'dgc-listRowSlim' }, t('curveTimeAxis')),
        h('span', { className: 'dgc-listRowSlim' }, t('curveBeatGrid')),
      );

      const body = h(
        'div',
        { className: 'dgc-curveBody' },
        h(
          'div',
          { className: 'dgc-curvePlot' },
          h('canvas', {
            ref: canvasRef,
            className: 'dgc-curveCanvas',
            style: { cursor },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onPointerLeave,
            onContextMenu,
            onWheel,
          }),
        ),
        side,
      );

      return h(
        'div',
        { className: 'dgc-curveLayer', role: 'region', 'aria-label': t('curveEditor') },
        header,
        body,
        footer,
        menu
          ? h(CurveContextMenu, {
              t,
              menu,
              segments: draft.segments,
              onClose: closeMenu,
              onSetView: menuSetView,
              onCreate: menuCreate,
              onChangeType: menuChangeType,
              onDelete: menuDelete,
            })
          : null,
      );
    }

    /** Memoized docked curve panel (avoids 60fps re-renders while playing). */
    const CurveEditorLayerMemo = React.memo(CurveEditorLayer);

    // ========================================================================
    // 11 · Left pane: staff list and element list.
    // ========================================================================

    /** Close a dialog on Escape (capture, so the editor shortcuts stay quiet). */
    function useDialogEscape(onClose) {
      useEffect(() => {
        const handler = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        };
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
      }, [onClose]);
    }

    /** Dialog that appends one empty chart or storyboard staff to the project. */
    function AddStaffDialog(props) {
      const { t, project, onCancel, onCreate } = props;
      const [kind, setKind] = useState('chart');
      const [name, setName] = useState(t('defaultStaffName'));
      const [edited, setEdited] = useState(false);
      const [error, setError] = useState('');
      useDialogEscape(onCancel);
      const identity = useMemo(() => uniqueStaffIdentity(project, kind), [project, kind]);
      const pickKind = (nextKind) => {
        if (nextKind === kind) return;
        setKind(nextKind);
        setError('');
        if (!edited) setName(nextKind === 'storyboard' ? t('defaultStoryboardName') : t('defaultStaffName'));
      };
      const submit = () => {
        const displayName = String(name || '').trim();
        if (displayName.length === 0) {
          setError(t('staffNameLabel'));
          return;
        }
        onCreate({ kind, displayName });
      };
      const kindCard = (value, label, description) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dgc-kindCard' + (kind === value ? ' is-active' : ''),
            onClick: () => pickKind(value),
            'aria-pressed': kind === value,
          },
          h('strong', null, label),
          h('span', null, description),
        );
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(460px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('newStaff')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            h(
              'div',
              { className: 'dgc-kindGrid' },
              kindCard('chart', t('staffKindChartOption'), t('staffKindChartDesc')),
              kindCard('storyboard', t('staffKindStoryboardOption'), t('staffKindStoryboardDesc')),
            ),
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('staffNameLabel'),
              h('input', {
                className: 'dgc-input',
                value: name,
                autoFocus: true,
                spellCheck: false,
                'aria-invalid': error ? 'true' : undefined,
                onChange: (event) => {
                  setEdited(true);
                  setName(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit();
                },
              }),
            ),
            h(
              'div',
              { className: 'dgc-listRowSlim dgc-mono' },
              t('staffFileLabel') + ' · ' + identity.fileName + '    ' + t('staffClassLabel') + ' · ' + identity.className,
            ),
            error ? h('div', { className: 'dgc-listRowSlim dgc-err' }, error) : null,
            h('div', { className: 'dgc-hint', style: { padding: '0' } }, t('newStaffHint')),
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onCancel }, t('cancel')),
            h(Button, { variant: 'primary', icon: 'plus', onClick: submit }, t('create')),
          ),
        ),
      );
    }

    /** Dialog that inserts one catalog element at a captured playhead time. */
    function ElementPaletteDialog(props) {
      const { t, project, catalog, initialStaffId, time, onCancel, onPick, onRequestStaff } = props;
      const editable = useMemo(
        () => (project.staffs || []).filter((staff) => staff.kind === 'chart' || staff.kind === 'storyboard'),
        [project],
      );
      const [staffId, setStaffId] = useState(() => {
        const preferred = editable.find((staff) => staff.id === initialStaffId);
        return preferred ? preferred.id : editable.length > 0 ? editable[0].id : '';
      });
      const [query, setQuery] = useState('');
      useDialogEscape(onCancel);

      const staff = editable.find((item) => item.id === staffId) || editable[0] || null;
      const effectiveStaffId = staff ? staff.id : '';
      const isStoryboard = !!staff && staff.kind === 'storyboard';
      const entries = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return (catalog.elements || []).filter((entry) => {
          if (!entry || entry.category === 'inner') return false;
          const allowed = isStoryboard ? entry.group === 'DeentyStoryboard' : entry.category === 'note' || entry.category === 'hold' || entry.category === 'lane';
          if (!allowed) return false;
          if (!needle) return true;
          return [entry.type, entry.shortName, entry.label, shortType(entry.type)]
            .join(' ')
            .toLowerCase()
            .indexOf(needle) !== -1;
        });
      }, [catalog, isStoryboard, query]);

      const categoryLabel = (entry) => {
        if (entry.category === 'lane') return t('filterLanes');
        if (entry.category === 'note' || entry.category === 'hold') return t('filterNotes');
        return t('filterOther');
      };
      let lastGroup = null;
      const rows = [];
      for (const entry of entries) {
        const group = categoryLabel(entry);
        if (group !== lastGroup) {
          lastGroup = group;
          rows.push(h('div', { key: 'group:' + group, className: 'dgc-groupHead' }, group));
        }
        rows.push(
          h(
            'button',
            {
              key: entry.type,
              type: 'button',
              className: 'dgc-paletteRow',
              title: entry.type + ' · ' + elementCategory(catalog, entry.type),
              onClick: () => onPick(entry.type, effectiveStaffId),
            },
            h('span', { className: 'dgc-swatch', style: { background: elementColor(catalog, entry.type) } }),
            h('strong', null, entry.label || entry.shortName || shortType(entry.type)),
            h('span', { className: 'dgc-rowMeta' }, entry.type),
          ),
        );
      }

      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(500px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('newElement')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          editable.length === 0
            ? h(
                'div',
                { className: 'dgc-dialogEmpty' },
                h('div', null, t('paletteNeedStaff')),
                h('div', { style: { marginTop: 10 } }, h(Button, { variant: 'primary', icon: 'plus', onClick: onRequestStaff }, t('addStaff'))),
              )
            : h(
                'div',
                { className: 'dgc-dialogBody', style: { gap: 8, paddingBottom: 0 } },
                h(
                  'div',
                  { className: 'dgc-paletteMeta', style: { padding: 0 } },
                  h('span', null, t('elementTarget')),
                  editable.length === 1
                    ? h('span', { className: 'dgc-listRowSlim', style: { padding: 0 } }, staff ? staff.displayName || staff.className || staff.id : '')
                    : h(
                        'select',
                        { className: 'dgc-select', value: effectiveStaffId, onChange: (event) => setStaffId(event.target.value) },
                        editable.map((item) =>
                          h('option', { key: item.id, value: item.id }, (item.displayName || item.className || item.id) + ' · ' + item.id),
                        ),
                      ),
                  h('span', { className: 'dgc-spacer' }),
                  h('span', { className: 'dgc-listRowSlim dgc-mono', style: { padding: 0 } }, formatTime(time)),
                ),
                h('input', {
                  className: 'dgc-input',
                  placeholder: t('search'),
                  value: query,
                  autoFocus: true,
                  spellCheck: false,
                  onChange: (event) => setQuery(event.target.value),
                }),
              ),
          editable.length === 0
            ? null
            : h(
                'div',
                { className: 'dgc-paletteList' },
                entries.length === 0 ? h('div', { className: 'dgc-dialogEmpty' }, t('paletteNoMatch')) : rows,
              ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-listRowSlim', style: { flex: '1 1 auto', padding: 0 } }, t('paletteHint')),
            h(Button, { onClick: onCancel }, t('cancel')),
          ),
        ),
      );
    }

    /**
     * Floating right-click menu for one staff row: rename its alias or delete
     * the staff (which removes the `.g` file on disk after confirmation).
     */
    function StaffContextMenu(props) {
      const { t, staff, x, y, onRename, onDelete, onClose } = props;
      const menuRef = useRef(null);
      useEffect(() => {
        const close = () => onClose();
        const onPointerDown = (event) => {
          const node = menuRef.current;
          if (node && event && event.target && typeof node.contains === 'function' && node.contains(event.target)) return;
          onClose();
        };
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', close);
        window.addEventListener('wheel', close, true);
        window.addEventListener('blur', close);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('wheel', close, true);
          window.removeEventListener('blur', close);
        };
      }, [onClose]);
      const label = staff.displayName || staff.className || staff.id;
      return h(
        'div',
        {
          ref: menuRef,
          className: 'dgc-menu',
          role: 'menu',
          'aria-label': t('staffs'),
          style: { left: x, top: y },
          onContextMenu: (event) => event.preventDefault(),
        },
        h('div', { className: 'dgc-menuHead', title: staff.file || staff.id }, label),
        h(
          'button',
          { type: 'button', className: 'dgc-menuItem', role: 'menuitem', onClick: () => onRename(staff) },
          h(Icon, { name: 'pencil', size: 13 }),
          h('span', null, t('renameStaff')),
        ),
        h(
          'button',
          { type: 'button', className: 'dgc-menuItem is-danger', role: 'menuitem', onClick: () => onDelete(staff) },
          h(Icon, { name: 'trash', size: 13 }),
          h('span', null, t('deleteStaff')),
        ),
      );
    }

    /** Dialog that edits one staff's display alias (the `.g` displayName header). */
    function RenameStaffDialog(props) {
      const { t, staff, onCancel, onSubmit } = props;
      const current = staff.displayName || staff.className || staff.id;
      const [name, setName] = useState(current);
      const [error, setError] = useState('');
      useDialogEscape(onCancel);
      const submit = () => {
        const value = String(name || '').trim();
        if (value.length === 0) {
          setError(t('staffAliasEmpty'));
          return;
        }
        if (value === current) {
          onCancel();
          return;
        }
        onSubmit(value);
      };
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(420px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('renameStaff')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('staffAliasLabel'),
              h('input', {
                className: 'dgc-input',
                value: name,
                autoFocus: true,
                spellCheck: false,
                'aria-invalid': error ? 'true' : undefined,
                onChange: (event) => {
                  setName(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit();
                },
              }),
            ),
            h(
              'div',
              { className: 'dgc-listRowSlim dgc-mono' },
              t('staffFileLabel') + ' · ' + staff.id + '    ' + t('staffClassLabel') + ' · ' + (staff.className || ''),
            ),
            error ? h('div', { className: 'dgc-listRowSlim dgc-err' }, error) : null,
            h('div', { className: 'dgc-hint', style: { padding: '0' } }, t('staffAliasHint')),
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onCancel }, t('cancel')),
            h(Button, { variant: 'primary', onClick: submit }, t('apply')),
          ),
        ),
      );
    }

    /** Confirmation dialog for permanently deleting one staff and its `.g` file. */
    function DeleteStaffDialog(props) {
      const { t, staff, onCancel, onConfirm } = props;
      useDialogEscape(onCancel);
      const name = staff.displayName || staff.className || staff.id;
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(430px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('deleteStaffTitle')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            h('div', { className: 'dgc-warnCard' }, t('deleteStaffWarning').replace('{name}', name)),
            staff.kind === 'audio' ? h('div', { className: 'dgc-listRowSlim dgc-err' }, t('deleteStaffAudioWarning')) : null,
            h('div', { className: 'dgc-listRowSlim dgc-mono' }, t('staffFileLabel') + ' · ' + (staff.file || staff.id)),
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onCancel }, t('cancel')),
            h(Button, { variant: 'danger', icon: 'trash', onClick: onConfirm }, t('delete')),
          ),
        ),
      );
    }

    /** Upload one browser `File` into the open project; returns host metadata. */
    async function importAudioRequest(file) {
      const response = await fetch(IMPORT_AUDIO_URL + '?name=' + encodeURIComponent(file.name || 'audio.wav'), {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok) {
        const message = body && (body.error || body.message) ? body.error || body.message : 'HTTP ' + response.status;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      if (!body || typeof body.file !== 'string' || body.file.length === 0) throw new Error('import response has no file name');
      return body;
    }

    /** Strip the extension from a file name (asset-name default). */
    function audioStem(fileName) {
      const base = String(fileName || '').split(/[\\/]/).pop() || '';
      const dot = base.lastIndexOf('.');
      return dot > 0 ? base.slice(0, dot) : base;
    }

    /**
     * Dialog that appends one `@Song` audio period ("音频乐段") to an audio
     * staff: pick a project audio file or import one from this computer, then
     * set the chart time at which the clip starts.
     */
    function AddAudioPeriodDialog(props) {
      const { t, project, staffId, time, hostReady, onCancel, onCreate } = props;
      const audioStaffs = useMemo(
        () => ((project && project.staffs) || []).filter((staff) => staff && staff.kind === 'audio'),
        [project],
      );
      const assets = (project && project.assets && Array.isArray(project.assets.audio) ? project.assets.audio : []).slice();
      const [targetStaff, setTargetStaff] = useState(() => {
        const preferred = audioStaffs.find((staff) => staff.id === staffId);
        return preferred ? preferred.id : audioStaffs.length > 0 ? audioStaffs[0].id : '';
      });
      const [mode, setMode] = useState(assets.length > 0 ? 'project' : 'import');
      const [asset, setAsset] = useState(assets.length > 0 ? assets[0] : '');
      const [file, setFile] = useState(null);
      const [name, setName] = useState(assets.length > 0 ? audioStem(assets[0]) : '');
      const [nameEdited, setNameEdited] = useState(false);
      const [offset, setOffset] = useState(() => {
        const seconds = Number.isFinite(time) && time >= 0 ? time : 0;
        return String(Math.round(seconds * 1000) / 1000);
      });
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      useDialogEscape(onCancel);

      const pickFile = (nextFile, source) => {
        setFile(nextFile);
        if (!nameEdited) setName(source ? audioStem(source) : '');
        setError('');
      };
      const pickMode = (next) => {
        setMode(next);
        setError('');
      };
      const submit = async () => {
        if (hostReady === false) {
          setError(t('audioHostStale'));
          return;
        }
        const seconds = Number(String(offset).trim());
        if (!Number.isFinite(seconds) || seconds < 0) {
          setError(t('audioTimeLabel'));
          return;
        }
        const trimmed = String(name || '').trim();
        if (trimmed.length === 0) {
          setError(t('audioNeedName'));
          return;
        }
        if (mode === 'import') {
          if (!file) {
            setError(t('audioNeedFile'));
            return;
          }
          setBusy(true);
          setError('');
          try {
            const uploaded = await importAudioRequest(file);
            onCreate({
              staffId: targetStaff,
              file: uploaded.file,
              name: trimmed,
              timeOffset: Math.round(seconds * 1e6) / 1e6,
              duration: uploaded.duration,
            });
          } catch (failure) {
            const stale = failure && (failure.status === 404 || failure.status === 405);
            setError(stale ? t('audioHostStale') : t('audioImportFailed') + ': ' + String((failure && failure.message) || failure));
            setBusy(false);
          }
          return;
        }
        if (!asset) {
          setError(t('audioNeedFile'));
          return;
        }
        onCreate({
          staffId: targetStaff,
          file: asset,
          name: trimmed,
          timeOffset: Math.round(seconds * 1e6) / 1e6,
        });
      };
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(500px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('newAudioPeriod')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            audioStaffs.length > 1
              ? h(
                  'label',
                  { className: 'dgc-dialogField' },
                  t('audioTargetStaff'),
                  h(
                    'select',
                    {
                      className: 'dgc-input',
                      value: targetStaff,
                      onChange: (event) => setTargetStaff(event.target.value),
                    },
                    audioStaffs.map((staff) => h('option', { key: staff.id, value: staff.id }, (staff.displayName || staff.className || staff.id) + ' · ' + staff.id)),
                  ),
                )
              : null,
            hostReady === false ? h('div', { className: 'dgc-warnCard' }, t('audioHostStale')) : null,
            audioStaffs.length === 0 ? h('div', { className: 'dgc-warnCard' }, t('audioPeriodAutoStaff')) : null,
            h(
              'div',
              { className: 'dgc-kindGrid' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dgc-kindCard' + (mode === 'project' ? ' is-active' : ''),
                  onClick: () => pickMode('project'),
                  disabled: assets.length === 0,
                  'aria-pressed': mode === 'project',
                },
                h('strong', null, t('audioFileFromProject')),
                h('span', null, assets.length > 0 ? String(assets.length) : '—'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dgc-kindCard' + (mode === 'import' ? ' is-active' : ''),
                  onClick: () => pickMode('import'),
                  'aria-pressed': mode === 'import',
                },
                h('strong', null, t('audioFileImport')),
                h('span', null, t('audioFileImportHint')),
              ),
            ),
            mode === 'project'
              ? h(
                  'label',
                  { className: 'dgc-dialogField' },
                  t('audioFileLabel'),
                  h(
                    'select',
                    {
                      className: 'dgc-input',
                      value: asset,
                      onChange: (event) => {
                        const next = event.target.value;
                        setAsset(next);
                        if (!nameEdited) setName(audioStem(next));
                        setError('');
                      },
                    },
                    assets.map((item) => h('option', { key: item, value: item }, item)),
                  ),
                )
              : h(
                  'label',
                  { className: 'dgc-dialogField' },
                  t('audioFileLabel'),
                  h('input', {
                    className: 'dgc-input',
                    type: 'file',
                    accept: '.wav,.mp3,.ogg,.m4a,.aac,.flac,.opus,audio/*',
                    disabled: busy,
                    onChange: (event) => {
                      const picked = event.target.files && event.target.files[0] ? event.target.files[0] : null;
                      pickFile(picked, picked ? picked.name : '');
                    },
                  }),
                  file ? h('div', { className: 'dgc-listRowSlim' }, file.name) : null,
                ),
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('audioNameLabel'),
              h('input', {
                className: 'dgc-input',
                value: name,
                spellCheck: false,
                disabled: busy,
                onChange: (event) => {
                  setNameEdited(true);
                  setName(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !busy) submit();
                },
              }),
            ),
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('audioTimeLabel'),
              h('input', {
                className: 'dgc-input',
                type: 'number',
                min: 0,
                step: 0.001,
                value: offset,
                disabled: busy,
                onChange: (event) => {
                  setOffset(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !busy) submit();
                },
              }),
            ),
            error ? h('div', { className: 'dgc-listRowSlim dgc-err' }, error) : null,
            h('div', { className: 'dgc-hint', style: { padding: '0' } }, t('audioPeriodHint')),
            busy ? h('div', { className: 'dgc-hint', style: { padding: '0' } }, t('audioImporting')) : null,
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onCancel, disabled: busy }, t('cancel')),
            h(Button, { variant: 'primary', icon: 'plus', onClick: submit, disabled: busy || hostReady === false, title: hostReady === false ? t('audioHostStaleShort') : undefined }, t('create')),
          ),
        ),
      );
    }

    /** Confirmation dialog for removing one audio period (keeps the file). */
    function DeleteAudioPeriodDialog(props) {
      const { t, staff, clip, onCancel, onConfirm } = props;
      useDialogEscape(onCancel);
      const staffName = (staff && (staff.displayName || staff.className || staff.id)) || '';
      const text = t('deleteAudioPeriodWarning').replace('{name}', clip.name || clip.method || '').replace('{staff}', staffName);
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(430px,94vw)' }, role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h('h3', null, t('deleteAudioPeriodTitle')),
            h(Button, { variant: 'ghost', onClick: onCancel, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            h('div', { className: 'dgc-warnCard' }, text),
            h('div', { className: 'dgc-listRowSlim dgc-mono' }, (clip.relativePath || clip.file || '') + ' · ' + formatTime(clip.offset || 0)),
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onCancel }, t('cancel')),
            h(Button, { variant: 'danger', icon: 'trash', onClick: onConfirm }, t('delete')),
          ),
        ),
      );
    }

    /** One staff row with a kind badge and element count. */
    function StaffRow(props) {
      const { staff, active, hidden, onSelect, onToggleHidden, onMenu, onAddAudio, t } = props;
      const kindLabel =
        staff.kind === 'audio'
          ? t('staffAudio')
          : staff.kind === 'storyboard'
            ? t('staffStoryboard')
            : staff.kind === 'chart'
              ? t('staffChart')
              : t('staffOther');
      const count =
        staff.kind === 'audio'
          ? (staff.audioPeriods || []).length
          : (staff.periods || []).reduce((total, period) => total + (period.elements || []).length, 0);
      return h(
        'div',
        {
          className: 'dgc-row' + (active ? ' is-active' : ''),
          onClick: () => onSelect(staff.id),
          onContextMenu: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            onSelect(staff.id);
            const px = event && Number.isFinite(event.clientX) ? event.clientX : 0;
            const py = event && Number.isFinite(event.clientY) ? event.clientY : 0;
            onMenu(staff.id, px, py);
          },
          title: (staff.file || staff.id) + ' · ' + t('staffMenuHint'),
        },
        h('button', {
          className: 'dgc-rowBtn',
          title: hidden ? t('show') : t('hide'),
          onClick: (event) => {
            event.stopPropagation();
            onToggleHidden(staff.id);
          },
          style: { opacity: hidden ? 0.35 : 0.75 },
        }, h(Icon, { name: hidden ? 'mute' : 'volume', size: 13 })),
        h('span', { className: 'dgc-rowLabel', style: hidden ? { opacity: 0.5 } : undefined }, staff.displayName || staff.className || staff.id),
        staff.kind === 'audio'
          ? h('button', {
              className: 'dgc-rowBtn',
              title: t('addAudioPeriod'),
              'aria-label': t('addAudioPeriod'),
              onClick: (event) => {
                event.stopPropagation();
                if (onAddAudio) onAddAudio(staff.id);
              },
            }, h(Icon, { name: 'plus', size: 12 }))
          : null,
        h('span', { className: 'dgc-rowMeta' }, kindLabel + ' · ' + count),
      );
    }

    /** The whole left pane. */
    function LeftPane(props) {
      const {
        project,
        catalog,
        t,
        selection,
        activeStaff,
        setActiveStaff,
        hiddenStaffs,
        toggleStaff,
        selectElement,
        seek,
        playheadRef,
        addStaffRef,
        addElementRef,
        onRenameStaff,
        onDeleteStaff,
        onAddAudioPeriod,
        onDeleteAudioPeriod,
      } = props;
      const [query, setQuery] = useState('');
      const [filter, setFilter] = useState('all');
      const [dialog, setDialog] = useState(null);
      /** Open right-click menu: `{ staffId, x, y }` in viewport coordinates. */
      const [menu, setMenu] = useState(null);

      const staffs = (project && project.staffs) || [];
      const audioHostReady = !!(project && Array.isArray(project.audioPeriods));
      const hasAudioStaff = staffs.some((staff) => staff && staff.kind === 'audio');
      const activeAudioStaff = staffs.find((staff) => staff && staff.kind === 'audio' && staff.id === activeStaff) || null;
      const audioPeriods = activeAudioStaff && Array.isArray(activeAudioStaff.audioPeriods) ? activeAudioStaff.audioPeriods : [];
      const shownAudioPeriods = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return audioPeriods;
        return audioPeriods.filter((clip) => [clip.name, clip.method, clip.relativePath].join(' ').toLowerCase().indexOf(needle) !== -1);
      }, [audioPeriods, query]);

      const elements = useMemo(() => {
        const rows = [];
        for (const staff of staffs) {
          if (staff.kind === 'audio') continue;
          if (activeStaff && staff.id !== activeStaff) continue;
          for (const period of staff.periods || []) {
            for (const element of period.elements || []) {
              if (element.category === 'inner') continue;
              rows.push({ element, staffId: staff.id, periodId: period.id });
            }
          }
        }
        rows.sort((a, b) => (a.element.start || 0) - (b.element.start || 0) || String(a.element.id).localeCompare(String(b.element.id)));
        return rows;
      }, [staffs, activeStaff]);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return elements.filter((row) => {
          const category = row.element.category;
          if (filter === 'notes' && category !== 'note' && category !== 'hold' && category !== 'inner') return false;
          if (filter === 'lanes' && category !== 'lane') return false;
          if (filter === 'other' && (category === 'note' || category === 'hold' || category === 'lane' || category === 'inner')) return false;
          if (!needle) return true;
          const haystack = [row.element.type, row.element.lane, row.element.id, describeValue(row.element.fields && row.element.fields.name)]
            .join(' ')
            .toLowerCase();
          return haystack.indexOf(needle) !== -1;
        });
      }, [elements, filter, query]);

      /** Display list with a 谱表 group header before each staff's elements. */
      const displayRows = useMemo(() => {
        if (activeStaff) return filtered.map((row) => Object.assign({ kind: 'row' }, row));
        const order = new Map(staffs.map((staff, index) => [staff.id, index]));
        const sorted = filtered
          .slice()
          .sort((a, b) => (order.get(a.staffId) || 0) - (order.get(b.staffId) || 0) || (a.element.start || 0) - (b.element.start || 0));
        const counts = new Map();
        for (const row of sorted) counts.set(row.staffId, (counts.get(row.staffId) || 0) + 1);
        const out = [];
        let lastStaff = null;
        for (const row of sorted) {
          if (row.staffId !== lastStaff) {
            lastStaff = row.staffId;
            const staff = staffs.find((item) => item.id === row.staffId);
            out.push({
              kind: 'header',
              key: 'header::' + row.staffId,
              staffId: row.staffId,
              label: staff ? staff.displayName || staff.className || staff.id : row.staffId,
              sublabel: staff ? staff.className || '' : '',
              count: counts.get(row.staffId) || 0,
            });
          }
          out.push(Object.assign({ kind: 'row' }, row));
        }
        return out;
      }, [activeStaff, filtered, staffs]);

      const editableStaffs = staffs.filter((staff) => staff.kind === 'chart' || staff.kind === 'storyboard');
      const openStaffDialog = () => setDialog({ kind: 'staff' });
      const openElementDialog = () => {
        const preferred = editableStaffs.find((staff) => staff.id === activeStaff) || editableStaffs[0] || null;
        const playhead = playheadRef && typeof playheadRef.current === 'number' && Number.isFinite(playheadRef.current) ? playheadRef.current : 0;
        setDialog({ kind: 'element', staffId: preferred ? preferred.id : '', time: Math.max(0, playhead) });
      };
      const createStaff = (request) => {
        setDialog(null);
        if (addStaffRef && typeof addStaffRef.current === 'function') addStaffRef.current(request);
      };
      const pickElement = (type, staffId) => {
        setDialog(null);
        setFilter('all');
        setQuery('');
        if (addElementRef && typeof addElementRef.current === 'function') addElementRef.current(type, staffId);
      };

      // --- Staff right-click menu (rename alias / delete staff) ---------------
      const menuStaff = menu ? staffs.find((staff) => staff.id === menu.staffId) || null : null;
      const renameTarget =
        dialog && dialog.kind === 'renameStaff' ? staffs.find((staff) => staff.id === dialog.staffId) || null : null;
      const deleteTarget =
        dialog && dialog.kind === 'deleteStaff' ? staffs.find((staff) => staff.id === dialog.staffId) || null : null;
      const deleteAudioTarget =
        dialog && dialog.kind === 'deleteAudioPeriod'
          ? (() => {
              const staff = staffs.find((item) => item.id === dialog.staffId) || null;
              const clip = staff ? (staff.audioPeriods || []).find((item) => item.id === dialog.audioPeriodId) || null : null;
              return staff && clip ? { staff, clip } : null;
            })()
          : null;

      const openStaffMenu = (staffId, x, y) => {
        // The menu is at most 260 × ~104 px (head + two items + padding): clamp
        // so it never opens off-screen at the right/bottom edge.
        const width = 264;
        const height = 110;
        const vw = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1200;
        const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
        setMenu({
          staffId,
          x: clamp(x, 8, Math.max(8, vw - width - 8)),
          y: clamp(y, 8, Math.max(8, vh - height - 8)),
        });
      };
      const closeStaffMenu = () => setMenu(null);
      const requestRename = (staff) => {
        setMenu(null);
        setDialog({ kind: 'renameStaff', staffId: staff.id });
      };
      const requestDelete = (staff) => {
        setMenu(null);
        setDialog({ kind: 'deleteStaff', staffId: staff.id });
      };
      const submitRename = (displayName) => {
        const staff = renameTarget;
        setDialog(null);
        if (staff && typeof onRenameStaff === 'function') onRenameStaff(staff, displayName);
      };
      const submitDelete = () => {
        const staff = deleteTarget;
        setDialog(null);
        if (staff && typeof onDeleteStaff === 'function') onDeleteStaff(staff);
      };

      return h(
        'div',
        { className: 'dgc-side' },
        h(
          'div',
          { className: 'dgc-sideSection is-staffs' },
          h(
            'div',
            { className: 'dgc-sideHead' },
            h('span', null, t('staffs')),
            h('span', { className: 'dgc-spacer' }),
            h('span', { className: 'dgc-listRowSlim' }, String(staffs.length)),
            hasAudioStaff
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dgc-headBtn',
                    title: t('addAudioPeriod'),
                    'aria-label': t('addAudioPeriod'),
                    onClick: () => setDialog({ kind: 'audioPeriod', staffId: '' }),
                  },
                  h(Icon, { name: 'volume', size: 12 }),
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'dgc-headBtn',
                title: t('addStaff'),
                'aria-label': t('addStaff'),
                onClick: openStaffDialog,
              },
              h(Icon, { name: 'plus', size: 12 }),
            ),
          ),
          h(
            'div',
            { className: 'dgc-list' },
            h(
              'div',
              { className: 'dgc-row' + (activeStaff ? '' : ' is-active'), onClick: () => setActiveStaff(null) },
              h('span', { className: 'dgc-rowLabel' }, t('filterAll')),
              h('span', { className: 'dgc-rowMeta' }, String(elements.length)),
            ),
            staffs.map((staff) =>
              h(StaffRow, {
                key: staff.id,
                staff,
                active: staff.id === activeStaff,
                hidden: hiddenStaffs.has(staff.id),
                onSelect: setActiveStaff,
                onToggleHidden: toggleStaff,
                onMenu: openStaffMenu,
                onAddAudio: (id) => setDialog({ kind: 'audioPeriod', staffId: id }),
                t,
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dgc-sideSection is-elements' },
          h(
            'div',
            { className: 'dgc-sideHead' },
            h('span', null, t('elements')),
            h('span', { className: 'dgc-spacer' }),
            h('span', { className: 'dgc-listRowSlim' }, activeAudioStaff ? String(shownAudioPeriods.length) : String(filtered.length) + '/' + String(elements.length)),
            h(
              'button',
              {
                type: 'button',
                className: 'dgc-headBtn',
                title: activeAudioStaff ? t('addAudioPeriod') : t('addElement'),
                'aria-label': activeAudioStaff ? t('addAudioPeriod') : t('addElement'),
                onClick: activeAudioStaff
                  ? () => setDialog({ kind: 'audioPeriod', staffId: activeAudioStaff.id })
                  : openElementDialog,
              },
              h(Icon, { name: 'plus', size: 12 }),
            ),
          ),
          h(
            'div',
            { style: { padding: '0 10px 6px', display: 'flex', flexDirection: 'column', gap: 5 } },
            h('input', {
              className: 'dgc-input',
              placeholder: t('search'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            activeAudioStaff
              ? null
              : h(
                  'div',
                  { className: 'dgc-chips' },
                  [
                    ['all', t('filterAll')],
                    ['notes', t('filterNotes')],
                    ['lanes', t('filterLanes')],
                    ['other', t('filterOther')],
                  ].map(([value, label]) =>
                    h('button', {
                      key: value,
                      className: 'dgc-chip' + (filter === value ? ' is-active' : ''),
                      onClick: () => setFilter(value),
                    }, label),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'dgc-list' },
            activeAudioStaff
              ? shownAudioPeriods.length === 0
                ? h(
                    'div',
                    { className: 'dgc-dialogEmpty', style: { padding: '14px 10px' } },
                    h('div', null, audioHostReady ? t('noAudioPeriods') : t('audioHostStale')),
                    h(
                      'div',
                      { style: { marginTop: 10 } },
                      h(
                        Button,
                        {
                          variant: 'primary',
                          icon: 'plus',
                          disabled: !audioHostReady,
                          title: audioHostReady ? undefined : t('audioHostStaleShort'),
                          onClick: () => setDialog({ kind: 'audioPeriod', staffId: activeAudioStaff.id }),
                        },
                        t('addAudioPeriod'),
                      ),
                    ),
                  )
                : shownAudioPeriods.map((clip) =>
                    h(
                      'div',
                      {
                        key: clip.id || clip.method,
                        className: 'dgc-row',
                        title: (clip.method || '') + (clip.relativePath ? ' · ' + clip.relativePath : ''),
                        onClick: () => seek(Math.max(0, clip.offset || 0)),
                        onDoubleClick: () => seek(Math.max(0, clip.offset || 0)),
                      },
                      h('span', { className: 'dgc-dot', style: { background: clip.missing ? '#ff6e6e' : '#38e8c4' } }),
                      h('span', { className: 'dgc-rowLabel' }, clip.name || clip.method || t('audioPeriods')),
                      clip.missing ? h('span', { className: 'dgc-rowMeta', style: { color: '#ff8a8a' } }, t('audioPeriodMissing')) : null,
                      h('span', { className: 'dgc-rowMeta', style: { width: 58, textAlign: 'right' } }, formatTime(clip.offset || 0)),
                      h(
                        'button',
                        {
                          className: 'dgc-rowBtn',
                          title: t('deleteAudioPeriod'),
                          'aria-label': t('deleteAudioPeriod'),
                          onClick: (event) => {
                            event.stopPropagation();
                            setDialog({ kind: 'deleteAudioPeriod', staffId: activeAudioStaff.id, audioPeriodId: clip.id });
                          },
                        },
                        h(Icon, { name: 'trash', size: 12 }),
                      ),
                    ),
                  )
              : filtered.length === 0
              ? h(
                  'div',
                  { className: 'dgc-dialogEmpty', style: { padding: '14px 10px' } },
                  h('div', null, t('emptyElementList')),
                  h(
                    'div',
                    { style: { marginTop: 10 } },
                    editableStaffs.length > 0
                      ? h(Button, { icon: 'plus', onClick: openElementDialog }, t('addElement'))
                      : h(Button, { variant: 'primary', icon: 'plus', onClick: openStaffDialog }, t('addStaff')),
                  ),
                )
              : displayRows.slice(0, 4000).map((row) => {
                  if (row.kind === 'header') {
                    // Staff group header for the merged ("全部") element list.
                    return h(
                      'div',
                      {
                        key: row.key,
                        className: 'dgc-groupHead',
                        title: row.staffId + ' · ' + t('staffMenuHint'),
                        onContextMenu: (event) => {
                          if (event && typeof event.preventDefault === 'function') event.preventDefault();
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                          const px = event && Number.isFinite(event.clientX) ? event.clientX : 0;
                          const py = event && Number.isFinite(event.clientY) ? event.clientY : 0;
                          openStaffMenu(row.staffId, px, py);
                        },
                      },
                      h(Icon, { name: 'lane', size: 12 }),
                      h('span', { className: 'dgc-rowLabel' }, row.label),
                      h('span', { className: 'dgc-spacer' }),
                      h('span', { className: 'dgc-rowMeta' }, String(row.count)),
                    );
                  }
                  const element = row.element;
                  const active = selection.indexOf(element.id) !== -1;
                  const lane = element.lane || (element.fields && typeof element.fields.name === 'string' ? element.fields.name : '');
                  return h(
                    'div',
                    {
                      key: element.id,
                      className: 'dgc-row' + (active ? ' is-active' : ''),
                      onClick: (event) => selectElement(element.id, event.shiftKey || event.metaKey || event.ctrlKey),
                      onDoubleClick: () => seek(Math.max(0, element.start || 0)),
                      title: element.type + ' · ' + element.id,
                    },
                    h('span', { className: 'dgc-dot', style: { background: elementColor(catalog, element.type) } }),
                    h('span', { className: 'dgc-rowLabel' }, shortType(element.type)),
                    lane ? h('span', { className: 'dgc-rowMeta', style: { maxWidth: 86, overflow: 'hidden', textOverflow: 'ellipsis' } }, lane) : null,
                    h('span', { className: 'dgc-rowMeta', style: { width: 58, textAlign: 'right' } }, formatTime(element.start || 0)),
                  );
                }),
          ),
        ),
        dialog && dialog.kind === 'staff'
          ? h(AddStaffDialog, { t, project, onCancel: () => setDialog(null), onCreate: createStaff })
          : null,
        dialog && dialog.kind === 'audioPeriod'
          ? h(AddAudioPeriodDialog, {
              key: 'audio::' + (dialog.staffId || 'auto'),
              t,
              project,
              staffId: dialog.staffId || '',
              time: playheadRef && Number.isFinite(playheadRef.current) ? playheadRef.current : 0,
              hostReady: audioHostReady,
              onCancel: () => setDialog(null),
              onCreate: (payload) => {
                setDialog(null);
                if (typeof onAddAudioPeriod === 'function') onAddAudioPeriod(payload);
              },
            })
          : null,
        dialog && deleteAudioTarget
          ? h(DeleteAudioPeriodDialog, {
              key: 'deleteAudio::' + deleteAudioTarget.staff.id + '::' + deleteAudioTarget.clip.id,
              t,
              staff: deleteAudioTarget.staff,
              clip: deleteAudioTarget.clip,
              onCancel: () => setDialog(null),
              onConfirm: () => {
                setDialog(null);
                if (typeof onDeleteAudioPeriod === 'function') onDeleteAudioPeriod(deleteAudioTarget.staff.id, deleteAudioTarget.clip);
              },
            })
          : null,
        dialog && dialog.kind === 'element'
          ? h(ElementPaletteDialog, {
              t,
              project,
              catalog,
              initialStaffId: dialog.staffId,
              time: dialog.time,
              onCancel: () => setDialog(null),
              onPick: pickElement,
              onRequestStaff: openStaffDialog,
            })
          : null,
        dialog && renameTarget
          ? h(RenameStaffDialog, {
              key: 'rename::' + renameTarget.id,
              t,
              staff: renameTarget,
              onCancel: () => setDialog(null),
              onSubmit: submitRename,
            })
          : null,
        dialog && deleteTarget
          ? h(DeleteStaffDialog, {
              key: 'delete::' + deleteTarget.id,
              t,
              staff: deleteTarget,
              onCancel: () => setDialog(null),
              onConfirm: submitDelete,
            })
          : null,
        menu && menuStaff
          ? h(StaffContextMenu, {
              key: 'menu::' + menu.staffId,
              t,
              staff: menuStaff,
              x: menu.x,
              y: menu.y,
              onRename: requestRename,
              onDelete: requestDelete,
              onClose: closeStaffMenu,
            })
          : null,
      );
    }

    /**
     * Memoized panes. The transport clock is page state that changes every
     * animation frame, so without memoisation the whole left list and the
     * recursive inspector tree would re-render ~60 times a second while
     * playing. The comparator ignores callback props (cheap closures over
     * stable setters) and compares the data that actually drives output.
     */
    const LeftPaneMemo = React.memo(LeftPane, (prev, next) => {
      return (
        prev.project === next.project &&
        prev.catalog === next.catalog &&
        prev.selection === next.selection &&
        prev.activeStaff === next.activeStaff &&
        prev.hiddenStaffs === next.hiddenStaffs &&
        prev.onAddAudioPeriod === next.onAddAudioPeriod &&
        prev.onDeleteAudioPeriod === next.onDeleteAudioPeriod &&
        prev.t === next.t
      );
    });

    // ========================================================================
    // 12 · Inspector: project summary, multi-selection, and one element's fields.
    // ========================================================================

    /** Editable project metadata (BPM / offset / title) plus counts. */
    function ProjectPanel(props) {
      const { project, catalog, t, onEdit, onDetectBpm, bpmBusy, bpmAvailable } = props;
      const counts = useMemo(() => {
        let elements = 0;
        let periods = 0;
        for (const staff of project.staffs || []) {
          periods += (staff.periods || []).length;
          for (const period of staff.periods || []) elements += (period.elements || []).length;
        }
        return { elements, periods, staffs: (project.staffs || []).length };
      }, [project]);
      const tempo = project.tempo || { bpm: 120, offset: 0 };
      return h(
        'div',
        null,
        h('div', { className: 'dgc-sectionTitle' }, t('projectInfo')),
        h(
          FieldRow,
          { label: t('tempo') },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0 } },
            h('span', { style: { flex: '1 1 auto', minWidth: 64 } }, h(NumberField, {
              value: tempo.bpm,
              step: 1,
              onCommit: (bpm) => onEdit([{ op: 'setMeta', tempo: { bpm } }]),
            })),
            h(
              Button,
              {
                icon: 'wave',
                className: 'dgc-autoBpm',
                title: bpmBusy ? t('autoBpmBusy') : bpmAvailable === false ? t('bpmNoAudio') : t('autoBpmHint'),
                disabled: bpmBusy === true || bpmAvailable === false,
                onClick: onDetectBpm,
              },
              bpmBusy ? t('autoBpmBusy') : t('autoBpm'),
            ),
          ),
        ),
        h(FieldRow, { label: t('offset') }, h(NumberField, {
          value: tempo.offset,
          step: 0.1,
          onCommit: (offset) => onEdit([{ op: 'setMeta', tempo: { offset } }]),
        })),
        h(FieldRow, { label: t('duration') }, h('span', { className: 'dgc-mono' }, formatTime(project.duration || 0))),
        h(FieldRow, { label: t('staffCount') }, h('span', { className: 'dgc-mono' }, String(counts.staffs))),
        h(FieldRow, { label: t('periodCount') }, h('span', { className: 'dgc-mono' }, String(counts.periods))),
        h(FieldRow, { label: t('elementCount') }, h('span', { className: 'dgc-mono' }, String(counts.elements))),
        project.audio ? h(FieldRow, { label: t('audio') }, h('span', { className: 'dgc-mono', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, project.audio.name || '')) : null,
        project.audioPeriods && project.audioPeriods.length > 0
          ? h(
              FieldRow,
              { label: t('audioPeriods') },
              h(
                'span',
                { className: 'dgc-mono', style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
                project.audioPeriods
                  .map((clip) => (clip.name || clip.method || '') + ' @ ' + formatTime(clip.offset || 0))
                  .join(' · '),
              ),
            )
          : null,
        (project.warnings || []).length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dgc-sectionTitle' }, t('warnings')),
              (project.warnings || []).slice(0, 8).map((warning, index) => h('div', { key: index, className: 'dgc-listRowSlim dgc-err' }, warning)),
            )
          : null,
        h('div', { className: 'dgc-sectionTitle' }, t('shortcuts')),
        h('div', { className: 'dgc-hint', style: { padding: '0 0 4px' } }, t('helpBody')),
        (project.assets && project.assets.images || []).length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dgc-sectionTitle' }, t('assetImages')),
              (project.assets.images || []).slice(0, 24).map((name, index) => h('div', { key: index, className: 'dgc-listRowSlim dgc-mono' }, name)),
            )
          : null,
      );
    }

    /** The one-element inspector. */
    function ElementInspector(props) {
      const { project, catalog, t, elementId, onEdit, onDelete, onDuplicate, seek } = props;
      const found = useMemo(() => findElement(project, elementId), [project, elementId]);

      if (!found) return h('div', { className: 'dgc-hint' }, t('noSelection'));

      const { staff, period, element } = found;
      const entry = catalogEntry(catalog, element.type);
      const timing = (entry && entry.timing) || {};
      const fields = element.fields || {};
      const schemaFields = (entry && entry.fields) || [];
      const knownNames = schemaFields.map((field) => field.name);
      const unknownNames = Object.keys(fields).filter((name) => knownNames.indexOf(name) === -1);
      const offset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;

      /** Commit one top-level field change. */
      const patchField = (name, value) => {
        onEdit([{ op: 'patch', elementId: element.id, path: [name], value }]);
      };

      // The catalog descriptor decides the timing fields; a field missing from
      // the parsed element is simply at its injector default (0) and a patch
      // materialises it.
      const startField = resolveStartField(catalog, element);
      const durationField = resolveDurationField(catalog, element);
      const startValue = startField ? valueAsNumber(fields[startField]) : null;
      const durationValue = durationField ? valueAsNumber(fields[durationField]) : null;

      const lanes = props.lanes || [];
      const laneFieldName = timing.lane || 'laneName';

      const toggleOptionalField = (name, schema, checked) => {
        if (checked) {
          patchField(name, defaultValueForSchema(schema));
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(fields, name)) return;
        // Optional fields are removed, not set to null, so an unchecked field
        // disappears from the .g file exactly like a field the chart omitted.
        const nextFields = Object.assign({}, fields);
        delete nextFields[name];
        props.onEdit([{ op: 'patch', elementId: element.id, path: [], value: nextFields }]);
      };

      const fieldRowFor = (name) => {
        const schema = schemaFields.find((field) => field.name === name) || null;
        const value = fields[name];
        const label = (schema && schema.label) || name;
        const optional = !!(schema && schema.optional === true);
        if (value === undefined) {
          if (optional) {
            return h(
              FieldRow,
              {
                key: name,
                label,
                title: name,
                optional: {
                  name,
                  checked: false,
                  title: label,
                  onChange: (checked) => toggleOptionalField(name, schema, checked),
                },
              },
              h('span', { className: 'dgc-optionalHint' }, t('fieldUnused')),
            );
          }
          // Injector-default field the .g file left implicit: offer to
          // materialise it so it becomes editable (patching creates it).
          return h(
            FieldRow,
            { key: name, label, title: name },
            h(
              Button,
              { variant: 'ghost', icon: 'plus', title: t('addField'), onClick: () => patchField(name, defaultValueForSchema(schema)) },
              h('span', { className: 'dgc-listRowSlim' }, t('addField')),
            ),
          );
        }
        const unused = optional && value === null;
        return h(
          FieldRow,
          {
            key: name,
            label,
            title: name,
            optional: optional
              ? {
                  name,
                  checked: !unused,
                  title: label,
                  onChange: (checked) => toggleOptionalField(name, schema, checked),
                }
              : null,
          },
          unused
            ? h('span', { className: 'dgc-optionalHint' }, t('fieldUnused'))
            : h(ValueEditor, {
                value,
                schema,
                t,
                depth: 0,
                path: [name],
                onChange: (next) => patchField(name, next),
                onEditCurve: props.onOpenCurve
                  ? (current, apply, curvePath) => {
                      // Patch the curve at its exact path instead of rebuilding
                      // the parent object, so editing another inspector field
                      // while the panel is open is not reverted on Apply.
                      const path =
                        Array.isArray(curvePath) && curvePath.length > 0 ? curvePath.slice() : [name];
                      const tail = path[path.length - 1];
                      const curveName =
                        typeof tail === 'number'
                          ? path.filter((segment) => segment !== 'items' && segment !== 'fields').join('.') + '[' + tail + ']'
                          : tail || name;
                      props.onOpenCurve({
                        name: curveName,
                        value: current,
                        apply: (next) => onEdit([{ op: 'patch', elementId: element.id, path, value: next }]),
                        anchorTime: Number.isFinite(element.start) ? element.start : 0,
                        elementId: element.id,
                        elementType: element.type,
                      });
                    }
                  : undefined,
              }),
        );
      };

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dgc-sectionTitle' },
          h('span', { style: { width: 8, height: 8, borderRadius: 2, background: elementColor(catalog, element.type), display: 'inline-block' } }),
          h('span', null, shortType(element.type)),
          h('span', { className: 'dgc-spacer', style: { flex: 1 } }),
          h('span', { className: 'dgc-listRowSlim', style: { textTransform: 'none', letterSpacing: 0 } }, element.id),
        ),
        h(FieldRow, { label: t('editTime') }, h(NumberField, {
          value: round(offset + (startValue === null ? 0 : startValue), 6),
          step: 0.05,
          onCommit: (next) => {
            if (!startField) return;
            patchField(startField, round(next - offset, 6));
          },
        })),
        durationField
          ? h(FieldRow, { label: t('length') }, h(NumberField, {
              value: durationValue,
              step: 0.05,
              onCommit: (next) => patchField(durationField, Math.max(0, round(next, 6))),
            }))
          : null,
        fields[laneFieldName] !== undefined
          ? h(
              FieldRow,
              { label: t('laneName') },
              h(
                'div',
                { style: { display: 'flex', gap: 4, width: '100%' } },
                h(TextField, { value: valueAsString(fields[laneFieldName]), onCommit: (text) => patchField(laneFieldName, text) }),
                h('select', {
                  className: 'dgc-select',
                  value: '',
                  onChange: (event) => {
                    if (event.target.value) patchField(laneFieldName, event.target.value);
                  },
                }, h('option', { value: '' }, '…'), lanes.map((lane) => h('option', { key: lane, value: lane }, lane))),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dgc-rowActions', style: { margin: '8px 0 4px' } },
          h(Button, { icon: 'duplicate', onClick: () => onDuplicate(element.id) }, t('duplicate')),
          h(Button, { icon: 'trash', variant: 'danger', onClick: () => onDelete([element.id]) }, t('delete')),
          h(Button, { icon: 'dot', onClick: () => seek(Math.max(0, element.start || 0)) }, t('goto')),
        ),
        h('div', { className: 'dgc-sectionTitle' }, t('field')),
        knownNames.map((name) => fieldRowFor(name)),
        unknownNames.length > 0
          ? h(
              'details',
              { className: 'dgc-tree', open: false },
              h('summary', { className: 'dgc-treeHead', style: { cursor: 'pointer' } }, h(Icon, { name: 'chevron', size: 13 }), h('span', null, t('advanced')), h('span', { className: 'dgc-listRowSlim' }, String(unknownNames.length))),
              h('div', { className: 'dgc-listRowSlim', style: { paddingBottom: 4 } }, t('advancedHint')),
              unknownNames.map((name) => fieldRowFor(name)),
            )
          : null,
      );
    }

    /** Multi-selection summary with the bulk actions that make sense. */
    function MultiPanel(props) {
      const { project, catalog, t, selection, onEdit, onDelete, seek, transport } = props;
      const found = selection.map((id) => ({ id, found: findElement(project, id) })).filter((item) => item.found);
      return h(
        'div',
        null,
        h('div', { className: 'dgc-sectionTitle' }, t('multiSelection').replace('{count}', String(found.length))),
        h(
          'div',
          { className: 'dgc-list' },
          found.slice(0, 60).map((item) =>
            h(
              'div',
              { key: item.id, className: 'dgc-row' },
              h('span', { className: 'dgc-dot', style: { background: elementColor(catalog, item.found.element.type) } }),
              h('span', { className: 'dgc-rowLabel' }, shortType(item.found.element.type)),
              h('span', { className: 'dgc-rowMeta' }, formatTime(item.found.element.start || 0)),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dgc-rowActions', style: { margin: '8px 0' } },
          h(Button, {
            icon: 'dot',
            onClick: () => {
              const delta = (transport ? transport.time : 0) - (found[0] ? found[0].found.element.start || 0 : 0);
              onEdit(
                found.map((item) => {
                  const startField = resolveStartField(catalog, item.found.element);
                  if (!startField) return null;
                  const current = valueAsNumber(item.found.element.fields[startField]);
                  if (current === null) return null;
                  return { op: 'patch', elementId: item.id, path: [startField], value: round(current + delta, 6) };
                }).filter(Boolean),
              );
            },
          }, t('goto')),
          h(Button, { icon: 'trash', variant: 'danger', onClick: () => onDelete(selection) }, t('delete')),
        ),
      );
    }

    /** Right pane container. */
    function InspectorPane(props) {
      const { project, catalog, t, selection } = props;
      let body;
      if (!project) body = h('div', { className: 'dgc-hint' }, t('noProject'));
      else if (selection.length === 0) body = h(ProjectPanel, props);
      else if (selection.length === 1) body = h(ElementInspector, Object.assign({ elementId: selection[0] }, props));
      else body = h(MultiPanel, props);
      return h(
        'aside',
        { className: 'dgc-inspector' },
        h('div', { className: 'dgc-sideHead' }, h('span', null, t('inspector')), h('span', { className: 'dgc-spacer' })),
        h('div', { className: 'dgc-inspectorBody' }, body),
      );
    }

    /** Memoized inspector (see LeftPaneMemo for why). */
    const InspectorPaneMemo = React.memo(InspectorPane, (prev, next) => {
      return (
        prev.project === next.project &&
        prev.catalog === next.catalog &&
        prev.selection === next.selection &&
        prev.lanes === next.lanes &&
        prev.bpmBusy === next.bpmBusy &&
        prev.bpmAvailable === next.bpmAvailable &&
        prev.onDetectBpm === next.onDetectBpm &&
        prev.onOpenCurve === next.onOpenCurve &&
        prev.t === next.t
      );
    });

    // ========================================================================
    // 13 · Transport bar.
    // ========================================================================

    /** Bottom transport: play/pause, clock, beat, scrubber, rate, follow. */
    function TransportBar(props) {
      const { t, transport, project, follow, setFollow, selection } = props;
      const tempo = (project && project.tempo) || { bpm: 120, offset: 0 };
      const duration = Math.max(1, transport.duration || (project && project.duration) || 0);
      const beat = ((transport.time - (tempo.offset || 0)) * (tempo.bpm || 120)) / 60;
      return h(
        'div',
        { className: 'dgc-transport' },
        h(
          Button,
          {
            variant: 'primary',
            icon: transport.playing ? 'pause' : 'play',
            onClick: () => (transport.playing ? transport.pause() : transport.play()),
            title: transport.playing ? t('pause') : t('play'),
          },
          transport.playing ? t('pause') : t('play'),
        ),
        h(Button, { icon: 'rewind', onClick: () => transport.seek(0), title: t('jumpToStart') }),
        h('div', { className: 'dgc-clock' }, formatTime(transport.time) + ' / ' + formatTime(duration)),
        h('div', { className: 'dgc-clock', style: { minWidth: 84 } }, t('beat') + ' ' + formatNum(beat, 3)),
        h(
          'div',
          { className: 'dgc-scrub' },
          h('input', {
            type: 'range',
            min: 0,
            max: 1000,
            step: 1,
            value: Math.round((clamp(transport.time / duration, 0, 1)) * 1000),
            onChange: (event) => transport.seek((Number(event.target.value) / 1000) * duration),
            'aria-label': t('time'),
          }),
        ),
        h(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('rate')),
          h(
            'select',
            {
              className: 'dgc-select',
              value: String(transport.rate),
              onChange: (event) => transport.setRate(Number(event.target.value)),
            },
            RATE_OPTIONS.map((value) => h('option', { key: value, value: String(value) }, value + 'x')),
          ),
        ),
        h(Button, {
          icon: transport.muted ? 'mute' : 'volume',
          variant: 'ghost',
          active: transport.muted,
          onClick: transport.toggleMute,
          title: transport.muted ? 'unmute' : 'mute',
        }),
        h(Button, {
          icon: 'grid',
          variant: follow ? 'primary' : 'ghost',
          onClick: () => setFollow(!follow),
          title: t('autoScroll'),
        }),
        h('span', { className: 'dgc-status' }, selection.length > 0 ? t('selected') + ': ' + selection.length : ''),
      );
    }

    // ========================================================================
    // 14 · Timeline layout model.
    // ========================================================================

    /** Flatten a staff into absolute-time elements (already derived by the Host). */
    function staffElements(staff) {
      const out = [];
      for (const period of staff.periods || []) {
        for (const element of period.elements || []) {
          out.push({ element, period, staff });
        }
      }
      return out;
    }

    /**
     * Build the timeline rows: one row per lane (with its notes), a misc row per
     * staff, and one draggable row per audio period (@Song clip). Rows keep the
     * file order of lane declarations.
     */
    function buildRows(project, hiddenStaffs, collapsedStaffs) {
      const rows = [];
      if (!project || !Array.isArray(project.staffs)) return rows;
      for (const staff of project.staffs) {
        if (hiddenStaffs && hiddenStaffs.has && hiddenStaffs.has(staff.id)) continue;
        if (staff.kind === 'audio') {
          // Audio staffs have no @Chart periods, but their @Song clips appear
          // as rows so a segment can be seen, selected and dragged in time.
          const clips = (staff.audioPeriods || []).slice().sort((a, b) => (a.offset || 0) - (b.offset || 0));
          const collapsedAudio = !!(collapsedStaffs && collapsedStaffs.has && collapsedStaffs.has(staff.id));
          rows.push({
            kind: 'group',
            key: staff.id + '::__group',
            staffId: staff.id,
            staff,
            audioGroup: true,
            label: staff.displayName || staff.className || staff.id,
            sublabel: staff.className && staff.className !== (staff.displayName || '') ? staff.className : '',
            laneCount: 0,
            noteCount: clips.length,
            collapsed: collapsedAudio,
          });
          if (!collapsedAudio) {
            for (const clip of clips) {
              rows.push({
                kind: 'row',
                key: staff.id + '::audio::' + (clip.id || clip.method || clip.offset),
                staffId: staff.id,
                staff,
                audioRow: true,
                clip,
                lane: null,
                notes: [],
              });
            }
          }
          continue;
        }
        const laneNames = [];
        // Several periods of one staff legitimately reuse a lane name (e.g.
        // DremuStaff2.g has 82 lane elements over 33 names): the row is per
        // NAME, but every element must stay visible and selectable.
        const laneElementsByName = new Map();
        const notesByLane = new Map();
        const misc = [];
        for (const item of staffElements(staff)) {
          const element = item.element;
          const category = element.category;
          if (category === 'inner') continue;
          if (category === 'lane') {
            const name = element.fields && typeof element.fields.name === 'string' ? element.fields.name : element.id;
            if (laneNames.indexOf(name) === -1) laneNames.push(name);
            if (!laneElementsByName.has(name)) laneElementsByName.set(name, []);
            laneElementsByName.get(name).push(element);
            continue;
          }
          const lane = element.lane;
          if (lane) {
            if (!notesByLane.has(lane)) notesByLane.set(lane, []);
            notesByLane.get(lane).push(element);
          } else {
            misc.push(element);
          }
        }
        for (const lane of notesByLane.keys()) {
          if (laneNames.indexOf(lane) === -1) laneNames.push(lane);
        }
        const staffRows = [];
        for (const lane of laneNames) {
          const laneElements = (laneElementsByName.get(lane) || []).slice().sort((a, b) => (a.start || 0) - (b.start || 0));
          staffRows.push({
            key: staff.id + '::' + lane,
            staffId: staff.id,
            staff,
            lane,
            laneElement: laneElements[0] || null,
            laneElements,
            notes: (notesByLane.get(lane) || []).sort((a, b) => (a.start || 0) - (b.start || 0)),
          });
        }
        if (misc.length > 0) {
          staffRows.push({
            key: staff.id + '::__misc',
            staffId: staff.id,
            staff,
            lane: null,
            laneElement: null,
            notes: misc.sort((a, b) => (a.start || 0) - (b.start || 0)),
            misc: true,
          });
        }
        // Group the staff's lanes under one collapsible header so the timeline
        // reads as "谱表 -> 轨道" instead of repeating the staff name per row.
        const collapsed = !!(collapsedStaffs && collapsedStaffs.has && collapsedStaffs.has(staff.id));
        const laneCount = laneNames.length;
        const noteCount = staffRows.reduce((total, row) => total + row.notes.length, 0);
        rows.push({
          kind: 'group',
          key: staff.id + '::__group',
          staffId: staff.id,
          staff,
          label: staff.displayName || staff.className || staff.id,
          sublabel: staff.className && staff.className !== (staff.displayName || '') ? staff.className : '',
          laneCount,
          noteCount,
          collapsed,
        });
        if (!collapsed) {
          for (const row of staffRows) rows.push(Object.assign({ kind: 'row' }, row));
        }
      }
      return rows;
    }

    /** Height of one timeline row (staff headers are shorter than lane rows). */
    function rowHeight(row) {
      return row && row.kind === 'group' ? GROUP_H : ROW_H;
    }

    /** Snap a time to the beat grid. */
    function snapTime(time, tempo, division, enabled) {
      if (!enabled || !division) return time;
      const bpm = tempo && Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : 120;
      const origin = tempo && Number.isFinite(tempo.offset) ? tempo.offset : 0;
      const secondsPerBeat = 60 / bpm;
      const step = 1 / division;
      const beat = (time - origin) / secondsPerBeat;
      return origin + Math.round(beat / step) * step * secondsPerBeat;
    }

    /** Resolve one of the placement tools to a catalog element type. */
    function typeForTool(catalog, tool) {
      const wanted = { tap: 'DremuTap', drag: 'DremuDrag', hold: 'DremuHold', lane: 'DremuMainLane', guide: 'DremuGuideLane' }[tool];
      if (!wanted) return null;
      const entries = (catalog && catalog.elements) || [];
      const match = entries.find((entry) => shortType(entry.type) === wanted);
      return match ? match.type : null;
    }

    /** Build the default field object for a new element of `type`. */
    function fieldsForNewElement(catalog, type) {
      const entry = catalogEntry(catalog, type);
      const fields = {};
      if (entry && Array.isArray(entry.fields)) {
        for (const field of entry.fields) {
          if (field.default === undefined) continue;
          fields[field.name] = deepClone(field.default);
        }
      }
      if (entry && entry.category === 'lane' && fields.name === undefined) fields.name = 'lane01';
      if (entry && entry.category !== 'lane' && fields.hitTime === undefined && entry.timing && entry.timing.start) {
        fields[entry.timing.start] = 0;
      }
      return fields;
    }

    /** Unique lane name inside a staff (optionally avoiding names being added now). */
    function uniqueLaneName(project, staffId, reserved) {
      const staff = (project.staffs || []).find((item) => item.id === staffId);
      const used = reserved instanceof Set ? reserved : new Set();
      if (staff) {
        for (const item of staffElements(staff)) {
          if (item.element.fields && typeof item.element.fields.name === 'string') used.add(item.element.fields.name);
        }
      }
      let index = 1;
      while (used.has('lane' + String(index).padStart(2, '0'))) index += 1;
      return 'lane' + String(index).padStart(2, '0');
    }

    /** ID generator for newly created elements (accepted by the Host). */
    function makeElementId(prefix) {
      return 'n' + (prefix ? String(prefix) + '-' : '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /** Unique `ClassName` + `ClassName.g` for a new staff (matches the Host defaults). */
    function uniqueStaffIdentity(project, kind) {
      const base = kind === 'storyboard' ? 'Storyboard' : kind === 'audio' ? 'Song' : 'Staff';
      const usedFiles = new Set();
      const usedClasses = new Set();
      for (const staff of (project && project.staffs) || []) {
        usedFiles.add(String(staff.id).toLowerCase());
        usedClasses.add(String(staff.className));
      }
      let index = 1;
      let candidate = base;
      while (usedClasses.has(candidate) || usedFiles.has((candidate + '.g').toLowerCase())) {
        index += 1;
        candidate = base + index;
      }
      return { className: candidate, fileName: candidate + '.g' };
    }

    /** First lane name defined by a staff (new notes target it by default). */
    function firstLaneName(project, staffId) {
      const staff = (project.staffs || []).find((item) => item.id === staffId);
      if (!staff) return '';
      for (const period of staff.periods || []) {
        for (const element of period.elements || []) {
          if (element.category !== 'lane') continue;
          const name = element.fields && element.fields.name;
          if (typeof name === 'string' && name.length > 0) return name;
        }
      }
      return '';
    }

    // ========================================================================
    // 15 · Timeline canvas.
    // ========================================================================

    /** Right-click menu for the audio strip: waveform vs. spectrum view. */
    function WaveformContextMenu(props) {
      const { t, x, y, mode, onSelect, onClose } = props;
      const menuRef = useRef(null);
      useEffect(() => {
        const close = () => onClose();
        const onPointerDown = (event) => {
          const node = menuRef.current;
          if (node && event && event.target && typeof node.contains === 'function' && node.contains(event.target)) return;
          onClose();
        };
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', close);
        window.addEventListener('wheel', close, true);
        window.addEventListener('blur', close);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('wheel', close, true);
          window.removeEventListener('blur', close);
        };
      }, [onClose]);
      const item = (value, label, icon) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dgc-menuItem',
            role: 'menuitemradio',
            'aria-checked': mode === value,
            onClick: () => onSelect(value),
          },
          h('span', { style: { width: 12, textAlign: 'center', fontSize: 11, flex: '0 0 12px' } }, mode === value ? '✓' : ''),
          h(Icon, { name: icon, size: 13 }),
          h('span', null, label),
        );
      return h(
        'div',
        {
          ref: menuRef,
          className: 'dgc-menu',
          role: 'menu',
          'aria-label': t('waveViewTitle'),
          style: { left: x, top: y },
          onContextMenu: (event) => event.preventDefault(),
        },
        h('div', { className: 'dgc-menuHead' }, t('waveViewTitle')),
        item('wave', t('waveViewWaveform'), 'wave'),
        item('spectrum', t('waveViewSpectrum'), 'spectrum'),
      );
    }

    /**
     * The central timeline: beat ruler, waveform strip, lane rows, notes, hold
     * bodies, selection, grid, playhead and all direct-manipulation gestures.
     */
    function TimelineCanvas(props) {
      const {
        project,
        catalog,
        t,
        selection,
        setSelection,
        tool,
        setTool,
        snapOn,
        setSnapOn,
        snapDiv,
        tempo,
        transport,
        follow,
        hiddenStaffs,
        activeStaff,
        onEdit,
        onNotice,
        waves,
        waveStatus,
        audioClips,
        onOpenNoteEditor,
      } = props;

      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const [size, setSize] = useState({ w: 0, h: 0 });
      const [view, setView] = useState({ t0: 0, pps: PPS_DEFAULT, scrollY: 0 });
      useEffect(() => {
        if (typeof props.onViewChange === 'function') {
          props.onViewChange({ t0: view.t0, pps: view.pps });
        }
      }, [view.t0, view.pps, props.onViewChange]);
      const [hover, setHover] = useState(null);
      // Right-click menu for the audio strip and the persisted view mode.
      const [waveMode, setWaveMode] = useState(readWaveModePreference);
      const [waveMenu, setWaveMenu] = useState(null);
      // Which staff groups are collapsed in the timeline gutter.
      const [collapsedStaffs, setCollapsedStaffs] = useState(() => new Set());
      const dragRef = useRef(null);
      const viewRef = useRef(view);
      const sizeRef = useRef(size);
      const projectRef = useRef(project);
      const selectionRef = useRef(selection);
      const transportRef = useRef(transport);
      const rowsRef = useRef([]);
      const layoutRef = useRef({ tops: [], total: 0 });
      const tempoRef = useRef(tempo);
      const wavesRef = useRef(waves);
      const hoverRef = useRef(hover);
      const waveStatusRef = useRef(waveStatus);
      const audioClipsRef = useRef(audioClips || []);
      const waveModeRef = useRef(waveMode);

      viewRef.current = view;
      sizeRef.current = size;
      projectRef.current = project;
      selectionRef.current = selection;
      transportRef.current = transport;
      tempoRef.current = tempo;
      wavesRef.current = waves || {};
      hoverRef.current = hover;
      waveStatusRef.current = waveStatus;
      audioClipsRef.current = audioClips || [];
      waveModeRef.current = waveMode;

      const rows = useMemo(() => buildRows(project, hiddenStaffs, collapsedStaffs), [project, hiddenStaffs, collapsedStaffs]);
      rowsRef.current = rows;

      // Variable row heights: staff group headers are shorter than lane rows,
      // so row tops are cumulative offsets rather than index * ROW_H.
      const layout = useMemo(() => {
        const tops = [];
        let total = 0;
        for (const row of rows) {
          tops.push(total);
          total += rowHeight(row);
        }
        return { tops, total };
      }, [rows]);
      layoutRef.current = layout;

      const headerH = RULER_H + WAVE_H;

      useEffect(() => {
        if (typeof props.onContentHeight === 'function') {
          props.onContentHeight(headerH + layout.total);
        }
      }, [headerH, layout.total, props.onContentHeight]);

      /** Switch the audio strip between waveform and spectrum, and persist it. */
      const selectWaveMode = useCallback((mode) => {
        const next = mode === 'spectrum' ? 'spectrum' : 'wave';
        setWaveMode(next);
        try {
          if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(WAVE_MODE_KEY, next);
        } catch (error) {
          /* storage unavailable: keep the in-memory preference */
        }
        setWaveMenu(null);
      }, []);

      // --- Resize tracking -------------------------------------------------
      useEffect(() => {
        const node = wrapRef.current;
        if (!node || typeof ResizeObserver !== 'function') {
          const onResize = () => {
            if (!wrapRef.current) return;
            const rect = wrapRef.current.getBoundingClientRect();
            setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
          };
          onResize();
          window.addEventListener('resize', onResize);
          return () => window.removeEventListener('resize', onResize);
        }
        const observer = new ResizeObserver(() => {
          if (!wrapRef.current) return;
          const rect = wrapRef.current.getBoundingClientRect();
          setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      // Collapsing staff groups shrinks the content: keep the scroll position
      // inside the new range instead of showing empty rows.
      useEffect(() => {
        const maxScroll = Math.max(0, layout.total - Math.max(0, size.h - headerH));
        setView((previous) => (previous.scrollY > maxScroll ? Object.assign({}, previous, { scrollY: maxScroll }) : previous));
      }, [layout, size.h, headerH]);

      // --- Geometry helpers -------------------------------------------------
      const xForTime = useCallback((time, currentView) => GUTTER_W + (time - currentView.t0) * currentView.pps, []);
      const timeForX = useCallback((x, currentView) => currentView.t0 + (x - GUTTER_W) / currentView.pps, []);
      const rowTop = useCallback((index, currentView) => {
        const tops = layoutRef.current.tops;
        const offset = index >= 0 && index < tops.length ? tops[index] : (index < 0 ? 0 : layoutRef.current.total);
        return headerH + offset - currentView.scrollY;
      }, [headerH]);

      /** Row index (into rowsRef.current) at a canvas y, or -1. */
      const rowIndexAt = useCallback(
        (y, currentView) => {
          const currentRows = rowsRef.current;
          const tops = layoutRef.current.tops;
          if (currentRows.length === 0) return -1;
          const target = y - headerH + currentView.scrollY;
          if (target < 0 || target >= layoutRef.current.total) return -1;
          // Small row counts (<200), a linear scan keeps this simple and exact.
          for (let index = currentRows.length - 1; index >= 0; index -= 1) {
            if (tops[index] <= target) return index;
          }
          return -1;
        },
        [headerH],
      );

      /** Bounding box of one element inside its row, in CSS pixels. */
      const elementBox = useCallback(
        (element, rowIndex, currentView) => {
          const top = rowTop(rowIndex, currentView);
          const centerY = top + ROW_H / 2;
          const x = xForTime(element.start || 0, currentView);
          const category = element.category;
          if (category === 'lane') {
            const width = Math.max(3, (element.duration || 0) * currentView.pps);
            return { x, y: top + 4, w: width, h: ROW_H - 8, kind: 'bar' };
          }
          if (element.duration !== null && element.duration !== undefined && element.duration > 0) {
            const width = Math.max(3, element.duration * currentView.pps);
            return { x, y: centerY - 7, w: width, h: 14, kind: 'bar' };
          }
          const radius = NOTE_R + 2;
          return { x: x - radius, y: centerY - radius, w: radius * 2, h: radius * 2, kind: 'point', cx: x, cy: centerY };
        },
        [rowTop, xForTime],
      );

      /** Time grid: choose a beat step that keeps labels ≥ 64px apart. */
      const gridStep = useCallback(
        (currentView) => {
          const bpm = tempo && tempo.bpm > 0 ? tempo.bpm : 120;
          const secondsPerBeat = 60 / bpm;
          let step = 1 / 16;
          while (step * secondsPerBeat * currentView.pps < 58) {
            step *= 2;
            if (step > 64) break;
          }
          return step;
        },
        [tempo],
      );

      // --- Painting ---------------------------------------------------------
      const paint = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const currentView = viewRef.current;
        const currentSize = sizeRef.current;
        const width = Math.max(60, currentSize.w || canvas.clientWidth || 600);
        const height = Math.max(60, currentSize.h || canvas.clientHeight || 400);
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // Resolve the theme once per frame; every painter below shares it.
        const colors = {
          background: cssToken('--dsw-alias-bg-base', '#10131a'),
          layerOne: cssToken('--dsw-alias-bg-layer-1', '#171b24'),
          layerTwo: cssToken('--dsw-alias-bg-layer-2', '#1e2330'),
          border: cssToken('--dsw-alias-border-l1', '#2b3244'),
          labelPrimary: cssToken('--dsw-alias-label-primary', '#eef1f7'),
          labelSecondary: cssToken('--dsw-alias-label-secondary', '#8b93a7'),
          brand: cssToken('--dsw-alias-brand-primary', '#5b8cff'),
        };
        const timeLeft = GUTTER_W;
        const timeWidth = Math.max(10, width - GUTTER_W);

        ctx.fillStyle = colors.background;
        ctx.fillRect(0, 0, width, height);

        paintRuler();
        paintWaveform();
        paintHeaderDivider();
        paintRows();
        paintGutterDivider();
        paintPlayhead();
        paintBoxSelection();
        paintHoverTooltip();
        paintEmptyState();

        // --- Ruler: background, beat grid and time labels -------------------
        function paintRuler() {
          ctx.fillStyle = colors.layerOne;
          ctx.fillRect(0, 0, width, headerH);
          ctx.fillStyle = colors.layerTwo;
          ctx.fillRect(0, 0, GUTTER_W, headerH);

          // Beat grid + labels.
          const step = gridStep(currentView);
          const bpm = tempo && tempo.bpm > 0 ? tempo.bpm : 120;
          const secondsPerBeat = 60 / bpm;
          const origin = tempo && Number.isFinite(tempo.offset) ? tempo.offset : 0;
          const totalBeats = (currentView.t0 + timeWidth / currentView.pps - origin) / secondsPerBeat;
          const firstBeat = Math.floor(((currentView.t0 - origin) / secondsPerBeat) / step) * step;
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textBaseline = 'middle';
          for (let beat = firstBeat; beat <= totalBeats + step; beat += step) {
            const time = origin + beat * secondsPerBeat;
            const x = xForTime(time, currentView);
            if (x < timeLeft - 1 || x > width) continue;
            // Whole beats are the strong lines; the label marks every 4th beat.
            const isWholeBeat = Math.abs(beat - Math.round(beat)) < 1e-9;
            ctx.strokeStyle = isWholeBeat ? colors.border : 'rgba(120,130,150,0.16)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, RULER_H);
            ctx.lineTo(Math.round(x) + 0.5, height);
            ctx.stroke();
            if (isWholeBeat && (Math.abs(beat % 4) < 1e-9 || currentView.pps > 90)) {
              ctx.fillStyle = colors.labelSecondary;
              ctx.fillText('♪' + formatNum(beat, 0), x + 3, RULER_H / 2);
            }
          }

          // Seconds labels along the ruler top (dense enough at any zoom).
          const secondsStep = (() => {
            const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
            for (const candidate of candidates) if (candidate * currentView.pps >= 72) return candidate;
            return 240;
          })();
          const firstSecond = Math.floor(currentView.t0 / secondsStep) * secondsStep;
          for (let second = firstSecond; second <= currentView.t0 + timeWidth / currentView.pps + secondsStep; second += secondsStep) {
            const x = xForTime(second, currentView);
            if (x < timeLeft || x > width) continue;
            ctx.fillStyle = colors.labelPrimary;
            ctx.fillText(formatTime(second), x + 3, 8);
            ctx.strokeStyle = colors.border;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, RULER_H);
            ctx.stroke();
          }
        }

        // --- Audio strip: waveform or spectrum, one band per audio period ----
        function paintWaveform() {
          ctx.save();
          ctx.beginPath();
          ctx.rect(timeLeft, RULER_H, timeWidth, WAVE_H);
          ctx.clip();
          ctx.textBaseline = 'middle';
          const mode = waveModeRef.current === 'spectrum' ? 'spectrum' : 'wave';
          const currentClips = audioClipsRef.current || [];
          const currentWaves = wavesRef.current || {};
          const bandColors = ['rgba(124,140,255,0.38)', 'rgba(56,232,196,0.34)', 'rgba(255,209,102,0.32)', 'rgba(255,122,182,0.32)'];
          let drew = false;

          /** Clip name in the top-left corner of its strip. */
          function drawClipLabel(clip, startX, endX) {
            if (endX - startX < 70) return;
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            const x = Math.max(timeLeft, startX) + 5;
            const budget = Math.max(20, Math.min(width, endX) - x - 6);
            const label = fitText(ctx, clip.name || clip.method || clip.relativePath || '', budget);
            if (!label) return;
            const labelWidth = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(6,8,16,0.55)';
            ctx.fillRect(x - 2, RULER_H + 3, labelWidth + 6, 13);
            ctx.fillStyle = colors.labelPrimary;
            ctx.fillText(label, x, RULER_H + 10);
          }

          currentClips.forEach((clip, index) => {
            if (!clip) return;
            const key = clip.file || clip.relativePath || '';
            const wave = key ? currentWaves[key] : null;
            const offset = Number.isFinite(clip.offset) ? clip.offset : 0;
            const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : wave && wave.duration ? wave.duration : 0;
            const startX = xForTime(offset, currentView);
            const endX = duration > 0 ? xForTime(offset + duration, currentView) : width;
            if (endX < timeLeft || startX > width) return;
            // Clip band + start marker make the segment visible even while the
            // waveform/spectrum is still loading.
            ctx.fillStyle = bandColors[index % bandColors.length];
            ctx.globalAlpha = 0.16;
            ctx.fillRect(startX, RULER_H + 2, Math.max(2, endX - startX), WAVE_H - 4);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = bandColors[index % bandColors.length];
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(startX) + 0.5, RULER_H);
            ctx.lineTo(Math.round(startX) + 0.5, RULER_H + WAVE_H);
            ctx.stroke();
            if (clip.missing) {
              ctx.fillStyle = 'rgba(255,120,120,0.9)';
              ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
              ctx.fillText(t('audioPeriodMissing'), Math.max(timeLeft, startX) + 4, RULER_H + WAVE_H - 6);
              drew = true;
              return;
            }

            if (mode === 'spectrum') {
              const spectrum = wave && wave.spectrum;
              if (!spectrum || !spectrum.data || duration <= 0) return;
              drew = true;
              const drawWidth = Math.max(1, endX - startX);
              const canvas = spectrumCanvasFor(spectrum);
              if (canvas) {
                ctx.save();
                // The cached image is wider than the strip, so smoothing is a
                // downscale (crisp); high quality keeps harmonics readable.
                ctx.imageSmoothingEnabled = true;
                if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(canvas, startX, RULER_H + 3, drawWidth, WAVE_H - 6);
                ctx.restore();
              } else {
                // Canvas image data is unavailable (very old browser/test
                // harness): draw coarse blocks instead of leaving a blank band.
                const columns = spectrum.columns;
                const bands = spectrum.bands;
                const step = Math.max(1, Math.ceil(columns / Math.max(1, Math.min(480, drawWidth))));
                const bandHeight = (WAVE_H - 6) / bands;
                const columnWidth = Math.max(1, (drawWidth / columns) * step);
                for (let c = 0; c < columns; c += step) {
                  const x = startX + (c / columns) * drawWidth;
                  for (let b = 0; b < bands; b += 1) {
                    const level = spectrum.data[c * bands + b] / 255;
                    if (level < 0.02) continue;
                    const rgb = spectrumColorRgb(level);
                    ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
                    ctx.fillRect(x, RULER_H + 3 + (bands - 1 - b) * bandHeight, columnWidth, bandHeight + 1);
                  }
                }
              }
              drawClipLabel(clip, startX, endX);
              return;
            }

            if (!wave || !wave.peaks || wave.peaks.length === 0 || duration <= 0) return;
            drew = true;
            const peaks = wave.peaks;
            const bins = peaks.length;
            const sampleDuration = wave.duration && wave.duration > 0 ? wave.duration : duration;
            const midY = RULER_H + WAVE_H / 2;
            const amplitude = WAVE_H / 2 - 5;
            ctx.fillStyle = bandColors[index % bandColors.length];
            const fromPx = Math.max(0, Math.floor(startX - timeLeft));
            const toPx = Math.min(timeWidth, Math.ceil(endX - timeLeft));
            for (let px = fromPx; px < toPx; px += 1) {
              const time = timeForX(timeLeft + px, currentView) - offset;
              if (time < 0 || time > sampleDuration) continue;
              const bin = Math.min(bins - 1, Math.max(0, Math.floor((time / sampleDuration) * bins)));
              const h2 = Math.max(0.5, peaks[bin] * amplitude);
              ctx.fillRect(timeLeft + px, midY - h2, 1, h2 * 2);
            }
            drawClipLabel(clip, startX, endX);
          });

          if (!drew && currentClips.length === 0) {
            ctx.fillStyle = colors.labelSecondary;
            ctx.font = '11px sans-serif';
            ctx.fillText(
              waveStatusRef.current === 'loading' ? t('waveLoading') : waveStatusRef.current === 'error' ? t('waveUnavailable') : t('audioMissing'),
              timeLeft + 10,
              RULER_H + WAVE_H / 2,
            );
          } else if (!drew && currentClips.length > 0) {
            ctx.fillStyle = colors.labelSecondary;
            ctx.font = '11px sans-serif';
            const message =
              mode === 'spectrum'
                ? waveStatusRef.current === 'loading'
                  ? t('spectrumLoading')
                  : t('spectrumUnavailable')
                : waveStatusRef.current === 'loading'
                  ? t('waveLoading')
                  : waveStatusRef.current === 'error'
                    ? t('waveUnavailable')
                    : '';
            ctx.fillText(message, timeLeft + 10, RULER_H + WAVE_H / 2);
          }
          ctx.restore();
        }

        // --- Lane rows, their elements and notes ----------------------------
        function paintRows() {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, headerH, width, height - headerH);
          ctx.clip();
          const currentRows = rowsRef.current;
          currentRows.forEach((row, rowIndex) => {
            const rowH = rowHeight(row);
            const top = rowTop(rowIndex, currentView);
            if (top > height || top + rowH < headerH) return;
            if (row && row.kind === 'group') paintGroupRow(row, rowIndex, top, rowH);
            else if (row && row.audioRow) paintAudioRow(row, rowIndex, top, rowH);
            else paintLaneRow(row, rowIndex, top, rowH);
          });
          ctx.restore();
        }

        /** One collapsible staff (谱表) header row. */
        function paintGroupRow(row, rowIndex, top, rowH) {
          const activeFocus = activeStaff && row.staffId === activeStaff;
          const hovered = hoverRef.current && hoverRef.current.rowIndex === rowIndex;
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(0, top, width, rowH);
          ctx.fillStyle = 'rgba(255,255,255,0.09)';
          ctx.fillRect(0, top, GUTTER_W, rowH);
          if (activeFocus) {
            ctx.fillStyle = 'rgba(91,140,255,0.16)';
            ctx.fillRect(0, top, width, rowH);
          } else if (hovered) {
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(0, top, width, rowH);
          }
          ctx.strokeStyle = 'rgba(170,180,200,0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(top) + 0.5);
          ctx.lineTo(width, Math.round(top) + 0.5);
          ctx.stroke();

          // Gutter: chevron, staff name and class name.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, top, width, rowH);
          ctx.clip();
          ctx.textBaseline = 'middle';
          const cx = 13;
          const cy = top + rowH / 2;
          ctx.fillStyle = colors.labelSecondary;
          ctx.beginPath();
          if (row.collapsed) {
            ctx.moveTo(cx - 3, cy - 4.5);
            ctx.lineTo(cx + 3.5, cy);
            ctx.lineTo(cx - 3, cy + 4.5);
          } else {
            ctx.moveTo(cx - 4.5, cy - 2.5);
            ctx.lineTo(cx + 4.5, cy - 2.5);
            ctx.lineTo(cx, cy + 3.5);
          }
          ctx.closePath();
          ctx.fill();
          // Name + class name share the gutter with a hard pixel budget, so
          // they are ellipsized instead of running into each other or into
          // the time area.
          const nameX = 24;
          const nameBudget = GUTTER_W - 6 - nameX;
          ctx.fillStyle = colors.labelPrimary;
          ctx.font = '600 12px sans-serif';
          const groupName = fitText(ctx, row.label || row.staffId, nameBudget);
          ctx.fillText(groupName, nameX, cy);
          const groupNameWidth = ctx.measureText(groupName).width;
          if (row.sublabel) {
            const subX = nameX + groupNameWidth + 7;
            const subBudget = GUTTER_W - 6 - subX;
            if (subBudget >= 28) {
              ctx.fillStyle = colors.labelSecondary;
              ctx.font = '10px sans-serif';
              ctx.fillText(fitText(ctx, row.sublabel, subBudget), subX, cy + 0.5);
            }
          }
          ctx.restore();

          // Counts live in the time column (header band only), never over the
          // staff name.
          ctx.save();
          ctx.beginPath();
          ctx.rect(GUTTER_W, top, Math.max(0, width - GUTTER_W), rowH);
          ctx.clip();
          ctx.fillStyle = colors.labelSecondary;
          ctx.font = '9.5px sans-serif';
          ctx.textBaseline = 'middle';
          const countsText = row.audioGroup
            ? t('audioPeriods') + ' ' + row.noteCount
            : t('lanes') + ' ' + row.laneCount + ' · ' + t('notes') + ' ' + row.noteCount;
          ctx.fillText(fitText(ctx, countsText, width - GUTTER_W - 20), GUTTER_W + 10, cy);
          ctx.restore();
        }

        /** One audio period (乐段): a clip bar that can be dragged in time. */
        function paintAudioRow(row, rowIndex, top, rowH) {
          const clip = row.clip || {};
          const activeFocus = activeStaff && row.staffId === activeStaff;
          ctx.fillStyle = rowIndex % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.06)';
          ctx.fillRect(0, top, width, rowH);
          if (activeFocus) {
            ctx.fillStyle = 'rgba(91,140,255,0.08)';
            ctx.fillRect(0, top, width, rowH);
          }
          // Gutter label: name + method.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, top, GUTTER_W, rowH);
          ctx.clip();
          ctx.textBaseline = 'middle';
          ctx.fillStyle = clip.missing ? '#ff8a8a' : colors.labelPrimary;
          ctx.font = '11px sans-serif';
          const gutterLabel = clip.name || clip.method || clip.relativePath || t('audioPeriods');
          ctx.fillStyle = colors.labelSecondary;
          ctx.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillText(formatTime(clip.offset || 0), 10, top + rowH / 2);
          ctx.fillStyle = clip.missing ? '#ff8a8a' : colors.labelPrimary;
          ctx.font = '11px sans-serif';
          ctx.fillText(fitText(ctx, gutterLabel, GUTTER_W - 60), 56, top + rowH / 2);
          ctx.restore();

          // Clip bar in the time column.
          const drag = dragRef.current && dragRef.current.mode === 'audio' && dragRef.current.clip === clip ? dragRef.current : null;
          const offset = Math.max(0, (Number.isFinite(clip.offset) ? clip.offset : 0) + (drag ? drag.delta : 0));
          const length = Number.isFinite(clip.duration) ? clip.duration : 0;
          const barTop = top + 6;
          const barH = rowH - 12;
          const barX = xForTime(offset, currentView);
          const barW = Math.max(6, length * currentView.pps);
          ctx.save();
          ctx.beginPath();
          ctx.rect(timeLeft, top, Math.max(0, width - timeLeft), rowH);
          ctx.clip();
          const band = drag ? 'rgba(56,232,196,0.42)' : 'rgba(56,232,196,0.26)';
          ctx.fillStyle = clip.missing ? 'rgba(255,110,110,0.26)' : band;
          ctx.fillRect(barX, barTop, barW, barH);
          ctx.strokeStyle = clip.missing ? 'rgba(255,120,120,0.85)' : 'rgba(56,232,196,0.85)';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(barX) + 0.5, Math.round(barTop) + 0.5, Math.max(1, Math.round(barW) - 1), barH - 1);
          ctx.fillStyle = clip.missing ? '#ffd0d0' : colors.labelPrimary;
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textBaseline = 'middle';
          const label = clip.missing
            ? t('audioPeriodMissing')
            : (drag ? '⏱ ' : '') + formatTime(offset) + (length > 0 ? ' · ' + formatTime(length) : '');
          ctx.fillStyle = clip.missing ? '#ffb0b0' : colors.labelPrimary;
          ctx.fillText(fitText(ctx, label, Math.max(0, Math.min(barW, width - timeLeft) - 10)), barX + 5, barTop + barH / 2);
          ctx.restore();
        }

        /** One lane row: stripe, gutter label, lane bars and its notes. */
        function paintLaneRow(row, rowIndex, top, rowH) {
          const activeFocus = activeStaff && row.staffId === activeStaff;
          const stripe = rowIndex % 2 === 0;
          ctx.fillStyle = stripe ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.06)';
          ctx.fillRect(0, top, width, rowH);
          if (activeFocus) {
            ctx.fillStyle = 'rgba(91,140,255,0.06)';
            ctx.fillRect(0, top, width, rowH);
          }
          if (hoverRef.current && hoverRef.current.rowIndex === rowIndex) {
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            ctx.fillRect(0, top, width, rowH);
          }
          ctx.strokeStyle = 'rgba(120,130,150,0.12)';
          ctx.beginPath();
          ctx.moveTo(0, Math.round(top + rowH) + 0.5);
          ctx.lineTo(width, Math.round(top + rowH) + 0.5);
          ctx.stroke();

          // Gutter label: a type dot plus the lane name (the staff name lives
          // in the group header above).
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, top, GUTTER_W, rowH);
          ctx.clip();
          ctx.textBaseline = 'middle';
          const firstLaneElement = (row.laneElements && row.laneElements[0]) || row.laneElement || null;
          const rowColor = firstLaneElement ? elementColor(catalog, firstLaneElement.type) : 'rgba(150,160,180,0.55)';
          ctx.fillStyle = rowColor;
          ctx.beginPath();
          ctx.arc(12, top + rowH / 2, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = colors.labelPrimary;
          ctx.font = '11.5px sans-serif';
          const laneLabel = row.misc ? t('miscRow') : row.lane || t('laneOrphan');
          ctx.fillText(fitText(ctx, laneLabel, GUTTER_W - 22 - 8), 22, top + rowH / 2);
          ctx.restore();

          // Lane bodies (every lane element that carries this row's name).
          const laneElementsOnRow = row.laneElements || (row.laneElement ? [row.laneElement] : []);
          laneElementsOnRow.forEach((laneElement, laneIndex) => paintLaneBar(laneElement, laneIndex, laneElementsOnRow.length, top, rowH));

          paintRowNotes(row, top, rowH);
        }

        /** One lane element bar on a row (multiple periods can share a name). */
        function paintLaneBar(laneElement, laneIndex, laneElementCount, top, rowH) {
          // A lane element is a normal draggable element, so it must honour the
          // in-flight drag exactly like notes do. Without this preview the bar
          // sits still under the pointer and only jumps to the new time on
          // release, which reads as "it moves but does not follow the mouse".
          const drag = dragRef.current;
          const dragged = drag && drag.mode === 'move' && drag.ids && drag.ids.indexOf(laneElement.id) !== -1;
          const resized = drag && drag.mode === 'resize' && drag.ids && drag.ids.indexOf(laneElement.id) !== -1;
          let laneStart = laneElement.start || 0;
          let durationValue = Number.isFinite(laneElement.duration) ? laneElement.duration : null;
          if (dragged) laneStart += drag.delta;
          if (resized && durationValue !== null) durationValue = Math.max(0, durationValue + drag.delta);
          const laneEnd = durationValue === null ? laneStart + 0.05 : laneStart + durationValue;
          const x0 = Math.max(timeLeft, xForTime(laneStart, currentView));
          const x1 = Math.min(width, xForTime(laneEnd, currentView));
          if (x1 <= x0) return;
          const color = elementColor(catalog, laneElement.type);
          const barTop = top + 3;
          const barHeight = rowH - 6;
          const barWidth = x1 - x0;
          const radius = Math.min(7, barHeight / 2, barWidth / 2);
          // Rounded lane strip: a click target for the lane itself and a
          // double-click target for the judgement-line note editor.
          noteRoundedPath(ctx, x0, barTop, barWidth, barHeight, radius);
          ctx.fillStyle = color + (laneIndex === 0 ? '1f' : '12');
          ctx.fill();
          ctx.strokeStyle = color + (laneIndex === 0 ? '77' : '44');
          ctx.lineWidth = 1;
          ctx.stroke();
          if (selectionRef.current.indexOf(laneElement.id) !== -1) {
            noteRoundedPath(ctx, x0 + 1, barTop + 1, Math.max(1, barWidth - 2), Math.max(1, barHeight - 2), Math.max(1, radius - 1));
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          // Type label lives INSIDE its bar: clipped to the bar rect and
          // ellipsized to the bar width, so a short bar never spills text over
          // its neighbours (most Dremu lanes are ~50 px wide at 1x zoom).
          if (laneIndex !== 0) return;
          const labelBudget = barWidth - 26;
          // Below ~70 px there is no room for anything readable: the bar's
          // colour + the gutter row already identify it, and the hover
          // tooltip shows the type, so draw nothing rather than noise.
          if (labelBudget < 44) return;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, barTop, barWidth, barHeight);
          ctx.clip();
          // Small lane-colour dot before the type name (the reference strip).
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x0 + 10, top + rowH / 2, 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = colors.labelPrimary;
          ctx.font = '10.5px sans-serif';
          ctx.textBaseline = 'middle';
          const label = laneElementCount > 1 ? shortType(laneElement.type) + ' ×' + laneElementCount : shortType(laneElement.type);
          ctx.fillText(fitText(ctx, label, labelBudget), x0 + 18, top + rowH / 2);
          ctx.restore();
        }

        /** Every note / element on one row, including drag-time previews. */
        function paintRowNotes(row, top, rowH) {
          const selectedIds = selectionRef.current;
          const drag = dragRef.current;
          const visibleFrom = currentView.t0 - 4;
          const visibleTo = currentView.t0 + timeWidth / currentView.pps + 4;
          for (const element of row.notes) {
            let start = element.start || 0;
            let duration = element.duration;
            const isSelected = selectedIds.indexOf(element.id) !== -1;
            const dragged = drag && drag.mode === 'move' && drag.ids && drag.ids.indexOf(element.id) !== -1;
            const resized = drag && drag.mode === 'resize' && drag.ids && drag.ids.indexOf(element.id) !== -1;
            if (dragged) start += drag.delta;
            if (resized) duration = Math.max(0, (duration || 0) + drag.delta);
            if (start > visibleTo || start + (duration || 0) < visibleFrom) continue;
            const color = elementColor(catalog, element.type);
            const category = element.category;
            const centerY = top + rowH / 2;
            const x = xForTime(start, currentView);
            if (duration !== null && duration !== undefined && duration > 0) {
              paintTimedElement(element, start, category, x, duration, centerY, color, isSelected);
            } else {
              paintInstantNote(element, category, x, centerY, color, isSelected);
            }
            if (drag && drag.mode === 'resize' && drag.primaryId === element.id && duration !== null && duration !== undefined && duration > 0) {
              const width = Math.max(2, duration * currentView.pps);
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(x + width - 2, centerY - 8, 4, 16);
            }
          }
        }

        /** Hold body / timed element: bar, inner-note ticks and selection. */
        function paintTimedElement(element, start, category, x, duration, centerY, color, isSelected) {
          const width = Math.max(2, duration * currentView.pps);
          ctx.fillStyle = color + 'cc';
          ctx.fillRect(x, centerY - 6, width, 12);
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.fillRect(x, centerY - 6, Math.min(width, 3), 12);
          if (category === 'hold' && Array.isArray(element.fields && element.fields.innerNotes ? element.fields.innerNotes.items : null)) {
            for (const inner of element.fields.innerNotes.items) {
              const innerStart = valueAsNumber(inner && inner.fields ? inner.fields.hitTime : null);
              if (innerStart === null) continue;
              // Inner notes are relative to the hold start.
              const innerX = xForTime(start + innerStart, currentView);
              ctx.fillStyle = 'rgba(255,255,255,0.75)';
              ctx.fillRect(innerX - 1, centerY - 6, 2, 12);
            }
          }
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, centerY - 7, width + 2, 14);
          }
        }

        /** Instant note marker: circle for holds, triangle for drags, diamond otherwise. */
        function paintInstantNote(element, category, x, centerY, color, isSelected) {
          const radius = NOTE_R;
          ctx.beginPath();
          if (category === 'hold') {
            ctx.arc(x, centerY, radius, 0, Math.PI * 2);
          } else if (shortType(element.type).toLowerCase().indexOf('drag') !== -1) {
            ctx.moveTo(x - radius, centerY - radius);
            ctx.lineTo(x, centerY);
            ctx.lineTo(x - radius, centerY + radius);
            ctx.closePath();
          } else {
            ctx.moveTo(x, centerY - radius);
            ctx.lineTo(x + radius, centerY);
            ctx.lineTo(x, centerY + radius);
            ctx.lineTo(x - radius, centerY);
            ctx.closePath();
          }
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.42)';
          ctx.stroke();
        }

        // --- Fixed chrome: header line and gutter divider -------------------
        function paintHeaderDivider() {
          ctx.strokeStyle = colors.border;
          ctx.beginPath();
          ctx.moveTo(0, headerH + 0.5);
          ctx.lineTo(width, headerH + 0.5);
          ctx.stroke();
        }

        function paintGutterDivider() {
          ctx.strokeStyle = colors.border;
          ctx.beginPath();
          ctx.moveTo(GUTTER_W + 0.5, 0);
          ctx.lineTo(GUTTER_W + 0.5, height);
          ctx.stroke();
        }

        function paintPlayhead() {
          const playheadX = xForTime(transportRef.current.time, currentView);
          if (playheadX < timeLeft - 1 || playheadX > width) return;
          ctx.strokeStyle = '#ff5f7a';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(playheadX, 0);
          ctx.lineTo(playheadX, height);
          ctx.stroke();
          ctx.fillStyle = '#ff5f7a';
          ctx.beginPath();
          ctx.moveTo(playheadX - 5, 0);
          ctx.lineTo(playheadX + 5, 0);
          ctx.lineTo(playheadX, 8);
          ctx.closePath();
          ctx.fill();
        }

        function paintBoxSelection() {
          const drag = dragRef.current;
          if (!drag || drag.mode !== 'box' || !drag.box) return;
          const box = drag.box;
          ctx.fillStyle = 'rgba(91,140,255,0.16)';
          ctx.strokeStyle = colors.brand;
          ctx.lineWidth = 1;
          const bx = Math.min(box.x0, box.x1);
          const by = Math.min(box.y0, box.y1);
          const bw = Math.abs(box.x1 - box.x0);
          const bh = Math.abs(box.y1 - box.y0);
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        }

        function paintHoverTooltip() {
          if (!hoverRef.current || !hoverRef.current.element) return;
          const element = hoverRef.current.element;
          const laneHint = element.category === 'lane' ? ' · ' + t('noteEditorOpenHint') : '';
          const text = shortType(element.type) + ' · ' + formatTime(element.start || 0) + (element.lane ? ' · ' + element.lane : '') + laneHint;
          ctx.font = '11px sans-serif';
          const textWidth = ctx.measureText(text).width + 12;
          let bx = hoverRef.current.x + 10;
          if (bx + textWidth > width - 6) bx = hoverRef.current.x - textWidth - 10;
          const by = clamp(hoverRef.current.y - 22, 2, height - 24);
          ctx.fillStyle = 'rgba(0,0,0,0.78)';
          ctx.fillRect(bx, by, textWidth, 18);
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, bx + 6, by + 9);
        }

        function paintEmptyState() {
          if (rowsRef.current.length !== 0) return;
          ctx.fillStyle = colors.labelSecondary;
          ctx.font = '12px sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(t('timelineEmpty'), GUTTER_W + 16, headerH + 30);
        }
      }, [activeStaff, catalog, gridStep, headerH, rowTop, t, timeForX, waveMode, xForTime]);

      // Redraw on any relevant change.
      useEffect(() => {
        paint();
      }, [paint, view, size, rows, selection, hover, project, waves, waveStatus, audioClips, waveMode, follow]);

      // Playhead animation while playing (no React re-render per frame).
      useEffect(() => {
        if (!transport.playing) {
          paint();
          return undefined;
        }
        let frame = 0;
        const loop = () => {
          paint();
          if (follow) {
            const currentView = viewRef.current;
            const currentSize = sizeRef.current;
            const time = transportRef.current.time;
            const visibleFrom = currentView.t0;
            const visibleTo = currentView.t0 + Math.max(1, currentSize.w - GUTTER_W) / currentView.pps;
            if (time < visibleFrom || time > visibleTo - 0.02) {
              setView((previous) => Object.assign({}, previous, { t0: Math.max(0, time - 0.15 * (visibleTo - visibleFrom)) }));
            } else {
              paint();
            }
          }
          frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
        return () => {
          if (frame) cancelAnimationFrame(frame);
        };
      }, [transport.playing, follow, paint]);

      // --- Pointer/hit helpers ---------------------------------------------
      const localPoint = useCallback((event) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }, []);

      /** Right-click on the audio strip opens the waveform/spectrum switcher. */
      const onWaveContextMenu = useCallback(
        (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          const point = localPoint(event);
          const inStrip = point.y >= RULER_H && point.y <= headerH && point.x >= GUTTER_W;
          if (!inStrip || (audioClipsRef.current || []).length === 0) {
            setWaveMenu(null);
            return;
          }
          const vw = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1200;
          const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
          const clientX = event && Number.isFinite(event.clientX) ? event.clientX : point.x;
          const clientY = event && Number.isFinite(event.clientY) ? event.clientY : point.y;
          setWaveMenu({
            x: clamp(clientX, 8, Math.max(8, vw - 196)),
            y: clamp(clientY, 8, Math.max(8, vh - 118)),
          });
        },
        [headerH, localPoint],
      );

      /** Element at a canvas point (rows area only). */
      const hitTest = useCallback(
        (point) => {
          const currentView = viewRef.current;
          const currentRows = rowsRef.current;
          if (point.y < headerH) return null;
          const rowIndex = rowIndexAt(point.y, currentView);
          if (rowIndex < 0 || rowIndex >= currentRows.length) return null;
          const row = currentRows[rowIndex];
          if (row.kind === 'group') return { row, rowIndex, element: null, group: true };
          if (row.audioRow) {
            const clip = row.clip || null;
            if (!clip || point.x < GUTTER_W) return { row, rowIndex, element: null, audio: true, clip: null };
            const start = Number.isFinite(clip.offset) ? clip.offset : 0;
            const length = Number.isFinite(clip.duration) ? clip.duration : 0;
            const x0 = xForTime(start, currentView);
            const x1 = xForTime(start + length, currentView);
            const hitBar = point.x >= Math.min(x0, x1) - 2 && point.x <= Math.max(x0, x1) + 2;
            return { row, rowIndex, element: null, audio: true, clip: hitBar ? clip : null };
          }
          if (point.x < GUTTER_W) return { row, rowIndex, element: null };
          // Search from the right so later elements win overlaps.
          for (let i = row.notes.length - 1; i >= 0; i -= 1) {
            const element = row.notes[i];
            const box = elementBox(element, rowIndex, currentView);
            if (point.x >= box.x - 2 && point.x <= box.x + box.w + 2 && point.y >= box.y - 2 && point.y <= box.y + box.h + 2) {
              return { row, rowIndex, element, box };
            }
          }
          const time = timeForX(point.x, currentView);
          const laneElementsOnRow = row.laneElements || (row.laneElement ? [row.laneElement] : []);
          for (let i = laneElementsOnRow.length - 1; i >= 0; i -= 1) {
            const laneElement = laneElementsOnRow[i];
            const laneStart = laneElement.start || 0;
            const durationValue = Number.isFinite(laneElement.duration) ? laneElement.duration : null;
            const laneEnd = durationValue === null ? laneStart + 0.05 : laneStart + durationValue;
            if (time >= laneStart - 0.02 && time <= laneEnd + 0.02) {
              return { row, rowIndex, element: laneElement, lane: true, box: elementBox(laneElement, rowIndex, currentView) };
            }
          }
          return { row, rowIndex, element: null };
        },
        [elementBox, headerH, rowIndexAt, timeForX, xForTime],
      );

      /** Start a move of the current selection. */
      const beginMove = useCallback(
        (point, hit, additive) => {
          const id = hit.element.id;
          let ids;
          if (additive) ids = selection.indexOf(id) === -1 ? Array.from(new Set(selection.concat([id]))) : selection;
          else ids = selection.indexOf(id) !== -1 ? selection : [id];
          setSelection(ids);
          const primary = hit.element;
          dragRef.current = {
            mode: 'move',
            ids,
            primaryId: primary.id,
            primaryStart: primary.start || 0,
            delta: 0,
            startX: point.x,
            startY: point.y,
            // Time at pointer-down: converting the pointer through timeForX on
            // every move keeps the drag stable even if the zoom changed.
            anchorTime: timeForX(point.x, viewRef.current),
            moved: false,
          };
        },
        [selection, setSelection, timeForX],
      );

      /** Start a resize when grabbing the right edge of a timed element. */
      const beginResize = useCallback((point, hit) => {
        setSelection([hit.element.id]);
        dragRef.current = {
          mode: 'resize',
          ids: [hit.element.id],
          primaryId: hit.element.id,
          primaryStart: hit.element.start || 0,
          primaryDuration: hit.element.duration || 0,
          delta: 0,
          startX: point.x,
          startY: point.y,
          anchorTime: timeForX(point.x, viewRef.current),
          moved: false,
        };
      }, [setSelection, timeForX]);

      const onPointerDown = useCallback(
        (event) => {
          if (event.button !== 0 && event.button !== 1) return;
          const point = localPoint(event);
          const currentView = viewRef.current;
          canvasRef.current && canvasRef.current.focus && canvasRef.current.focus();
          // Capture immediately: scrubbing and panning must survive the pointer
          // leaving the canvas.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch (error) {
            /* ignore */
          }
          if (event.button === 1 || event.altKey) {
            dragRef.current = { mode: 'pan', startX: point.x, startY: point.y, t0: currentView.t0, scrollY: currentView.scrollY };
            event.preventDefault();
            return;
          }
          if (point.y < headerH) {
            // Scrub.
            dragRef.current = { mode: 'scrub', startX: point.x, startY: point.y };
            transport.seek(Math.max(0, timeForX(point.x, currentView)));
            event.preventDefault();
            return;
          }
          const hit = hitTest(point);
          if (hit && hit.group) {
            // Clicking a 谱表 header collapses/expands its lanes.
            const staffId = hit.row.staffId;
            setCollapsedStaffs((current) => {
              const next = new Set(current);
              if (next.has(staffId)) next.delete(staffId);
              else next.add(staffId);
              return next;
            });
            setHover(null);
            return;
          }
          if (hit && hit.audio) {
            if (hit.clip) {
              dragRef.current = {
                mode: 'audio',
                clip: hit.clip,
                staffId: hit.row.staffId,
                primaryOffset: Number.isFinite(hit.clip.offset) ? hit.clip.offset : 0,
                delta: 0,
                startX: point.x,
                startY: point.y,
                anchorTime: timeForX(point.x, currentView),
                moved: false,
              };
            }
            return;
          }
          if (hit && hit.element) {
            const box = hit.box || elementBox(hit.element, hit.rowIndex, currentView);
            // Only a real right-edge handle resizes: a narrow element must stay
            // draggable, so the handle needs ~6 px and the box ~16 px.
            const boxWidth = box ? box.w : 0;
            const handleSize = Math.min(6, Math.max(3, boxWidth / 3));
            const nearRightEdge = hit.element.duration > 0 && boxWidth >= 16 && point.x >= box.x + boxWidth - handleSize;
            if (nearRightEdge) {
              beginResize(point, hit);
            } else {
              beginMove(point, hit, event.shiftKey || event.metaKey || event.ctrlKey);
            }
          } else {
            if (!event.shiftKey && !event.metaKey && !event.ctrlKey) setSelection([]);
            dragRef.current = {
              mode: 'box',
              box: { x0: point.x, y0: point.y, x1: point.x, y1: point.y },
              additive: event.shiftKey || event.metaKey || event.ctrlKey,
              startX: point.x,
              startY: point.y,
              moved: false,
            };
          }
        },
        [beginMove, beginResize, elementBox, headerH, hitTest, localPoint, setSelection, timeForX, transport],
      );

      const onPointerMove = useCallback(
        (event) => {
          const point = localPoint(event);
          const drag = dragRef.current;
          const currentView = viewRef.current;
          if (!drag) {
            const hit = hitTest(point);
            const next =
              hit && hit.element
                ? { rowIndex: hit.rowIndex, element: hit.element, x: point.x, y: point.y, lane: hit.lane }
                : hit
                  ? { rowIndex: hit.rowIndex, element: null }
                  : null;
            const currentId = hover && hover.element ? hover.element.id : null;
            const nextId = next && next.element ? next.element.id : null;
            const currentRow = hover ? hover.rowIndex : -1;
            const nextRow = next ? next.rowIndex : -1;
            if (currentId !== nextId || currentRow !== nextRow) setHover(next);
            return;
          }
          if (drag.mode === 'scrub') {
            transport.seek(Math.max(0, timeForX(point.x, currentView)));
            return;
          }
          if (drag.mode === 'pan') {
            setView((previous) =>
              Object.assign({}, previous, {
                t0: Math.max(0, drag.t0 - (point.x - drag.startX) / previous.pps),
                scrollY: Math.max(0, drag.scrollY - (point.y - drag.startY)),
              }),
            );
            return;
          }
          if (drag.mode === 'box') {
            drag.box.x1 = point.x;
            drag.box.y1 = point.y;
            drag.moved = drag.moved || Math.abs(point.x - drag.startX) > 3 || Math.abs(point.y - drag.startY) > 3;
            paint();
            return;
          }
          const deltaX = point.x - drag.startX;
          const deltaTime = timeForX(point.x, currentView) - (drag.anchorTime === undefined ? timeForX(drag.startX, currentView) : drag.anchorTime);
          if (Math.abs(deltaX) > 2) drag.moved = true;
          if (drag.mode === 'audio') {
            const target = snapTime(drag.primaryOffset + deltaTime, tempoRef.current, snapDiv, snapOn);
            drag.delta = Math.max(-drag.primaryOffset, target - drag.primaryOffset);
            paint();
            return;
          }
          if (drag.mode === 'move') {
            const target = snapTime(drag.primaryStart + deltaTime, tempoRef.current, snapDiv, snapOn);
            drag.delta = target - drag.primaryStart;
            paint();
            return;
          }
          if (drag.mode === 'resize') {
            const targetEnd = snapTime(drag.primaryStart + drag.primaryDuration + deltaTime, tempoRef.current, snapDiv, snapOn);
            drag.delta = Math.max(-drag.primaryDuration, targetEnd - (drag.primaryStart + drag.primaryDuration));
            paint();
          }
        },
        [hitTest, hover, localPoint, paint, snapDiv, snapOn, timeForX, transport],
      );

      const onPointerUp = useCallback(
        (event) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* ignore */
          }
          const currentView = viewRef.current;
          if (drag.mode === 'box') {
            const box = drag.box;
            const currentRows = rowsRef.current;
            const ids = [];
            currentRows.forEach((row, rowIndex) => {
              if (row.kind === 'group') return;
              const rowH = rowHeight(row);
              const top = headerH + (layoutRef.current.tops[rowIndex] || 0) - currentView.scrollY;
              if (top + rowH < Math.min(box.y0, box.y1) || top > Math.max(box.y0, box.y1)) return;
              const minX = Math.min(box.x0, box.x1);
              const maxX = Math.max(box.x0, box.x1);
              for (const element of row.notes) {
                const elementXBox = elementBox(element, rowIndex, currentView);
                if (elementXBox.x + elementXBox.w < minX || elementXBox.x > maxX) continue;
                ids.push(element.id);
              }
              if (row.laneElement) {
                const laneBox = elementBox(row.laneElement, rowIndex, currentView);
                if (laneBox.x + laneBox.w >= minX && laneBox.x <= maxX) ids.push(row.laneElement.id);
              }
            });
            if (ids.length > 0) {
              setSelection(drag.additive ? Array.from(new Set(selection.concat(ids))) : ids);
            }
            paint();
            return;
          }
          if (drag.mode === 'audio') {
            if (drag.moved && Math.abs(drag.delta) > 1e-9) {
              const next = round(Math.max(0, drag.primaryOffset + drag.delta), 6);
              onEdit([
                {
                  op: 'patchAudioPeriod',
                  staffId: drag.clip.staffId || drag.staffId,
                  audioPeriodId: drag.clip.id,
                  fields: { timeOffset: next },
                },
              ]);
            }
            paint();
            return;
          }
          if (drag.mode === 'move' && drag.moved && Math.abs(drag.delta) > 1e-9) {
            const ops = [];
            for (const id of drag.ids) {
              const found = findElement(project, id);
              if (!found) continue;
              const startField = resolveStartField(catalog, found.element);
              if (!startField) continue;
              const current = valueAsNumber(found.element.fields[startField]);
              if (current === null) continue;
              ops.push({ op: 'patch', elementId: id, path: [startField], value: round(current + drag.delta, 6) });
            }
            if (ops.length > 0) onEdit(ops);
          } else if (drag.mode === 'resize' && drag.moved && Math.abs(drag.delta) > 1e-9) {
            const found = findElement(project, drag.primaryId);
            if (found) {
              const durationField = resolveDurationField(catalog, found.element);
              if (durationField) {
                const current = valueAsNumber(found.element.fields[durationField]) || 0;
                const next = Math.max(0, round(current + drag.delta, 6));
                if (Math.abs(next - current) > 1e-9) {
                  onEdit([{ op: 'patch', elementId: drag.primaryId, path: [durationField], value: next }]);
                }
              }
            }
          }
          paint();
        },
        [catalog, elementBox, headerH, onEdit, paint, project, selection, setSelection, xForTime],
      );

      /** Pointer cancel aborts the gesture instead of committing it. */
      const onPointerCancel = useCallback(
        (event) => {
          dragRef.current = null;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch (error) {
            /* ignore */
          }
          paint();
        },
        [paint],
      );

      /** Double-click on empty space places the current tool. */
      const onDoubleClick = useCallback(
        (event) => {
          const point = localPoint(event);
          if (point.y < headerH) return;
          const currentView = viewRef.current;
          const currentRows = rowsRef.current;
          const rowIndex = rowIndexAt(point.y, currentView);
          const row = currentRows[rowIndex];
          if (row && row.audioRow && row.clip) {
            transport.seek(Math.max(0, row.clip.offset || 0));
            return;
          }
          if (!row || row.kind === 'group') return;
          const openNoteEditor = () => {
            if (typeof onOpenNoteEditor !== 'function' || !row.lane) return false;
            onOpenNoteEditor({ staffId: row.staffId, lane: row.lane, laneElement: (row.laneElements && row.laneElements[0]) || row.laneElement || null });
            return true;
          };
          // The gutter label is a mode-independent shortcut; the lane bar is
          // the reference double-click target while the select tool is active
          // (with a placement tool the historical "double-click to place"
          // behavior is preserved below).
          if (point.x < GUTTER_W) {
            openNoteEditor();
            return;
          }
          const hitNow = hitTest(point);
          if (hitNow && hitNow.element && hitNow.element.category !== 'lane') return;
          if (tool === 'select') {
            if (hitNow && hitNow.lane) openNoteEditor();
            return;
          }
          // The lane's label area doubles as an explicit editor target while a
          // placement tool is active; the rest of the strip keeps placing.
          if (hitNow && hitNow.lane && hitNow.box && point.x <= hitNow.box.x + 110) {
            openNoteEditor();
            return;
          }
          const type = typeForTool(catalog, tool);
          if (!row || row.kind === 'group' || !type) return;
          const time = Math.max(0, snapTime(timeForX(point.x, currentView), tempoRef.current, snapDiv, snapOn));
          const staffId = row.staffId;
          const periodId = pickPeriod(project, staffId, time);
          const staff = (project.staffs || []).find((item) => item.id === staffId);
          const period = staff && (staff.periods || []).find((item) => item.id === periodId);
          if (!period) {
            onNotice({ kind: 'error', text: t('errorGeneric') });
            return;
          }
          const periodOffset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
          const entry = catalogEntry(catalog, type);
          const timing = (entry && entry.timing) || {};
          const fields = fieldsForNewElement(catalog, type);
          if (entry && entry.category === 'lane') {
            fields.name = uniqueLaneName(project, staffId);
            if (fields[timing.start || 'generateTime'] !== undefined) fields[timing.start || 'generateTime'] = round(time - periodOffset, 6);
            if (fields.keepTime !== undefined) fields.keepTime = 8;
          } else {
            const startField = timing.start || 'hitTime';
            fields[startField] = round(time - periodOffset, 6);
            if (row.lane) fields[timing.lane || 'laneName'] = row.lane;
            if (fields.keepTime !== undefined) fields.keepTime = 1;
            if (fields.holdTime !== undefined) fields.holdTime = 1;
          }
          const id = makeElementId(periodId);
          onEdit([{ op: 'add', staffId, periodId, element: { id, type, fields } }]);
          setSelection([id]);
          setTool('select');
        },
        [catalog, headerH, hitTest, localPoint, onEdit, onNotice, onOpenNoteEditor, project, rowIndexAt, setSelection, setTool, snapDiv, snapOn, t, timeForX, tool, transport],
      );

      /** Wheel: zoom (ctrl), pan time (shift), scroll rows (default). */
      const onWheel = useCallback(
        (event) => {
          if (dragRef.current) return;
          const point = localPoint(event);
          const currentView = viewRef.current;
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const factor = Math.exp(-event.deltaY * 0.0015);
            const nextPps = clamp(currentView.pps * factor, MIN_PPS, MAX_PPS);
            const anchorTime = timeForX(Math.max(GUTTER_W, point.x), currentView);
            setView((previous) => {
              const t0 = anchorTime - (Math.max(GUTTER_W, point.x) - GUTTER_W) / nextPps;
              return { t0: Math.max(0, t0), pps: nextPps, scrollY: previous.scrollY };
            });
            return;
          }
          if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            event.preventDefault();
            const delta = (event.shiftKey ? event.deltaY : event.deltaX) / currentView.pps;
            setView((previous) => Object.assign({}, previous, { t0: Math.max(0, previous.t0 + delta) }));
            return;
          }
          const currentSize = sizeRef.current;
          const maxScroll = Math.max(0, layoutRef.current.total - Math.max(0, currentSize.h - headerH));
          if (maxScroll <= 0) return;
          event.preventDefault();
          setView((previous) => Object.assign({}, previous, { scrollY: clamp(previous.scrollY + event.deltaY, 0, maxScroll) }));
        },
        [headerH, localPoint, timeForX],
      );

      // Expose zoom helpers to the toolbar via props callbacks.
      useEffect(() => {
        if (props.onReady) {
          props.onReady({
            zoomIn: () => setView((previous) => Object.assign({}, previous, { pps: clamp(previous.pps * 1.3, MIN_PPS, MAX_PPS) })),
            zoomOut: () => setView((previous) => Object.assign({}, previous, { pps: clamp(previous.pps / 1.3, MIN_PPS, MAX_PPS) })),
            fit: () => {
              const currentSize = sizeRef.current;
              const duration = Math.max(1, (projectRef.current && projectRef.current.duration) || 30);
              const width = Math.max(120, currentSize.w - GUTTER_W - 24);
              setView({ t0: 0, pps: clamp(width / duration, MIN_PPS, MAX_PPS), scrollY: 0 });
            },
            scrollBy: (delta) => {
              if (!Number.isFinite(delta)) return;
              setView((previous) => Object.assign({}, previous, { t0: Math.max(0, previous.t0 + delta) }));
            },
            setT0: (t0) => {
              if (!Number.isFinite(t0)) return;
              setView((previous) => Object.assign({}, previous, { t0: Math.max(0, t0) }));
            },
            zoomAt: (factor, time, x) => {
              if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(time)) return;
              setView((previous) => {
                const nextPps = clamp(previous.pps * factor, MIN_PPS, MAX_PPS);
                const px = Number.isFinite(x) ? x : GUTTER_W;
                const t0 = Math.max(0, time - (px - GUTTER_W) / nextPps);
                return { t0, pps: nextPps, scrollY: previous.scrollY };
              });
            },
            center: (time) => {
              const currentSize = sizeRef.current;
              const width = Math.max(120, currentSize.w - GUTTER_W);
              setView((previous) => Object.assign({}, previous, { t0: Math.max(0, time - width / previous.pps / 2) }));
            },
            reveal: (time) => {
              const currentSize = sizeRef.current;
              const visible = Math.max(120, currentSize.w - GUTTER_W);
              const from = viewRef.current.t0;
              const to = from + visible / viewRef.current.pps;
              if (time < from || time > to) {
                setView((previous) => Object.assign({}, previous, { t0: Math.max(0, time - visible / previous.pps / 3) }));
              }
            },
            viewRef,
          });
        }
      }, [props.onReady]);

      return h(
        'div',
        { className: 'dgc-canvasWrap', ref: wrapRef },
        h('canvas', {
          ref: canvasRef,
          className: 'dgc-canvas',
          tabIndex: 0,
          style: { cursor: tool !== 'select' ? 'crosshair' : hover && hover.lane ? 'pointer' : 'default' },
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerCancel,
          onPointerLeave: () => {
            if (!dragRef.current) setHover(null);
          },
          onDoubleClick,
          onWheel,
          onContextMenu: onWaveContextMenu,
          'aria-label': t('timeline'),
        }),
        waveMenu
          ? h(WaveformContextMenu, {
              key: 'wave-menu',
              t,
              x: waveMenu.x,
              y: waveMenu.y,
              mode: waveMode,
              onSelect: selectWaveMode,
              onClose: () => setWaveMenu(null),
            })
          : null,
      );
    }

    // ========================================================================
    // 15.5 · Judgement-line note editor.
    //
    // The timeline edits time horizontally, one row per lane. This view flips
    // the axes for one lane: time is vertical (future above a fixed judgement
    // line), the note's `position` is horizontal, and the audio spectrum runs
    // down the far-left edge. It is a pure client-side view: every gesture
    // mutates the same element fields (hitTime / position / holdTime) through
    // the existing `add` / `patch` ops.
    // ========================================================================

    const NOTE_SPECTRUM_W = 54;
    const NOTE_RULER_W = 46;
    const NOTE_RIGHT_PAD = 18;
    /** World units shown from the centre to either side (±5.75). */
    const NOTE_WORLD_HALF = 5.75;
    /** Horizontal snapping step and the usable position range. */
    const NOTE_POS_STEP = 0.5;
    const NOTE_POS_LIMIT = 5.5;
    /** Note sprite width in world units (matches the playback renderer). */
    const NOTE_NOTE_WORLD = 2.0;
    const NOTE_CHIP_H = 17;
    const NOTE_PPS_DEFAULT = 160;
    const NOTE_PPS_MIN = 40;
    const NOTE_PPS_MAX = 900;

    /** Layout of the vertical editor for one canvas size. */
    function noteEditorLayout(width, height) {
      const w = Math.max(160, Math.round(Number.isFinite(width) ? width : 800));
      const h = Math.max(140, Math.round(Number.isFinite(height) ? height : 420));
      const spectrumW = Math.min(NOTE_SPECTRUM_W, Math.max(34, Math.round(w * 0.08)));
      const rulerW = Math.min(NOTE_RULER_W, Math.max(28, Math.round(w * 0.06)));
      const rightPad = Math.min(NOTE_RIGHT_PAD, Math.max(10, Math.round(w * 0.03)));
      const left = spectrumW + rulerW;
      const laneW = Math.max(60, w - left - rightPad);
      const judgeGap = clamp(Math.round(h * 0.12), 48, 112);
      const chipW = clamp((NOTE_NOTE_WORLD / (NOTE_WORLD_HALF * 2)) * laneW, 36, 156);
      return {
        w,
        h,
        spectrumW,
        rulerW,
        left,
        laneW,
        right: left + laneW,
        judgeY: h - judgeGap,
        judgeGap,
        chipW,
      };
    }

    /** World position -> canvas x. */
    function notePositionToX(position, layout) {
      const value = Number.isFinite(position) ? position : 0;
      return layout.left + ((value + NOTE_WORLD_HALF) / (NOTE_WORLD_HALF * 2)) * layout.laneW;
    }

    /** Canvas x -> world position (unclamped; callers may clamp). */
    function noteXToPosition(x, layout) {
      return ((x - layout.left) / Math.max(1, layout.laneW)) * (NOTE_WORLD_HALF * 2) - NOTE_WORLD_HALF;
    }

    /** Absolute time -> canvas y (future is above the fixed judgement line). */
    function noteTimeToY(time, anchorTime, pps, layout) {
      return layout.judgeY - (time - anchorTime) * pps;
    }

    /** Canvas y -> absolute time. */
    function noteYToTime(y, anchorTime, pps, layout) {
      return anchorTime + (layout.judgeY - y) / Math.max(1e-6, pps);
    }

    /** Snap a horizontal position to the 0.5 column grid. */
    function snapNotePosition(position, enabled) {
      const value = clamp(Number.isFinite(position) ? position : 0, -NOTE_POS_LIMIT, NOTE_POS_LIMIT);
      if (!enabled) return value;
      return clamp(Math.round(value / NOTE_POS_STEP) * NOTE_POS_STEP, -NOTE_POS_LIMIT, NOTE_POS_LIMIT);
    }

    /** Note-editor tool for a keyboard key, or null when the key is not a tool. */
    function noteToolForKey(key) {
      switch (String(key || '').toLowerCase()) {
        case 'q':
          return 'tap';
        case 'w':
          return 'drag';
        case 'e':
          return 'taplik';
        case 'r':
          return 'hold';
        case 'v':
          return 'select';
        default:
          return null;
      }
    }

    /** Read a note's horizontal `position` (VariableFloat baseValue), default 0. */
    function notePositionOf(element) {
      const value = element && element.fields ? element.fields.position : null;
      if (isTypedValue(value) && value.t === 'obj' && value.fields && typeof value.fields === 'object') {
        const number = valueAsNumber(value.fields.baseValue);
        if (number !== null && Number.isFinite(number)) return number;
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      return 0;
    }

    /**
     * Patch that writes a note's horizontal position without dropping an
     * authored VariableFloat variation curve. Notes whose `position` field is
     * absent get a complete typed value (a dead nested path is never emitted).
     */
    function notePositionPatch(element, position) {
      const value = round(clamp(position, -NOTE_POS_LIMIT, NOTE_POS_LIMIT), 6);
      const current = element && element.fields ? element.fields.position : null;
      if (
        isTypedValue(current) &&
        current.t === 'obj' &&
        current.fields &&
        typeof current.fields === 'object' &&
        Object.prototype.hasOwnProperty.call(current.fields, 'baseValue')
      ) {
        return { path: ['position', 'fields', 'baseValue'], value };
      }
      if (typeof current === 'number') return { path: ['position'], value };
      return {
        path: ['position'],
        value: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: value } },
      };
    }

    /** New typed position value with `baseValue` replaced. */
    function notePositionValue(existing, position) {
      const value = round(clamp(position, -NOTE_POS_LIMIT, NOTE_POS_LIMIT), 6);
      if (isTypedValue(existing) && existing.t === 'obj') {
        return {
          t: 'obj',
          type: typeof existing.type === 'string' && existing.type ? existing.type : 'GorgeFramework.VariableFloat',
          fields: Object.assign({}, existing.fields || {}, { baseValue: value }),
        };
      }
      return { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: value } };
    }

    /** Hold length in seconds (engine default 1 when the field is absent). */
    function noteHoldTimeOf(element) {
      const raw = element && element.fields ? valueAsNumber(element.fields.holdTime) : null;
      if (raw !== null && Number.isFinite(raw) && raw >= 0) return raw;
      if (element && Number.isFinite(element.duration)) return element.duration;
      return 1;
    }

    /** True for DremuHold (catalog category or a hold-ish type name). */
    function isHoldNote(element) {
      if (!element) return false;
      if (element.category === 'hold') return true;
      return /hold/i.test(shortType(element.type));
    }

    /** Lane + note model for one judgement line. */
    function buildLaneEditorModel(project, staffId, laneName) {
      const staff = ((project && project.staffs) || []).find((item) => item && item.id === staffId) || null;
      if (!staff || typeof laneName !== 'string' || laneName.length === 0) return null;
      const laneElements = [];
      const windows = [];
      const notes = [];
      for (const period of staff.periods || []) {
        const offset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
        for (const element of period.elements || []) {
          if (!element) continue;
          if (element.category === 'lane') {
            const name = element.fields && typeof element.fields.name === 'string' ? element.fields.name : '';
            if (name !== laneName) continue;
            laneElements.push(element);
            const start = Number.isFinite(element.start) ? element.start : 0;
            const duration = Number.isFinite(element.duration) ? Math.max(0, element.duration) : 10;
            windows.push({ start, end: start + duration, element });
          } else if (element.category === 'note' || element.category === 'hold') {
            const noteLane = element.lane || (element.fields && typeof element.fields.laneName === 'string' ? element.fields.laneName : '');
            if (noteLane === laneName) notes.push({ element, period, periodOffset: offset });
          }
        }
      }
      laneElements.sort((a, b) => (a.start || 0) - (b.start || 0));
      windows.sort((a, b) => a.start - b.start);
      notes.sort((a, b) => (a.element.start || 0) - (b.element.start || 0) || String(a.element.id).localeCompare(String(b.element.id)));
      return {
        staff,
        laneName,
        laneElements,
        windows,
        notes,
        staffLabel: staff.displayName || staff.className || staff.id,
      };
    }

    /** The period that owns the lane instance covering `time` (creation target). */
    function pickLanePeriodId(project, staffId, laneName, time) {
      const staff = ((project && project.staffs) || []).find((item) => item && item.id === staffId) || null;
      if (!staff) return null;
      let covering = null;
      for (const period of staff.periods || []) {
        for (const element of period.elements || []) {
          if (!element || element.category !== 'lane') continue;
          const name = element.fields && typeof element.fields.name === 'string' ? element.fields.name : '';
          if (name !== laneName) continue;
          const start = Number.isFinite(element.start) ? element.start : 0;
          const duration = Number.isFinite(element.duration) ? Math.max(0, element.duration) : 10;
          const end = start + duration;
          if (time >= start - 1e-6 && time < end + 1e-6) {
            if (!covering || start > (covering.start || 0)) covering = { start, period };
          }
        }
      }
      if (covering) return covering.period.id;
      // No lane instance covers the click: fall back to the period at that
      // time (the timeline's own placement rule).
      return pickPeriod(project, staffId, time);
    }

    /** Rounded-rectangle path (no CanvasRenderingContext2D.roundRect dependency). */
    function noteRoundedPath(ctx, x, y, width, height, radius) {
      const r = Math.max(0, Math.min(radius, width / 2, height / 2));
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    /**
     * The vertical note editor for one lane. Rendered as an overlay over the
     * timeline (which stays mounted, preserving its zoom/scroll state).
     */
    function NoteEditorLayer(props) {
      const {
        t,
        project,
        catalog,
        target,
        tempo,
        transport,
        waves,
        waveStatus,
        audioClips,
        selection,
        setSelection,
        tool,
        snapOn,
        snapDiv,
        pps,
        setPps,
        onEdit,
        onClose,
      } = props;

      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const [size, setSize] = useState({ w: 0, h: 0 });
      const [cursor, setCursor] = useState('default');
      const dragRef = useRef(null);
      const paintRef = useRef(null);
      /** Hover lives in a ref: only the canvas needs it and every pointer move
       * already schedules a repaint, so it must not re-render the page. */
      const hoverRef = useRef(null);

      const model = useMemo(
        () => buildLaneEditorModel(project, target.staffId, target.lane),
        [project, target.staffId, target.lane],
      );
      const notes = model ? model.notes : [];
      const layout = useMemo(() => noteEditorLayout(size.w || 800, size.h || 420), [size.w, size.h]);

      const layoutRef = useRef(layout);
      layoutRef.current = layout;
      const modelRef = useRef(model);
      modelRef.current = model;
      const notesRef = useRef(notes);
      notesRef.current = notes;
      const selectionRef = useRef(selection);
      selectionRef.current = selection;
      const toolRef = useRef(tool);
      toolRef.current = tool;
      const ppsRef = useRef(pps);
      ppsRef.current = pps;
      const tempoRef = useRef(tempo);
      tempoRef.current = tempo;
      const snapRef = useRef({ on: snapOn, div: snapDiv });
      snapRef.current = { on: snapOn, div: snapDiv };
      const projectRef = useRef(project);
      projectRef.current = project;
      const wavesRef = useRef(waves);
      wavesRef.current = waves || {};
      const audioClipsRef = useRef(audioClips || []);
      audioClipsRef.current = audioClips || [];
      const transportRef = useRef(transport);
      transportRef.current = transport;

      // --- Size tracking -----------------------------------------------------
      useEffect(() => {
        const measure = () => {
          const node = wrapRef.current;
          if (!node) return;
          const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          const width = Math.round((rect && rect.width) || node.clientWidth || 0);
          const height = Math.round((rect && rect.height) || node.clientHeight || 0);
          if (width <= 0 || height <= 0) return;
          setSize((previous) => (previous.w === width && previous.h === height ? previous : { w: width, h: height }));
        };
        // Measure synchronously as well: the smoke harness's ResizeObserver
        // never fires, and the first frame still needs real geometry.
        measure();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(wrapRef.current);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, []);

      /** Snap a time using the shared editor grid. */
      const snapEditorTime = useCallback((time, loose) => {
        const settings = snapRef.current;
        const tempoNow = tempoRef.current || { bpm: 120, offset: 0 };
        return snapTime(time, tempoNow, settings.div, settings.on && !loose);
      }, []);

      /** Snap a horizontal position. */
      const snapEditorPosition = useCallback((position, loose) => {
        return snapNotePosition(position, snapRef.current.on && !loose);
      }, []);

      // --- Painting ----------------------------------------------------------
      const paint = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const currentView = layoutRef.current;
        const width = Math.max(160, currentView.w);
        const height = Math.max(140, currentView.h);
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const colors = {
          background: cssToken('--dsw-alias-bg-base', '#10131a'),
          layerOne: cssToken('--dsw-alias-bg-layer-1', '#171b24'),
          layerTwo: cssToken('--dsw-alias-bg-layer-2', '#1e2330'),
          border: cssToken('--dsw-alias-border-l1', '#2b3244'),
          labelPrimary: cssToken('--dsw-alias-label-primary', '#eef1f7'),
          labelSecondary: cssToken('--dsw-alias-label-secondary', '#8b93a7'),
          brand: cssToken('--dsw-alias-brand-primary', '#5b8cff'),
        };
        const now = transportRef.current ? transportRef.current.time : 0;
        const currentPps = Math.max(1, ppsRef.current);
        const currentModel = modelRef.current;
        const currentNotes = notesRef.current;
        const selectedIds = selectionRef.current || [];
        const currentTool = toolRef.current;
        const currentHover = hoverRef.current;
        const currentDrag = dragRef.current;
        const bpm = tempoRef.current && Number.isFinite(tempoRef.current.bpm) && tempoRef.current.bpm > 0 ? tempoRef.current.bpm : 120;
        const secondsPerBeat = 60 / bpm;
        const origin = tempoRef.current && Number.isFinite(tempoRef.current.offset) ? tempoRef.current.offset : 0;
        const xOf = (position) => notePositionToX(position, currentView);
        const yOf = (time) => noteTimeToY(time, now, currentPps, currentView);
        const timeOf = (y) => noteYToTime(y, now, currentPps, currentView);

        ctx.fillStyle = colors.background;
        ctx.fillRect(0, 0, width, height);

        // --- Spectrum strip (far left, aligned with the time axis) ---------
        paintSpectrum();

        // --- Lane lifetime bands -------------------------------------------
        if (currentModel) {
          for (const laneWindow of currentModel.windows) {
            const y1 = yOf(laneWindow.start);
            const y2 = yOf(laneWindow.end);
            const top = Math.min(y1, y2);
            const bottom = Math.max(y1, y2);
            if (bottom < 0 || top > height) continue;
            ctx.save();
            ctx.beginPath();
            ctx.rect(currentView.left, 0, currentView.laneW, height);
            ctx.clip();
            ctx.fillStyle = 'rgba(91,140,255,0.045)';
            ctx.fillRect(currentView.left, top, currentView.laneW, Math.max(1, bottom - top));
            ctx.strokeStyle = 'rgba(91,140,255,0.2)';
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(currentView.left, Math.round(top) + 0.5);
            ctx.lineTo(currentView.right, Math.round(top) + 0.5);
            ctx.moveTo(currentView.left, Math.round(bottom) + 0.5);
            ctx.lineTo(currentView.right, Math.round(bottom) + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }

        // --- Horizontal (position) columns ---------------------------------
        ctx.save();
        ctx.beginPath();
        ctx.rect(currentView.left, 0, currentView.laneW, height);
        ctx.clip();
        const columns = [];
        for (let position = -NOTE_WORLD_HALF + (NOTE_WORLD_HALF % NOTE_POS_STEP); position <= NOTE_WORLD_HALF; position += NOTE_POS_STEP) {
          columns.push(round(position, 6));
        }
        for (const position of columns) {
          const x = xOf(position);
          const centre = Math.abs(position) < 1e-9;
          const edge = Math.abs(Math.abs(position) - 5) < 1e-9;
          ctx.strokeStyle = centre ? 'rgba(210,218,235,0.34)' : edge ? 'rgba(170,180,205,0.26)' : 'rgba(120,130,155,0.12)';
          ctx.lineWidth = centre ? 1.4 : 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, height);
          ctx.stroke();
        }
        // Frame edges.
        ctx.strokeStyle = 'rgba(150,160,185,0.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(currentView.left + 0.5, 0.5, Math.max(1, currentView.laneW - 1), height - 1);
        ctx.restore();

        // --- Beat grid + labels --------------------------------------------
        const targetBeatSpacing = 12;
        let beatStep = 1 / (snapRef.current.on ? Math.max(1, snapRef.current.div) : 4);
        while (secondsPerBeat * currentPps * beatStep < targetBeatSpacing) beatStep *= 2;
        const topTime = timeOf(0);
        const bottomTime = timeOf(height);
        const firstBeat = Math.floor(((bottomTime - origin) / secondsPerBeat) / beatStep) * beatStep - beatStep;
        const lastBeat = Math.ceil(((topTime - origin) / secondsPerBeat) / beatStep) + beatStep;
        const beatPixel = secondsPerBeat * currentPps;
        const labelEvery = beatPixel >= 130 ? 1 : beatPixel >= 64 ? 2 : 4;
        ctx.save();
        ctx.beginPath();
        ctx.rect(currentView.left, 0, currentView.laneW, height);
        ctx.clip();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'middle';
        for (let beat = firstBeat; beat <= lastBeat + 1e-9; beat += beatStep) {
          const time = origin + beat * secondsPerBeat;
          const y = yOf(time);
          if (y < -20 || y > height + 20) continue;
          const whole = Math.abs(beat - Math.round(beat)) < 1e-9;
          const bar = whole && Math.abs(beat % 4) < 1e-9;
          ctx.strokeStyle = bar ? 'rgba(225,230,245,0.3)' : whole ? 'rgba(165,175,200,0.2)' : 'rgba(115,125,150,0.1)';
          ctx.lineWidth = bar ? 1.25 : 1;
          ctx.beginPath();
          ctx.moveTo(currentView.left, Math.round(y) + 0.5);
          ctx.lineTo(currentView.right, Math.round(y) + 0.5);
          ctx.stroke();
        }
        ctx.restore();

        // Beat numbers live in the narrow ruler between spectrum and grid.
        ctx.save();
        ctx.beginPath();
        ctx.rect(currentView.spectrumW, 0, currentView.rulerW, height);
        ctx.clip();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const firstLabel = Math.ceil(firstBeat / labelEvery) * labelEvery;
        for (let beat = firstLabel; beat <= lastBeat + 1e-9; beat += labelEvery) {
          const y = yOf(origin + beat * secondsPerBeat);
          if (y < -10 || y > height + 10) continue;
          ctx.fillStyle = colors.labelSecondary;
          ctx.fillText(formatNum(beat, 0), currentView.left - 7, y - 1);
          ctx.strokeStyle = 'rgba(139,147,167,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(currentView.left - 4, Math.round(y) + 0.5);
          ctx.lineTo(currentView.left - 0.5, Math.round(y) + 0.5);
          ctx.stroke();
        }
        ctx.restore();

        // --- Hold bodies first, then note heads ----------------------------
        const chipW = currentView.chipW;
        const previewFor = (item) => {
          if (!currentDrag || !currentDrag.ids || currentDrag.ids.indexOf(item.element.id) === -1) return null;
          const original = currentDrag.originals && currentDrag.originals[item.element.id];
          if (!original) return null;
          if (currentDrag.mode === 'move') {
            return {
              start: original.start + (currentDrag.deltaTime || 0),
              position: original.position + (currentDrag.deltaPos || 0),
              holdTime: noteHoldTimeOf(item.element),
            };
          }
          if (currentDrag.mode === 'resize') {
            return {
              start: original.start,
              position: original.position,
              holdTime: Math.max(currentDrag.minHold || 0.05, original.holdTime + (currentDrag.deltaTime || 0)),
            };
          }
          return null;
        };

        function noteGeometry(item, override) {
          const element = item.element;
          const position = override && Number.isFinite(override.position) ? override.position : notePositionOf(element);
          const holdTime = override && Number.isFinite(override.holdTime) ? override.holdTime : noteHoldTimeOf(element);
          return {
            element,
            item,
            x: xOf(position),
            y: yOf(override && Number.isFinite(override.start) ? override.start : element.start || 0),
            start: override && Number.isFinite(override.start) ? override.start : element.start || 0,
            holdTime,
            position,
            hold: isHoldNote(element),
            selected: selectedIds.indexOf(element.id) !== -1,
          };
        }

        /** Draw a hold body + inner-note ticks. */
        function paintHoldBody(note) {
          if (!note.hold || !(note.holdTime > 0)) return;
          const tailTime = note.start + note.holdTime;
          const tailY = yOf(tailTime);
          const top = Math.min(tailY, note.y);
          const bottom = Math.max(tailY, note.y);
          if (bottom < -30 || top > height + 30) return;
          const bodyW = clamp(chipW * 0.22, 8, 26);
          const color = elementColor(catalog, note.element.type);
          ctx.save();
          ctx.globalAlpha = note.selected ? 0.45 : 0.3;
          ctx.fillStyle = color;
          noteRoundedPath(ctx, note.x - bodyW / 2, top, bodyW, Math.max(2, bottom - top), bodyW / 2);
          ctx.fill();
          ctx.globalAlpha = note.selected ? 0.95 : 0.7;
          ctx.strokeStyle = color;
          ctx.lineWidth = note.selected ? 1.6 : 1;
          ctx.stroke();
          // Inner-note ticks (hitTime is relative to the hold head).
          const inner = note.element.fields && note.element.fields.innerNotes;
          if (inner && Array.isArray(inner.items)) {
            for (const entry of inner.items) {
              const relative = entry && entry.fields ? valueAsNumber(entry.fields.hitTime) : null;
              if (relative === null || relative < 0 || relative > note.holdTime) continue;
              const tickY = yOf(note.start + relative);
              ctx.globalAlpha = 0.85;
              ctx.strokeStyle = 'rgba(255,255,255,0.82)';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(note.x - bodyW / 2 - 3, Math.round(tickY) + 0.5);
              ctx.lineTo(note.x + bodyW / 2 + 3, Math.round(tickY) + 0.5);
              ctx.stroke();
            }
          }
          ctx.restore();
        }

        /** Draw one note chip: pill, centre diamond and a type glyph. */
        function paintNoteChip(note, ghost) {
          if (!note || !Number.isFinite(note.x) || !Number.isFinite(note.y)) return;
          const halfW = chipW / 2;
          if (note.x + halfW < currentView.left || note.x - halfW > currentView.right) return;
          if (note.y + NOTE_CHIP_H < -20 || note.y - NOTE_CHIP_H > height + 20) return;
          const color = elementColor(catalog, note.element.type);
          const type = shortType(note.element.type);
          const isDrag = /drag/i.test(type);
          const isTaplik = /taplik|flick/i.test(type);
          const inWindow = laneAliveAt(currentModel, note.start);
          const alpha = ghost ? 0.45 : inWindow ? 1 : 0.42;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.rect(currentView.left, 0, currentView.laneW, height);
          ctx.clip();
          const left = note.x - halfW;
          const top = note.y - NOTE_CHIP_H / 2;
          noteRoundedPath(ctx, left, top, chipW, NOTE_CHIP_H, NOTE_CHIP_H / 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = ghost ? 1.5 : 1;
          if (ghost) {
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#ffffff';
          } else {
            ctx.strokeStyle = note.selected ? '#ffffff' : 'rgba(0,0,0,0.42)';
            if (note.selected) ctx.lineWidth = 2;
          }
          ctx.stroke();
          ctx.setLineDash([]);
          // Outward arrowheads mark a drag note.
          if (isDrag) {
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            const size = Math.min(7, NOTE_CHIP_H / 2);
            ctx.beginPath();
            ctx.moveTo(left + 2, note.y);
            ctx.lineTo(left + size + 2, note.y - size);
            ctx.lineTo(left + size + 2, note.y + size);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(left + chipW - 2, note.y);
            ctx.lineTo(left + chipW - size - 2, note.y - size);
            ctx.lineTo(left + chipW - size - 2, note.y + size);
            ctx.closePath();
            ctx.fill();
          }
          // Centre glyph: diamond for tap/hold, star for taplik.
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 1;
          if (isTaplik) {
            const r = Math.min(6, NOTE_CHIP_H / 2.6);
            ctx.beginPath();
            for (let index = 0; index < 8; index += 1) {
              const radius = index % 2 === 0 ? r : r * 0.4;
              const angle = (Math.PI / 4) * index - Math.PI / 2;
              const px = note.x + Math.cos(angle) * radius;
              const py = note.y + Math.sin(angle) * radius;
              if (index === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
          } else {
            const r = Math.min(6, NOTE_CHIP_H / 2.6);
            ctx.beginPath();
            ctx.moveTo(note.x, note.y - r);
            ctx.lineTo(note.x + r, note.y);
            ctx.lineTo(note.x, note.y + r);
            ctx.lineTo(note.x - r, note.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }

        const painted = [];
        for (const item of currentNotes) {
          const note = noteGeometry(item, previewFor(item));
          painted.push(note);
        }
        // Holds first so a head chip always sits above its body.
        for (const note of painted) paintHoldBody(note);
        for (const note of painted) if (!note.selected) paintNoteChip(note, false);
        for (const note of painted) if (note.selected) paintNoteChip(note, false);

        // --- Creation ghost -------------------------------------------------
        const ghost = creationGhost();
        if (ghost) {
          const element = { type: typeForNoteTool(ghost.type), fields: {} };
          if (ghost.type === 'hold') {
            paintHoldBody({
              element,
              x: xOf(ghost.position),
              y: yOf(ghost.start),
              start: ghost.start,
              holdTime: ghost.holdTime,
              hold: true,
              selected: false,
            });
          }
          paintNoteChip(
            {
              element,
              x: xOf(ghost.position),
              y: yOf(ghost.start),
              start: ghost.start,
              position: ghost.position,
              hold: ghost.type === 'hold',
              holdTime: ghost.holdTime,
              selected: false,
            },
            true,
          );
        }

        // --- Box selection --------------------------------------------------
        if (currentDrag && currentDrag.mode === 'box' && currentDrag.box) {
          const box = currentDrag.box;
          ctx.fillStyle = 'rgba(91,140,255,0.16)';
          ctx.strokeStyle = colors.brand;
          ctx.lineWidth = 1;
          ctx.fillRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
          ctx.strokeRect(Math.min(box.x0, box.x1) + 0.5, Math.min(box.y0, box.y1) + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
        }

        // --- Top position labels -------------------------------------------
        if (currentView.laneW > 180) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(currentView.left, 0, currentView.laneW, height);
          ctx.clip();
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const labelStep = currentView.laneW >= 520 ? 1 : 2.5;
          for (let position = -5; position <= 5 + 1e-9; position += labelStep) {
            const x = xOf(position);
            const strong = Math.abs(position) < 1e-9 || Math.abs(Math.abs(position) - 5) < 1e-9;
            ctx.fillStyle = strong ? 'rgba(210,218,235,0.62)' : 'rgba(150,160,185,0.42)';
            ctx.fillText(formatNum(position, Number.isInteger(position) ? 0 : 1), x, 5);
          }
          ctx.restore();
        }

        // --- Judgement line + label ----------------------------------------
        ctx.save();
        ctx.strokeStyle = colors.labelPrimary;
        ctx.globalAlpha = 0.92;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(currentView.judgeY) + 0.5);
        ctx.lineTo(width, Math.round(currentView.judgeY) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 0.16;
        ctx.strokeStyle = colors.brand;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(currentView.judgeY) + 0.5);
        ctx.lineTo(width, Math.round(currentView.judgeY) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const judgeBeat = (now - origin) / secondsPerBeat;
        const judgeLabel = t('noteEditorJudge') + ' · ' + formatTime(now) + ' · ♪' + formatNum(judgeBeat, 2);
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const judgeLabelWidth = ctx.measureText(judgeLabel).width;
        ctx.fillStyle = 'rgba(8,10,18,0.7)';
        ctx.fillRect(currentView.spectrumW + 2, currentView.judgeY - 17, Math.min(width - currentView.spectrumW - 4, judgeLabelWidth + 8), 15);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillText(judgeLabel, currentView.spectrumW + 6, currentView.judgeY - 4);
        ctx.restore();

        // --- Hover tooltip --------------------------------------------------
        if (currentHover && currentHover.noteId) {
          const hovered = painted.find((note) => note.element.id === currentHover.noteId);
          if (hovered) {
            const position = hovered.position;
            const type = shortType(hovered.element.type);
            const text = type + ' · ' + t('noteEditorPosition') + ' ' + formatNum(position, 2) + ' · ' + formatTime(hovered.start);
            ctx.font = '11px sans-serif';
            const textWidth = ctx.measureText(text).width + 12;
            let bx = currentHover.x + 12;
            if (bx + textWidth > width - 6) bx = currentHover.x - textWidth - 12;
            const by = clamp(currentHover.y - 30, 4, height - 24);
            ctx.fillStyle = 'rgba(0,0,0,0.82)';
            ctx.fillRect(bx, by, textWidth, 19);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx + 6, by + 10);
          }
        }

        // --- Empty state ----------------------------------------------------
        if (!currentModel) {
          ctx.fillStyle = colors.labelSecondary;
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(t('noteEditorNoLane'), currentView.left + currentView.laneW / 2, height / 2);
        } else if (currentNotes.length === 0) {
          ctx.fillStyle = colors.labelSecondary;
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const message = fitText(ctx, t('noteEditorEmpty'), Math.max(80, currentView.laneW - 24));
          ctx.fillText(message, currentView.left + currentView.laneW / 2, Math.max(80, currentView.judgeY / 2));
        }

        // --- Small helpers used by the painters above ----------------------
        function paintSpectrum() {
          const left = 0;
          const stripW = currentView.spectrumW;
          const topTime = timeOf(0);
          const bottomTime = timeOf(height);
          const fromLimit = Math.max(0, bottomTime);
          const toLimit = Math.max(fromLimit, topTime);
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, 0, stripW, height);
          ctx.clip();
          ctx.fillStyle = colors.layerTwo;
          ctx.fillRect(left, 0, stripW, height);

          let drew = false;
          let missingStatus = '';
          for (const clip of audioClipsRef.current || []) {
            if (!clip) continue;
            const key = clip.file || clip.relativePath || '';
            const wave = key ? wavesRef.current[key] : null;
            const clipStart = Number.isFinite(clip.offset) ? clip.offset : 0;
            const clipDuration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : wave && wave.duration ? wave.duration : 0;
            if (!(clipDuration > 0)) {
              missingStatus = missingStatus || (clip.missing ? t('waveUnavailable') : t('audioMissing'));
              continue;
            }
            const start = Math.max(fromLimit, clipStart);
            const end = Math.min(toLimit, clipStart + clipDuration);
            if (end - start <= 1e-6) continue;
            const yStart = yOf(start);
            const yEnd = yOf(end);
            const drawTop = Math.min(yStart, yEnd);
            const drawHeight = Math.max(1, Math.abs(yStart - yEnd));
            const spectrum = wave && wave.spectrum;
            const source = spectrum ? spectrumCanvasFor(spectrum) : null;
            if (source) {
              const sx = clamp(((start - clipStart) / clipDuration) * spectrum.columns, 0, spectrum.columns - 1);
              const sw = Math.max(1, Math.min(spectrum.columns - sx, ((end - start) / clipDuration) * spectrum.columns));
              ctx.save();
              ctx.beginPath();
              ctx.rect(left, drawTop, stripW, drawHeight);
              ctx.clip();
              ctx.translate(left, drawTop + drawHeight);
              ctx.rotate(-Math.PI / 2);
              ctx.drawImage(source, sx, 0, sw, spectrum.bands, 0, 0, drawHeight, stripW);
              ctx.restore();
              drew = true;
            } else if (spectrum && spectrum.data && spectrum.columns > 0) {
              // Canvas creation unavailable: coarse time/frequency cells.
              const rows = Math.max(4, Math.floor(drawHeight / 3));
              const bands = spectrum.bands;
              const steps = 18;
              for (let row = 0; row < rows; row += 1) {
                const time = start + ((end - start) * (row + 0.5)) / rows;
                const column = clamp(Math.floor(((time - clipStart) / clipDuration) * spectrum.columns), 0, spectrum.columns - 1);
                const y = yOf(time);
                for (let band = 0; band < bands; band += steps) {
                  const level = spectrum.data[column * bands + band] / 255;
                  if (!(level > 0.035)) continue;
                  const rgb = spectrumColorRgb(level);
                  ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
                  const cellW = Math.max(1, (stripW * steps) / bands);
                  ctx.fillRect((band / bands) * stripW, y, cellW, Math.max(2, drawHeight / rows + 1));
                }
              }
              drew = true;
            } else if (wave && wave.peaks && wave.peaks.length > 0) {
              ctx.fillStyle = 'rgba(124,140,255,0.5)';
              const sampleDuration = wave.duration && wave.duration > 0 ? wave.duration : clipDuration;
              for (let y = Math.floor(drawTop); y < Math.ceil(drawTop + drawHeight); y += 1) {
                const time = timeOf(y);
                const relative = time - clipStart;
                if (relative < 0 || relative > sampleDuration) continue;
                const bin = clamp(Math.floor((relative / sampleDuration) * wave.peaks.length), 0, wave.peaks.length - 1);
                const amplitude = Math.max(1, wave.peaks[bin] * stripW * 0.85);
                ctx.fillRect(left, y, amplitude, 1);
              }
              drew = true;
            } else {
              missingStatus = missingStatus || (waveStatus === 'loading' ? t('spectrumLoading') : t('spectrumUnavailable'));
            }
          }
          ctx.strokeStyle = colors.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(stripW + 0.5, 0);
          ctx.lineTo(stripW + 0.5, height);
          ctx.stroke();
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillStyle = colors.labelSecondary;
          ctx.fillText(fitText(ctx, t('noteEditorSpectrumShort'), stripW - 8), 5, 5);
          if (!drew) {
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.font = '9px sans-serif';
            ctx.fillStyle = colors.labelSecondary;
            ctx.fillText(fitText(ctx, missingStatus || t('audioMissing'), stripW - 8), 5, 19);
            ctx.restore();
          }
          ctx.restore();
        }

        function laneAliveAt(currentModelValue, time) {
          if (!currentModelValue || !Array.isArray(currentModelValue.windows) || currentModelValue.windows.length === 0) return true;
          for (const laneWindow of currentModelValue.windows) {
            if (time >= laneWindow.start - 1e-6 && time < laneWindow.end + 1e-6) return true;
          }
          return false;
        }

        function creationGhost() {
          const currentToolNow = currentTool;
          if (!currentToolNow || currentToolNow === 'select') return null;
          const drag = currentDrag;
          if (drag) {
            if (drag.mode !== 'create') return null;
            return { type: drag.type, start: drag.curTime, position: drag.curPos, holdTime: drag.holdTime };
          }
          const hovered = currentHover;
          if (!hovered || hovered.area !== 'lane' || !Number.isFinite(hovered.x) || !Number.isFinite(hovered.y)) return null;
          const rawTime = timeOf(hovered.y);
          const time = Math.max(0, snapEditorTime(rawTime, hovered.alt));
          const position = snapEditorPosition(noteXToPosition(hovered.x, currentView), hovered.alt);
          return { type: currentToolNow, start: time, position, holdTime: Math.max(1e-3, 60 / bpm) };
        }
      }, [audioClips, catalog, layout, model, notes, pps, selection, snapDiv, snapOn, t, tempo, tool, transport.time, waves, waveStatus]);

      paintRef.current = paint;

      useEffect(() => {
        paint();
      }, [paint]);

      // --- Pointer helpers ---------------------------------------------------
      const localPoint = useCallback((event) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }, []);

      const currentAnchorTime = useCallback(() => {
        const transportNow = transportRef.current;
        if (!transportNow) return 0;
        if (transportNow.timeRef && Number.isFinite(transportNow.timeRef.current)) return transportNow.timeRef.current;
        return Number.isFinite(transportNow.time) ? transportNow.time : 0;
      }, []);

      /** Note / ruler hit-testing at a canvas point. */
      const hitTest = useCallback((point, layoutNow, anchorNow) => {
        const currentModel = modelRef.current;
        if (!currentModel) return { area: 'outside' };
        if (point.x < layoutNow.left) return { area: 'ruler' };
        if (point.x > layoutNow.right) return { area: 'outside' };
        const currentNotes = notesRef.current;
        const chipW = layoutNow.chipW;
        const selectedIds = selectionRef.current || [];
        // Selected notes are painted last; reverse iteration must therefore
        // see them first so an overlapping selected chip is preferred.
        const ordered = [];
        for (const item of currentNotes) if (selectedIds.indexOf(item.element.id) === -1) ordered.push(item);
        for (const item of currentNotes) if (selectedIds.indexOf(item.element.id) !== -1) ordered.push(item);
        for (let index = ordered.length - 1; index >= 0; index -= 1) {
          const item = ordered[index];
          const element = item.element;
          const x = notePositionToX(notePositionOf(element), layoutNow);
          const y = noteTimeToY(element.start || 0, anchorNow, ppsRef.current, layoutNow);
          if (isHoldNote(element)) {
            const holdTime = noteHoldTimeOf(element);
            const tailY = noteTimeToY((element.start || 0) + holdTime, anchorNow, ppsRef.current, layoutNow);
            const top = Math.min(tailY, y);
            const bottom = Math.max(tailY, y);
            if (Math.abs(point.x - x) <= chipW / 2 + 2 && point.y >= y - NOTE_CHIP_H / 2 - 3 && point.y <= y + NOTE_CHIP_H / 2 + 3) {
              return { area: 'note', item, mode: 'head', x, y };
            }
            const bodyHalf = Math.max(11, clamp(chipW * 0.22, 8, 26) / 2 + 4);
            if (Math.abs(point.x - x) <= bodyHalf && point.y >= top - 8 && point.y <= bottom + 8) {
              if (Math.abs(point.y - tailY) <= 9) return { area: 'note', item, mode: 'tail', x, y };
              return { area: 'note', item, mode: 'body', x, y };
            }
          } else if (Math.abs(point.x - x) <= chipW / 2 + 2 && Math.abs(point.y - y) <= NOTE_CHIP_H / 2 + 4) {
            return { area: 'note', item, mode: 'head', x, y };
          }
        }
        return { area: 'lane' };
      }, []);

      /** Selection after clicking a note. */
      const selectionForClick = useCallback((id, additive) => {
        const current = selectionRef.current || [];
        if (!additive) return current.indexOf(id) !== -1 ? current : [id];
        if (current.indexOf(id) !== -1) return current;
        return current.concat([id]);
      }, []);

      const seekTo = useCallback((time) => {
        const transportNow = transportRef.current;
        if (!transportNow) return;
        const duration = Math.max(0, Number.isFinite(transportNow.duration) ? transportNow.duration : 0);
        transportNow.seek(clamp(time, 0, Math.max(duration, 0)));
      }, []);

      // --- Gesture starts ----------------------------------------------------
      const beginCreate = useCallback((point, type, anchorNow, loose) => {
        const layoutNow = layoutRef.current;
        const rawTime = noteYToTime(point.y, anchorNow, ppsRef.current, layoutNow);
        const start = Math.max(0, snapEditorTime(rawTime, loose));
        const position = snapEditorPosition(noteXToPosition(point.x, layoutNow), loose);
        const beat = 60 / ((tempoRef.current && tempoRef.current.bpm) || 120);
        const minHold = Math.max(0.05, beat / Math.max(1, snapRef.current.div));
        dragRef.current = {
          mode: 'create',
          type,
          startX: point.x,
          startY: point.y,
          anchorTime: rawTime,
          startTime: start,
          startPos: position,
          curTime: start,
          curPos: position,
          holdTime: beat,
          minHold,
          moved: false,
        };
        if (transportRef.current && transportRef.current.playing) transportRef.current.pause();
        paintRef.current && paintRef.current();
      }, [snapEditorPosition, snapEditorTime]);

      const beginMove = useCallback((point, hit, anchorNow, additive) => {
        const layoutNow = layoutRef.current;
        const element = hit.item.element;
        const nextSelection = selectionForClick(element.id, additive);
        setSelection(nextSelection);
        const ids = nextSelection.indexOf(element.id) !== -1 ? nextSelection : [element.id];
        const originals = {};
        for (const item of notesRef.current) {
          if (ids.indexOf(item.element.id) === -1) continue;
          originals[item.element.id] = {
            start: item.element.start || 0,
            position: notePositionOf(item.element),
            holdTime: noteHoldTimeOf(item.element),
          };
        }
        dragRef.current = {
          mode: 'move',
          ids,
          primaryId: element.id,
          originals,
          anchorTime: noteYToTime(point.y, anchorNow, ppsRef.current, layoutNow),
          anchorPosition: noteXToPosition(point.x, layoutNow),
          startX: point.x,
          startY: point.y,
          deltaTime: 0,
          deltaPos: 0,
          moved: false,
        };
        if (transportRef.current && transportRef.current.playing) transportRef.current.pause();
        paintRef.current && paintRef.current();
      }, [selectionForClick, setSelection]);

      const beginResize = useCallback((point, hit, anchorNow) => {
        const layoutNow = layoutRef.current;
        const element = hit.item.element;
        setSelection([element.id]);
        const originals = {};
        originals[element.id] = {
          start: element.start || 0,
          position: notePositionOf(element),
          holdTime: noteHoldTimeOf(element),
        };
        dragRef.current = {
          mode: 'resize',
          ids: [element.id],
          primaryId: element.id,
          originals,
          anchorTime: noteYToTime(point.y, anchorNow, ppsRef.current, layoutNow),
          anchorPosition: noteXToPosition(point.x, layoutNow),
          startX: point.x,
          startY: point.y,
          deltaTime: 0,
          minHold: Math.max(0.05, 60 / ((tempoRef.current && tempoRef.current.bpm) || 120) / Math.max(1, snapRef.current.div)),
          moved: false,
        };
        if (transportRef.current && transportRef.current.playing) transportRef.current.pause();
        paintRef.current && paintRef.current();
      }, [setSelection]);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0 && event.button !== 1) return;
        const point = localPoint(event);
        const layoutNow = layoutRef.current;
        const anchorNow = currentAnchorTime();
        const canvas = canvasRef.current;
        if (canvas && canvas.focus) canvas.focus();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
        if (event.button === 1 || point.x < layoutNow.left) {
          // Scrub against the pointer-down anchor: using the live transport
          // time on every move would feed the seek back into y -> time and
          // make the playhead run away from the pointer.
          dragRef.current = { mode: 'scrub', anchorTime: anchorNow };
          seekTo(noteYToTime(point.y, anchorNow, ppsRef.current, layoutNow));
          event.preventDefault();
          return;
        }
        if (point.x > layoutNow.right) {
          dragRef.current = null;
          return;
        }
        const hit = hitTest(point, layoutNow, anchorNow);
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        if (hit.area === 'note' && hit.item) {
          if (hit.mode === 'tail') beginResize(point, hit, anchorNow);
          else beginMove(point, hit, anchorNow, additive);
          return;
        }
        if (toolRef.current !== 'select') {
          const rawType = toolRef.current;
          const type = rawType === 'tap' || rawType === 'drag' || rawType === 'taplik' || rawType === 'hold' ? rawType : null;
          if (!type) {
            dragRef.current = { mode: 'box', box: { x0: point.x, y0: point.y, x1: point.x, y1: point.y }, additive: false, moved: false };
            return;
          }
          beginCreate(point, type, anchorNow, !!event.altKey);
          return;
        }
        if (!event.shiftKey && !event.metaKey && !event.ctrlKey) setSelection([]);
        dragRef.current = {
          mode: 'box',
          box: { x0: point.x, y0: point.y, x1: point.x, y1: point.y },
          additive: event.shiftKey || event.metaKey || event.ctrlKey,
          moved: false,
        };
        event.preventDefault();
      }, [beginCreate, beginMove, beginResize, currentAnchorTime, hitTest, localPoint, seekTo, setSelection]);

      /** Update the hover readout/cursor and repaint the canvas directly. */
      const updateHover = useCallback((point, altKey) => {
        const layoutNow = layoutRef.current;
        const anchorNow = currentAnchorTime();
        const hit = hitTest(point, layoutNow, anchorNow);
        let mode = 'default';
        if (point.x < layoutNow.left) mode = 'pointer';
        else if (hit.area === 'note') mode = hit.mode === 'tail' ? 'ns-resize' : 'grab';
        else if (toolRef.current !== 'select') mode = 'crosshair';
        else mode = 'default';
        setCursor((previous) => (previous === mode ? previous : mode));
        if (point.x < layoutNow.left) {
          hoverRef.current = { area: 'ruler', x: point.x, y: point.y };
        } else if (point.x > layoutNow.right) {
          hoverRef.current = null;
        } else if (hit.area === 'note' && hit.item) {
          hoverRef.current = { area: 'note', noteId: hit.item.element.id, x: point.x, y: point.y };
        } else {
          hoverRef.current = { area: 'lane', x: point.x, y: point.y, alt: !!altKey };
        }
        paintRef.current && paintRef.current();
      }, [currentAnchorTime, hitTest]);

      const onPointerMove = useCallback((event) => {
        const point = localPoint(event);
        const drag = dragRef.current;
        const layoutNow = layoutRef.current;
        if (!drag) {
          updateHover(point, event.altKey);
          return;
        }
        if (drag.mode === 'scrub') {
          seekTo(noteYToTime(point.y, drag.anchorTime, ppsRef.current, layoutNow));
          return;
        }
        if (drag.mode === 'box') {
          drag.box.x1 = point.x;
          drag.box.y1 = point.y;
          drag.moved = drag.moved || Math.abs(point.x - drag.startX) > 3 || Math.abs(point.y - drag.startY) > 3;
          paintRef.current && paintRef.current();
          return;
        }
        if (drag.mode === 'create') {
          const loose = !!event.altKey;
          const time = Math.max(0, snapEditorTime(noteYToTime(point.y, currentAnchorTime(), ppsRef.current, layoutNow), loose));
          const position = snapEditorPosition(noteXToPosition(point.x, layoutNow), loose);
          if (drag.type === 'hold') {
            // The head stays where the gesture started; the tail follows up.
            drag.curTime = drag.startTime;
            drag.curPos = drag.startPos === undefined ? drag.curPos : drag.startPos;
            drag.holdTime = Math.max(drag.minHold, time - drag.startTime);
          } else {
            drag.curTime = time;
            drag.curPos = position;
          }
          drag.moved = drag.moved || Math.abs(point.x - drag.startX) > 2 || Math.abs(point.y - drag.startY) > 2;
          paintRef.current && paintRef.current();
          return;
        }
        const anchorNow = currentAnchorTime();
        const deltaRaw = noteYToTime(point.y, anchorNow, ppsRef.current, layoutNow) - drag.anchorTime;
        if (drag.mode === 'move') {
          const primary = drag.originals[drag.primaryId];
          if (!primary) return;
          const loose = !!event.altKey;
          const targetStart = Math.max(0, snapEditorTime(primary.start + deltaRaw, loose));
          const targetPosition = snapEditorPosition(primary.position + (noteXToPosition(point.x, layoutNow) - drag.anchorPosition), loose);
          drag.deltaTime = targetStart - primary.start;
          drag.deltaPos = targetPosition - primary.position;
          drag.moved = drag.moved || Math.abs(point.x - drag.startX) > 2 || Math.abs(point.y - drag.startY) > 2;
          paintRef.current && paintRef.current();
          return;
        }
        if (drag.mode === 'resize') {
          const primary = drag.originals[drag.primaryId];
          if (!primary) return;
          const loose = !!event.altKey;
          const targetEnd = snapEditorTime(primary.start + primary.holdTime + deltaRaw, loose);
          const nextHold = Math.max(drag.minHold, targetEnd - primary.start);
          drag.deltaTime = nextHold - primary.holdTime;
          drag.moved = drag.moved || Math.abs(point.x - drag.startX) > 2 || Math.abs(point.y - drag.startY) > 2;
          paintRef.current && paintRef.current();
        }
      }, [currentAnchorTime, localPoint, seekTo, snapEditorPosition, snapEditorTime, updateHover]);

      /** Build and send one `add` for a finished creation gesture. */
      const commitCreate = useCallback((drag) => {
        const currentProject = projectRef.current;
        const currentModel = modelRef.current;
        if (!currentProject || !currentModel || !drag.type) return;
        const type = typeForNoteTool(drag.type);
        const entry = catalogEntry(catalog, type);
        if (!entry) return;
        const time = Math.max(0, drag.curTime);
        const position = drag.curPos;
        const periodId = pickLanePeriodId(currentProject, target.staffId, target.lane, time);
        const staff = (currentProject.staffs || []).find((item) => item && item.id === target.staffId);
        const period = staff && (staff.periods || []).find((item) => item.id === periodId);
        if (!period) return;
        const periodOffset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
        const fields = fieldsForNewElement(catalog, type);
        const timing = entry.timing || {};
        fields[timing.start || 'hitTime'] = round(time - periodOffset, 6);
        fields[timing.lane || 'laneName'] = target.lane;
        fields.position = notePositionValue(fields.position, position);
        if (entry.category === 'hold' || /hold/i.test(shortType(type))) {
          const holdTime = drag.type === 'hold' ? Math.max(0.05, drag.holdTime) : 1;
          fields.holdTime = round(holdTime, 6);
        }
        const id = makeElementId(periodId);
        onEdit([{ op: 'add', staffId: target.staffId, periodId, element: { id, type, fields } }]);
        setSelection([id]);
      }, [catalog, makeElementId, onEdit, setSelection, t, target.lane, target.staffId]);

      const commitMove = useCallback((drag) => {
        const currentProject = projectRef.current;
        if (!currentProject || !drag.originals) return;
        if (Math.abs(drag.deltaTime) < 1e-9 && Math.abs(drag.deltaPos) < 1e-9) return;
        const ops = [];
        for (const id of drag.ids) {
          const original = drag.originals[id];
          const found = findElement(currentProject, id);
          if (!original || !found) continue;
          const nextStart = Math.max(0, original.start + drag.deltaTime);
          if (Math.abs(nextStart - original.start) > 1e-9) {
            const startField = resolveStartField(catalog, found.element);
            const periodOffset = Number.isFinite(found.period.timeOffset) ? found.period.timeOffset : 0;
            if (startField) {
              ops.push({ op: 'patch', elementId: id, path: [startField], value: round(nextStart - periodOffset, 6) });
            }
          }
          if (Math.abs(drag.deltaPos) > 1e-9) {
            const patch = notePositionPatch(found.element, original.position + drag.deltaPos);
            ops.push({ op: 'patch', elementId: id, path: patch.path, value: patch.value });
          }
        }
        if (ops.length > 0) onEdit(ops);
      }, [catalog, onEdit]);

      const commitResize = useCallback((drag) => {
        const currentProject = projectRef.current;
        const id = drag.primaryId;
        const original = drag.originals && drag.originals[id];
        const found = currentProject ? findElement(currentProject, id) : null;
        if (!original || !found) return;
        if (Math.abs(drag.deltaTime) < 1e-9) return;
        const nextHold = Math.max(drag.minHold || 0.05, original.holdTime + drag.deltaTime);
        if (Math.abs(nextHold - original.holdTime) < 1e-9) return;
        onEdit([{ op: 'patch', elementId: id, path: ['holdTime'], value: round(nextHold, 6) }]);
      }, [onEdit]);

      const onPointerUp = useCallback((event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) {
          paintRef.current && paintRef.current();
          return;
        }
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
        if (drag.mode === 'create') commitCreate(drag);
        else if (drag.mode === 'move') commitMove(drag);
        else if (drag.mode === 'resize') commitResize(drag);
        else if (drag.mode === 'box') {
          const currentModel = modelRef.current;
          const layoutNow = layoutRef.current;
          const anchorNow = currentAnchorTime();
          const minX = Math.min(drag.box.x0, drag.box.x1);
          const maxX = Math.max(drag.box.x0, drag.box.x1);
          const minY = Math.min(drag.box.y0, drag.box.y1);
          const maxY = Math.max(drag.box.y0, drag.box.y1);
          const ids = [];
          for (const item of currentModel ? currentModel.notes : []) {
            const x = notePositionToX(notePositionOf(item.element), layoutNow);
            const y = noteTimeToY(item.element.start || 0, anchorNow, ppsRef.current, layoutNow);
            if (x + layoutNow.chipW / 2 < minX || x - layoutNow.chipW / 2 > maxX) continue;
            if (y + NOTE_CHIP_H < minY || y - NOTE_CHIP_H > maxY) continue;
            ids.push(item.element.id);
          }
          if (ids.length > 0) {
            setSelection(drag.additive ? Array.from(new Set((selectionRef.current || []).concat(ids))) : ids);
          }
        }
        paintRef.current && paintRef.current();
      }, [commitCreate, commitMove, commitResize, currentAnchorTime, setSelection]);

      const onPointerCancel = useCallback(() => {
        dragRef.current = null;
        hoverRef.current = null;
        paintRef.current && paintRef.current();
      }, []);

      const onPointerLeave = useCallback(() => {
        if (dragRef.current) return;
        hoverRef.current = null;
        setCursor('default');
        paintRef.current && paintRef.current();
      }, []);

      const onWheel = useCallback((event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const transportNow = transportRef.current;
        if (!transportNow) return;
        const layoutNow = layoutRef.current;
        if (event.ctrlKey || event.metaKey) {
          const factor = Math.exp(-event.deltaY * 0.0015);
          // Functional update: several wheel ticks can arrive before React
          // re-renders, and each one must compound on the previous zoom.
          if (setPps) setPps((previous) => round(clamp(previous * factor, NOTE_PPS_MIN, NOTE_PPS_MAX), 2));
          return;
        }
        const delta = event.deltaY / Math.max(1, ppsRef.current);
        const currentTime = transportNow.timeRef && Number.isFinite(transportNow.timeRef.current) ? transportNow.timeRef.current : transportNow.time;
        const duration = Math.max(
          Number.isFinite(transportNow.duration) ? transportNow.duration : 0,
          (projectRef.current && Number.isFinite(projectRef.current.duration)) ? projectRef.current.duration : 0,
          currentTime,
        );
        transportNow.seek(clamp(currentTime + delta, 0, Math.max(0, duration)));
        // Keep the pointer ghost current after a wheel seek.
        const point = localPoint(event);
        if (point.y >= 0 && point.y <= layoutNow.h && point.x >= layoutNow.left && point.x <= layoutNow.right) {
          hoverRef.current = { area: 'lane', x: point.x, y: point.y, alt: !!event.altKey };
        }
        paintRef.current && paintRef.current();
      }, [localPoint, setPps]);

      // --- Render ------------------------------------------------------------
      const staffLabel = model ? model.staffLabel : target.staffId;
      const laneType = model && model.laneElements.length > 0 ? shortType(model.laneElements[0].type) : '';
      const noteCount = notes.length;
      return h(
        'div',
        { className: 'dgc-noteEditor', role: 'region', 'aria-label': t('noteEditor') },
        h(
          'div',
          { className: 'dgc-noteEditorHead' },
          h(Button, { variant: 'ghost', icon: 'back', onClick: onClose, title: t('noteEditorBack') }, t('noteEditorBack')),
          h('strong', { className: 'dgc-noteEditorTitle', title: staffLabel + ' · ' + target.lane }, staffLabel + ' · ' + target.lane),
          h(
            'span',
            { className: 'dgc-noteEditorMeta' },
            target.staffId + (laneType ? ' · ' + laneType : '') + ' · ' + t('noteEditorNotesCount').replace('{count}', String(noteCount)),
          ),
          h('span', { className: 'dgc-spacer' }),
          h('span', { className: 'dgc-noteEditorHint', title: t('noteEditorHint') }, t('noteEditorHint')),
        ),
        h(
          'div',
          { className: 'dgc-noteCanvasWrap', ref: wrapRef },
          h('canvas', {
            ref: canvasRef,
            className: 'dgc-noteCanvas',
            tabIndex: 0,
            style: { cursor },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onPointerLeave,
            onWheel,
            'aria-label': t('noteEditor') + ' · ' + target.lane,
          }),
        ),
      );
    }

    /** Resolve a short note tool id to a catalog element type. */
    function typeForNoteTool(tool) {
      const wanted = { tap: 'DremuTap', drag: 'DremuDrag', taplik: 'DremuTaplik', hold: 'DremuHold' }[tool];
      if (!wanted) return 'Dremu.DremuTap';
      return 'Dremu.' + wanted;
    }

    // ========================================================================
    // 16 · Open / create-project dialogs.
    // ========================================================================

    /** Characters a new project folder name may not contain (Host mirror). */
    const PROJECT_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;

    /**
     * Client-side mirror of the Host's folder-name rules.
     * Returns `'required'`, `'invalid'` or null.
     */
    function projectNameProblem(value) {
      const name = String(value || '').trim();
      if (name.length === 0) return 'required';
      if (name === '.' || name === '..' || name.startsWith('.') || name.endsWith('.')) return 'invalid';
      if (PROJECT_NAME_FORBIDDEN.test(name)) return 'invalid';
      return null;
    }

    /** Modal listing the chart library and accepting a manual path. */
    function OpenProjectDialog(props) {
      const { t, state, onOpen, onClose, onNewProject,
      } = props;
      const [path, setPath] = useState('');
      const [busy, setBusy] = useState(false);
      const projects = (state && state.projects) || [];
      const recent = (state && state.recent) || [];
      const submit = useCallback(
        async (target) => {
          const value = (target || path || '').trim();
          if (!value) return;
          setBusy(true);
          const ok = await onOpen(value);
          setBusy(false);
          if (ok) onClose();
        },
        [onOpen, onClose, path],
      );
      return h(
        'div',
        { className: 'dgc-modalBackdrop', role: 'dialog', 'aria-modal': 'true', onClick: (event) => {
          if (event.target === event.currentTarget) onClose();
        } },
        h(
          'div',
          { className: 'dgc-modal', style: { maxWidth: 620 } },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h(Icon, { name: 'folder' }),
            h('h3', null, t('openProject')),
            onNewProject
              ? h(Button, { icon: 'plus', onClick: onNewProject, title: t('newProjectHint') }, t('newProject'))
              : null,
            h(Button, { variant: 'ghost', onClick: onClose, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-modalBody', style: { flexDirection: 'column', overflow: 'auto' } },
            h(
              'div',
              { style: { padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: { display: 'flex', gap: 8 } },
                h('input', {
                  className: 'dgc-input is-mono',
                  placeholder: t('openProjectPlaceholder'),
                  value: path,
                  onChange: (event) => setPath(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submit();
                  },
                  autoFocus: true,
                }),
                h(Button, { variant: 'primary', disabled: busy, onClick: () => submit() }, busy ? t('loading') : t('open')),
              ),
              recent.length > 0
                ? h(
                    'div',
                    null,
                    h('div', { className: 'dgc-sectionTitle' }, t('recent')),
                    recent.slice(0, 8).map((item) =>
                      h(
                        'div',
                        { key: item, className: 'dgc-row', onClick: () => submit(item), title: item },
                        h(Icon, { name: 'dot', size: 12 }),
                        h('span', { className: 'dgc-rowLabel dgc-mono' }, item),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                null,
                h('div', { className: 'dgc-sectionTitle' }, t('projects')),
                projects.length === 0
                  ? h('div', { className: 'dgc-hint', style: { padding: '2px 0' } }, t('noProjectHint'))
                  : projects.slice(0, 40).map((item) => {
                      const dir = typeof item === 'string' ? item : item.dir;
                      const title = typeof item === 'string' ? item.split('/').filter(Boolean).pop() : item.title || item.dir;
                      const counts = typeof item === 'object' && item.staffs !== undefined ? ' · ' + item.staffs + ' 谱表' : '';
                      return h(
                        'div',
                        { key: dir, className: 'dgc-row', onClick: () => submit(dir), title: dir },
                        h(Icon, { name: 'folder', size: 13 }),
                        h('span', { className: 'dgc-rowLabel' }, title),
                        h('span', { className: 'dgc-rowMeta' }, counts),
                      );
                    }),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * Modal that creates a brand-new project folder.
     *
     * Fields: the folder name, its parent (defaults to the configured project
     * root), the starter staff template and the initial period length. The
     * resulting path is previewed; `onCreate(request)` posts to the Host and
     * resolves `{ ok }` or `{ ok: false, error }` so validation failures stay
     * inline instead of closing the dialog.
     */
    function CreateProjectDialog(props) {
      const { t, projectRoot, onCreate, onClose } = props;
      const [name, setName] = useState('');
      const [parent, setParent] = useState(projectRoot || '');
      const [template, setTemplate] = useState('chart');
      const [length, setLength] = useState('180');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      useDialogEscape(() => {
        if (!busy) onClose();
      });
      const trimmedParent = String(parent || '').trim().replace(/[\\/]+$/, '');
      const preview = trimmedParent && String(name || '').trim() ? trimmedParent + '/' + String(name).trim() : '';
      const submit = async () => {
        if (busy) return;
        const projectName = String(name || '').trim();
        const problem = projectNameProblem(projectName);
        if (problem === 'required') {
          setError(t('projectNameRequired'));
          return;
        }
        if (problem) {
          setError(t('projectNameInvalid'));
          return;
        }
        if (trimmedParent.length === 0) {
          setError(t('projectParentRequired'));
          return;
        }
        const rawLength = String(length || '').trim();
        const seconds = rawLength === '' ? 180 : Number(rawLength);
        if (!Number.isFinite(seconds) || seconds < 0) {
          setError(t('projectLengthInvalid'));
          return;
        }
        setError('');
        setBusy(true);
        let result;
        try {
          result = await onCreate({ name: projectName, parent: trimmedParent, template, minLength: seconds });
        } catch (failure) {
          result = { ok: false, error: String((failure && failure.message) || failure) };
        }
        if (result && result.ok) {
          onClose();
          return;
        }
        setBusy(false);
        setError((result && result.error) || t('loadFailed'));
      };
      const kindCard = (value, label, description) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dgc-kindCard' + (template === value ? ' is-active' : ''),
            onClick: () => setTemplate(value),
            'aria-pressed': template === value,
          },
          h('strong', null, label),
          h('span', null, description),
        );
      return h(
        'div',
        {
          className: 'dgc-modalBackdrop',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          { className: 'dgc-modal', style: { width: 'min(520px,94vw)' } },
          h(
            'div',
            { className: 'dgc-modalHead' },
            h(Icon, { name: 'plus' }),
            h('h3', null, t('newProject')),
            h(Button, { variant: 'ghost', onClick: onClose, title: t('close') }, '×'),
          ),
          h(
            'div',
            { className: 'dgc-dialogBody' },
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('projectNameLabel'),
              h('input', {
                className: 'dgc-input',
                value: name,
                autoFocus: true,
                spellCheck: false,
                placeholder: t('projectNamePlaceholder'),
                onChange: (event) => {
                  setName(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit();
                },
              }),
            ),
            h(
              'label',
              { className: 'dgc-dialogField' },
              t('projectParentLabel'),
              h('input', {
                className: 'dgc-input is-mono',
                value: parent,
                spellCheck: false,
                onChange: (event) => {
                  setParent(event.target.value);
                  setError('');
                },
              }),
            ),
            h('div', { className: 'dgc-hint', style: { marginTop: -4 } }, t('projectParentHint')),
            h(
              'div',
              { className: 'dgc-dialogField' },
              t('projectTemplateLabel'),
              h(
                'div',
                { className: 'dgc-kindGrid' },
                kindCard('chart', t('projectTemplateChart'), t('projectTemplateChartDesc')),
                kindCard('storyboard', t('projectTemplateStoryboard'), t('projectTemplateStoryboardDesc')),
              ),
            ),
            h(
              'label',
              { className: 'dgc-dialogField', style: { maxWidth: 200 } },
              t('projectLengthLabel'),
              h('input', {
                className: 'dgc-input',
                type: 'number',
                min: 0,
                step: 1,
                value: length,
                onChange: (event) => {
                  setLength(event.target.value);
                  setError('');
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit();
                },
              }),
            ),
            h('div', { className: 'dgc-hint', style: { marginTop: -4 } }, t('projectLengthHint')),
            preview
              ? h(
                  'div',
                  { className: 'dgc-dialogField' },
                  t('projectPathPreview'),
                  h('div', { className: 'dgc-listRowSlim dgc-mono', style: { wordBreak: 'break-all', padding: '2px 0' } }, preview),
                )
              : null,
            error ? h('div', { className: 'dgc-listRowSlim dgc-err' }, error) : null,
            h('div', { className: 'dgc-hint', style: { padding: 0 } }, t('newProjectHint')),
          ),
          h(
            'div',
            { className: 'dgc-dialogFoot' },
            h('span', { className: 'dgc-spacer' }),
            h(Button, { onClick: onClose, disabled: busy }, t('cancel')),
            h(
              Button,
              { variant: 'primary', icon: 'plus', disabled: busy, onClick: () => submit() },
              busy ? t('projectCreating') : t('create'),
            ),
          ),
        ),
      );
    }

    // ========================================================================
    // 17 · Playback scene (Dremu form renderer — playback only, no chart signals)
    // ========================================================================
    //
    // Ports the *visual* part of the Unity GorgeStudio "Dremu" form to a 2D
    // canvas so a chart can be previewed in the browser. The formulas, engine
    // defaults and known deviations are documented in docs/playback-model.md.
    //
    // Deliberately NOT implemented: the Gorge signal system (SignalTsiga, touch
    // / float / bool signals), judgement, scoring, respond hints, inner-note
    // hits and hold audio effects. The only "state" is PLAYER.hideHeadAtHit, a
    // fixed autoplay visual rule: note heads vanish at their hit time and hold
    // bodies shrink from the judgement line until the release time.

    /** 16:10 content box + camera constants (GamePlay scene, orthographic 5). */
    const PLAYER = {
      aspect: 16 / 10,
      cameraHeight: 10,
      laneWidth: 0.1,
      noteWidth: 2.0,
      noteHeight: 0.4,
      hideHeadAtHit: true,
      clearColor: '#314d79',
      maxPointCount: 2000,
      rateOptions: RATE_OPTIONS,
    };

    /**
     * Dremu note sprites, embedded from the Unity form package
     * (Packages/cn.starbow.gorge.sampleforms/Dremu/Dremu/FormAsset/*.png).
     * 200x40 white RGB + alpha; drawn at 2.0x0.4 world units (100 px/unit), so
     * the nine-slice borders are the identity at that size.
     */
    const PLAYER_SPRITES = {
      tap: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAYAAAC7HLUcAAAACXBIWXMAAAsTAAALEwEAmpwYAAACcElEQVR4nO2d2W7iQBREC5T/pvhy5gEyE8DLXcptZ6gjIWNs+nakOsZL2zndbjcIuTymV2WjxgThy7TNl6oh3OXgj3lLYkZC/NtAf8+3OSsawbscxHNnjdkS4jlvr3ksoxBkrjOEJTHbQ0znTCJJV5C1ThCWxGwHsZyvtiQdQaLFCUti9BCxXLUkqQqSLUpYEqODyOWpLElFkGoxwpKYPkQtR6XcZgXp7tMRlsTUIXr5Sec3I4jq1BlhSUweQpObVI6jgsjOKz84Cdsyn4FyyEc4zxFB1HJcxe2Zz0Cdm1Cu1wSxHOZIDJdkSRDLYY7IUEnmBLEc5sgMk2RKkL3kuOB+IOaXXxesM0SSV0EmV2qQkUNZ1/xuiINIcl5a2MRymA7EASQ5T30owHIYBcTOknzBcphjw8d07Q7V7+VcWinBBbj/gqivat+C6/lquokSzYo8y2fcjVPeP07EfhbVdc3/SXSPhNCO8SOA6/nnjLhxS2K67CoH8HwW6++HwiKWxFTZXQ7g/TrI00JRMUtishxCDgA4zTw4bvPCxjQhBmR0bizW5MrN4so/xnw2xKAN+NJo3tkvNTphSUwXYuDezdr9IItfLnbGkpgqxOBd/8gdhauNJCEsiclD7HBcHL0nPdRYAl9FN1miIzQiEME8Z55qEm50Bd88ZSqockMkcpx9Llaq8Qksh+nQzQ+RzG9WkFKRB5bDKKjmiCjktiJIpZjlMEqyeSKKez5VQTJFLYfZgsxwlPJhQUeQSHHLYbZkLV9E88RSV5ClTlgOM4K5nBGCs64KQYD3zlgOM5LXvBGi63bK/3LLmffGjOB1Ay3hD4ECL19aoJfNAAAAAElFTkSuQmCC',
      drag: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAYAAAC7HLUcAAAACXBIWXMAAAsTAAALEwEAmpwYAAACWUlEQVR4nO3dPXLTUBiF4deU2UmCS6C1sgmgFHU2wSaooxLYBHLJT2nCTtyK4kbg0ciKLH2KJc/7zKiyo0lmvjP3SLp2VlVVIandi3P/AtKcGRCpgwGROhgQqUNkQK6Ae6Dy8DjjcU+axRCroLtY18BXYB1xMmmkHfAOeBh7oogVJAd+YTg0H2vgJ2k2RxkTkLpShS5pUpCQ+RxasaxUWpLBlWvICpJjpdKyDK5cpwTESqUlGzS/fSuWlUqXZAe8B34/9cY+K0iOlUqXZQ38oEfl6gqIlUqXrNd8HwvINfCdgPvILbbALbDy8DjhuCXNTrScNOsv215sC0jONJVqS/ojM6AMPrcuX0manSmCcrRyHV6kXwGf2t400hb4iKFQrIw0V5vg8xbAHbCH/wG5Ab4Qu2oYDD2HjPig/LvLtaqqKietHFEX4gZD55ARG5Q9cDfF50HqbcfSc5pk7uqKtSZVrJvAc5ekRE9x50GqbUhzlgWe8w/wFtjVK8gOeE26QImSkULyjfgLKWlDmq2S2HAUwCtSJlq3muTEXpPUSlxRNN4UKwY8XnPQWCSO7cWaonLVSgyKTjdVMOCgUjVf6NqsONVzEWlOCg6eezR13cXaAx8ej9Yflhas13z33e6+Bj5zZL+KtDBHK1VT3+cgO+ANsXe5pHMoOLhL9ZRTHhRaubRkg+Z36Jc2WLm0JL0rVdPQrSZWLi1FwQmVqmnMXiwrl+YsZD6jvnrUyqU5eSB9D9agVeNQ1G5eK5fmoiDtKxwdDohbQaSL5P8HkToYEKmDAZE6GBCpw194qkdqEvQK2gAAAABJRU5ErkJggg==',
      taplik: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAYAAAC7HLUcAAAACXBIWXMAAAsTAAALEwEAmpwYAAADDUlEQVR4nO2d646rMAyE3aN978w+uffHUp22y8WOHXLRfFLEVltsE81AgBIeqiqJlG35nRmUECP4WIb5ygokv+bAy2eahNwJ5P8O+vk5zL+MIPLXHJD3YglpCeRdb596rCbDIEfFQGgS0h7Ivs5STBI1yFUREJqEtANyrq+wSSIGsSaH0CQkH4hNVyGT1BrEmxRCk5A8ID49VZukxiC1ySA0CYkDqdNRlW69BomO6SDrmSRze0qDeCsBiW2TX7+qam1F8yiOvKO3rO0pyf3zjNe7f7IaNA9Y81qPIGnXlTceibFGAJK7Z8uOtwKZP/mw94/BRSXRuS73TtJeKRXrl5O+yojXu38y21lf1XCpxeEKmrB9UhzrFkOfReP17p/sZukzD6eaHKaQidsexbBecfRdJF7v/mnRPH1n4VCb3QtYoB1RTtYp9q4Lx+vdP63a2TbXsKvRbolvyNsCj0FU90VdAvlr4nlrHoGig5iE5vBRI7aiudvpjTejQVQHMQnN4aNWbEXz7yNZ481qENUBTEJz+JhRbDPW/ErRjib5ct00sfFtjLfizSySD7bl1ROqz//j7EsOisjvb7Gy72pb73iudjedtMOqlXwtb4cnJB+eitoOi9l5WzPjcGXGml+xDtebaLh5AkObySQzim3Gmp90NYfq38u8NMk5M4ptxppVBzCH7hiEJjlnRrHNWPMQ5lBVeajunlNDch+2gaw7T1bqzHsNWPViCOQGjR49D7L75WDy1Z5uI/2A3LQDP3tg6nClQBE0CYkCuXF0czX1KLZlVkHPeCsNt1YdwowI5Oahv+WR28sgTiA8khA/kA7nxdZn0k3BHHCvS7xkXgyBGPXsmfbHHPQC62+1CHklSzcQh46982K5gu9Ac5AIUf1AnPqtmVnRnWSD5iAZ1OoIUqHb2rl5vcloDpKJV0+QypFPZHZ3a1Kag7TAqitI4LQg+n6Qq+Q0B2nJlb4gwQtLGW+YOiqC5iB3cKQzSMJV16x3FELei6E5yJ186g2SdN8u8y23OPibkDv43EGn8AOcxPEhcNaELQAAAABJRU5ErkJggg==',
    };

    /** Cached HTMLImageElements for the note sprites (null when unavailable). */
    const PLAYER_SPRITE_STATE = { tap: null, drag: null, taplik: null, v: 0 };

    /** DremuRespondHint / Heart textures (same form package). */
    const PLAYER_EFFECT_SPRITES = {
      hint: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAVQAAAFUCAYAAAB7ksS1AAAACXBIWXMAAAsTAAALEwEAmpwYAAALRWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOnRpZmY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vdGlmZi8xLjAvIiB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDIzLTA0LTI2VDAzOjUwOjU1KzA4OjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDIzLTA0LTI2VDA0OjA4OjQ1KzA4OjAwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyMy0wNC0yNlQwNDowODo0NSswODowMCIgZGM6Zm9ybWF0PSJpbWFnZS9wbmciIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6NjA5MjAyYjQtMmYzMC0wZDQ1LTg3NDYtMzE0MzAwYTYxMGRkIiB4bXBNTTpEb2N1bWVudElEPSJhZG9iZTpkb2NpZDpwaG90b3Nob3A6YjA4Mjg0ZDgtM2E0ZS0yMzQ0LThlYmUtZGM5NjFlYTM5NjA5IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6OTlkOWQ1ZGUtOGI3Yy1mNTQ0LWIxZjktYjgwYjRlNjM5Mzk0IiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0ic1JHQiBJRUM2MTk2Ni0yLjEiIHRpZmY6T3JpZW50YXRpb249IjEiIHRpZmY6WFJlc29sdXRpb249IjcyMDAwMC8xMDAwMCIgdGlmZjpZUmVzb2x1dGlvbj0iNzIwMDAwLzEwMDAwIiB0aWZmOlJlc29sdXRpb25Vbml0PSIyIiBleGlmOkNvbG9yU3BhY2U9IjEiIGV4aWY6UGl4ZWxYRGltZW5zaW9uPSIzNDAiIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSIzNDAiPiA8eG1wTU06SGlzdG9yeT4gPHJkZjpTZXE+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjcmVhdGVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjk5ZDlkNWRlLThiN2MtZjU0NC1iMWY5LWI4MGI0ZTYzOTM5NCIgc3RFdnQ6d2hlbj0iMjAyMy0wNC0yNlQwMzo1MDo1NSswODowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDozZTQyZWZhZi1kZmVkLTUwNDgtOWFhMS1lNGM4M2NiNWQ1ZmUiIHN0RXZ0OndoZW49IjIwMjMtMDQtMjZUMDM6NTg6MDgrMDg6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChXaW5kb3dzKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6OWU4M2YzNGUtZGNkYi02ZDRiLWFkNTEtZGYxYjcxNDBkOTk2IiBzdEV2dDp3aGVuPSIyMDIzLTA0LTI2VDA0OjA4OjQ1KzA4OjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249ImNvbnZlcnRlZCIgc3RFdnQ6cGFyYW1ldGVycz0iZnJvbSBhcHBsaWNhdGlvbi92bmQuYWRvYmUucGhvdG9zaG9wIHRvIGltYWdlL3BuZyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iZGVyaXZlZCIgc3RFdnQ6cGFyYW1ldGVycz0iY29udmVydGVkIGZyb20gYXBwbGljYXRpb24vdm5kLmFkb2JlLnBob3Rvc2hvcCB0byBpbWFnZS9wbmciLz4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjYwOTIwMmI0LTJmMzAtMGQ0NS04NzQ2LTMxNDMwMGE2MTBkZCIgc3RFdnQ6d2hlbj0iMjAyMy0wNC0yNlQwNDowODo0NSswODowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiBzdEV2dDpjaGFuZ2VkPSIvIi8+IDwvcmRmOlNlcT4gPC94bXBNTTpIaXN0b3J5PiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDo5ZTgzZjM0ZS1kY2RiLTZkNGItYWQ1MS1kZjFiNzE0MGQ5OTYiIHN0UmVmOmRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDoxODRkZWIzMS05N2ZkLWU3NDAtYThkNC03MTM4MjhkZjY1ZTQiIHN0UmVmOm9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo5OWQ5ZDVkZS04Yjdj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',
      heart: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAACXBIWXMAAAsTAAALEwEAmpwYAAAE8GlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgOS4xLWMwMDIgNzkuYTZhNjM5NiwgMjAyNC8wMy8xMi0wNzo0ODoyMyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDI1LjExIChXaW5kb3dzKSIgeG1wOkNyZWF0ZURhdGU9IjIwMjQtMTEtMjNUMjM6MDM6MjIrMDg6MDAiIHhtcDpNZXRhZGF0YURhdGU9IjIwMjQtMTEtMjNUMjM6MDM6MjIrMDg6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDI0LTExLTIzVDIzOjAzOjIyKzA4OjAwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo0YWY0OTk3YS0zNDNjLTc4NDEtODdhMy0wN2Y5NGYyMzhkOTkiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6NGFmNDk5N2EtMzQzYy03ODQxLTg3YTMtMDdmOTRmMjM4ZDk5IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6NGFmNDk5N2EtMzQzYy03ODQxLTg3YTMtMDdmOTRmMjM4ZDk5IiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIj4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo0YWY0OTk3YS0zNDNjLTc4NDEtODdhMy0wN2Y5NGYyMzhkOTkiIHN0RXZ0OndoZW49IjIwMjQtMTEtMjNUMjM6MDM6MjIrMDg6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCAyNS4xMSAoV2luZG93cykiLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+Xn4pGgAAAONJREFUWIXN19sKgzAQhOEIvnfSJ59e1LZ42GR3ZzwsiLmQnw+CEScAxTF1ub88D0t7AEZXxX+q43lpLxJTIMO9aIxBpnqZWAaZ7mVjESTVY2IeJN1jYz2kpKeI7aLK3rwcmk1w+DZjTfXmUsokiK2iwpm+W9IEW6Kehs1L8iRkg3HMPAH5w8E4qO9ErnDofOruQO5wPeDVyEPcCHgV0sR5gGcjuzgv8CzkEBcBqpEuXBSoQrpxGSCLDOGywCwyjGOAUWQKxwK9yDROARwhKZwKaCFpnBK4RUpwwOefRDXNWFPzBgYjM6jf31slAAAAAElFTkSuQmCC',
    };
    /** DremuNativeResources @InstantAudio RespondA (RespondEffect.wav). */
    const PLAYER_RESPONSE_SOUND = 'data:audio/wav;base64,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ZW1lbnRzLzEuMS8iPgogICAgICAgICA8eG1wRE06VHJhY2tzPgogICAgICAgICAgICA8cmRmOkJhZz4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDx4bXBETTp0cmFja05hbWU+Q3VlUG9pbnQgTWFya2VyczwveG1wRE06dHJhY2tOYW1lPgogICAgICAgICAgICAgICAgICA8eG1wRE06dHJhY2tUeXBlPkN1ZTwveG1wRE06dHJhY2tUeXBlPgogICAgICAgICAgICAgICAgICA8eG1wRE06ZnJhbWVSYXRlPmY0NDEwMDwveG1wRE06ZnJhbWVSYXRlPgogICAgICAgICAgICAgICA8L3JkZjpsaT4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDx4bXBETTp0cmFja05hbWU+Q0QgVHJhY2sgTWFya2VyczwveG1wRE06dHJhY2tOYW1lPgogICAgICAgICAgICAgICAgICA8eG1wRE06dHJhY2tUeXBlPlRyYWNrPC94bXBETTp0cmFja1R5cGU+CiAgICAgICAgICAgICAgICAgIDx4bXBETTpmcmFtZVJhdGU+ZjQ0MTAwPC94bXBETTpmcmFtZVJhdGU+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHhtcERNOnRyYWNrTmFtZT5TdWJjbGlwIE1hcmtlcnM8L3htcERNOnRyYWNrTmFtZT4KICAgICAgICAgICAgICAgICAgPHhtcERNOnRyYWNrVHlwZT5Jbk91dDwveG1wRE06dHJhY2tUeXBlPgogICAgICAgICAgICAgICAgICA8eG1wRE06ZnJhbWVSYXRlPmY0NDEwMDwveG1wRE06ZnJhbWVSYXRlPgogICAgICAgICAgICAgICA8L3JkZjpsaT4KICAgICAgICAgICAgPC9yZGY6QmFnPgogICAgICAgICA8L3htcERNOlRyYWNrcz4KICAgICAgICAgPHhtcDpNZXRhZGF0YURhdGU+MjAyMy0wNC0yMlQyMjoxNDowMiswODowMDwveG1wOk1ldGFkYXRhRGF0ZT4KICAgICAgICAgPHhtcDpNb2RpZnlEYXRlPjIwMjMtMDQtMjJUMjI6MTQ6MDIrMDg6MDA8L3htcDpNb2RpZnlEYXRlPgogICAgICAgICA8eG1wTU06SW5zdGFuY2VJRD54bXAuaWlkOjQwNjFjNmQ2LWY5MGEtNjQ0OS1iNjBjLTQ1ODk4NmM2ZmNhZjwveG1wTU06SW5zdGFuY2VJRD4KICAgICAgICAgPHhtcE1NOkRvY3VtZW50SUQ+eG1wLmRpZDo3ZDE1OGFhMy02NTQ1LTNhNDUtYTM5Ny05OWQ3NjdjMzc4ZWU8L3htcE1NOkRvY3VtZW50SUQ+CiAgICAgICAgIDx4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ+eG1wLmRpZDo3ZDE1OGFhMy02NTQ1LTNhNDUtYTM5Ny05OWQ3NjdjMzc4ZWU8L3htcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD4KICAgICAgICAgPHhtcE1NOkhpc3Rvcnk+CiAgICAgICAgICAgIDxyZGY6U2VxPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmFjdGlvbj5zYXZlZDwvc3RFdnQ6YWN0aW9uPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6aW5zdGFuY2VJRD54bXAuaWlkOjdkMTU4YWEzLTY1NDUtM2E0NS1hMzk3LTk5ZDc2N2MzNzhlZTwvc3RFdnQ6aW5zdGFuY2VJRD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OndoZW4+MjAyMy0wNC0yMlQyMjoxNDowMiswODowMDwvc3RFdnQ6d2hlbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnNvZnR3YXJlQWdlbnQ+QWRvYmUgQXVkaXRpb24gQ0MgMjAxOC4wIChXaW5kb3dzKTwvc3RFdnQ6c29mdHdhcmVBZ2VudD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmNoYW5nZWQ+L21ldGFkYXRhPC9zdEV2dDpjaGFuZ2VkPgogICAgICAgICAgICAgICA8L3JkZjpsaT4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDphY3Rpb24+c2F2ZWQ8L3N0RXZ0OmFjdGlvbj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0Omluc3RhbmNlSUQ+eG1wLmlpZDo0MDYxYzZkNi1mOTBhLTY0NDktYjYwYy00NTg5ODZjNmZjYWY8L3N0RXZ0Omluc3RhbmNlSUQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDp3aGVuPjIwMjMtMDQtMjJUMjI6MTQ6MDIrMDg6MDA8L3N0RXZ0OndoZW4+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpzb2Z0d2FyZUFnZW50PkFkb2JlIEF1ZGl0aW9uIENDIDIwMTguMCAoV2luZG93cyk8L3N0RXZ0OnNvZnR3YXJlQWdlbnQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpjaGFuZ2VkPi88L3N0RXZ0OmNoYW5nZWQ+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICA8L3JkZjpTZXE+CiAgICAgICAgIDwveG1wTU06SGlzdG9yeT4KICAgICAgICAgPGRjOmZvcm1hdD5hdWRpby94LXdhdjwvZGM6Zm9ybWF0PgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSJ3Ij8+';
    const PLAYER_EFFECT_STATE = { hint: null, heart: null };

    /** Load the three embedded note textures once; `onLoaded` bumps a repaint. */
    function ensurePlayerSprites(onLoaded) {
      if (typeof window === 'undefined' || typeof window.Image !== 'function') return;
      for (const kind of ['tap', 'drag', 'taplik']) {
        if (PLAYER_SPRITE_STATE[kind]) continue;
        const image = new window.Image();
        PLAYER_SPRITE_STATE[kind] = { image, ready: false };
        image.onload = () => {
          PLAYER_SPRITE_STATE[kind].ready = true;
          PLAYER_SPRITE_STATE.v += 1;
          if (typeof onLoaded === 'function') onLoaded();
        };
        image.onerror = () => {
          PLAYER_SPRITE_STATE[kind].ready = false;
        };
        image.src = PLAYER_SPRITES[kind];
      }
    }

    /** Load the hit-response textures once; `onLoaded` bumps a repaint. */
    function ensurePlayerEffects(onLoaded) {
      if (typeof window === 'undefined' || typeof window.Image !== 'function') return;
      for (const kind of ['hint', 'heart']) {
        if (PLAYER_EFFECT_STATE[kind]) continue;
        const image = new window.Image();
        PLAYER_EFFECT_STATE[kind] = { image, ready: false };
        image.onload = () => {
          PLAYER_EFFECT_STATE[kind].ready = true;
          if (typeof onLoaded === 'function') onLoaded();
        };
        image.onerror = () => {
          PLAYER_EFFECT_STATE[kind].ready = false;
        };
        image.src = PLAYER_EFFECT_SPRITES[kind];
      }
    }

    // ---- Engine defaults -------------------------------------------------
    // These mirror the `[auto defaultValue ...]` declarations of the Unity
    // Dremu form, NOT the CATALOG authoring defaults (LANE_COLOR / NOTE_COLOR
    // are only used when a *new* element is created in the editor).
    const GORGE = 'GorgeFramework.';
    const WHITE_COLOR = Object.freeze({ a: 1, r: 1, g: 1, b: 1 });

    function playerValueFloat(baseValue) {
      return { t: 'obj', type: GORGE + 'VariableFloat', fields: { baseValue } };
    }
    function playerLinearCurve(k, b) {
      return { t: 'obj', type: GORGE + 'LinearFunctionCurve', fields: { k, b } };
    }
    function playerConstantCurve(value) {
      return { t: 'obj', type: GORGE + 'ConstantFunctionCurve', fields: { value } };
    }

    const PLAYER_NOTE_DEFAULTS = {
      laneName: '',
      hitTime: 0,
      leadTime: 1.5,
      lagTime: 1.5,
      position: playerValueFloat(0),
      distance: playerLinearCurve(-8, 0),
      color: null,
      hintReference: false,
      positionZ: -2,
    };
    const PLAYER_HOLD_DEFAULTS = Object.assign({}, PLAYER_NOTE_DEFAULTS, {
      holdTime: 1,
      endDistance: playerLinearCurve(-8, 0),
      holdLine: playerConstantCurve(0),
      truncation: true,
      holdLength: 1,
      pointCount: 100,
      targetProjectionFix: true,
    });
    const PLAYER_LANE_DEFAULTS = {
      name: '',
      generateTime: 0,
      keepTime: 10,
      laneLines: [],
      animation: playerLinearCurve(1, 0),
      drawStartX: playerValueFloat(-10),
      drawEndX: playerValueFloat(10),
      pointCount: 100,
      evaluateDelta: 0.01,
      color: null,
      positionZ: -1,
    };
    const PLAYER_MAIN_LANE_DEFAULTS = Object.assign({}, PLAYER_LANE_DEFAULTS, {
      positionX: playerValueFloat(0),
      positionY: playerValueFloat(0),
      rotationZ: playerValueFloat(0),
    });
    const PLAYER_GUIDE_LANE_DEFAULTS = Object.assign({}, PLAYER_LANE_DEFAULTS, {
      mainLaneName: '',
      position: playerValueFloat(0),
      targetProjectionFix: true,
    });
    const PLAYER_STORYBOARD_DEFAULTS = {
      assetName: '',
      startMoment: 0,
      keepTime: 1,
      positionMode: 'ScreenX',
      positionX: playerValueFloat(0),
      positionY: playerValueFloat(0),
      rotationZ: playerValueFloat(0),
      scaleX: playerValueFloat(1),
      scaleY: playerValueFloat(1),
      positionZ: playerValueFloat(1),
      alpha: playerValueFloat(1),
      useChartTime: false,
    };

    // ---- Value / curve helpers -------------------------------------------
    function playerNumber(value, fallback) {
      const number = valueAsNumber(value);
      return Number.isFinite(number) ? number : fallback;
    }
    function playerBool(value, fallback) {
      return typeof value === 'boolean' ? value : fallback;
    }
    function playerString(value, fallback) {
      return typeof value === 'string' ? value : fallback;
    }
    function playerEnumName(value, fallback) {
      if (typeof value === 'string' && value.length > 0) return stripNamespace(value);
      if (isTypedValue(value) && value.t === 'ref' && typeof value.path === 'string') return stripNamespace(value.path);
      return fallback;
    }
    /** Clamp a user-supplied point count into a safe drawing range. */
    function playerPointCount(value, fallback) {
      const count = Math.round(playerNumber(value, fallback));
      return Number.isFinite(count) ? clamp(count, 2, PLAYER.maxPointCount) : 2;
    }
    /** Evaluate a FunctionCurve-ish typed value at x (0 on unknown data). */
    function playerCurveValue(value, x) {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      const sampled = sampleCurve(value, x);
      return Number.isFinite(sampled) ? sampled : 0;
    }
    /** `VariableFloat.EvaluateAdd` (base + curve), also handles plain curves. */
    function evalAdd(value, x) {
      if (value === null || value === undefined) return 0;
      const sampled = sampleCurve(value, x);
      return Number.isFinite(sampled) ? sampled : 0;
    }
    /**
     * `VariableFloat.EvaluateDoubleLerp(t, min, max)` as observed in the
     * shipped charts (storyboard alpha fades: baseValue 1 + curve -1..0 => 0..1).
     */
    function evalDoubleLerp(value, x, min, max) {
      if (!isTypedValue(value) || value.t !== 'obj') {
        const sampled = sampleCurve(value, x);
        return Number.isFinite(sampled) ? sampled : min;
      }
      const fields = value.fields || {};
      const base = playerNumber(fields.baseValue, 0);
      if (fields.variationCurve === null || fields.variationCurve === undefined) return base;
      const curve = sampleCurve(fields.variationCurve, x);
      return base + min + (max - min) * (Number.isFinite(curve) ? curve : 0);
    }
    /** `{ a, r, g, b }` from a ColorArgb-ish typed value (defaults are 1). */
    function playerColorFromValue(value) {
      if (!isTypedValue(value) || value.t !== 'obj') return WHITE_COLOR;
      const fields = value.fields || {};
      const channel = (name) => {
        const raw = valueAsNumber(fields[name]);
        if (!Number.isFinite(raw)) return 1;
        return clamp(raw > 1 ? raw / 255 : raw, 0, 1);
      };
      return { a: channel('a'), r: channel('r'), g: channel('g'), b: channel('b') };
    }
    /** Sample a `LerpColorCurve` at x (null/other => white, like Unity). */
    function colorCurveAt(value, x) {
      if (!isTypedValue(value) || value.t !== 'obj') return WHITE_COLOR;
      if (stripNamespace(value.type) !== 'LerpColorCurve') return WHITE_COLOR;
      const fields = value.fields || {};
      const list = fields.colorPoints;
      const items = isTypedValue(list) && list.t === 'arr' && Array.isArray(list.items) ? list.items : [];
      const count = items.length;
      if (count === 0) return WHITE_COLOR;
      const progressCurve = fields.progressCurve;
      if (progressCurve === null || progressCurve === undefined) return playerColorFromValue(items[0]);
      const raw = sampleCurve(progressCurve, x);
      const progress = Number.isFinite(raw) ? raw : 0;
      const first = clamp(Math.floor(progress), 0, count - 1);
      const second = clamp(Math.ceil(progress), 0, count - 1);
      const a = playerColorFromValue(items[first]);
      if (first === second) return a;
      const b = playerColorFromValue(items[second]);
      const mix = progress - first;
      return {
        a: a.a + (b.a - a.a) * mix,
        r: a.r + (b.r - a.r) * mix,
        g: a.g + (b.g - a.g) * mix,
        b: a.b + (b.b - a.b) * mix,
      };
    }
    function playerCssColor(color, alpha) {
      const c = color || WHITE_COLOR;
      const a = clamp(alpha === undefined ? c.a : alpha, 0, 1);
      return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + a + ')';
    }

    // ---- Model normalization ---------------------------------------------
    /** Absolute start time from a wire element (fields keep period-local time). */
    function playerElementStart(element, fieldFallback, fallback) {
      if (element && Number.isFinite(element.start)) return element.start;
      return playerNumber(fieldFallback, fallback);
    }
    function playerElementDuration(element, fieldFallback, fallback) {
      if (element && Number.isFinite(element.duration)) return element.duration;
      return playerNumber(fieldFallback, fallback);
    }
    function playerArrayItems(value) {
      if (isTypedValue(value) && value.t === 'arr' && Array.isArray(value.items)) return value.items;
      if (Array.isArray(value)) return value;
      return [];
    }

    function normalizePlaybackLane(element, type) {
      const fields = element.fields || {};
      const kind = type === 'DremuGuideLane' ? 'guide' : 'main';
      const defaults = kind === 'guide' ? PLAYER_GUIDE_LANE_DEFAULTS : PLAYER_MAIN_LANE_DEFAULTS;
      const start = playerElementStart(element, fields.generateTime, defaults.generateTime);
      const keepRaw = playerElementDuration(element, fields.keepTime, defaults.keepTime);
      const delta = playerNumber(fields.evaluateDelta, defaults.evaluateDelta);
      const lane = {
        id: element.id,
        type: element.type,
        kind,
        name: playerString(fields.name, defaults.name),
        start,
        keep: Math.max(0.0001, Number.isFinite(keepRaw) ? keepRaw : defaults.keepTime),
        laneLines: playerArrayItems(fields.laneLines),
        animation: fields.animation === undefined ? defaults.animation : fields.animation,
        drawStartX: fields.drawStartX === undefined ? defaults.drawStartX : fields.drawStartX,
        drawEndX: fields.drawEndX === undefined ? defaults.drawEndX : fields.drawEndX,
        pointCount: playerPointCount(fields.pointCount, defaults.pointCount),
        evaluateDelta: delta > 0 && Number.isFinite(delta) ? delta : 0.01,
        color: fields.color === undefined ? null : fields.color,
        positionZ: playerNumber(fields.positionZ, defaults.positionZ),
        mainLaneName: playerString(fields.mainLaneName, kind === 'guide' ? defaults.mainLaneName : ''),
        position: fields.position === undefined ? (defaults.position || playerValueFloat(0)) : fields.position,
        targetProjectionFix: playerBool(fields.targetProjectionFix, kind === 'guide' ? defaults.targetProjectionFix : true),
        positionX: kind === 'main' ? (fields.positionX === undefined ? defaults.positionX : fields.positionX) : null,
        positionY: kind === 'main' ? (fields.positionY === undefined ? defaults.positionY : fields.positionY) : null,
        rotationZ: kind === 'main' ? (fields.rotationZ === undefined ? defaults.rotationZ : fields.rotationZ) : null,
        mainLane: null,
        usable: kind === 'main',
      };
      return lane;
    }

    function normalizePlaybackNote(element, type) {
      const fields = element.fields || {};
      const hold = type === 'DremuHold';
      const noteKind = hold ? 'hold' : /DremuDrag$/.test(type) ? 'drag' : /DremuTaplik$/.test(type) ? 'taplik' : 'tap';
      const defaults = hold ? PLAYER_HOLD_DEFAULTS : PLAYER_NOTE_DEFAULTS;
      const start = playerElementStart(element, fields.hitTime, defaults.hitTime);
      const holdTime = hold ? Math.max(0.0001, playerElementDuration(element, fields.holdTime, defaults.holdTime)) : 0;
      const holdLength = playerNumber(fields.holdLength, PLAYER_HOLD_DEFAULTS.holdLength);
      return {
        id: element.id,
        type: element.type,
        kind: noteKind,
        laneName: playerString(fields.laneName, defaults.laneName),
        start,
        holdTime,
        leadTime: Math.max(0, playerNumber(fields.leadTime, defaults.leadTime)),
        lagTime: Math.max(0, playerNumber(fields.lagTime, defaults.lagTime)),
        position: fields.position === undefined ? defaults.position : fields.position,
        distance: fields.distance === undefined ? defaults.distance : fields.distance,
        color: fields.color === undefined ? null : fields.color,
        positionZ: playerNumber(fields.positionZ, defaults.positionZ),
        endDistance: fields.endDistance === undefined ? PLAYER_HOLD_DEFAULTS.endDistance : fields.endDistance,
        holdLine: fields.holdLine === undefined ? PLAYER_HOLD_DEFAULTS.holdLine : fields.holdLine,
        truncation: playerBool(fields.truncation, PLAYER_HOLD_DEFAULTS.truncation),
        holdLength: Math.abs(holdLength) > 1e-6 ? holdLength : 1,
        pointCount: playerPointCount(fields.pointCount, PLAYER_HOLD_DEFAULTS.pointCount),
        targetProjectionFix: playerBool(fields.targetProjectionFix, PLAYER_HOLD_DEFAULTS.targetProjectionFix),
        hintReference: playerBool(fields.hintReference, false),
        respondHintColor1: fields.respondHintColor1 === undefined ? null : fields.respondHintColor1,
        respondHintColor2: fields.respondHintColor2 === undefined ? null : fields.respondHintColor2,
        lane: null,
      };
    }

    /** `assetName : "image:Background1"` -> installed project file path. */
    function resolvePlaybackImageFiles(project) {
      const map = new Map();
      const files = project && project.assets && Array.isArray(project.assets.images) ? project.assets.images : [];
      const dir = project && typeof project.dir === 'string' ? project.dir.replace(/[/\\]+$/, '') : '';
      for (const raw of files) {
        const name = String(raw);
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const absolute = dir ? dir + '/' + name : name;
        map.set(stem.toLowerCase(), absolute);
        map.set(name.toLowerCase(), absolute);
      }
      return map;
    }
    function resolvePlaybackImagePath(filesMap, assetName) {
      let name = String(assetName || '');
      if (!name) return null;
      const colon = name.indexOf(':');
      if (colon !== -1) name = name.slice(colon + 1);
      const key = name.toLowerCase();
      if (filesMap.has(key)) return filesMap.get(key);
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
        if (filesMap.has(key + ext)) return filesMap.get(key + ext);
      }
      return null;
    }

    function normalizePlaybackImage(element, filesMap) {
      const fields = element.fields || {};
      const defaults = PLAYER_STORYBOARD_DEFAULTS;
      const start = playerElementStart(element, fields.startMoment, defaults.startMoment);
      const keep = Math.max(0.0001, playerElementDuration(element, fields.keepTime, defaults.keepTime));
      const assetName = playerString(fields.assetName, defaults.assetName);
      return {
        id: element.id,
        assetName,
        file: resolvePlaybackImagePath(filesMap, assetName),
        start,
        keep,
        mode: playerEnumName(fields.positionMode, defaults.positionMode),
        positionX: fields.positionX === undefined ? defaults.positionX : fields.positionX,
        positionY: fields.positionY === undefined ? defaults.positionY : fields.positionY,
        rotationZ: fields.rotationZ === undefined ? defaults.rotationZ : fields.rotationZ,
        scaleX: fields.scaleX === undefined ? defaults.scaleX : fields.scaleX,
        scaleY: fields.scaleY === undefined ? defaults.scaleY : fields.scaleY,
        positionZ: fields.positionZ === undefined ? defaults.positionZ : fields.positionZ,
        alpha: fields.alpha === undefined ? defaults.alpha : fields.alpha,
        useChartTime: playerBool(fields.useChartTime, defaults.useChartTime),
      };
    }

    // ---- Lane binding ----------------------------------------------------
    const PLAYBACK_EPSILON = 1e-6;
    function playbackLaneAlive(lane, at) {
      return at >= lane.start - PLAYBACK_EPSILON && at <= lane.start + lane.keep + PLAYBACK_EPSILON;
    }
    /**
     * Unity resolves lanes by name at the element's spawn time
     * (Environment.FindAliveLane: main lanes first, then guide lanes). When
     * several instances are alive we pick the most recently generated one;
     * charts normally keep names unique over time.
     */
    function findPlaybackLane(list, at, wantKind) {
      if (!Array.isArray(list) || list.length === 0) return null;
      let best = null;
      for (const lane of list) {
        if (wantKind && lane.kind !== wantKind) continue;
        if (!lane.usable) continue;
        if (!playbackLaneAlive(lane, at)) continue;
        if (!best || lane.start > best.start) best = lane;
      }
      return best;
    }

    /**
     * Build the immutable playback model from the wire project.
     * Every timing decision uses `element.start`/`element.duration` (absolute);
     * the raw fields only provide curve data and non-time values.
     */
    function buildPlaybackModel(project) {
      const stats = { mainLanes: 0, guideLanes: 0, notes: 0, boundNotes: 0, unresolvedNotes: 0, images: 0, skipped: 0 };
      const lanes = [];
      const notes = [];
      const images = [];
      const byName = new Map();
      if (!project || !Array.isArray(project.staffs)) return { lanes, notes, images, byName, stats };
      const imageFiles = resolvePlaybackImageFiles(project);
      for (const staff of project.staffs) {
        if (!staff || staff.kind === 'audio') continue;
        const form = typeof staff.form === 'string' ? staff.form : '';
        const periods = Array.isArray(staff.periods) ? staff.periods : [];
        for (const period of periods) {
          const elements = period && Array.isArray(period.elements) ? period.elements : [];
          for (const element of elements) {
            if (!element || typeof element.type !== 'string') { stats.skipped += 1; continue; }
            const type = shortType(element.type);
            if (type === 'DremuMainLane' || type === 'DremuGuideLane') {
              const lane = normalizePlaybackLane(element, type);
              lanes.push(lane);
              if (lane.kind === 'main') stats.mainLanes += 1;
              else stats.guideLanes += 1;
              if (lane.name) {
                if (!byName.has(lane.name)) byName.set(lane.name, []);
                byName.get(lane.name).push(lane);
              }
            } else if (type === 'DremuTap' || type === 'DremuDrag' || type === 'DremuTaplik' || type === 'DremuHold') {
              notes.push(normalizePlaybackNote(element, type));
              stats.notes += 1;
            } else if (type === 'Image' && (form === 'DeentyStoryboard' || element.type === 'DeentyStoryboard.Image')) {
              images.push(normalizePlaybackImage(element, imageFiles));
              stats.images += 1;
            } else {
              stats.skipped += 1;
            }
          }
        }
      }
      for (const lane of lanes) {
        if (lane.kind !== 'guide') continue;
        lane.mainLane = lane.mainLaneName ? findPlaybackLane(byName.get(lane.mainLaneName), lane.start, 'main') : null;
        lane.usable = !!lane.mainLane;
      }
      for (const note of notes) {
        const spawn = note.start - note.leadTime;
        const lane = findPlaybackLane(byName.get(note.laneName), spawn, 'main') || findPlaybackLane(byName.get(note.laneName), spawn, null);
        if (lane) {
          note.lane = lane;
          stats.boundNotes += 1;
        } else {
          stats.unresolvedNotes += 1;
        }
      }
      return { lanes, notes, images, byName, stats };
    }

    // ---- Frame geometry (all coordinates are 16:10 content space) -------
    const PLAYBACK_RAD = Math.PI / 180;
    // DremuRespondHint / DremuRespondHintHeartTransformer constants.
    const PLAYER_RESPONSE = { keepTime: 0.8, size: 2.5, expandSpeed: 5, alphaChangeSpeed: 0.2 };
    const PLAYER_RESPONSE_CURVE = {
      t: 'obj',
      type: 'GorgeFramework.CubicHermiteSpline',
      fields: {
        startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } },
        startTangent: 0,
        startWeight: 0,
        endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } },
        endTangent: 0.1,
        endWeight: 0.8,
      },
    };
    function playbackHash(value) {
      const textValue = String(value);
      let hash = 2166136261;
      for (let index = 0; index < textValue.length; index += 1) {
        hash ^= textValue.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }
    function playbackRandom(seed) {
      let state = seed >>> 0;
      return function random() {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Visible windows + the autoplay visual rule (no chart signals involved). */
    function playbackNoteHeadVisible(note, time) {
      const spawn = note.start - note.leadTime;
      if (time < spawn - PLAYBACK_EPSILON) return false;
      if (PLAYER.hideHeadAtHit) return time <= note.start + PLAYBACK_EPSILON;
      return time <= note.start + (note.kind === 'hold' ? note.holdTime : 0) + note.lagTime;
    }
    function playbackHoldBodyVisible(note, time) {
      if (note.kind !== 'hold') return false;
      if (time < note.start - note.leadTime - PLAYBACK_EPSILON) return false;
      return time < note.start + note.holdTime;
    }

    /**
     * Collect one rendered frame at chart time `time`.
     * Returns pure data (no canvas, no signals): lane polylines, hold ribbons,
     * note sprites and storyboard image rects, all in 16:10 content space.
     * `options.aspect` defaults to 16:10; `options.imageSize(entry)` must return
     * the natural pixel size `{ w, h }` of a storyboard image (else it is
     * skipped until its texture has loaded).
     */
    function collectFrame(model, time, options) {
      const opts = options || {};
      const aspect = Number.isFinite(opts.aspect) && opts.aspect > 0 ? opts.aspect : PLAYER.aspect;
      const imageSize = typeof opts.imageSize === 'function' ? opts.imageSize : null;
      const frameTime = Number.isFinite(time) ? time : 0;
      const frame = { images: [], lanes: [], holds: [], notes: [], effects: [] };
      if (!model) return frame;
      const curveStates = new Map();
      const poses = new Map();
      function laneProgressAt(lane, at) {
        if (at === frameTime) {
          let state = curveStates.get(lane);
          if (!state) {
            state = { progress: evalAdd(lane.animation, at - lane.start) };
            curveStates.set(lane, state);
          }
          return state.progress;
        }
        return evalAdd(lane.animation, at - lane.start);
      }
      function laneLineValueAt(lane, x, at) {
        const lines = lane.laneLines;
        const count = lines.length;
        if (count === 0) return 0;
        const progress = laneProgressAt(lane, at);
        const first = clamp(Math.floor(progress), 0, count - 1);
        const second = clamp(Math.ceil(progress), 0, count - 1);
        const y1 = playerCurveValue(lines[first], x);
        if (first === second) return y1;
        const y2 = playerCurveValue(lines[second], x);
        return y1 + (y2 - y1) * (progress - first);
      }
      function laneNormalAtTime(lane, x, at) {
        const delta = lane.evaluateDelta > 0 ? lane.evaluateDelta : 0.01;
        const y0 = laneLineValueAt(lane, x - delta, at);
        const y1 = laneLineValueAt(lane, x + delta, at);
        const tx = 2 * delta;
        const ty = y1 - y0;
        const length = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = -ty / length;
        const ny = tx / length;
        return { x: nx, y: ny, angle: Math.atan2(ny, nx) / PLAYBACK_RAD };
      }
      function mainPointAt(lane, x, distance, at) {
        const y = laneLineValueAt(lane, x, at);
        const normal = laneNormalAtTime(lane, x, at);
        return { x: x + normal.x * distance, y: y + normal.y * distance };
      }
      function guidePointAt(guide, x, distance, at) {
        const main = guide.mainLane;
        if (!main) return { x: 0, y: 0 };
        const offset = evalAdd(guide.position, at - guide.start);
        const shape = laneLineValueAt(guide, distance, at);
        return mainPointAt(main, x + offset + shape, distance, at);
      }
      function frameLaneOf(lane) {
        return lane.kind === 'guide' ? lane.mainLane : lane;
      }
      function poseAtTime(lane, at) {
        const target = frameLaneOf(lane);
        if (!target) return { x: 0, y: 0, rot: 0, cos: 1, sin: 0 };
        if (at === frameTime) {
          const cachedPose = poses.get(target);
          if (cachedPose) return cachedPose;
        }
        const age = at - target.start;
        const rot = evalAdd(target.rotationZ, age);
        const pose = {
          x: evalAdd(target.positionX, age),
          y: evalAdd(target.positionY, age),
          rot,
          cos: Math.cos(rot * PLAYBACK_RAD),
          sin: Math.sin(rot * PLAYBACK_RAD),
        };
        if (at === frameTime) poses.set(target, pose);
        return pose;
      }
      function applyPose(pose, point) {
        return {
          x: pose.x + point.x * pose.cos - point.y * pose.sin,
          y: pose.y + point.x * pose.sin + point.y * pose.cos,
        };
      }
      function lanePointAt(lane, x, distance, at) {
        return lane.kind === 'guide' ? guidePointAt(lane, x, distance, at) : mainPointAt(lane, x, distance, at);
      }
      function laneLineValue(lane, x) { return laneLineValueAt(lane, x, frameTime); }
      function laneNormalAt(lane, x) { return laneNormalAtTime(lane, x, frameTime); }
      function mainPoint(lane, x, distance) { return mainPointAt(lane, x, distance, frameTime); }
      function guidePoint(guide, x, distance) { return guidePointAt(guide, x, distance, frameTime); }
      function poseAt(lane) { return poseAtTime(lane, frameTime); }
      function lanePoint(lane, x, distance) { return lanePointAt(lane, x, distance, frameTime); }
      // Hit-response spawn state is fixed at the note's hit time and cached on
      // the note: local spawn point + colour pair + the 16 heart particles.
      function noteEffectData(note) {
        if (note.effect) return note.effect;
        const lane = note.lane;
        let local = { x: 0, y: 0 };
        if (lane && lane.usable) {
          if (note.kind === 'hold') {
            const mainX = evalAdd(note.position, 0);
            let fix = 1;
            const normalLane = lane.kind === 'guide' ? lane.mainLane : lane;
            if (note.targetProjectionFix && normalLane) {
              fix = Math.sin(laneNormalAtTime(normalLane, mainX, note.start).angle * PLAYBACK_RAD);
            }
            local = lanePointAt(lane, mainX + evalAdd(note.holdLine, 0) * fix, 0, note.start);
          } else {
            local = lanePointAt(lane, evalAdd(note.position, 0), evalAdd(note.distance, 0), note.start);
          }
        }
        const random = playbackRandom(playbackHash(note.id));
        const hearts = [];
        for (let index = 0; index < 16; index += 1) {
          const angle = random() * Math.PI * 2;
          hearts.push({
            dx: Math.cos(angle),
            dy: Math.sin(angle),
            distance: 1.2 + random() * 1.3,
            finalSize: random() * 0.2,
            keepTime: 0.3 + random() * 0.5,
          });
        }
        note.effect = {
          local,
          color1: playerColorFromValue(note.respondHintColor1),
          color2: playerColorFromValue(note.respondHintColor2),
          hearts,
          fixedWorld: !note.hintReference,
        };
        return note.effect;
      }
      function noteWorld(note, lane) {
        const elapsed = frameTime - note.start;
        const lateral = evalAdd(note.position, elapsed);
        const distance = evalAdd(note.distance, elapsed);
        const pose = poseAt(lane);
        let local;
        let localRot;
        if (lane.kind === 'guide') {
          local = guidePoint(lane, lateral, distance);
          const delta = lane.evaluateDelta > 0 ? lane.evaluateDelta : 0.01;
          const p1 = guidePoint(lane, 0, distance - delta);
          const p2 = guidePoint(lane, 0, distance + delta);
          localRot = Math.atan2(p2.y - p1.y, p2.x - p1.x) / PLAYBACK_RAD - 90;
        } else {
          local = mainPoint(lane, lateral, distance);
          localRot = laneNormalAt(lane, lateral).angle - 90;
        }
        const world = applyPose(pose, local);
        if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return null;
        return { x: world.x, y: world.y, rot: pose.rot + localRot };
      }
      function holdPolyline(note, lane) {
        const elapsed = frameTime - note.start;
        const waiting = elapsed < 0;
        const startDistance = waiting ? evalAdd(note.distance, elapsed) : 0;
        const endDistance = evalAdd(note.endDistance, elapsed - note.holdTime);
        const count = note.pointCount;
        const stepDistance = (endDistance - startDistance) / (count - 1);
        const startTime = waiting ? 0 : Math.max(0, elapsed);
        const stepTime = note.truncation
          ? (((endDistance - startDistance) / note.holdLength) * note.holdTime) / (count - 1)
          : (note.holdTime - startTime) / (count - 1);
        const mainX = evalAdd(note.position, elapsed);
        const pose = poseAt(lane);
        const normalLane = lane.kind === 'guide' ? lane.mainLane : lane;
        let fix = 1;
        if (note.targetProjectionFix && normalLane) {
          fix = Math.sin(laneNormalAt(normalLane, mainX).angle * PLAYBACK_RAD);
        }
        const points = [];
        for (let index = 0; index < count; index += 1) {
          const x = mainX + evalAdd(note.holdLine, startTime + index * stepTime) * fix;
          const distance = startDistance + index * stepDistance;
          const local = lanePoint(lane, x, distance);
          const world = applyPose(pose, local);
          if (Number.isFinite(world.x) && Number.isFinite(world.y)) points.push([world.x, world.y]);
        }
        return points;
      }
      function storyboardRect(image) {
        if (!image.file) return null;
        const size = imageSize(image);
        if (!size || !(size.w > 0) || !(size.h > 0)) return null;
        const elapsed = frameTime - image.start;
        const progress = image.useChartTime ? elapsed : image.keep > 0 ? elapsed / image.keep : 0;
        const alpha = clamp(evalDoubleLerp(image.alpha, progress, 0, 1), 0, 1);
        const rot = evalAdd(image.rotationZ, progress);
        const z = evalDoubleLerp(image.positionZ, progress, 0, 1);
        const imageAspect = size.w / size.h;
        let x = 0;
        let y = 0;
        let w = 0;
        let h = 0;
        if (image.mode === 'GamePlayPanel') {
          x = evalAdd(image.positionX, progress);
          y = evalAdd(image.positionY, progress);
          w = evalAdd(image.scaleX, progress);
          h = evalAdd(image.scaleY, progress);
        } else {
          const baseW = PLAYER.cameraHeight * aspect;
          const baseH = PLAYER.cameraHeight;
          x = (evalAdd(image.positionX, progress) * baseW) / 2;
          y = (evalAdd(image.positionY, progress) * baseH) / 2;
          const scaleX = evalAdd(image.scaleX, progress);
          const scaleY = evalAdd(image.scaleY, progress);
          if (image.mode === 'ScreenXY') {
            w = scaleX * baseW;
            h = scaleY * baseH;
          } else if (image.mode === 'ScreenX') {
            w = scaleX * baseW;
            h = w / imageAspect;
          } else if (image.mode === 'ScreenY') {
            h = scaleY * baseH;
            w = h * imageAspect;
          } else if (image.mode === 'ScreenContain' || image.mode === 'ScreenCover') {
            const baseWider = baseW * size.h > baseH * size.w;
            if (image.mode === 'ScreenContain') {
              if (baseWider) {
                h = baseH;
                w = h * imageAspect;
              } else {
                w = baseW;
                h = w / imageAspect;
              }
            } else if (baseWider) {
              w = baseW;
              h = w / imageAspect;
            } else {
              h = baseH;
              w = h * imageAspect;
            }
          } else {
            w = scaleX * baseW;
            h = scaleY * baseH;
          }
        }
        if (!(w > 0) || !(h > 0)) return null;
        return { assetName: image.assetName, file: image.file, x, y, w, h, rot, alpha, z };
      }

      // ---- Lanes ---------------------------------------------------------
      for (const lane of model.lanes) {
        if (!lane.usable) continue;
        if (!playbackLaneAlive(lane, frameTime)) continue;
        const age = frameTime - lane.start;
        const pose = poseAt(lane);
        const startX = evalAdd(lane.drawStartX, age);
        const endX = evalAdd(lane.drawEndX, age);
        const count = lane.pointCount;
        if (!Number.isFinite(startX) || !Number.isFinite(endX) || count < 2) continue;
        const step = (endX - startX) / (count - 1);
        let fix = 1;
        let guideNode = null;
        if (lane.kind === 'guide' && lane.mainLane) {
          const offset = evalAdd(lane.position, age);
          if (lane.targetProjectionFix) {
            fix = Math.sin(laneNormalAt(lane.mainLane, offset).angle * PLAYBACK_RAD);
          }
          // The guide line is drawn in the guide node's local space: that node
          // sits on the main lane at x = position(frameTime) and is rotated by the main
          // lane normal, so its polyline is a perpendicular stroke through that
          // point (DremuGuideLaneLineTransformer + DremuGuideLanePositionTransformer).
          const guideRotation = (laneNormalAt(lane.mainLane, offset).angle - 90) * PLAYBACK_RAD;
          guideNode = {
            x: offset,
            y: laneLineValue(lane.mainLane, offset),
            cos: Math.cos(guideRotation),
            sin: Math.sin(guideRotation),
          };
        }
        const points = [];
        for (let index = 0; index < count; index += 1) {
          const x = startX + step * index;
          let local = lane.kind === 'guide'
            ? mainPoint(lane.mainLane, laneLineValue(lane, x) * fix, x)
            : mainPoint(lane, x, 0);
          if (guideNode) {
            local = {
              x: guideNode.x + local.x * guideNode.cos - local.y * guideNode.sin,
              y: guideNode.y + local.x * guideNode.sin + local.y * guideNode.cos,
            };
          }
          const world = applyPose(pose, local);
          if (Number.isFinite(world.x) && Number.isFinite(world.y)) points.push([world.x, world.y]);
        }
        if (points.length < 2) continue;
        frame.lanes.push({ id: lane.id, kind: lane.kind, name: lane.name, points, color: colorCurveAt(lane.color, age), z: lane.positionZ });
      }

      // ---- Notes + hold bodies ------------------------------------------
      for (const note of model.notes) {
        const lane = note.lane;
        if (!lane || !lane.usable) continue;
        const elapsed = frameTime - note.start;
        const color = colorCurveAt(note.color, elapsed);
        if (playbackNoteHeadVisible(note, frameTime)) {
          const world = noteWorld(note, lane);
          if (world) frame.notes.push({ id: note.id, type: note.kind, laneId: lane.id, x: world.x, y: world.y, rot: world.rot, color, z: note.positionZ });
        }
        if (playbackHoldBodyVisible(note, frameTime)) {
          const points = holdPolyline(note, lane);
          if (points.length >= 2) frame.holds.push({ id: note.id, points, color, z: note.positionZ });
        }
      }

      // ---- Hit response (DremuRespondHint + 16 heart particles) ---------
      // Autoplay responds at hitTime, so the whole effect is a pure function
      // of `frameTime - hitTime`; nothing here depends on input signals.
      for (const note of model.notes) {
        const lane = note.lane;
        if (!lane || !lane.usable) continue;
        const age = frameTime - note.start;
        if (age < -PLAYBACK_EPSILON || age >= PLAYER_RESPONSE.keepTime) continue;
        const effect = noteEffectData(note);
        const pose = effect.fixedWorld ? poseAtTime(lane, note.start) : poseAtTime(lane, frameTime);
        const ringWorld = applyPose(pose, effect.local);
        if (!Number.isFinite(ringWorld.x) || !Number.isFinite(ringWorld.y)) continue;
        const curveTime = age / PLAYER_RESPONSE.keepTime;
        const process = sampleCurve(PLAYER_RESPONSE_CURVE, curveTime);
        const size = Math.atan(process * PLAYER_RESPONSE.keepTime * PLAYER_RESPONSE.expandSpeed) * 2 * PLAYER_RESPONSE.size / Math.PI;
        const alpha = Math.atan(((1 - process) * PLAYER_RESPONSE.keepTime) / PLAYER_RESPONSE.alphaChangeSpeed) * 2 / Math.PI;
        frame.effects.push({ id: note.id, kind: 'ring', x: ringWorld.x, y: ringWorld.y, size, alpha, rot: 45, color: effect.color1, z: -1.5 });
        for (const heart of effect.hearts) {
          const heartTime = age / heart.keepTime;
          if (!(heartTime < 1)) continue;
          const progress = sampleCurve(PLAYER_RESPONSE_CURVE, heartTime);
          const local = {
            x: effect.local.x + heart.dx * heart.distance * progress,
            y: effect.local.y + heart.dy * heart.distance * progress,
          };
          const world = applyPose(pose, local);
          const width = 0.3 + (heart.finalSize - 0.3) * heartTime;
          const height = 0.225 + (heart.finalSize * 0.75 - 0.225) * heartTime;
          if (!(width > 0) || !(height > 0)) continue;
          frame.effects.push({
            id: note.id,
            kind: 'heart',
            x: world.x,
            y: world.y,
            w: width,
            h: height,
            color: heartTime > 0.93 ? effect.color2 : effect.color1,
            z: -1,
          });
        }
      }

      // ---- Storyboard images --------------------------------------------
      if (imageSize) {
        for (const image of model.images) {
          if (frameTime < image.start - PLAYBACK_EPSILON || frameTime > image.start + image.keep + PLAYBACK_EPSILON) continue;
          const rect = storyboardRect(image);
          if (rect) frame.images.push(rect);
        }
      }
      return frame;
    }

    // ---- Canvas painter ---------------------------------------------------
    /**
     * Map 16:10 content coordinates onto the canvas. The canvas is treated as
     * the Unity camera view: 10 world units tall, width = 10 * aspect. The
     * Dremu content box is 16:10 and is contained inside that view with
     * s = aspect >= 1.6 ? 1 : aspect / 1.6 (SelfAdaptiveStandardBase).
     */
    function playerViewport(width, height) {
      const safeWidth = Math.max(1, width || 1);
      const safeHeight = Math.max(1, height || 1);
      const aspect = safeWidth / safeHeight;
      const contentScale = aspect >= PLAYER.aspect ? 1 : aspect / PLAYER.aspect;
      const pixelsPerUnit = safeHeight / PLAYER.cameraHeight;
      const scale = contentScale * pixelsPerUnit;
      return {
        width: safeWidth,
        height: safeHeight,
        aspect,
        contentScale,
        pixelsPerUnit,
        unit: scale,
        toX: (x) => safeWidth / 2 + x * scale,
        toY: (y) => safeHeight / 2 - y * scale,
      };
    }

    /** Tinted note sprite cache; null while the embedded texture is loading. */
    const PLAYER_TINT_CACHE = new Map();
    const PLAYER_IMAGE_TINT_CACHE = new Map();
    function playerTintedSprite(kind, color) {
      // DremuHold reuses the Tap texture for its head (DremuHold.g), so the
      // 'hold' frame entry must not fall through to the solid fallback.
      const spriteKind = kind === 'hold' ? 'tap' : kind;
      const state = PLAYER_SPRITE_STATE[spriteKind];
      if (!state || !state.ready || !state.image) return null;
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
      const red = Math.round(clamp(color.r, 0, 1) * 255);
      const green = Math.round(clamp(color.g, 0, 1) * 255);
      const blue = Math.round(clamp(color.b, 0, 1) * 255);
      const key = kind + ':' + red + ':' + green + ':' + blue;
      const cached = PLAYER_TINT_CACHE.get(key);
      if (cached) return cached;
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 40;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.clearRect(0, 0, 200, 40);
      ctx.drawImage(state.image, 0, 0, 200, 40);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
      ctx.fillRect(0, 0, 200, 40);
      ctx.globalCompositeOperation = 'source-over';
      if (PLAYER_TINT_CACHE.size > 256) PLAYER_TINT_CACHE.clear();
      PLAYER_TINT_CACHE.set(key, canvas);
      return canvas;
    }

    /** Tint an arbitrary effect texture (same vertex-colour semantics). */
    function playerTintImage(image, color, key) {
      if (!image) return null;
      const red = Math.round(clamp(color.r, 0, 1) * 255);
      const green = Math.round(clamp(color.g, 0, 1) * 255);
      const blue = Math.round(clamp(color.b, 0, 1) * 255);
      const cacheKey = key + ':' + red + ':' + green + ':' + blue;
      const cached = PLAYER_IMAGE_TINT_CACHE.get(cacheKey);
      if (cached) return cached;
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(image, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      if (PLAYER_IMAGE_TINT_CACHE.size > 64) PLAYER_IMAGE_TINT_CACHE.clear();
      PLAYER_IMAGE_TINT_CACHE.set(cacheKey, canvas);
      return canvas;
    }

    /**
     * Gorge NineSliceSprite math, ported from the Godot adaptor's
     * draw_gorge_nine_slice (addons/nine_slice_sprite_2d_godot2d).
     * baseSize keeps the corners at the base scale; everything else stretches.
     */
    function playerDrawNineSlice(ctx, image, width, height, baseWidth, baseHeight, left, top, right, bottom) {
      const sourceWidth = image.width;
      const sourceHeight = image.height;
      if (!(width > 0) || !(height > 0) || !(sourceWidth > 0) || !(sourceHeight > 0)) return;
      const expand = (target, base, a, b) => target <= base
        ? [target * a, target * b]
        : [base * a, target - base * b];
      const [targetLeft, targetRight] = expand(width, baseWidth, left / sourceWidth, right / sourceWidth);
      const [targetTop, targetBottom] = expand(height, baseHeight, top / sourceHeight, bottom / sourceHeight);
      const sourceX = [[0, left], [left, right - left + 1], [right + 1, sourceWidth - right - 1]];
      const sourceY = [[0, top], [top, bottom - top + 1], [bottom + 1, sourceHeight - bottom - 1]];
      const targetX = [[0, targetLeft], [targetLeft, targetRight - targetLeft + 1], [targetRight + 1, width - targetRight - 1]];
      const targetY = [[0, targetTop], [targetTop, targetBottom - targetTop + 1], [targetBottom + 1, height - targetBottom - 1]];
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < 3; x += 1) {
          const sx = sourceX[x];
          const sy = sourceY[y];
          const dx = targetX[x];
          const dy = targetY[y];
          if (!(sx[1] > 0) || !(sy[1] > 0) || !(dx[1] > 0) || !(dy[1] > 0)) continue;
          ctx.drawImage(image, sx[0], sy[0], sx[1], sy[1], dx[0], dy[0], dx[1], dy[1]);
        }
      }
    }

    /** DremuRespondHint: nine-sliced ring rotated 45 degrees (screen diamond). */
    function playerDrawResponseRing(ctx, view, effect) {
      const size = effect.size * view.unit;
      if (!(size > 0)) return;
      const color = effect.color || WHITE_COLOR;
      const alpha = clamp(effect.alpha, 0, 1) * clamp(color.a, 0, 1);
      if (alpha <= 0.002) return;
      const state = PLAYER_EFFECT_STATE.hint;
      if (!state || !state.ready) return;
      const tinted = playerTintImage(state.image, color, 'hint');
      if (!tinted) return;
      const base = 0.2 * view.unit;
      ctx.save();
      ctx.translate(view.toX(effect.x), view.toY(effect.y));
      ctx.rotate(-(effect.rot || 0) * PLAYBACK_RAD);
      ctx.globalAlpha = alpha;
      playerDrawNineSlice(ctx, tinted, size, size, base, base, 169, 169, 169, 169);
      ctx.restore();
    }

    /** DremuRespondHintHeartTransformer particle. */
    function playerDrawResponseHeart(ctx, view, effect) {
      const state = PLAYER_EFFECT_STATE.heart;
      if (!state || !state.ready) return;
      const color = effect.color || WHITE_COLOR;
      const alpha = clamp(color.a, 0, 1);
      if (alpha <= 0.002) return;
      const width = effect.w * view.unit;
      const height = effect.h * view.unit;
      if (!(width > 0) || !(height > 0)) return;
      const tinted = playerTintImage(state.image, color, 'heart');
      if (!tinted) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(tinted, view.toX(effect.x) - width / 2, view.toY(effect.y) - height / 2, width, height);
      ctx.restore();
    }

    function playerStrokePolyline(ctx, view, points, color, lineWidth) {
      if (!points || points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(view.toX(points[0][0]), view.toY(points[0][1]));
      for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(view.toX(points[index][0]), view.toY(points[index][1]));
      }
      ctx.strokeStyle = playerCssColor(color);
      ctx.lineWidth = Math.max(0.6, lineWidth);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 4;
      ctx.stroke();
    }

    /**
     * Paint one frame. Draw order (far -> near) mirrors the Unity node z as
     * closely as a flat 2D canvas can: storyboard images, hold ribbons, lane
     * lines, note heads.
     */
    function paintPlaybackFrame(ctx, view, frame, images, options) {
      const opts = options || {};
      if (!frame) return;
      const unit = view.unit;
      ctx.save();
      ctx.fillStyle = PLAYER.clearColor;
      ctx.fillRect(0, 0, view.width, view.height);
      const items = [];
      const storyboard = opts.storyboard !== false;
      for (const item of frame.images) {
        if (!storyboard) continue;
        const entry = images ? images.get(item.file) : null;
        const image = entry && entry.ready ? entry.image : null;
        if (!image) continue;
        const width = item.w * unit;
        const height = item.h * unit;
        if (!(width > 0) || !(height > 0)) continue;
        items.push({
          z: Number.isFinite(item.z) ? item.z : 0,
          priority: 0,
          draw: () => {
            ctx.save();
            ctx.globalAlpha = clamp(item.alpha, 0, 1);
            ctx.translate(view.toX(item.x), view.toY(item.y));
            ctx.rotate(-item.rot * PLAYBACK_RAD);
            ctx.drawImage(image, -width / 2, -height / 2, width, height);
            ctx.restore();
          },
        });
      }
      const lineWidth = PLAYER.laneWidth * unit;
      for (const lane of frame.lanes) {
        items.push({
          z: Number.isFinite(lane.z) ? lane.z : 0,
          priority: 1,
          draw: () => playerStrokePolyline(ctx, view, lane.points, lane.color, lineWidth),
        });
      }
      for (const effect of frame.effects) {
        items.push({
          z: Number.isFinite(effect.z) ? effect.z : 0,
          priority: effect.kind === 'heart' ? 2 : 3,
          draw: effect.kind === 'heart'
            ? () => playerDrawResponseHeart(ctx, view, effect)
            : () => playerDrawResponseRing(ctx, view, effect),
        });
      }
      for (const hold of frame.holds) {
        items.push({
          z: Number.isFinite(hold.z) ? hold.z : 0,
          priority: 4,
          draw: () => playerStrokePolyline(ctx, view, hold.points, hold.color, lineWidth),
        });
      }
      const noteWidth = PLAYER.noteWidth * unit;
      const noteHeight = PLAYER.noteHeight * unit;
      for (const note of frame.notes) {
        items.push({
          z: Number.isFinite(note.z) ? note.z : 0,
          priority: 5,
          draw: () => {
            const alpha = clamp(note.color.a, 0, 1);
            if (alpha <= 0.002) return;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(view.toX(note.x), view.toY(note.y));
            ctx.rotate(-note.rot * PLAYBACK_RAD);
            const sprite = playerTintedSprite(note.type, note.color);
            if (sprite) {
              ctx.drawImage(sprite, -noteWidth / 2, -noteHeight / 2, noteWidth, noteHeight);
            } else {
              ctx.fillStyle = playerCssColor(note.color, 1);
              ctx.fillRect(-noteWidth / 2, -noteHeight / 2, noteWidth, noteHeight);
            }
            ctx.restore();
          },
        });
      }
      // Unity sorts by z descending (larger z = further); equal z keeps the
      // sprite order: images, lanes, hearts, ring, hold ribbons, note heads.
      items.sort((a, b) => (b.z - a.z) || (a.priority - b.priority));
      for (const item of items) item.draw();
      ctx.restore();
    }
    // ---- Asset loading ----------------------------------------------------
    /**
     * Load the embedded note textures and the storyboard images referenced by
     * the model. `version` bumps whenever a texture finishes loading so the
     * canvas repaints (images are skipped until their size is known).
     */
    function usePlaybackAssets(model) {
      const [version, setVersion] = useState(0);
      const imagesRef = useRef(null);
      if (imagesRef.current === null) imagesRef.current = new Map();
      const bump = useCallback(() => setVersion((value) => value + 1), []);
      useEffect(() => {
        ensurePlayerSprites(bump);
        ensurePlayerEffects(bump);
        const images = imagesRef.current;
        let changed = false;
        const list = model && Array.isArray(model.images) ? model.images : [];
        for (const image of list) {
          if (!image || !image.file || images.has(image.file)) continue;
          const entry = { image: null, ready: false };
          images.set(image.file, entry);
          changed = true;
          if (typeof window === 'undefined' || typeof window.Image !== 'function') continue;
          const element = new window.Image();
          entry.image = element;
          element.onload = () => {
            entry.ready = true;
            bump();
          };
          element.onerror = () => {
            entry.ready = false;
          };
          element.src = assetUrl(image.file);
        }
        if (changed) setVersion((value) => value + 1);
      }, [model, bump]);
      return { images: imagesRef.current, version };
    }

    // ---- Playback overlay component ---------------------------------------
    /**
     * Embedded playback layer over the timeline pane: canvas + minimal
     * transport (play/pause, restart, seek, rate, mute, background toggle).
     * Rendering is driven by the shared transport clock; there is no signal
     * simulation here, only the pure-playback frame collector.
     */
    function PlaybackLayer(props) {
      const { project, model, transport, tr, onClose } = props;
      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const [size, setSize] = useState({ w: 0, h: 0 });
      const [showStoryboard, setShowStoryboard] = useState(true);
      const sizeRef = useRef(size);
      const modelRef = useRef(model);
      const transportRef = useRef(transport);
      const storyboardRef = useRef(showStoryboard);
      sizeRef.current = size;
      modelRef.current = model;
      transportRef.current = transport;
      storyboardRef.current = showStoryboard;
      const assets = usePlaybackAssets(model);
      const assetsRef = useRef(assets);
      assetsRef.current = assets;

      // ---- Autoplay hit sound (RespondA -> RespondEffect.wav) ------------
      const hitPoolRef = useRef(null);
      const lastHitTimeRef = useRef(null);
      useEffect(() => {
        if (hitPoolRef.current) return undefined;
        if (typeof Audio !== 'function') return undefined;
        const pool = [];
        for (let index = 0; index < 12; index += 1) {
          const audio = new Audio(PLAYER_RESPONSE_SOUND);
          audio.preload = 'auto';
          audio.volume = 0.45;
          pool.push(audio);
        }
        hitPoolRef.current = pool;
        return () => {
          for (const audio of pool) {
            try { audio.pause(); } catch (error) { /* ignore */ }
          }
          hitPoolRef.current = null;
        };
      }, []);
      useEffect(() => {
        const now = transport.time;
        const previous = lastHitTimeRef.current;
        lastHitTimeRef.current = now;
        if (!model || !transport.playing || transport.muted || previous === null) return;
        const delta = now - previous;
        // Ignore scrubbing: a hit sound only accompanies continuous playback.
        if (!(delta > 0) || delta > 0.35) return;
        const pool = hitPoolRef.current;
        if (!pool || pool.length === 0) return;
        let plays = 0;
        for (const note of model.notes) {
          if (!(note.start > previous - PLAYBACK_EPSILON && note.start <= now + PLAYBACK_EPSILON)) continue;
          if (!note.lane || !note.lane.usable) continue;
          const audio = pool.find((item) => item.paused || item.ended);
          if (!audio) break;
          try {
            audio.currentTime = 0;
            const promise = audio.play();
            if (promise && typeof promise.catch === 'function') promise.catch(() => undefined);
          } catch (error) { /* ignore */ }
          plays += 1;
          if (plays >= 4) break;
        }
      }, [transport.time, transport.playing, transport.muted, model]);

      // Track the stage size (ResizeObserver, falling back to window resize).
      useEffect(() => {
        const measure = () => {
          const node = wrapRef.current;
          if (!node) return;
          let rect = null;
          try {
            rect = node.getBoundingClientRect();
          } catch (error) {
            rect = null;
          }
          const width = Math.round((rect && rect.width) || node.clientWidth || 0);
          const height = Math.round((rect && rect.height) || node.clientHeight || 0);
          setSize((previous) => (previous.w === width && previous.h === height ? previous : { w: width, h: height }));
        };
        measure();
        const node = wrapRef.current;
        if (node && typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(node);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, []);

      const paint = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const stage = sizeRef.current || {};
        const stageWidth = stage.w || canvas.clientWidth || 600;
        const stageHeight = stage.h || canvas.clientHeight || 400;
        const width = Math.max(60, Math.min(stageWidth, stageHeight * (16 / 10)));
        const height = width / (16 / 10);
        const dpr = Math.min(
          typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1,
          2,
        );
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const currentTransport = transportRef.current;
        const timeRef = currentTransport && currentTransport.timeRef;
        const time = timeRef && Number.isFinite(timeRef.current)
          ? timeRef.current
          : (currentTransport && Number.isFinite(currentTransport.time) ? currentTransport.time : 0);
        const currentAssets = assetsRef.current || null;
        const images = (currentAssets && currentAssets.images) || new Map();
        const imageSize = (entry) => {
          const loaded = entry && entry.file ? images.get(entry.file) : null;
          if (!loaded || !loaded.ready || !loaded.image) return null;
          const image = loaded.image;
          const naturalWidth = image.naturalWidth || image.width || 0;
          const naturalHeight = image.naturalHeight || image.height || 0;
          return naturalWidth > 0 && naturalHeight > 0 ? { w: naturalWidth, h: naturalHeight } : null;
        };
        const frame = collectFrame(modelRef.current, time, { aspect: width / height, imageSize });
        paintPlaybackFrame(ctx, playerViewport(width, height), frame, images, { storyboard: storyboardRef.current });
      }, []);

      useEffect(() => {
        paint();
      }, [paint, model, size, transport.time, showStoryboard, assets.version]);

      const duration = Math.max(1, transport.duration || (project && project.duration) || 0);
      const time = Number.isFinite(transport.time) ? transport.time : 0;
      const stats = (model && model.stats) || { mainLanes: 0, guideLanes: 0, notes: 0, unresolvedNotes: 0 };
      const empty = !model || stats.mainLanes + stats.guideLanes + stats.notes === 0;
      const title = project ? project.title || project.dir || tr('playbackTitle') : tr('playbackTitle');
      const frameWidth = Math.max(60, Math.round(Math.min(size.w || 600, (size.h || 375) * (16 / 10))));
      const frameHeight = Math.round(frameWidth * (10 / 16));
      return h(
        'div',
        { className: 'dgc-player', role: 'dialog', 'aria-label': tr('playbackTitle') },
        h(
          'div',
          { className: 'dgc-playerHead' },
          h('div', { className: 'dgc-playerTitle' }, h('strong', null, title), h('span', null, tr('playbackHint'))),
          h('span', { className: 'dgc-playerBadge' }, tr('playbackLanes') + ' ' + (stats.mainLanes + stats.guideLanes)),
          h('span', { className: 'dgc-playerBadge' }, tr('playbackNotes') + ' ' + stats.notes),
          stats.unresolvedNotes > 0
            ? h('span', { className: 'dgc-playerBadge is-warn' }, tr('playbackUnbound') + ' ' + stats.unresolvedNotes)
            : null,
          h('span', { className: 'dgc-spacer' }),
          h(Button, { variant: 'ghost', icon: 'close', title: tr('playbackClose'), onClick: onClose }, tr('playbackClose')),
        ),
        h(
          'div',
          { className: 'dgc-playerStage', ref: wrapRef },
          h(
            'div',
            { className: 'dgc-playerFrame', style: { width: frameWidth, height: frameHeight } },
            h('canvas', { className: 'dgc-playerCanvas', ref: canvasRef }),
            empty ? h('div', { className: 'dgc-playerEmpty' }, tr('playbackEmpty')) : null,
            !project || audioClipsOf(project).length === 0
              ? h('div', { className: 'dgc-playerNote' }, tr('playbackNoAudio'))
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dgc-playerBar' },
          h(
            Button,
            {
              variant: 'primary',
              icon: transport.playing ? 'pause' : 'play',
              onClick: () => (transport.playing ? transport.pause() : transport.play()),
            },
            transport.playing ? tr('pause') : tr('play'),
          ),
          h(Button, {
            icon: 'rewind',
            title: tr('playbackRestart'),
            onClick: () => {
              transport.seek(0);
              if (!transport.playing) transport.play();
            },
          }),
          h(
            'div',
            { className: 'dgc-scrub' },
            h('input', {
              type: 'range',
              min: 0,
              max: Math.round(duration * 1000),
              step: 1,
              value: Math.round(clamp(time, 0, duration) * 1000),
              onChange: (event) => transport.seek(Number(event.target.value) / 1000),
              'aria-label': tr('time'),
            }),
          ),
          h('div', { className: 'dgc-clock' }, formatTime(time) + ' / ' + formatTime(duration)),
          h(
            'label',
            { className: 'dgc-playerLabel' },
            h('span', null, tr('rate')),
            h(
              'select',
              {
                className: 'dgc-select',
                value: String(transport.rate),
                onChange: (event) => transport.setRate(Number(event.target.value)),
              },
              PLAYER.rateOptions.map((value) => h('option', { key: value, value: String(value) }, value + 'x')),
            ),
          ),
          h(Button, {
            icon: transport.muted ? 'mute' : 'volume',
            variant: 'ghost',
            active: transport.muted,
            title: transport.muted ? tr('unmute') : tr('mute'),
            onClick: transport.toggleMute,
          }),
          h(
            'label',
            { className: 'dgc-playerCheck' },
            h('input', {
              type: 'checkbox',
              checked: showStoryboard,
              onChange: (event) => setShowStoryboard(!!event.target.checked),
            }),
            h('span', null, tr('playbackBackground')),
          ),
        ),
      );
    }

    // ========================================================================
    // 18 · Page assembly.
    // ========================================================================

    /**
     * Page header: title/path, dirty/connection badges and project actions.
     * Pure presentation; every value arrives from ChartStudioPage.
     */
    function StudioHeader(props) {
      const { t, project, dirty, connection, session, hasPlayableContent, onOpenProject, onNewProject, onPreview, previewDisabled, curveBusy } = props;
      return h(
        'div',
        { className: 'dgc-header' },
        h(
          'div',
          { className: 'dgc-title' },
          h('strong', null, project ? project.title || t('title') : t('title')),
          h('span', { className: 'dgc-mono' }, project ? project.dir : t('subtitle')),
        ),
        h('span', { className: 'dgc-badge ' + (dirty ? 'is-dirty' : 'is-clean') }, dirty ? t('unsaved') : t('clean')),
        dirty ? h('span', { className: 'dgc-badge', title: t('dirtyDot') }, '●') : null,
        connection === 'offline' ? h('span', { className: 'dgc-badge is-dirty dgc-offline' }, t('offline')) : null,
        h('span', { className: 'dgc-spacer' }),
        h(Button, { icon: 'plus', onClick: onNewProject, title: t('newProjectHint') }, t('newProject')),
        h(Button, { icon: 'folder', onClick: onOpenProject }, t('openProject')),
        h(Button, { icon: 'preview', onClick: onPreview, disabled: !project || !hasPlayableContent || previewDisabled, title: previewDisabled ? t('curvePreviewBusy') : t('playbackOpen') }, t('playbackOpen')),
        h(Button, { icon: 'reload', onClick: () => session.reload(), disabled: !project || curveBusy, title: curveBusy ? t('curvePreviewBusy') : undefined }, t('reload')),
        h(Button, { icon: 'undo', onClick: () => session.undo(), disabled: !project || curveBusy, title: curveBusy ? t('curvePreviewBusy') : undefined }, t('undo')),
        h(Button, { icon: 'redo', onClick: () => session.redo(), disabled: !project || curveBusy, title: curveBusy ? t('curvePreviewBusy') : undefined }, t('redo')),
        h(
          Button,
          {
            icon: 'export',
            disabled: !project || session.exporting,
            title: session.exporting ? t('exporting') : t('exportHint'),
            onClick: () => session.exportProject(),
          },
          session.exporting
            ? t('exporting') + (Number.isFinite(session.exportPercent) ? ' ' + session.exportPercent + '%' : '')
            : t('export'),
        ),
        h(
          Button,
          {
            variant: 'primary',
            icon: 'save',
            disabled: !project || session.saving,
            onClick: () => session.save(),
          },
          session.saving ? t('saving') : t('save'),
        ),
      );
    }

    /**
     * Toolbar: placement tools, snap division, zoom, selection actions and the
     * chart tempo/offset fields. Pure presentation.
     */
    function StudioToolbar(props) {
      const { t, tool, setTool, snapOn, snapDiv, setSnapOn, setSnapDiv, canvasApiRef, selection, onDuplicate, onDelete, tempo, onEdit, noteEditor } = props;
      const noteMode = !!(noteEditor && noteEditor.tool);
      const activeTool = noteMode ? noteEditor.tool : tool;
      const chooseTool = noteMode ? noteEditor.setTool : setTool;
      const tools = noteMode
        ? [
            { id: 'select', icon: 'select', label: t('toolSelect'), key: 'V' },
            { id: 'tap', icon: 'tap', label: t('toolTap'), key: 'Q' },
            { id: 'drag', icon: 'drag', label: t('toolDrag'), key: 'W' },
            { id: 'taplik', icon: 'taplik', label: t('toolTaplik'), key: 'E' },
            { id: 'hold', icon: 'hold', label: t('toolHold'), key: 'R' },
          ]
        : [
            { id: 'select', icon: 'select', label: t('toolSelect'), key: 'V' },
            { id: 'tap', icon: 'tap', label: t('toolTap'), key: 'Q' },
            { id: 'drag', icon: 'drag', label: t('toolDrag'), key: 'W' },
            { id: 'hold', icon: 'hold', label: t('toolHold'), key: 'E' },
            { id: 'lane', icon: 'lane', label: t('toolLane'), key: 'T' },
          ];
      const zoom = (direction) => {
        if (noteMode) {
          noteEditor.onZoom(direction);
          return;
        }
        const api = canvasApiRef.current;
        if (!api) return;
        if (direction === 'in') api.zoomIn();
        else if (direction === 'out') api.zoomOut();
        else api.fit();
      };
      return h(
        'div',
        { className: 'dgc-toolbar' },
        h(
          'div',
          { className: 'dgc-toolgroup' },
          tools.map((item) =>
            h(
              Button,
              {
                key: item.id,
                icon: item.icon,
                active: activeTool === item.id,
                title: item.label + ' (' + item.key + ')',
                onClick: () => chooseTool(item.id),
              },
              item.label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dgc-toolgroup' },
          h('label', null, h('span', null, t('snap'))),
          h(
            'select',
            {
              className: 'dgc-select',
              value: snapOn ? String(snapDiv) : 'off',
              onChange: (event) => {
                if (event.target.value === 'off') setSnapOn(false);
                else {
                  setSnapOn(true);
                  setSnapDiv(Number(event.target.value));
                }
              },
            },
            h('option', { value: 'off' }, t('snapOff')),
            SNAP_DIVISIONS.map((value) => h('option', { key: value, value: String(value) }, '1/' + value)),
          ),
        ),
        h(
          'div',
          { className: 'dgc-toolgroup' },
          h(Button, { variant: 'ghost', icon: 'zoomOut', title: t('zoomOut'), onClick: () => zoom('out') }),
          h(Button, { variant: 'ghost', icon: 'zoomIn', title: t('zoomIn'), onClick: () => zoom('in') }),
          h(Button, { variant: 'ghost', icon: 'fit', title: noteMode ? t('reset') : t('fitAll'), onClick: () => zoom('reset') }),
        ),
        h(
          'div',
          { className: 'dgc-toolgroup' },
          h(Button, { variant: 'ghost', icon: 'duplicate', title: t('duplicate'), disabled: selection.length === 0, onClick: () => onDuplicate(selection) }),
          h(Button, { variant: 'ghost', icon: 'trash', title: t('delete'), disabled: selection.length === 0, onClick: () => onDelete(selection) }),
        ),
        h('span', { className: 'dgc-spacer' }),
        h('label', null, h('span', null, t('tempo')), h(NumberField, {
          value: tempo.bpm,
          step: 1,
          onCommit: (bpm) => onEdit([{ op: 'setMeta', tempo: { bpm } }]),
        })),
        h('label', null, h('span', null, t('offset')), h(NumberField, {
          value: tempo.offset,
          step: 0.05,
          onCommit: (offset) => onEdit([{ op: 'setMeta', tempo: { offset } }]),
        })),
      );
    }


    /**
     * Editor shortcut policy for one keydown event.
     *
     * The page installs a single window listener and calls this with the
     * current action set, so a transport tick (which re-renders ~60x/s)     * cannot churn listeners and the shortcut table stays in one place.
     *
     * @param {KeyboardEvent} event
     * @param {object} actions  current editor actions and state.
     */
    function handleEditorKey(event, actions) {
      const {
        preview,
        closePreview,
        transport,
        session,
        selection,
        allElementIds,
        setSelection,
        copySelection,
        pasteClipboard,
        duplicateElements,
        deleteElements,
        nudgeSelection,
        setTool,
        setSnapDiv,
        tempo,
        snapDiv,
        canvasApiRef,
        curveEditing,
        closeCurvePanel,
        noteEditing,
        noteTool,
        setNoteTool,
        notePps,
        setNotePps,
        closeNoteEditor,
        selectLaneNotes,
        nudgeNoteSelection,
      } = actions;

      const target = event.target;
      if (preview) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePreview();
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          if (transport.playing) transport.pause();
          else transport.play();
          return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const step = event.shiftKey ? 5 : 1;
          transport.seek(Math.max(0, transport.time + (event.key === 'ArrowRight' ? step : -step)));
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          transport.seek(0);
          return;
        }
        return;
      }
      const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
      if (curveEditing) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCurvePanel();
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          if (transport.playing) transport.pause();
          else transport.play();
          return;
        }
        // Keep chart-editing shortcuts (delete/undo/duplicate/...) away from
        // the draft editor; the panel has its own apply/cancel controls.
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) session.redo();
        else session.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        session.redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        session.save();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        if (noteEditing && typeof selectLaneNotes === 'function') setSelection(selectLaneNotes());
        else setSelection(allElementIds.slice(0, 4000));
        return;
      }
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateElements(selection);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        if (transport.playing) transport.pause();
        else transport.play();
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        transport.seek(0);
        if (canvasApiRef.current) canvasApiRef.current.reveal(0);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteElements(selection);
        return;
      }
      if (event.key === 'Escape') {
        if (noteEditing) {
          if (selection.length > 0) setSelection([]);
          else closeNoteEditor();
          return;
        }
        if (selection.length > 0) setSelection([]);
        else setTool('select');
        return;
      }
      if (noteEditing && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const stepSeconds = (60 / ((tempo && tempo.bpm) || 120)) / (snapDiv || 4);
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const step = stepSeconds * (event.shiftKey ? 4 : 1);
          nudgeNoteSelection(event.key === 'ArrowUp' ? step : -step, 0);
        } else {
          const step = event.shiftKey ? 1 : 0.5;
          nudgeNoteSelection(0, event.key === 'ArrowRight' ? step : -step);
        }
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (selection.length > 0) nudgeSelection(event.key === 'ArrowRight' ? 1 : -1);
        else {
          const step = (60 / ((tempo && tempo.bpm) || 120)) / (snapDiv || 4);
          transport.seek(Math.max(0, transport.time + (event.key === 'ArrowRight' ? step : -step)));
        }
        return;
      }
      if (noteEditing) {
        if (/^[1-8]$/.test(event.key)) {
          setSnapDiv(SNAP_DIVISIONS[Number(event.key) - 1]);
          return;
        }
        if (event.key === '=' || event.key === '+') {
          setNotePps((previous) => clamp((previous || NOTE_PPS_DEFAULT) * 1.25, NOTE_PPS_MIN, NOTE_PPS_MAX));
          return;
        }
        if (event.key === '-') {
          setNotePps((previous) => clamp((previous || NOTE_PPS_DEFAULT) / 1.25, NOTE_PPS_MIN, NOTE_PPS_MAX));
          return;
        }
        if (event.key === '0') {
          setNotePps(NOTE_PPS_DEFAULT);
          return;
        }
        const noteToolNext = noteToolForKey(event.key);
        if (noteToolNext) setNoteTool(noteToolNext);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'q') setTool('tap');
      else if (key === 'w') setTool('drag');
      else if (key === 'e') setTool('hold');
      else if (key === 't') setTool('lane');
      else if (key === 'v') setTool('select');
      else if (/^[1-8]$/.test(event.key)) setSnapDiv(SNAP_DIVISIONS[Number(event.key) - 1]);
      else if (event.key === '=' || event.key === '+') {
        if (canvasApiRef.current) canvasApiRef.current.zoomIn();
      } else if (event.key === '-') {
        if (canvasApiRef.current) canvasApiRef.current.zoomOut();
      } else if (event.key === '0') {
        if (canvasApiRef.current) canvasApiRef.current.fit();
      }
    }

    /** The full-page chart studio rendered inside the `main` panel slot. */
    function ChartStudioPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => (zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : key);
      const session = useChartSession();
      const state = session.state;
      const project = state && state.project ? state.project : null;
      const catalog = (state && state.catalog) || { elements: [], valueTypes: {}, palettes: {} };

      const [selection, setSelection] = useState([]);
      const [activeStaff, setActiveStaff] = useState(null);
      const [hiddenStaffs, setHiddenStaffs] = useState(() => new Set());
      const [tool, setTool] = useState('select');
      const [snapDiv, setSnapDiv] = useState(4);
      const [snapOn, setSnapOn] = useState(true);
      const [follow, setFollow] = useState(false);
      const [openDialog, setOpenDialog] = useState(false);
      const [createDialog, setCreateDialog] = useState(false);
      const [preview, setPreview] = useState(false);
      const [notice, setNotice] = useState(null);
      const [curveTarget, setCurveTarget] = useState(null);
      const [noteEditor, setNoteEditor] = useState(null);
      const [noteTool, setNoteTool] = useState('select');
      const [notePps, setNotePps] = useState(NOTE_PPS_DEFAULT);
      const noteEditorRef = useRef(null);
      const curveSeqRef = useRef(0);
      const curveTargetRef = useRef(null);
      // Latest main-timeline view ({t0, pps}); the docked curve panel uses it
      // to put its beat grid on the same x coordinates as the main ruler.
      const timelineViewRef = useRef({ t0: 0, pps: PPS_DEFAULT });
      const [liveTimelineView, setLiveTimelineView] = useState({ t0: 0, pps: PPS_DEFAULT });
      const [timelineContentHeight, setTimelineContentHeight] = useState(0);
      const onTimelineContentHeight = useCallback((height) => {
        if (!Number.isFinite(height)) return;
        const next = Math.max(0, Math.round(height));
        setTimelineContentHeight((previous) => (Math.abs(previous - next) <= 1 ? previous : next));
      }, []);
      const onTimelineView = useCallback((next) => {
        if (!next) return;
        timelineViewRef.current = { t0: next.t0, pps: next.pps };
        // While the curve panel is open it is the second view of the same time
        // axis, so every main horizontal scroll/zoom must update it too.
        if (curveTargetRef.current) setLiveTimelineView({ t0: next.t0, pps: next.pps });
      }, []);
      const canvasApiRef = useRef(null);
      const setCanvasApi = useCallback((api) => {
        canvasApiRef.current = api;
      }, []);
      const syncTimelineScroll = useCallback((delta) => {
        const api = canvasApiRef.current;
        if (api && typeof api.scrollBy === 'function') api.scrollBy(delta);
      }, []);
      const syncTimelineSetT0 = useCallback((t0) => {
        const api = canvasApiRef.current;
        if (api && typeof api.setT0 === 'function') api.setT0(t0);
      }, []);
      const syncTimelineZoom = useCallback((factor, time, x) => {
        const api = canvasApiRef.current;
        if (api && typeof api.zoomAt === 'function') api.zoomAt(factor, time, x);
      }, []);
      const syncTimelineFit = useCallback(() => {
        const api = canvasApiRef.current;
        if (api && typeof api.fit === 'function') api.fit();
      }, []);
      const [library, setLibrary] = useState([]);
      const clipboardRef = useRef([]);
      const noticeTimerRef = useRef(0);

      // A staff that disappears (undone add, host rejection, reload) must not
      // keep the element list filtered to an id that no longer exists.
      useEffect(() => {
        if (!activeStaff) return;
        if (project && (project.staffs || []).some((staff) => staff.id === activeStaff)) return;
        setActiveStaff(null);
      }, [activeStaff, project]);

      // The state payload carries `recent`; the full library is fetched on
      // demand (the projects scan touches the filesystem).
      useEffect(() => {
        if (!openDialog || (state && Array.isArray(state.projects) && state.projects.length > 0)) return undefined;
        let cancelled = false;
        fetch(PROJECTS_URL, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (cancelled || !payload) return;
            setLibrary(Array.isArray(payload.projects) ? payload.projects : []);
          })
          .catch(() => undefined);
        return () => {
          cancelled = true;
        };
      }, [openDialog, state]);

      // Every @Song clip of the open project, with an absolute file path for
      // the <audio> elements / waveform fetch. `audioClipsOf` falls back to the
      // legacy single `project.audio` shape.
      const audioClips = useMemo(() => {
        if (!project) return [];
        const dir = typeof project.dir === 'string' ? project.dir.replace(/\/$/, '') : '';
        return audioClipsOf(project)
          .filter((clip) => clip && (clip.file || clip.relativePath))
          .map((clip) => {
            let file = clip.file || '';
            if (file.charAt(0) !== '/' && clip.relativePath) file = dir ? dir + '/' + clip.relativePath : clip.relativePath;
            return Object.assign({}, clip, { file });
          });
      }, [project]);

      const resetKey = project ? project.dir || '' : '';
      const transport = useTransport(audioClips, project ? project.duration : 0, resetKey);
      const { waves, status: waveStatus } = useWaveforms(audioClips);
      const tempo = (project && project.tempo) || { bpm: 120, offset: 0 };

      // Playback preview: pure autoplay rendering, no chart signals.
      const hasPlayableContent = useMemo(() => {
        for (const staff of (project && project.staffs) || []) {
          if (!staff || staff.kind === 'audio') continue;
          for (const period of staff.periods || []) {
            for (const element of period.elements || []) {
              const type = shortType(element && element.type);
              if (type === 'DremuMainLane' || type === 'DremuGuideLane' || type === 'DremuTap' || type === 'DremuDrag' || type === 'DremuTaplik' || type === 'DremuHold') return true;
            }
          }
        }
        return false;
      }, [project]);
      const playbackModel = useMemo(() => (preview && project ? buildPlaybackModel(project) : null), [preview, project]);
      const openPreview = useCallback(() => {
        if (!project || curveTargetRef.current) return;
        const total = Math.max(1, transport.duration || project.duration || 0);
        if (transport.time >= total - 0.05) transport.seek(0);
        transport.play();
        setPreview(true);
      }, [project, transport]);
      const closePreview = useCallback(() => {
        transport.pause();
        setPreview(false);
      }, [transport]);
      useEffect(() => {
        if (!project && preview) setPreview(false);
      }, [project, preview]);

      const pushNotice = useCallback((next) => {
        setNotice(next);
        if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4200);
      }, []);

      // Judgement-line note editor: opened from a lane strip, hosted by the
      // center pane as an overlay so the timeline keeps its view state.
      noteEditorRef.current = noteEditor;
      const openNoteEditor = useCallback(
        (targetValue) => {
          if (!targetValue || typeof targetValue.staffId !== 'string' || typeof targetValue.lane !== 'string') return;
          const staff = project ? (project.staffs || []).find((item) => item && item.id === targetValue.staffId) : null;
          const hasLane = !!(staff && (staff.periods || []).some((period) =>
            (period.elements || []).some((element) => element && element.category === 'lane' && element.fields && element.fields.name === targetValue.lane),
          ));
          if (!hasLane) {
            pushNotice({ kind: 'error', text: t('noteEditorNoLane') });
            return;
          }
          if (curveTargetRef.current) {
            // Do not discard an in-flight curve draft behind the user's back;
            // the curve panel must be applied or cancelled first.
            pushNotice({ kind: 'error', text: t('curveOpenBusy') });
            return;
          }
          if (preview) {
            transport.pause();
            setPreview(false);
          }
          // If the playhead is outside the lane's lifetime, jump to the
          // nearest lane window so the notes being edited are actually in
          // view (the timeline's own playhead is untouched while it is inside
          // a window, which keeps the fixture/editor flow predictable).
          const laneModel = buildLaneEditorModel(project, targetValue.staffId, targetValue.lane);
          if (laneModel && laneModel.windows.length > 0) {
            const playhead = transport.time;
            const inside = laneModel.windows.some((laneWindow) => playhead >= laneWindow.start - 1e-6 && playhead < laneWindow.end + 1e-6);
            if (!inside) {
              let nearest = null;
              let nearestDistance = Infinity;
              for (const laneWindow of laneModel.windows) {
                const distance = playhead < laneWindow.start ? laneWindow.start - playhead : playhead > laneWindow.end ? playhead - laneWindow.end : 0;
                if (distance < nearestDistance) {
                  nearestDistance = distance;
                  nearest = laneWindow;
                }
              }
              if (nearest) {
                transport.seek(Math.max(0, nearest.start));
                if (canvasApiRef.current && typeof canvasApiRef.current.reveal === 'function') {
                  canvasApiRef.current.reveal(Math.max(0, nearest.start));
                }
              }
            }
          }
          setNoteEditor({ staffId: targetValue.staffId, lane: targetValue.lane });
          setNoteTool('select');
          setSelection([]);
          setActiveStaff(targetValue.staffId);
        },
        [preview, project, pushNotice, t, transport],
      );
      const closeNoteEditor = useCallback(() => {
        setNoteEditor(null);
        setNoteTool('select');
      }, []);
      const noteZoom = useCallback((direction) => {
        setNotePps((previous) => {
          if (direction === 'reset') return NOTE_PPS_DEFAULT;
          if (direction === 'in') return clamp(previous * 1.25, NOTE_PPS_MIN, NOTE_PPS_MAX);
          return clamp(previous / 1.25, NOTE_PPS_MIN, NOTE_PPS_MAX);
        });
      }, []);
      const selectLaneNotes = useCallback(() => {
        if (!noteEditor || !project) return [];
        const laneModel = buildLaneEditorModel(project, noteEditor.staffId, noteEditor.lane);
        return laneModel ? laneModel.notes.map((item) => item.element.id) : [];
      }, [noteEditor, project]);
      const nudgeNoteSelection = useCallback(
        (deltaTime, deltaPosition) => {
          if (!noteEditor || !project || selection.length === 0) return;
          const ops = [];
          for (const id of selection) {
            const found = findElement(project, id);
            if (!found) continue;
            const noteLane = found.element.lane || (found.element.fields && typeof found.element.fields.laneName === 'string' ? found.element.fields.laneName : '');
            if (noteLane !== noteEditor.lane) continue;
            if (Number.isFinite(deltaTime) && Math.abs(deltaTime) > 1e-12) {
              const startField = resolveStartField(catalog, found.element);
              const current = startField ? valueAsNumber(found.element.fields[startField]) : null;
              if (startField && current !== null) {
                const nextStart = Math.max(0, (found.element.start || 0) + deltaTime);
                const periodOffset = Number.isFinite(found.period.timeOffset) ? found.period.timeOffset : 0;
                const nextRelative = round(nextStart - periodOffset, 6);
                if (Math.abs(nextRelative - current) > 1e-9) {
                  ops.push({ op: 'patch', elementId: id, path: [startField], value: nextRelative });
                }
              }
            }
            if (Number.isFinite(deltaPosition) && Math.abs(deltaPosition) > 1e-12) {
              const nextPosition = clamp(notePositionOf(found.element) + deltaPosition, -NOTE_POS_LIMIT, NOTE_POS_LIMIT);
              const patch = notePositionPatch(found.element, nextPosition);
              ops.push({ op: 'patch', elementId: id, path: patch.path, value: patch.value });
            }
          }
          if (ops.length > 0) session.edit(ops);
        },
        [catalog, noteEditor, project, selection, session],
      );

      // Docked curve editor: the inspector requests it, the center pane hosts it.
      curveTargetRef.current = curveTarget;
      // Keep the beat origin in sync when the element's start time is edited
      // while the panel is open (the stored target keeps the value snapshot).
      const liveCurveTarget = useMemo(() => {
        if (!curveTarget) return null;
        const found = project ? findElement(project, curveTarget.elementId) : null;
        const anchor = found && Number.isFinite(found.element.start) ? found.element.start : curveTarget.anchorTime;
        return Object.assign({}, curveTarget, { anchorTime: anchor, mainView: liveTimelineView });
      }, [curveTarget, project, liveTimelineView]);
      const closeCurvePanel = useCallback(() => setCurveTarget(null), []);
      const applyCurvePanel = useCallback((next) => {
        const current = curveTargetRef.current;
        if (current && typeof current.apply === 'function') current.apply(next);
        setCurveTarget(null);
      }, []);
      const openCurveRef = useRef(null);
      openCurveRef.current = (target) => {
        if (!target) return;
        if (curveTargetRef.current) {
          pushNotice({ kind: 'error', text: t('curveOpenBusy') });
          return;
        }
        if (preview) {
          transport.pause();
          setPreview(false);
        }
        // The curve panel docks under the timeline; close the note editor so
        // it cannot cover the panel it was opened from.
        if (noteEditorRef.current) {
          setNoteEditor(null);
          setNoteTool('select');
        }
        curveSeqRef.current += 1;
        const view = timelineViewRef.current;
        setLiveTimelineView({ t0: view.t0, pps: view.pps });
        setCurveTarget(
          Object.assign({}, target, {
            token: curveSeqRef.current,
            mainView: view ? { t0: view.t0, pps: view.pps } : null,
          }),
        );
      };
      const openCurvePanel = useCallback((target) => openCurveRef.current(target), []);

      // Close the editor when its element/selection goes away or the document
      // changes underneath it (agent edit, undo/redo, reload).
      useEffect(() => {
        if (!curveTarget) return;
        if (selection.length !== 1 || selection[0] !== curveTarget.elementId) setCurveTarget(null);
      }, [selection, curveTarget]);
      useEffect(() => {
        if (!curveTarget) return;
        if (!project || !findElement(project, curveTarget.elementId)) setCurveTarget(null);
      }, [project, curveTarget]);
      useEffect(() => {
        setCurveTarget(null);
      }, [project && project.dir]);
      useEffect(() => {
        if (!noteEditor) return;
        if (!project) {
          setNoteEditor(null);
          return;
        }
        const staff = (project.staffs || []).find((item) => item && item.id === noteEditor.staffId);
        const hasLane = !!(staff && (staff.periods || []).some((period) =>
          (period.elements || []).some((element) => element && element.category === 'lane' && element.fields && element.fields.name === noteEditor.lane),
        ));
        if (!hasLane) setNoteEditor(null);
      }, [project, noteEditor]);

      const [bpmBusy, setBpmBusy] = useState(false);
      const bpmAvailable = useMemo(
        () =>
          audioClips.some((clip) => {
            const key = clip && (clip.file || clip.relativePath) ? clip.file || clip.relativePath : '';
            const wave = key ? waves[key] : null;
            if (!wave || !wave.spectrum) return false;
            const duration = Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : wave.duration;
            return duration > 3;
          }),
        [audioClips, waves],
      );
      /** Detect a project BPM from the analyzed audio and apply it as setMeta. */
      const detectProjectTempo = useCallback(() => {
        if (bpmBusy) return;
        const result = detectProjectBpm(audioClips, waves);
        if (!result || !Number.isFinite(result.bpm)) {
          pushNotice({ kind: 'error', text: t('bpmNoAudio') });
          return;
        }
        setBpmBusy(true);
        // Paint the busy state first: the Goertzel scan is a short, synchronous
        // pass over the cached spectrogram.
        window.setTimeout(() => {
          try {
            // Song tempos are usually integers or halves; snap only when the
            // estimate is very close, otherwise keep the measured decimals.
            const half = Math.round(result.bpm * 2) / 2;
            const bpm = Math.round((Math.abs(result.bpm - half) <= 0.12 ? half : result.bpm) * 100) / 100;
            session.edit([{ op: 'setMeta', tempo: { bpm } }]);
            const low = result.confidence < 0.35 ? ' · ' + t('bpmLowConfidence') : '';
            pushNotice({ kind: 'ok', text: t('bpmDetected').replace('{bpm}', bpm.toFixed(2)) + low });
          } finally {
            setBpmBusy(false);
          }
        }, 20);
      }, [audioClips, bpmBusy, pushNotice, session, t, waves]);
      useEffect(() => () => {
        if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      }, []);

      useEffect(() => {
        if (session.notice) {
          pushNotice(session.notice);
          session.setNotice(null);
        }
      }, [session.notice, session.setNotice, pushNotice]);

      // Reset per-project editor state when the project identity changes.
      useEffect(() => {
        setSelection([]);
        setActiveStaff(null);
        setHiddenStaffs(new Set());
        setNoteEditor(null);
        setNoteTool('select');
        clipboardRef.current = [];
      }, [project && project.dir]);

      const lanes = useMemo(() => {
        const names = [];
        for (const staff of (project && project.staffs) || []) {
          for (const period of staff.periods || []) {
            for (const element of period.elements || []) {
              if (element.category === 'lane' && element.fields && typeof element.fields.name === 'string' && names.indexOf(element.fields.name) === -1) {
                names.push(element.fields.name);
              }
            }
          }
        }
        return names;
      }, [project]);

      const allElementIds = useMemo(() => {
        const ids = [];
        for (const staff of (project && project.staffs) || []) {
          if (staff.kind === 'audio') continue;
          for (const period of staff.periods || []) {
            for (const element of period.elements || []) {
              if (element.category === 'inner') continue;
              ids.push(element.id);
            }
          }
        }
        return ids;
      }, [project]);

      const selectElement = useCallback(
        (id, additive) => {
          setSelection((current) => {
            if (!additive) return [id];
            return current.indexOf(id) === -1 ? current.concat([id]) : current.filter((item) => item !== id);
          });
        },
        [],
      );

      /** Delete elements through one op batch (single undo step). */
      const deleteElements = useCallback(
        (ids) => {
          if (!ids || ids.length === 0) return;
          session.edit(ids.map((id) => ({ op: 'remove', elementId: id })));
          setSelection((current) => current.filter((id) => ids.indexOf(id) === -1));
        },
        [session],
      );

      /** Rename one staff's alias (the `.g` `displayName` header) — one undo step. */
      const renameStaff = useCallback(
        (staff, displayName) => {
          const name = typeof displayName === 'string' ? displayName.trim() : '';
          if (!staff || name.length === 0) return;
          session.edit([{ op: 'setStaffName', staffId: staff.id, displayName: name }]);
          pushNotice({ kind: 'ok', text: t('staffAliasSaved') + ' · ' + name });
        },
        [session, t, pushNotice],
      );

      /**
       * Permanently delete one staff: the Host removes the `.g` file (and its
       * `.bak`) after the dialog confirmed it. Deletion is not undoable, so it
       * does not land on the undo stack.
       */
      const deleteStaff = useCallback(
        (staff) => {
          if (!staff) return;
          const name = staff.displayName || staff.className || staff.id;
          session.edit([{ op: 'removeStaff', staffId: staff.id, deleteFile: true }], { record: false });
          setSelection([]);
          setHiddenStaffs((current) => {
            if (!current.has(staff.id)) return current;
            const next = new Set(current);
            next.delete(staff.id);
            return next;
          });
          pushNotice({ kind: 'ok', text: t('staffDeleted') + ' · ' + name });
        },
        [session, t, pushNotice],
      );

      /** Duplicate elements one beat later (single undo step). */
      const duplicateElements = useCallback(
        (ids) => {
          if (!project || !ids || ids.length === 0) return;
          const secondsPerBeat = 60 / ((tempo && tempo.bpm) || 120);
          const shift = secondsPerBeat;
          const ops = [];
          const newIds = [];
          const usedLaneNames = new Set();
          for (const id of ids) {
            const found = findElement(project, id);
            if (!found) continue;
            const startField = resolveStartField(catalog, found.element);
            const durationField = resolveDurationField(catalog, found.element);
            const fields = deepClone(found.element.fields);
            if (startField) {
              const current = valueAsNumber(fields[startField]);
              if (current === null) fields[startField] = round(found.period.timeOffset ? 0 : 0, 6);
              else fields[startField] = round(current + shift, 6);
            }
            // A duplicated lane must not collide with the source lane name:
            // rows are grouped by name, so two same-named lanes hide one row
            // and the .g file would carry two lanes with one identity.
            if (found.element.category === 'lane' && typeof fields.name === 'string') {
              fields.name = uniqueLaneName(project, found.staff.id, usedLaneNames);
              usedLaneNames.add(fields.name);
            }
            const newId = makeElementId(found.period.id);
            newIds.push(newId);
            ops.push({
              op: 'add',
              staffId: found.staff.id,
              periodId: found.period.id,
              element: { id: newId, type: found.element.type, fields },
            });
          }
          if (ops.length > 0) {
            session.edit(ops);
            setSelection(newIds);
          }
        },
        [catalog, project, session, snapDiv, tempo],
      );

      /** Copy the selection into the local clipboard. */
      const copySelection = useCallback(() => {
        if (!project) return;
        const items = [];
        let base = Infinity;
        for (const id of selection) {
          const found = findElement(project, id);
          if (!found) continue;
          base = Math.min(base, found.element.start || 0);
          items.push({ type: found.element.type, start: found.element.start || 0, fields: deepClone(found.element.fields) });
        }
        if (items.length > 0) {
          clipboardRef.current = items;
          pushNotice({ kind: 'ok', text: t('copy') + ' · ' + items.length });
        }
      }, [project, selection, pushNotice, t]);

      /** Paste the clipboard at the playhead, into the active staff when set. */
      const pasteClipboard = useCallback(() => {
        if (!project || clipboardRef.current.length === 0) return;
        const items = clipboardRef.current;
        const base = Math.min.apply(null, items.map((item) => item.start));
        const targetTime = snapOn ? snapTime(transport.time, tempo, snapDiv, true) : transport.time;
        const editable = (project.staffs || []).filter((item) => item.kind === 'chart' || item.kind === 'storyboard');
        const staff = editable.find((item) => item.id === activeStaff) || editable[0];
        if (!staff) return;
        const periodId = pickPeriod(project, staff.id, targetTime);
        const period = (staff.periods || []).find((item) => item.id === periodId);
        if (!period) return;
        const periodOffset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
        const ops = [];
        const newIds = [];
        for (const item of items) {
          const entry = catalogEntry(catalog, item.type);
          const timing = (entry && entry.timing) || {};
          const fields = deepClone(item.fields);
          const startField = typeof timing.start === 'string' && timing.start.length > 0 ? timing.start : ['hitTime', 'generateTime', 'startMoment'].find((name) => fields[name] !== undefined);
          if (startField) fields[startField] = round(targetTime + (item.start - base) - periodOffset, 6);
          if (entry && entry.category === 'lane' && typeof fields.name === 'string') fields.name = uniqueLaneName(project, staff.id);
          const newId = makeElementId(periodId);
          newIds.push(newId);
          ops.push({ op: 'add', staffId: staff.id, periodId, element: { id: newId, type: item.type, fields } });
        }
        session.edit(ops);
        setSelection(newIds);
      }, [activeStaff, catalog, project, session, snapDiv, snapOn, tempo, transport.time]);

      /** Nudge the selection in time by one grid step. */
      const nudgeSelection = useCallback(
        (direction) => {
          if (!project || selection.length === 0) return;
          const bpm = (tempo && tempo.bpm) || 120;
          const step = (60 / bpm) / (snapDiv || 4);
          const ops = [];
          for (const id of selection) {
            const found = findElement(project, id);
            if (!found) continue;
            const startField = resolveStartField(catalog, found.element);
            if (!startField) continue;
            const current = valueAsNumber(found.element.fields[startField]);
            if (current === null) continue;
            ops.push({ op: 'patch', elementId: id, path: [startField], value: round(current + direction * step, 6) });
          }
          if (ops.length > 0) session.edit(ops);
        },
        [catalog, project, selection, session, snapDiv, tempo],
      );

      /** Create one empty staff from the left pane's 新建谱表 dialog. */
      const addStaffFromDialog = useCallback(
        (request) => {
          if (!project) return;
          const kind = request && request.kind === 'storyboard' ? 'storyboard' : 'chart';
          const identity = uniqueStaffIdentity(project, kind);
          const displayName =
            request && typeof request.displayName === 'string' && request.displayName.trim().length > 0
              ? request.displayName.trim()
              : kind === 'storyboard' ? t('defaultStoryboardName') : t('defaultStaffName');
          session.edit([
            {
              op: 'addStaff',
              kind,
              form: kind === 'storyboard' ? 'DeentyStoryboard' : 'Dremu',
              displayName,
              className: identity.className,
              fileName: identity.fileName,
              timeOffset: 0,
            },
          ]);
          setActiveStaff(identity.fileName);
          setHiddenStaffs((current) => {
            if (!current.has(identity.fileName)) return current;
            const next = new Set(current);
            next.delete(identity.fileName);
            return next;
          });
          if (canvasApiRef.current) canvasApiRef.current.reveal(0);
          pushNotice({ kind: 'ok', text: t('createdStaff') + ' · ' + displayName });
        },
        [project, session, t, pushNotice],
      );

      /** Add one catalog element at the playhead into the requested staff. */
      const addElementFromDialog = useCallback(
        (type, staffId) => {
          if (!project) return;
          const editable = (project.staffs || []).filter((staff) => staff.kind === 'chart' || staff.kind === 'storyboard');
          const staff =
            editable.find((item) => item.id === staffId) || editable.find((item) => item.id === activeStaff) || editable[0] || null;
          if (!staff) {
            pushNotice({ kind: 'error', text: t('paletteNeedStaff') });
            return;
          }
          const entry = catalogEntry(catalog, type);
          if (!entry) return;
          const targetTime = Math.max(0, snapOn ? snapTime(transport.time, tempo, snapDiv, true) : transport.time);
          const periodId = pickPeriod(project, staff.id, targetTime);
          const period = (staff.periods || []).find((item) => item.id === periodId) || (staff.periods || [])[0] || null;
          const periodOffset = period && Number.isFinite(period.timeOffset) ? period.timeOffset : 0;
          const fields = fieldsForNewElement(catalog, type);
          const timing = entry.timing || {};
          if (period) {
            if (entry.category === 'lane') {
              fields.name = uniqueLaneName(project, staff.id);
              fields[timing.start || 'generateTime'] = round(targetTime - periodOffset, 6);
            } else {
              fields[timing.start || 'hitTime'] = round(targetTime - periodOffset, 6);
              if (timing.lane) {
                const lane = firstLaneName(project, staff.id);
                if (lane) fields[timing.lane] = lane;
              }
            }
          }
          if (entry.type === 'DeentyStoryboard.Image') {
            const images = (project.assets && project.assets.images) || [];
            if (images.length > 0) fields.assetName = images[0];
          }
          const id = makeElementId(periodId || 'p0');
          const op = { op: 'add', staffId: staff.id, element: { id, type, fields } };
          if (period) op.periodId = period.id;
          else op.element.start = targetTime;
          session.edit([op]);
          setSelection([id]);
          setHiddenStaffs((current) => {
            if (!current.has(staff.id)) return current;
            const next = new Set(current);
            next.delete(staff.id);
            return next;
          });
          if (canvasApiRef.current) canvasApiRef.current.reveal(targetTime);
          pushNotice({ kind: 'ok', text: t('createdElement') + ' · ' + (entry.label || shortType(type)) });
        },
        [activeStaff, catalog, project, session, snapOn, snapDiv, t, tempo, transport, pushNotice],
      );

      /** Append one audio period (乐段) from the left pane dialog. */
      const addAudioPeriodFromDialog = useCallback(
        (request) => {
          if (!project || !request || typeof request.file !== 'string' || request.file.length === 0) return;
          const audioStaff = (project.staffs || []).find((staff) => staff && staff.kind === 'audio') || null;
          const staffId = typeof request.staffId === 'string' && request.staffId.length > 0 ? request.staffId : audioStaff ? audioStaff.id : '';
          const op = {
            op: 'addAudioPeriod',
            file: request.file,
            name: typeof request.name === 'string' ? request.name : '',
            timeOffset: Number.isFinite(request.timeOffset) ? request.timeOffset : 0,
          };
          if (staffId) op.staffId = staffId;
          session.edit([op]);
          if (staffId) setActiveStaff(staffId);
          if (canvasApiRef.current && Number.isFinite(request.timeOffset)) canvasApiRef.current.reveal(Math.max(0, request.timeOffset));
          pushNotice({ kind: 'ok', text: t('audioCreated') + (request.name ? ' · ' + request.name : '') });
        },
        [project, session, t, pushNotice],
      );

      /** Remove one audio period (the audio file itself stays on disk). */
      const deleteAudioPeriodFromDialog = useCallback(
        (staffId, clip) => {
          if (!staffId || !clip || !clip.id) return;
          session.edit([{ op: 'removeAudioPeriod', staffId, audioPeriodId: clip.id }]);
          pushNotice({ kind: 'ok', text: t('audioDeleted') + (clip.name ? ' · ' + clip.name : '') });
        },
        [session, t, pushNotice],
      );

      // Keyboard shortcuts. The listener is registered once and dispatches to a
      // handler ref, so a transport tick (which re-renders the page ~60x/s)
      // cannot churn window listeners.
      const keyHandlerRef = useRef(null);
      useEffect(() => {
        const dispatch = (event) => {
          const handler = keyHandlerRef.current;
          if (typeof handler === 'function') handler(event);
        };
        window.addEventListener('keydown', dispatch);
        return () => window.removeEventListener('keydown', dispatch);
      }, []);

      keyHandlerRef.current = (event) =>
        handleEditorKey(event, {
          preview,
          closePreview,
          transport,
          session,
          selection,
          allElementIds,
          setSelection,
          copySelection,
          pasteClipboard,
          duplicateElements,
          deleteElements,
          nudgeSelection,
          setTool,
          setSnapDiv,
          tempo,
          snapDiv,
          canvasApiRef,
          curveEditing: curveTarget !== null,
          closeCurvePanel,
          noteEditing: noteEditor !== null,
          noteTool,
          setNoteTool,
          notePps,
          setNotePps,
          closeNoteEditor,
          selectLaneNotes,
          nudgeNoteSelection,
        });

      // The left pane is memoized and ignores callback props, so hand it stable
      // refs whose `.current` always points at the latest handler.
      const addStaffRef = useRef(null);
      const addElementRef = useRef(null);
      addStaffRef.current = addStaffFromDialog;
      addElementRef.current = addElementFromDialog;

      const dirty = !!(state && state.dirty);
      const connection = session.connection;
      const phase = session.phase;

      // The project picker shows the last-known list until `/projects` answers.
      const dialogState = Object.assign({}, state || {}, {
        projects: state && Array.isArray(state.projects) && state.projects.length > 0 ? state.projects : library,
      });

      return h(
        'div',
        { className: 'dgc-root' },
        h(StyleSheet),
        h(StudioHeader, {
          t,
          project,
          dirty,
          connection,
          session,
          hasPlayableContent,
          previewDisabled: curveTarget !== null,
          curveBusy: curveTarget !== null,
          onOpenProject: () => setOpenDialog(true),
          onNewProject: () => setCreateDialog(true),
          onPreview: openPreview,
        }),
        h(StudioToolbar, {
          t,
          tool,
          setTool,
          snapOn,
          snapDiv,
          setSnapOn,
          setSnapDiv,
          canvasApiRef,
          selection,
          onDuplicate: duplicateElements,
          onDelete: deleteElements,
          tempo,
          onEdit: session.edit,
          noteEditor: noteEditor ? { tool: noteTool, setTool: setNoteTool, onZoom: noteZoom } : null,
        }),

        // Body.
        h(
          'div',
          { className: 'dgc-body' },
          project
            ? h(LeftPaneMemo, {
                project,
                catalog,
                t,
                selection,
                activeStaff,
                setActiveStaff,
                hiddenStaffs,
                toggleStaff: (id) =>
                  setHiddenStaffs((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  }),
                selectElement,
                seek: (time) => {
                  transport.seek(time);
                  if (canvasApiRef.current) canvasApiRef.current.reveal(time);
                },
                playheadRef: transport.timeRef,
                addStaffRef,
                addElementRef,
                onRenameStaff: renameStaff,
                onDeleteStaff: deleteStaff,
                onAddAudioPeriod: addAudioPeriodFromDialog,
                onDeleteAudioPeriod: deleteAudioPeriodFromDialog,
              })
            : null,
          h(
            'div',
            {
              className: 'dgc-center' + (liveCurveTarget && project ? ' has-curve' : ''),
              style:
                liveCurveTarget && project
                  ? { '--dgc-timeline-h': Math.max(120, timelineContentHeight) + 'px' }
                  : undefined,
            },
            h(TimelineCanvas, {
              project: project || { staffs: [], tempo, duration: 0 },
              catalog,
              t,
              selection,
              setSelection,
              tool,
              setTool,
              snapOn,
              setSnapOn,
              snapDiv,
              tempo,
              transport,
              follow,
              hiddenStaffs,
              activeStaff,
              onEdit: session.edit,
              onNotice: pushNotice,
              waves,
              waveStatus,
              audioClips,
              onReady: setCanvasApi,
              onViewChange: onTimelineView,
              onContentHeight: onTimelineContentHeight,
              onOpenNoteEditor: openNoteEditor,
            }),
            // Docked curve editor: replaces the timeline pane visually while
            // keeping the editor chrome, inspector and transport reachable.
            liveCurveTarget && project
              ? h(CurveEditorLayerMemo, {
                  key: liveCurveTarget.token,
                  t,
                  catalog,
                  target: liveCurveTarget,
                  tempo,
                  snapOn,
                  snapDiv,
                  playheadRef: transport.timeRef,
                  onTimelineScroll: syncTimelineScroll,
                  onTimelineSetT0: syncTimelineSetT0,
                  onTimelineZoom: syncTimelineZoom,
                  onTimelineFit: syncTimelineFit,
                  onApply: applyCurvePanel,
                  onClose: closeCurvePanel,
                })
              : null,
            // Judgement-line note editor overlay (timeline stays mounted
            // underneath so returning keeps its zoom and scroll state).
            noteEditor && project
              ? h(NoteEditorLayer, {
                  key: 'note:' + noteEditor.staffId + '::' + noteEditor.lane,
                  t,
                  project,
                  catalog,
                  target: noteEditor,
                  tempo,
                  transport,
                  waves,
                  waveStatus,
                  audioClips,
                  selection,
                  setSelection,
                  tool: noteTool,
                  snapOn,
                  snapDiv,
                  pps: notePps,
                  setPps: setNotePps,
                  onEdit: session.edit,
                  onClose: closeNoteEditor,
                })
              : null,
            phase === 'error'
              ? h(
                  'div',
                  { className: 'dgc-overlay' },
                  h(
                    'div',
                    { className: 'dgc-overlayCard' },
                    h('h3', null, t('loadFailed')),
                    h('p', null, session.error || ''),
                    h(
                      'div',
                      { className: 'dgc-rowActions' },
                      h(Button, { variant: 'primary', icon: 'reload', onClick: () => session.refresh() }, t('retry')),
                      h(Button, { onClick: () => setOpenDialog(true) }, t('openProject')),
                    ),
                  ),
                )
              : null,
            phase === 'loading'
              ? h(
                  'div',
                  { className: 'dgc-overlay' },
                  h('div', { className: 'dgc-overlayCard' }, h('h3', null, t('loading')), h('p', null, t('subtitle'))),
                )
              : null,
            // Embedded preview: occupy the timeline pane only, so the
            // editor header, side panes and transport stay reachable.
            preview && playbackModel
              ? h(PlaybackLayer, { project, model: playbackModel, transport, tr: t, onClose: closePreview })
              : null,
          ),
          project
            ? h(InspectorPaneMemo, {
                project,
                catalog,
                t,
                selection,
                lanes,
                transport,
                onEdit: session.edit,
                onDetectBpm: detectProjectTempo,
                bpmBusy,
                bpmAvailable,
                onDelete: deleteElements,
                onDuplicate: (id) => duplicateElements([id]),
                onOpenCurve: openCurvePanel,
                seek: (time) => {
                  transport.seek(time);
                  if (canvasApiRef.current) canvasApiRef.current.reveal(time);
                },
              })
            : h('aside', { className: 'dgc-inspector' }, h('div', { className: 'dgc-hint' }, t('noSelectionHint'))),
        ),
        // Transport.
        h(TransportBar, { t, transport, project, follow, setFollow, selection }),

        // No-project overlay.
        !project && phase === 'empty'
          ? h(
              'div',
              { className: 'dgc-overlay' },
              h(
                'div',
                { className: 'dgc-overlayCard' },
                h('h3', null, t('noProject')),
                h('p', null, t('noProjectHint')),
                h(
                  'div',
                  { className: 'dgc-rowActions' },
                  h(Button, { variant: 'primary', icon: 'plus', onClick: () => setCreateDialog(true) }, t('newProject')),
                  h(Button, { icon: 'folder', onClick: () => setOpenDialog(true) }, t('openProject')),
                  state && (state.recent || []).length > 0
                    ? h(Button, { onClick: () => session.openProject(state.recent[0]) }, state.recent[0])
                    : null,
                ),
              ),
            )
          : null,
        // Notice toast.
        notice
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: '50%',
                  bottom: 74,
                  transform: 'translateX(-50%)',
                  zIndex: 20,
                  padding: '7px 14px',
                  borderRadius: 8,
                  fontSize: 12,
                  color: '#fff',
                  background: notice.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
                  boxShadow: '0 8px 20px rgba(0,0,0,.28)',
                  maxWidth: '70%',
                },
                role: 'status',
              },
              notice.text,
            )
          : null,
        openDialog
          ? h(OpenProjectDialog, {
              t,
              state: dialogState,
              onOpen: (dir) => {
                setCurveTarget(null);
                session.openProject(dir);
              },
              onNewProject: () => {
                setOpenDialog(false);
                setCreateDialog(true);
              },
              onClose: () => setOpenDialog(false),
            })
          : null,
        createDialog
          ? h(CreateProjectDialog, {
              t,
              projectRoot: (state && state.projectRoot) || '',
              onCreate: (request) => {
                setCurveTarget(null);
                return session.createProject(request);
              },
              onClose: () => setCreateDialog(false),
            })
          : null,
      );
    }

    // ========================================================================
    // 19 · Sidebar panel icon.
    // ========================================================================

    /** 18px sidebar glyph: a branch lane with three notes on it. */
    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: size, height: size, fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M2.2 13.6c2.8 0 3.6-7.2 6-7.2s3.2 7.2 6 7.2',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 5.2, cy: 10.6, r: 1.7, fill: 'currentColor' }),
        h('circle', { cx: 10.1, cy: 7.1, r: 1.7, fill: 'currentColor' }),
        h('path', { d: 'M14.1 11.1l1.7 1.2-1.5 1.4z', fill: 'currentColor' }),
      );
    }

    // ========================================================================
    // 20 · Client plugin entry.
    // ========================================================================

    /**
     * Register the sidebar entry and the full-page studio panel. Theme token
     * caches are invalidated when the shell switches light/dark.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gorge-chart: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.effect(() => {
        const target = document.documentElement;
        if (!target || typeof MutationObserver !== 'function') return undefined;
        const observer = new MutationObserver(() => resetTokenCache());
        observer.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        return () => observer.disconnect();
      }, 'gorge-chart: theme token cache');

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 3,
            label: () => t('panel'),
            locale: NS,
          },
          PanelIcon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          ChartStudioPage,
        ),
      );
    }

    const playbackTestApi = Object.freeze({
      buildPlaybackModel,
      collectFrame,
      colorCurveAt,
      evalAdd,
    });
    const audioTestApi = Object.freeze({ audioClipsOf, clipActiveAt, spectrumFromSamples: computeSpectrum, wavPeaks, detectBpmFromSpectrum, detectBpmFromOnsets });
    const curveTestApi = Object.freeze({
      sampleCurve,
      readCurveDraft,
      buildCurveValue,
      normalizeSegments,
      setSegmentBoundary,
      splitCurveSegment,
      addCurveSegmentOutside,
      deleteCurveSegment,
      changeCurveSegmentType,
      defaultSegmentCurve,
      curveNaturalRange,
      curveInitialView,
      curveAlignedView,
      curveValueRange,
      curveParamHandles,
      curveBoundaryWarnings,
      autoFixCurveBoundaryJumps,
      offsetCurveValue,
      snapCurveTime,
      curveLayout,
      curveTypeOf,
      isCurveEditorValue,
    });
    const noteEditorTestApi = Object.freeze({
      layout: noteEditorLayout,
      positionToX: notePositionToX,
      xToPosition: noteXToPosition,
      timeToY: noteTimeToY,
      yToTime: noteYToTime,
      snapPosition: snapNotePosition,
      toolForKey: noteToolForKey,
      buildLaneEditorModel,
      positionOf: notePositionOf,
      positionPatch: notePositionPatch,
      holdTimeOf: noteHoldTimeOf,
      pickLanePeriodId,
    });
    const clientPlugin = {
      name: 'gorge-chart-studio-client',
      inject: ['slots', 'locale'],
      apply,
    };
    // Test hooks for tests/client-smoke.mjs: pure playback model/frame helpers
    // and the audio-clip window/legacy-fallback helpers.
    Object.defineProperty(clientPlugin, '__playback', { value: playbackTestApi, enumerable: false });
    Object.defineProperty(clientPlugin, '__audio', { value: audioTestApi, enumerable: false });
    Object.defineProperty(clientPlugin, '__curve', { value: curveTestApi, enumerable: false });
    Object.defineProperty(clientPlugin, '__noteEditor', { value: noteEditorTestApi, enumerable: false });
    return clientPlugin;
  },
});
