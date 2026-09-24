# 有道词典笔官方 UI 设计规范（提取自系统 app）

来源：设备内置 app 的 QuickJS 字节码**字符串池**（`.js.bin` 是编译产物不可逆，
但字符串池是明文字面量，样式名/颜色/尺寸/字体都在里面）。

提取对象：词典笔桌面 `8080222437664451`（`/userdata/miniapp/data/mini_app/pkg/.../b/`）

## 官方设计系统

- 名称：**`yd-dictpen-haasui`**
- 组件库路径：`yd-dictpen-haasui/ui/commons/`
- 确认存在的组件：`BasePage.vue` / `Card.vue` / `Button.vue` /
  `BackButton.vue` / `toolbuttons/BackToolButton.vue`

## 字体

```
fontFamily:      OPPOSans
fontFamilyZhCn:  Noto Sans
fontFamilyEnUs / fontFamilyEnSymbol
```

## 屏幕基准

桌面 app 画布：**600 × 960 px**（出现频次最高的整屏尺寸）。
其他常见画布：800×480、640、560、320。

## 字号 / 行高

| 用途 | fontSize | lineHeight |
|---|---|---|
| 按钮文字 | 28px | 37px |
| 卡片标题 | 24px | — |
| 正文 | 20px | — |
| 次要 | 16px | — |
| 辅助 | 14px | — |
| 最小 | 12px | — |

## 间距 / 尺寸

`13px / 16px / 20px / 24px / 28px / 30px` 为常用值。
按钮高度 **80px**；卡片图标区 76/68/120/111px；常用容器 100/110/120/164/168px。

## 颜色

### 主色（强调 / 品牌橙）
```
#f9532f   主强调色（出现最多）
#f19824   次强调
#ff8b20 / #ff7e08 / #e9900c   橙系变体
```

### 功能色（蓝）
```
#5687ff / #5b7fff / #008cff / #2d73dc / #509deb   蓝系
#644fec   紫
```

### 中性色（深色主题基底）
```
#1a1b1f   最深背景
#151626   深蓝黑
#18191b / #222328 / #2d2e33 / #36373d   层级背景
#41434d / #484848 / #515259 / #909199 / #a8aab2   文本灰阶
#ffffff   主文本
```

### 状态色
```
#13b876 / #28c7b2   成功（青绿）
#ff3333 / #f03043 / #be1a1b   错误（红）
#4dffff / #0affff   高亮（青）
```

### 半透明
```
rgba(45, 46, 51, 0.8)     Toast 背景
rgba(0, 0, 0, 0.96)       Dialog 背景
rgba(255, 255, 255, 0.3)  边框
```

## 组件实现要点（从字符串池还原）

### Toast
- 定位：`fixed`，`left/right/bottom` 撑满，内容 `center` 居中，`bottom: 190px`
- 背景：`rgba(45,46,51,0.8)`（`type: white` 时文字为 white）
- 动效：`animation-in`（`ease-out`）+ `animation-out`（`ease-in`）
- 结构：`toastStyle` / `contentStyle`，`isFocusable`、`isExamTheme` 开关

### SystemDialog
- 背景：`rgba(0,0,0,0.96)`（几乎不透明，非遮罩式）
- 结构：`tipContainerStyle` / `tipStyle` / `rightPartStyle` / `confirmButtonStyle`
- 定位与动效同 Toast

### Button
- 高度 80px，`justifyContent: center` + `alignItems: center`
- `textSize` / `textLineHeight` / `textColor` / `borderRadius` 全可配
- 有 `opacity:active` 与 `item-enabled` 状态类
- 支持多机型主题：`theme-coco` / `theme-almond` / `theme-apollo` / `theme-x3s`

### Card
- 图标区固定尺寸 + `marginTop` / `marginRight` 定位
- 文本区 `card-text`，主题变体 `card-text-exam` / `card-text-pear`
- 角标：`update-point-exam` / `update-point-pear`（`#f9532f`）
- 图标 `loading-icon-exam` / `loading-icon-pear`

## 我们项目的适配

设备实际逻辑分辨率与桌面 app 的 600×960 基准不同；我们项目通过
`/etc/miniapp/resources/cfg.json` + `setViewPort()` 自动适配，
样式统一用 `rpx`（按 viewport 缩放）。

沿用官方规范的做法：
- 字号阶梯按 600 基准换算 → rpx（`28px → 28rpx` 在 600 宽下等价，见 base.less）
- 主强调色改用 `#f9532f`（官方橙）
- 字体 `OPPOSans`（设备已内置）
- 按钮高度 80px、圆角与间距按上表
