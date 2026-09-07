// 图表常量表（来源：Skill-Judge.md §R6a-4.1-4.6 常量表，逐字提取）
// 用途：render-report.js 图表纯函数的唯一常量源；不缩写、不自创。
'use strict';

module.exports = {
  // A8-P2a：图表 max-width 规范表（唯一权威源；render-report.injectChart 统一读取，禁止逐图手写）
  CHART_MAXWIDTH: {
    radar: 500,
    bar: 600,
    donut: 360,
    scBar: 320,
    matrix: 420,
    c9: 500,
    c8Chart1: 500,   // C8 模板图1：viewBox 400×300
    c8Chart2: 520,   // C8 模板图2：viewBox 420×174
    c8Chart3: 600    // C8 模板图3：viewBox 600×420
  },

  radar: {
    cx: 250, cy: 250, max: 10,
    rMax: 180,                 // r = 180 × score / 10
    refRings: [22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180],
    labelR: 210,
    viewBox: '0 0 500 570',
    legendY: 500,
    axes: [ // 序号/维度/cos/sin/轴标签坐标（常量表逐行复制）
      { n: 1, dim: '证伪',   cos: 0,      sin: -1,     lx: 250, ly: 460 },
      { n: 2, dim: '理性',   cos: 0.866,  sin: -0.5,   lx: 432, ly: 355 },
      { n: 3, dim: '场面感', cos: 0.866,  sin: 0.5,    lx: 432, ly: 145 },
      { n: 4, dim: '证成',   cos: 0,      sin: 1,      lx: 250, ly: 40  },
      { n: 5, dim: '感性',   cos: -0.866, sin: 0.5,    lx: 68,  ly: 145 },
      { n: 6, dim: '意义感', cos: -0.866, sin: -0.5,   lx: 68,  ly: 355 }
    ],
    // A7-B4/缺陷H：fill 改用 CSS 变量（浅色/深色模式自适应；:root 与 body.dark 定义见 report.css）
    pro:  { fill: 'var(--chart-pro-fill)', stroke: '#1565c0' },
    con:  { fill: 'var(--chart-con-fill)', stroke: '#c62828' }
  },

  bar: {
    viewBox: '0 0 600 300',
    CL: 60, CR: 540, CT: 30, CB: 260,
    chartW: 480, chartH: 230,
    barW: 28, barGap: 4, groupW: 60, groupCount: 4, groupSpacing: 80,
    padL: 24, padR: 24,        // 260805：首柱与 y 轴、末柱与右缘保持边距
    colorPro: '#1565c0', colorCon: '#c62828',
    gridColor: '#e0e0e0', labelFont: 13
  },

  donut: {
    CX: 200, CY: 160, R: 110, SW: 60,
    CIRCUMFERENCE: 691.2, QUARTER: 172.8,
    viewBox: '0 0 400 360',
    colors: ['#1565c0', '#43a047', '#c62828'], // 路径①蓝/②绿/③红
    legend: [
      { x: 60,  y: 325, label: '路径①·A未必→B' },
      { x: 230, y: 325, label: '路径②·B未必→C' },
      { x: 60,  y: 347, label: '路径③·B不重要' }
    ]
  },

  scBar: {
    viewBox: '0 0 400 280',
    CL: 80, CT: 30, CB: 230, chartH: 200,
    barW: 40, barCxPro: 160, barCxCon: 260,
    colorPro: '#1565c0', colorCon: '#c62828',
    yMin: 4 // Y_MAX = max(DATA_MAX+1, 4)
  },

  c9: {
    viewBox: '0 0 500 44', x1: 90, x2: 410,
    axes: [
      { id: 'ZHENGMING', left: '批判者（证伪）', right: '审判者（证成）', color: '#1565c0' },
      { id: 'SHUOFU',    left: '卫道者（理性）', right: '问道者（感性）', color: '#c62828' },
      { id: 'DISAN',     left: '技术者（场面感）', right: '艺术者（意义感）', color: '#f9a825' }
    ]
  },

  c8: {
    quadrantCenters: { Q1: { cx: 105, cy: 75 }, Q2: { cx: 295, cy: 75 }, Q4: { cx: 105, cy: 205 }, Q3: { cx: 295, cy: 205 } },
    // A8-P2c：图3 双向轨道（C8图表优化模板.730.html 目标规范）——上排正方攻击→反方（实线红），下排反方攻击→正方（虚线蓝）
    track: {
      viewBox: '0 0 600 420',
      proTitle: { x: 150, y: 45, text: '正方攻击 → 反方', fill: '#c62828' },
      conTitle: { x: 430, y: 205, text: '反方攻击 → 正方', fill: '#1565c0' },
      xFrom: 130, xTo: 400,
      proY0: 55, conY0: 225, yStep: 40,
      markerRed: 'url(#arrow-red)', markerBlue: 'url(#arrow-blue)',
      legend: [
        { x: 130, y: 390, fill: '#c62828', label: '正方攻击（实线带箭头）' },
        { x: 310, y: 390, fill: '#1565c0', label: '反方攻击（虚线带箭头）' }
      ]
    },
    dominanceColors: {
      正方: { bg: '#e8f5e9', stroke: '#2e7d32', text: '#2e7d32' },
      反方: { bg: '#e3f2fd', stroke: '#1565c0', text: '#1565c0' },
      均衡: { bg: '#fff8e1', stroke: '#f9a825', text: '#f9a825' },
      空缺: { bg: '#fafafa', stroke: '#e0e0e0', text: '#bdbdbd' }
    },
    line: { pro: { stroke: '#c62828', dash: null }, con: { stroke: '#1565c0', dash: '6,3' } }
  }
};
